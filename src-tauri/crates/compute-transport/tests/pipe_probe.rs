//! 命名管道的方向隔离：一个方向阻塞时，另一个方向还能不能动。
//!
//! 这不是历史探针，而是**设计前提的回归测试**：`src/pipe.rs` 之所以要用重叠（异步）IO，
//! 是因为 Windows 对同一个文件对象上的同步 IO 是串行的。三条用例把这个前提钉住：
//! A 用 Rust 的 `File`（`try_clone` 出来的第二份句柄）、B 用裸 `ReadFile`/`WriteFile`
//! （同步、`None` overlapped）——两个都得卡住，说明问题不在 Rust 也不在句柄复制；C 换成
//! `FILE_FLAG_OVERLAPPED` 之后，读还在飞时写必须立刻完成。
//!
//! 只有 C 下硬断言：它是我们自己的修法，失效就必须红。A/B 记录的是操作系统的行为，不设断言
//! ——它们哪天不再卡住，说明 Windows 改了同步 IO 的语义（而不是我们写错了），此时该有人回来
//! 判断重叠重写还有没有必要，但不该把这一套装成「平台一改就崩」。
//!
//! 结论用「写有没有在 2 秒内完成」表示：`None` = 卡住了。判超时的线程直接 `drop`，不 join，
//! 所以真卡住时测试进程也不会被挂死。
#![cfg(windows)]

use std::fs::File;
use std::io::Read;
use std::os::windows::io::{AsRawHandle, IntoRawHandle};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ,
    FILE_SHARE_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows::Win32::System::Threading::CreateEventW;

const PATIENCE: Duration = Duration::from_secs(2);

struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

impl SendHandle {
    /// 闭包里必须整体借用 `SendHandle`，不能直接读 `.0`：2021 版的精确捕获会只捕获那个
    /// `HANDLE` 字段，于是闭包又不是 `Send` 了。
    fn raw(&self) -> HANDLE {
        self.0
    }
}

fn create_pipe(name: &str) -> HANDLE {
    let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
    let handle = unsafe {
        CreateNamedPipeW(
            &path,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            None,
        )
    };
    assert!(handle != INVALID_HANDLE_VALUE, "CreateNamedPipeW 失败");
    handle
}

fn connect(handle: HANDLE, name: &str) -> File {
    let connecting = {
        let handle = SendHandle(handle);
        thread::spawn(move || {
            let _ = unsafe { ConnectNamedPipe(handle.raw(), None) };
            handle
        })
    };
    let file = File::options()
        .read(true)
        .write(true)
        .open(format!(r"\\.\pipe\{name}"))
        .expect("客户端连不上");
    let _ = connecting.join().expect("连接线程挂了");
    file
}

/// 写 4 字节，返回耗时；`None` 表示 `PATIENCE` 内没写完。
fn timed_write(handle: HANDLE, label: &'static str) -> Option<Duration> {
    let (sender, receiver) = mpsc::channel();
    let handle = SendHandle(handle);
    thread::spawn(move || {
        let buffer = *b"ping";
        let start = Instant::now();
        let mut written = 0u32;
        let result =
            unsafe { WriteFile(handle.raw(), Some(buffer.as_slice()), Some(&mut written), None) };
        let _ = sender.send((result.is_ok(), start.elapsed(), written, label));
    });
    match receiver.recv_timeout(PATIENCE) {
        Ok((ok, elapsed, written, label)) => {
            eprintln!("[{label}] 写完成 ok={ok} 用时 {elapsed:?} 写进 {written} 字节");
            Some(elapsed)
        }
        Err(_) => {
            eprintln!("[{label}] 写 {PATIENCE:?} 内没完成");
            None
        }
    }
}

/// A：Rust 的 `File` 在克隆出来的那一份上阻塞读，此时往原来那一份写——worker 现在就是这个形状。
#[test]
fn a_a_rust_reader_blocks_a_rust_writer_on_the_same_connection() {
    let name = format!("yomika-pipe-probe-a-{}", std::process::id());
    let server = create_pipe(&name);
    let client = connect(server, &name);
    let reader = {
        let mut reader = client.try_clone().expect("try_clone 失败");
        thread::spawn(move || {
            let mut byte = [0u8; 8];
            let _ = reader.read(&mut byte);
        })
    };
    thread::sleep(Duration::from_millis(200));
    let elapsed = timed_write(HANDLE(client.as_raw_handle()), "A:rust-write");
    eprintln!("[A] 结果：{elapsed:?}");
    // 不 join 读线程：写要是真卡住了，join 会把这个探针本身挂死（已经踩过一次）。
    drop(reader);
    thread::sleep(Duration::from_millis(100));
}

