//! 宿主侧的命名管道端点（docs/71 §6.1）。
//!
//! 方向是固定的：**宿主建管道、worker 去连**。这样 worker 不需要任何权限就能找到宿主，
//! 而宿主能挑一个别人猜不到的名字，并用 `FILE_FLAG_FIRST_PIPE_INSTANCE` 保证「第一条同名
//! 管道」是自己建的——抢注者拿不到这个名字。
//!
//! 三道门都是必需的，缺一条就等于把控制面挂在别人能连上的地方：
//!
//! 1. **名字随机**（`random_name()`，进程内计数器 + 纳秒时间 + PID）。管道名是全局命名
//!    空间，可猜的名字等于可连接的端口。
//! 2. **DACL 只放当前登录用户**（SDDL `D:P(A;;GA;;;<SID>)`）。默认 DACL 会给
//!    `Everyone` 和 `Authenticated Users`，那是给「同机任何进程都能连」留的后门。
//! 3. **`PIPE_REJECT_REMOTE_CLIENTS`** 顺带堵掉远程 SMB 路径，不指望 DACL 单独扛。
//!
//! 连接建好后由调用方核对「对面这个 PID 是不是我 spawn 的 worker」（`Accepted::peer_pid`）
//! 与协议 nonce（§6.1）。这里只如实报出 PID，不替调用方做判断。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use windows::core::{BOOL, HSTRING, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, HANDLE,
        HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
        SE_KERNEL_OBJECT,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject,
    };

    use crate::pipe::PipeStream;
    use super::PIPE_BUFFER_BYTES;

    /// 一条已经连上的管道，外加它是谁连上来的。
    pub struct Accepted {
        /// 双向字节流（重叠 IO，见 `pipe.rs`）。
        pub stream: PipeStream,
        /// 管道对面的进程 ID。调用方必须拿它和本次 spawn 的 worker 比对（§6.1）：
        /// 名字与 DACL 只保证「同机同用户」，不保证「就是我们起的那个进程」。
        pub peer_pid: u32,
    }

    /// 一条还没接上人的管道服务端。
    pub struct PipeServer {
        handle: HANDLE,
        name: String,
    }

    // 内核句柄可以在任意线程上用；把它标成 Send/Sync 是准确的，而不是图方便。
    unsafe impl Send for PipeServer {}
    unsafe impl Sync for PipeServer {}

    impl Drop for PipeServer {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    fn win32_error(what: &str) -> io::Error {
        // 一律用 GetLastError 取 Win32 错误码：windows-rs 的 `Error::code()` 是 HRESULT，
        // 套到 `from_raw_os_error` 上会变成一个看不出所以然的数字。
        let code = unsafe { GetLastError() };
        io::Error::new(
            io::Error::from_raw_os_error(code.0 as i32).kind(),
            format!("{what} 失败（Win32 错误 {}）", code.0),
        )
    }

    /// 管道名。它落在全局命名空间里，所以必须不可猜：纳秒时间 + 进程内自增 + PID。
    fn random_name() -> String {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let ticks = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        format!(
            "yomika-compute-{ticks:016x}-{:08x}-{sequence:04x}",
            std::process::id()
        )
    }

    /// 当前登录用户的 SID 字符串（`S-1-5-...`）。DACL 只认这一条身份。
    pub fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|error| io::Error::other(format!("OpenProcessToken 失败：{error}")))?;
            let result = (|| -> io::Result<String> {
                let mut size = 0u32;
                // 第一次调用故意不成功：只为问「要多大缓冲区」。
                let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
                if size == 0 {
                    return Err(win32_error("GetTokenInformation（问长度）"));
                }
                let mut buffer = vec![0u8; size as usize];
                GetTokenInformation(
                    token,
                    TokenUser,
                    Some(buffer.as_mut_ptr() as *mut c_void),
                    size,
                    &mut size,
                )
                .map_err(|error| io::Error::other(format!("GetTokenInformation 失败：{error}")))?;
                let user = &*(buffer.as_ptr() as *const TOKEN_USER);
                let mut sid = PWSTR::null();
                ConvertSidToStringSidW(user.User.Sid, &mut sid)
                    .map_err(|error| io::Error::other(format!("ConvertSidToStringSidW 失败：{error}")))?;
                let text = sid
                    .to_string()
                    .map_err(|error| io::Error::other(format!("SID 不是合法 UTF-16：{error:?}")));
                let _ = LocalFree(Some(HLOCAL(sid.0 as *mut c_void)));
                text
            })();
            let _ = CloseHandle(token);
            result
        }
    }

    /// SDDL → 安全描述符。调用方负责 `LocalFree` 返回的指针。
    fn descriptor_from_sddl(sddl: &str) -> io::Result<PSECURITY_DESCRIPTOR> {
        let wide = HSTRING::from(sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &wide,
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(|error| io::Error::other(format!("解析 SDDL 失败：{error}")))?;
        Ok(descriptor)
    }

    impl PipeServer {
        pub fn create() -> io::Result<Self> {
            let name = random_name();
            let sid = current_user_sid()?;
            // `D:P`：DACL 是保护态，不给继承进来的 ACE 留位置。
            // 唯一一条 ACE：当前用户全权。别人（包括同机的其他用户）连不上。
            let sddl = format!("D:P(A;;GA;;;{sid})");
            let descriptor = descriptor_from_sddl(&sddl)?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                // 不继承：worker 要拿的是我们显式传过去的那个句柄，不是顺手继承来的一堆。
                bInheritHandle: BOOL(0),
            };
            let path = HSTRING::from(format!(r"\\.\pipe\{name}"));
            let handle = unsafe {
                CreateNamedPipeW(
                    &path,
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    // PIPE_WAIT 与重叠 IO 不冲突：同步调用会阻塞，但我们所有调用都带 OVERLAPPED。
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    // 只有一条实例：同一个 worker 不该有第二条连接。
                    1,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    Some(&attributes),
                )
            };
            unsafe {
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            }
            if handle == INVALID_HANDLE_VALUE {
                return Err(win32_error("CreateNamedPipeW"));
            }
            Ok(Self { handle, name })
        }

        /// 管道名（不含 `\\.\pipe\` 前缀）。spawn worker 时通过参数交给它。
        pub fn name(&self) -> &str {
            &self.name
        }

        /// 读回内核里那条 DACL 的样子（SDDL）。
        ///
        /// 存在的理由是：DACL 是「设了但没生效」最容易发生的地方（句柄继承、默认 DACL、
        /// 传错属性指针都会静默地给你一份宽松 ACL），所以要有办法把内核里那份读出来核对，
        /// 而不是相信代码注释。
        pub fn dacl_sddl(&self) -> io::Result<String> {
            unsafe {
                let mut descriptor = PSECURITY_DESCRIPTOR::default();
                GetSecurityInfo(
                    self.handle,
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    None,
                    None,
                    None,
                    None,
                    Some(&mut descriptor),
                )
                .ok()
                .map_err(|error| {
                    io::Error::other(format!("GetSecurityInfo 失败：{error}"))
                })?;
                let mut text = PWSTR::null();
                let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    None,
                );
                let result = match converted {
                    Ok(()) => text
                        .to_string()
                        .map_err(|error| io::Error::other(format!("SDDL 不是合法 UTF-16：{error:?}"))),
                    Err(error) => Err(io::Error::other(format!(
                        "ConvertSecurityDescriptorToStringSecurityDescriptorW 失败：{error}"
                    ))),
                };
                let _ = LocalFree(Some(HLOCAL(descriptor.0)));
                if !text.is_null() {
                    let _ = LocalFree(Some(HLOCAL(text.0 as *mut c_void)));
                }
                result
            }
        }

        /// 等 worker 连上来，最多等 `timeout`。
        ///
        /// 成功时这条管道（连同它的句柄）归 `Accepted::stream` 所有；失败或超时时管道被
        /// 关掉——这个对象是消费型的，重试必须重新 `create`（名字就该换一个）。
        ///
        /// 超时用 `CancelIoEx` 收尾：重叠的 `ConnectNamedPipe` 还在内核里挂着，不取消就
        /// 关句柄，那个挂起的 IRP 会一直吊着直到有别人连上这个（已经不存在的）名字。
        pub fn accept(self, timeout: Duration) -> io::Result<Accepted> {
            let handle = self.handle;
            let event = unsafe { CreateEventW(None, true, false, None) }
                .map_err(|error| io::Error::other(format!("CreateEventW 失败：{error}")))?;
            let outcome = (|| -> io::Result<()> {
                let mut overlapped = OVERLAPPED {
                    hEvent: event,
                    ..Default::default()
                };
                match unsafe { ConnectNamedPipe(handle, Some(&mut overlapped)) } {
                    // 少数情况下调用时对面已经连上了，这里同步返回成功。
                    Ok(()) => Ok(()),
                    Err(_) => {
                        let code = unsafe { GetLastError() };
                        if code == ERROR_PIPE_CONNECTED {
                            // 早在我们调用之前就连上了：这就是成功。
                            return Ok(());
                        }
                        if code != ERROR_IO_PENDING {
                            return Err(io::Error::new(
                                io::Error::from_raw_os_error(code.0 as i32).kind(),
                                format!("ConnectNamedPipe 失败（Win32 错误 {}）", code.0),
                            ));
                        }
                        let millis = timeout.as_millis().min(u32::MAX as u128) as u32;
                        match unsafe { WaitForSingleObject(event, millis) } {
                            WAIT_OBJECT_0 => {
                                let mut transferred = 0u32;
                                unsafe {
                                    GetOverlappedResult(
                                        handle,
                                        &overlapped,
                                        &mut transferred,
                                        false,
                                    )
                                }
                                .map_err(|_| win32_error("GetOverlappedResult（连接）"))
                            }
                            WAIT_TIMEOUT => {
                                unsafe {
                                    let _ = CancelIoEx(handle, Some(&overlapped));
                                }
                                Err(io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    format!("等 worker 连接超时（{} ms）", timeout.as_millis()),
                                ))
                            }
                            other => {
                                unsafe {
                                    let _ = CancelIoEx(handle, Some(&overlapped));
                                }
                                Err(io::Error::other(format!(
                                    "等 worker 连接时拿到 WAIT_EVENT {}",
                                    other.0
                                )))
                            }
                        }
                    }
                }
            })();
            unsafe {
                let _ = CloseHandle(event);
            }
            outcome?;

            let stream = PipeStream::wrap(handle)
                .map_err(|error| io::Error::other(format!("包装已连接的管道失败：{error}")))?;
            let mut peer_pid = 0u32;
            unsafe { GetNamedPipeClientProcessId(handle, &mut peer_pid) }
                .map_err(|error| io::Error::other(format!("GetNamedPipeClientProcessId 失败：{error}")))?;
            // 句柄已经交给 stream；忘了这个对象，否则 Drop 会把 stream 正在用的句柄关掉。
            std::mem::forget(self);
            Ok(Accepted {
                stream,
                peer_pid,
            })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::time::Duration;

    use crate::pipe::PipeStream;

    pub struct Accepted {
        pub stream: PipeStream,
        pub peer_pid: u32,
    }

    pub struct PipeServer;

    impl PipeServer {
        pub fn create() -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "命名管道只在 Windows 上存在；移动端不做进程外计算",
            ))
        }

        pub fn name(&self) -> &str {
            ""
        }

        pub fn dacl_sddl(&self) -> io::Result<String> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "只在 Windows"))
        }

        pub fn accept(self, _timeout: Duration) -> io::Result<Accepted> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "只在 Windows"))
        }
    }

    pub fn current_user_sid() -> io::Result<String> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "只在 Windows"))
    }
}

