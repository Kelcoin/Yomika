//! Windows Job Object：把 worker 放进一个「句柄一关就整族一起死」的容器（docs/71 §8.3）。
//!
//! 为什么必须用 Job Object、而不是只 `Child::kill()`：worker 自己也可能拉起进程
//! （将来接 NCNN/ORT 的辅助进程），只杀直接的子进程会留下占着 GPU 的孤儿。
//! Job Object 让内核替我们收尾，`KILL_ON_JOB_CLOSE` 保证我们崩了、被强杀、忘了收拾，
//! 那些进程也一起走。
//!
//! 这里**不宣称**资源限制一定生效：宿主自己可能已经在别的 job 里，`AssignProcessToJobObject`
//! 会失败（§8.3 要求这种情况如实诊断、不假装限制已生效）。调用方拿 `assign` 的返回值决定。

/// 交给 Job Object 的限制。「软阈值」不在这里——那是调度器的策略（丢后台任务），
/// 不是内核限制；这里只放**硬**限制，因为超过它的后果是分配失败，必须由 worker 处理。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobLimits {
    /// 整族的提交上限。超过之后族内任何分配失败——这是硬阈值，不是提醒。
    pub memory_bytes: Option<u64>,
    /// 关掉最后一个句柄时是否连族一起终止。生产环境**必须**是 true。
    pub kill_on_close: bool,
}

impl Default for JobLimits {
    fn default() -> Self {
        Self {
            memory_bytes: None,
            kill_on_close: true,
        }
    }
}

/// 内核里那份限制信息读回来的样子（用来核对我们真的设进去了）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueriedLimits {
    pub memory_bytes: Option<u64>,
    pub kill_on_close: bool,
}

#[cfg(windows)]
mod imp {
    use super::{JobLimits, QueriedLimits};
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_JOB_MEMORY,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct JobObject {
        handle: HANDLE,
    }

    // 内核句柄可以在任意线程上用：把它标成 Send/Sync 是准确的，而不是图方便。
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl Drop for JobObject {
        fn drop(&mut self) {
            // 关句柄就是这套机制的本体：KILL_ON_JOB_CLOSE 在这一刻收走整族。
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    fn to_wide(name: &str) -> Vec<u16> {
        name.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl JobObject {
        pub fn create(name: Option<&str>, limits: JobLimits) -> io::Result<Self> {
            let wide = name.map(to_wide);
            let name_ptr = wide
                .as_ref()
                .map(|w| PCWSTR(w.as_ptr()))
                .unwrap_or(PCWSTR::null());
            let handle = unsafe { CreateJobObjectW(None, name_ptr) }
                .map_err(|error| io::Error::other(format!("CreateJobObjectW 失败：{error}")))?;
            let job = Self { handle };

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            if limits.kill_on_close {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            }
            if let Some(bytes) = limits.memory_bytes {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = bytes as usize;
            }
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            unsafe {
                SetInformationJobObject(
                    job.handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    size,
                )
            }
            .map_err(|error| io::Error::other(format!("SetInformationJobObject 失败：{error}")))?;
            Ok(job)
        }

        pub fn handle(&self) -> HANDLE {
            self.handle
        }

        /// 把进程收进这个 job。失败必须原样告诉调用方：**不设限制**和**设了没生效**
        /// 是两件完全不同的事，界面上要分得开。
        pub fn assign(&self, child: &Child) -> Result<(), String> {
            let process = HANDLE(child.as_raw_handle());
            unsafe { AssignProcessToJobObject(self.handle, process) }
                .map_err(|error| format!("AssignProcessToJobObject 失败（进程可能已在别的 job 里）：{error}"))
        }

        pub fn contains(&self, child: &Child) -> bool {
            let process = HANDLE(child.as_raw_handle());
            let mut inside = windows::core::BOOL::default();
            let ok = unsafe { IsProcessInJob(process, Some(self.handle), &mut inside) };
            ok.is_ok() && inside.as_bool()
        }

        pub fn terminate(&self) -> io::Result<()> {
            unsafe { TerminateJobObject(self.handle, 1) }
                .map_err(|error| io::Error::other(format!("TerminateJobObject 失败：{error}")))
        }

        pub fn query_limits(&self) -> io::Result<QueriedLimits> {
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let mut written = 0u32;
            unsafe {
                QueryInformationJobObject(
                    Some(self.handle),
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    size,
                    Some(&mut written),
                )
            }
            .map_err(|error| io::Error::other(format!("QueryInformationJobObject 失败：{error}")))?;
            let flags = info.BasicLimitInformation.LimitFlags;
            Ok(QueriedLimits {
                memory_bytes: if flags.contains(JOB_OBJECT_LIMIT_JOB_MEMORY) {
                    Some(info.JobMemoryLimit as u64)
                } else {
                    None
                },
                kill_on_close: flags.contains(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE),
            })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{JobLimits, QueriedLimits};
    use std::io;
    use std::process::Child;

    pub struct JobObject;

    impl JobObject {
        pub fn create(_name: Option<&str>, _limits: JobLimits) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Job Object 只在 Windows 有意义；移动端不做进程外计算",
            ))
        }

        pub fn assign(&self, _child: &Child) -> Result<(), String> {
            Err("Job Object 只在 Windows 有意义".to_string())
        }

        pub fn contains(&self, _child: &Child) -> bool {
            false
        }

        pub fn terminate(&self) -> io::Result<()> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "只在 Windows"))
        }