/// B：同一个连接、同一对句柄，但读写都用裸 `ReadFile`/`WriteFile`——用来区分「Rust 的文件锁」
/// 和「Windows 对同一个文件对象做同步串行化」。
#[test]
fn b_raw_readfile_and_writefile_on_the_same_connection() {
    let name = format!("yomika-pipe-probe-b-{}", std::process::id());
    let server = create_pipe(&name);
    let client = connect(server, &name);
    let reader_handle = SendHandle(HANDLE(client.as_raw_handle()));
    let writing_handle = client.into_raw_handle();
    thread::spawn(move || {
        let mut buffer = [0u8; 8];
        let mut read = 0u32;
        let _ = unsafe {
            ReadFile(
                reader_handle.raw(),
                Some(buffer.as_mut_slice()),
                Some(&mut read),
                None,
            )
        };
    });
    thread::sleep(Duration::from_millis(200));
    let elapsed = timed_write(HANDLE(writing_handle), "B:raw-write");
    eprintln!("[B] 结果：{elapsed:?}");
    thread::sleep(Duration::from_millis(100));
}

/// 用 `FILE_FLAG_OVERLAPPED` 打开客户端句柄：这是候选的修法。
fn open_overlapped(name: &str) -> HANDLE {
    let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
    unsafe {
        CreateFileW(
            &path,
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .expect("CreateFileW 重叠打开失败")
    }
}

/// 重叠写：不等 IO 完成就不返回；`None` 表示 `PATIENCE` 内没完成。
fn overlapped_write(handle: HANDLE, label: &'static str) -> Option<Duration> {
    let (sender, receiver) = mpsc::channel();
    let handle = SendHandle(handle);
    thread::spawn(move || {
        let buffer = *b"ping";
        let start = Instant::now();
        let event = unsafe { CreateEventW(None, true, false, None) }.expect("CreateEventW");
        let mut overlapped = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        let mut written = 0u32;
        let started = unsafe {
            WriteFile(
                handle.raw(),
                Some(buffer.as_slice()),
                Some(&mut written),
                Some(&mut overlapped),
            )
        };
        let outcome = match started {
            Ok(()) => Ok(()),
            Err(_) if unsafe { GetLastError() } == ERROR_IO_PENDING => unsafe {
                GetOverlappedResult(handle.raw(), &overlapped, &mut written, true)
                    .map_err(|error| error.code().0)
            },
            Err(error) => Err(error.code().0),
        };
        let _ = unsafe { CloseHandle(event) };
        let _ = sender.send((outcome, start.elapsed(), written, label));
    });
    match receiver.recv_timeout(PATIENCE) {
        Ok((outcome, elapsed, written, label)) => {
            eprintln!("[{label}] 重叠写返回 {outcome:?} 用时 {elapsed:?} 写进 {written} 字节");
            outcome.ok().map(|()| elapsed)
        }
        Err(_) => {
            eprintln!("[{label}] 重叠写 {PATIENCE:?} 内没完成");
            None
        }
    }
}

/// C：客户端句柄用重叠（异步）IO；一个读一直在飞，写还能不能立刻完成。
#[test]
fn c_overlapped_io_keeps_both_directions_alive() {
    let name = format!("yomika-pipe-probe-c-{}", std::process::id());
    let server = create_pipe(&name);
    let connecting = {
        let handle = SendHandle(server);
        thread::spawn(move || {
            let _ = unsafe { ConnectNamedPipe(handle.raw(), None) };
            handle
        })
    };
    let client = open_overlapped(&name);
    let _ = connecting.join().expect("连接线程挂了");

    let reader = SendHandle(client);
    thread::spawn(move || {
        let event = unsafe { CreateEventW(None, true, false, None) }.expect("CreateEventW");
        let mut overlapped = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        let mut buffer = [0u8; 8];
        let mut read = 0u32;
        let started = unsafe {
            ReadFile(
                reader.raw(),
                Some(buffer.as_mut_slice()),
                Some(&mut read),
                Some(&mut overlapped),
            )
        };
        if let Err(error) = started {
            assert_eq!(
                unsafe { GetLastError() },
                ERROR_IO_PENDING,
                "重叠读不是挂起而是失败：{error:?}"
            );
            unsafe { GetOverlappedResult(reader.raw(), &overlapped, &mut read, true) }
                .expect("读完成");
        }
        let _ = unsafe { CloseHandle(event) };
        eprintln!("[C] 读回 {read} 字节 {buffer:?}");
    });
    thread::sleep(Duration::from_millis(200));

    let elapsed = overlapped_write(client, "C:overlapped-write");
    eprintln!("[C] 结果：{elapsed:?}");
    assert!(elapsed.is_some(), "重叠写在读还在飞的时候也阻塞了");
    thread::sleep(Duration::from_millis(200));
}
