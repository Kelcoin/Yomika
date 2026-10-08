//! Windows 命名管道，双向重叠（异步）IO。
//!
//! 管道由宿主创建、worker 去连（docs/71 §6.1）。这个文件住在传输 crate 里，因为**两端
//! 用的是同一份代码**：宿主侧的 `server.rs` 建管道，worker 侧调 `connect`，两边都把
//! 句柄交给这里的 `PipeStream`。名字只允许 `[A-Za-z0-9_-]`：宿主给的是它自己生成的
//! 随机名，worker 顺手把「名字里塞路径」这条路堵死。
//!
//! peer 校验（管道对面的 PID 是不是本次 spawn 的宿主/worker）与 DACL 在调用方：宿主侧
//! 看 `server::Accepted::peer_pid`，worker 这边靠 `worker_epoch` 确认「对面找的就是我」。
//!
//! **为什么必须是重叠 IO**：Windows 对同一个文件对象上的同步 IO 是串行的，`try_clone()` /
//! `DuplicateHandle` 出来的第二份句柄仍指向同一个文件对象。worker 的会话线程只要在
//! `ReadFile` 上等着对端说话，另一个线程在同一个连接上的 `WriteFile` 就永远排不进去——
//! 双方互等，会话僵死。这不是 Rust 的锁（裸 `ReadFile`/`WriteFile` 一样卡），所以只能换
//! 重叠模式。实测见 `tests/pipe_probe.rs`：同步读在飞时同步写 2 秒内完不成；同一
//! 连接换成 `FILE_FLAG_OVERLAPPED` 之后，读还在飞时写 9.5µs 就完成了。

#[cfg(windows)]
mod imp {
    use std::io::{self, Read, Write};
    use std::sync::Arc;

    use windows::core::HSTRING;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, ERROR_IO_PENDING,
        ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
    use windows::Win32::System::Threading::{CreateEventW, ResetEvent};