        pub fn query_limits(&self) -> io::Result<QueriedLimits> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "只在 Windows"))
        }
    }
}

pub use imp::JobObject;

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// 一个会活很久、不碰 GPU、不需要控制台的子进程。
    fn long_lived_child() -> Child {
        Command::new("ping")
            .args(["-n", "600", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("ping 是系统自带的")
    }

    fn wait_until_dead(child: &mut Child, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(None) => return false,
                Err(error) => panic!("try_wait 失败：{error}"),
            }
        }
    }

    /// 关掉最后一个句柄时整族一起走——这就是「不制造 GPU 孤儿」的本体。
    #[test]
    fn closing_the_last_handle_kills_the_whole_family() {
        let mut child = long_lived_child();
        {
            let job = JobObject::create(
                Some("yomika-job-object-test-close"),
                JobLimits::default(),
            )
            .expect("建 job");
            job.assign(&child).expect("收进 job");
            assert!(job.contains(&child), "刚收进去的进程应该在 job 里");
            assert!(!wait_until_dead(&mut child, Duration::from_millis(50)));
        }
        assert!(
            wait_until_dead(&mut child, Duration::from_secs(5)),
            "job 句柄关掉之后子进程还活着"
        );
    }

    /// 硬限制要真的进内核、而且要能读回来核对；不核对的限制等于没设。
    #[test]
    fn a_hard_memory_limit_is_set_in_the_kernel_and_reads_back() {
        let limit = 64 * 1024 * 1024;
        let job = JobObject::create(
            Some("yomika-job-object-test-limit"),
            JobLimits {
                memory_bytes: Some(limit),
                kill_on_close: true,
            },
        )
        .expect("建 job");
        let queried = job.query_limits().expect("读限制");
        assert_eq!(queried.memory_bytes, Some(limit));
        assert!(queried.kill_on_close);
    }

    /// 给一个已经退出的进程分配 job 会失败——失败必须变成可读的字符串，
    /// 而不是 panic 或者一句「限制已生效」。
    #[test]
    fn assigning_a_dead_process_reports_a_diagnostic() {
        let job = JobObject::create(Some("yomika-job-object-test-dead"), JobLimits::default())
            .expect("建 job");
        let mut child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("cmd 是系统自带的");
        let _ = child.wait();
        let error = job.assign(&child).expect_err("死进程不该被收进 job");
        assert!(
            error.contains("AssignProcessToJobObject"),
            "诊断里要说清是哪一步失败：{error}"
        );
    }
}