pub use imp::{current_user_sid, Accepted, PipeServer};

/// 管道缓冲区大小，也是协议单帧的上限（§6.2：帧体 ≤ 64 KiB）。
pub const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::pipe::PipeStream;

    use std::thread;
    use std::time::{Duration, Instant};

    use windows::core::HSTRING;
    use windows::Win32::Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    /// 名字随机 + 首实例标志的合体含义：第二条同名管道建不出来。
    #[test]
    fn a_second_instance_of_the_same_name_is_refused() {
        let server = PipeServer::create().expect("建服务端");
        let path = HSTRING::from(format!(r"\\.\pipe\{}", server.name()));
        let second = unsafe {
            CreateNamedPipeW(
                &path,
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                None,
            )
        };
        assert_eq!(
            second, INVALID_HANDLE_VALUE,
            "FILE_FLAG_FIRST_PIPE_INSTANCE 没挡住第二条同名管道"
        );
        // 实测这里 Windows 给的是 231（ERROR_PIPE_BUSY，第一条实例还没接人），不是文档里
        // 常写的 5（ERROR_ACCESS_DENIED）。两者都表示「这个名字已经归别人了」，所以
        // 断言的是这件事，而不是某一个具体错误码。
        let code = unsafe { GetLastError() };
        assert!(
            code == ERROR_PIPE_BUSY || code == ERROR_ACCESS_DENIED,
            "第二条同名管道失败的原因应是「名字已被占用」，实际 {code:?}"
        );
    }

    /// DACL 必须只认当前用户，而且要是保护态（不继承）。默认 DACL 会给 Everyone。
    #[test]
    fn the_dacl_names_only_the_current_user() {
        let server = PipeServer::create().expect("建服务端");
        let sid = current_user_sid().expect("取当前用户 SID");
        assert!(sid.starts_with("S-1-"), "SID 长得不对：{sid}");
        let sddl = server.dacl_sddl().expect("读 DACL");
        assert!(
            sddl.starts_with("D:P"),
            "DACL 不是保护态，继承来的 ACE 会溜进来：{sddl}"
        );
        assert!(sddl.contains(&sid), "DACL 里没有当前用户 {sid}：{sddl}");
        for wide in [";;;WD)", ";;;AU)", ";;;BU)"] {
            assert!(
                !sddl.contains(wide),
                "DACL 把 {wide} 放进来了，同机其他进程也能连：{sddl}"
            );
        }
    }

    /// 有人连上时能接住，并如实报出对面就是连上来的那个进程。
    #[test]
    fn a_server_accepts_a_client_and_reports_its_pid() {
        let server = PipeServer::create().expect("建服务端");
        let name = server.name().to_string();
        // 客户端跑在另一个线程里：这样「客户端先连上、宿主后 accept」这条分支
        // （ERROR_PIPE_CONNECTED）真的会被走到。
        let client = thread::spawn(move || PipeStream::connect(&name));
        let accepted = server.accept(Duration::from_secs(5)).expect("接住客户端");
        let _client = client.join().expect("客户端线程").expect("客户端连上");
        assert_eq!(
            accepted.peer_pid,
            std::process::id(),
            "对面就是发起连接的这个进程"
        );
    }

    /// 没人连的时候必须按时超时返回，而不是把调用线程挂在 `ConnectNamedPipe` 里。
    #[test]
    fn nobody_connecting_times_out_without_hanging() {
        let server = PipeServer::create().expect("建服务端");
        let started = Instant::now();
        // 不用 `expect_err`：`Accepted` 里装着不可 Debug 的管道，手写匹配更直接。
        let error = match server.accept(Duration::from_millis(200)) {
            Ok(_) => panic!("没人连就不该接上"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "超时之后没有及时返回：{:?}",
            started.elapsed()
        );
    }
}