    /// 管道名允许的字符：宿主生成的随机名只会有这些。
    fn valid_name(name: &str) -> bool {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    struct PipeInner {
        handle: HANDLE,
        /// 每个方向一个手动重置事件。读方向只有会话线程一个读者，写方向外面还有
        /// `Writer` 的互斥锁，所以一个方向一个事件就够。
        read_event: HANDLE,
        write_event: HANDLE,
    }

    // 句柄是内核对象句柄，跨线程使用是安全的；同一个方向上的并发调用由事件串行化。
    unsafe impl Send for PipeInner {}
    unsafe impl Sync for PipeInner {}

    impl Drop for PipeInner {
        fn drop(&mut self) {
            // 关掉自己的句柄；对端会因此看到 EOF。
            unsafe {
                let _ = CloseHandle(self.read_event);
                let _ = CloseHandle(self.write_event);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    /// 一条已连上的命名管道。`Clone` 出来的各份共享同一个句柄，可分别当读端与写端用。
    #[derive(Clone)]
    pub struct PipeStream {
        inner: Arc<PipeInner>,
    }

    impl PipeStream {
        /// 客户端：连上宿主已经建好的那条管道。
        pub fn connect(name: &str) -> io::Result<Self> {
            if !valid_name(name) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "管道名只允许字母、数字与 -_",
                ));
            }
            let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
            let handle = unsafe {
                CreateFileW(
                    &path,
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            }
            .map_err(last_error)?;
            Self::wrap(handle)
        }

        /// 宿主侧：把 `CreateNamedPipeW` 得到的那份句柄包进来。
        ///
        /// 句柄必须以重叠模式建出来（`PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED`）：
        /// 宿主一旦在等读，同步模式的连接就再也发不出 `cancel` 了。
        pub fn wrap(handle: HANDLE) -> io::Result<Self> {
            let read_event = unsafe { CreateEventW(None, true, false, None) }.map_err(last_error)?;
            let write_event = match unsafe { CreateEventW(None, true, false, None) } {
                Ok(event) => event,
                Err(error) => {
                    unsafe { let _ = CloseHandle(read_event); }
                    return Err(last_error(error));
                }
            };
            Ok(Self {
                inner: Arc::new(PipeInner {
                    handle,
                    read_event,
                    write_event,
                }),
            })
        }

        fn read_once(&self, buffer: &mut [u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let inner = &self.inner;
            unsafe { let _ = ResetEvent(inner.read_event); }
            let mut overlapped = OVERLAPPED {
                hEvent: inner.read_event,
                ..Default::default()
            };
            let mut read = 0u32;
            let started =
                unsafe { ReadFile(inner.handle, Some(buffer), Some(&mut read), Some(&mut overlapped)) };
            let outcome = match started {
                Ok(()) => Ok(read),
                Err(_) => {
                    // 一律用 GetLastError 取 Win32 错误码：windows-rs 的 `Error::code()` 是
                    // HRESULT，套到 `from_raw_os_error` 上就变成一个看不出所以然的数字。
                    let code = unsafe { GetLastError() };
                    if code == ERROR_IO_PENDING {
                        let mut done = 0u32;
                        unsafe {
                            GetOverlappedResult(inner.handle, &overlapped, &mut done, true)
                                .map(|()| done)
                                .map_err(last_error)
                        }
                    } else {
                        Err(io::Error::from_raw_os_error(code.0 as i32))
                    }
                }
            };
            match outcome {
                Ok(bytes) => Ok(bytes as usize),
                // 对端关掉管道（或已经读到底）就是干净的 EOF：`read_frame` 靠这个判会话结束。
                Err(error) if is_end_of_pipe(&error) => Ok(0),
                Err(error) => Err(error),
            }
        }

        fn write_once(&self, buffer: &[u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let inner = &self.inner;
            unsafe { let _ = ResetEvent(inner.write_event); }
            let mut overlapped = OVERLAPPED {
                hEvent: inner.write_event,
                ..Default::default()
            };
            let mut written = 0u32;
            let started = unsafe {
                WriteFile(
                    inner.handle,
                    Some(buffer),
                    Some(&mut written),
                    Some(&mut overlapped),
                )
            };
            match started {
                Ok(()) => Ok(written as usize),
                Err(_) => {
                    let code = unsafe { GetLastError() };
                    if code == ERROR_IO_PENDING {
                        let mut done = 0u32;
                        unsafe {
                            GetOverlappedResult(inner.handle, &overlapped, &mut done, true)
                                .map(|()| done as usize)
                                .map_err(last_error)
                        }
                    } else {
                        Err(io::Error::from_raw_os_error(code.0 as i32))
                    }
                }
            }
        }
    }

    impl Read for PipeStream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.read_once(buffer)
        }
    }

    impl Write for PipeStream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.write_once(buffer)
        }

        /// `write_all` 已经把整帧交给内核，这里没有用户态缓冲要推。千万别落成
        /// `FlushFileBuffers`：那对管道会等到对端把数据读干，等于把异步写又变回同步。
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn is_end_of_pipe(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error(),
            Some(code)
                if code == ERROR_BROKEN_PIPE.0 as i32
                    || code == ERROR_HANDLE_EOF.0 as i32
                    || code == ERROR_PIPE_NOT_CONNECTED.0 as i32
        )
    }

    fn last_error(error: windows::core::Error) -> io::Error {
        let code = unsafe { GetLastError() };
        if code.0 == 0 {
            io::Error::other(error.to_string())
        } else {
            io::Error::from_raw_os_error(code.0 as i32)
        }
    }
}

#[cfg(windows)]
pub use imp::PipeStream;

/// 现在只有 Windows 会 spawn worker（§5.2：移动端仍是有界的进程内 adapter）。留一个同名的
/// 空壳，是为了让跨目标 `cargo check` 也能过，而不是让非 Windows 目标上根本编不出来。
#[cfg(not(windows))]
#[derive(Clone)]
pub struct PipeStream;

#[cfg(not(windows))]
impl PipeStream {
    pub fn connect(_name: &str) -> std::io::Result<Self> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "worker 目前只支持 Windows 命名管道",
        ))
    }
}

#[cfg(not(windows))]
impl std::io::Read for PipeStream {
    fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "worker 目前只支持 Windows 命名管道",
        ))
    }
}

#[cfg(not(windows))]
impl std::io::Write for PipeStream {
    fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "worker 目前只支持 Windows 命名管道",
        ))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
