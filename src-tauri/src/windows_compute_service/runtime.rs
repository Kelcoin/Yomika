//! SCM supervises a GUI-less host under the installing user's existing token.
//! No user DLL or model is ever evaluated by the privileged service process.
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, SystemTime},
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, WAIT_OBJECT_0},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_USER,
        },
        System::{
            Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock},
            RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken},
            Threading::{
                CreateProcessAsUserW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
                CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
            },
        },
    },
};

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(Some(0)).collect()
}
fn owner_token() -> Result<Option<(u32, OwnedHandle)>, String> {
    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == u32::MAX {
        return Ok(None);
    }
    let mut token = HANDLE::default();
    if unsafe { WTSQueryUserToken(session, &mut token) }.is_err() {
        return Ok(None);
    }
    let token = OwnedHandle(token);
    let mut size = 0;
    unsafe {
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut size);
    }
    if size == 0 {
        return Err("无法读取服务用户身份".into());
    }
    // TOKEN_USER needs pointer alignment, not the alignment of a byte vector.
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            size,
            &mut size,
        )
        .map_err(|e| e.to_string())?;
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid).map_err(|e| e.to_string())?;
        let text = sid.to_string().map_err(|e| e.to_string());
        let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
        if text? != super::configuration()?.owner {
            return Ok(None);
        }
    }
    Ok(Some((session, token)))
}
fn marker(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效的服务运行标识".into());
    }
    Ok(super::directory()?
        .join("runtime")
        .join(format!("runtime-{id}")))
}

fn refresh_heartbeat(path: &std::path::Path) -> std::io::Result<()> {
    // Rust's empty fs::write does not update LastWriteTime on Windows when an
    // existing empty file is opened. The host otherwise expires after 20s even
    // while its controller is healthy, aborting every in-flight HTTP request.
    std::fs::write(path, b"alive")
}
struct Runtime {
    process: OwnedHandle,
    session: u32,
    heartbeat: PathBuf,
}
impl Runtime {
    fn start(session: u32, token: OwnedHandle) -> Result<Self, String> {
        let id = format!(
            "{:x}{:x}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        );
        let heartbeat = marker(&id)?;
        std::fs::create_dir_all(heartbeat.parent().unwrap()).map_err(|e| e.to_string())?;
        refresh_heartbeat(&heartbeat).map_err(|e| e.to_string())?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = wide(exe.as_os_str());
        let directory = wide(exe.parent().unwrap().as_os_str());
        let mut command = wide(std::ffi::OsStr::new(&format!(
            "\"{}\" --compute-service-host {id}",
            exe.display()
        )));
        let mut environment = std::ptr::null_mut();
        unsafe { CreateEnvironmentBlock(&mut environment, Some(token.0), false) }
            .map_err(|e| e.to_string())?;
        let mut desktop = wide(std::ffi::OsStr::new("winsta0\\default"));
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        let result = unsafe {
            CreateProcessAsUserW(
                Some(token.0),
                PCWSTR(path.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                Some(environment),
                PCWSTR(directory.as_ptr()),
                &startup,
                &mut info,
            )
        };
        unsafe {
            let _ = DestroyEnvironmentBlock(environment);
        }
        result.map_err(|e| format!("启动独立处理进程失败：{e}"))?;
        unsafe {
            let _ = CloseHandle(info.hThread);
        }
        Ok(Self {
            process: OwnedHandle(info.hProcess),
            session,
            heartbeat,
        })
    }
    fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) != WAIT_OBJECT_0 }
    }
    fn stop(&self) {
        let _ = std::fs::write(self.heartbeat.with_extension("stop"), b"");
        unsafe {
            if WaitForSingleObject(self.process.0, 12_000) != WAIT_OBJECT_0 {
                let _ = TerminateProcess(self.process.0, 1);
                let _ = WaitForSingleObject(self.process.0, 2_000);
            }
        }
        let _ = std::fs::remove_file(&self.heartbeat);
        let _ = std::fs::remove_file(self.heartbeat.with_extension("stop"));
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(super) fn control(
    rx: &mpsc::Receiver<()>,
    started: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut runtime: Option<Runtime> = None;
    started()?;
    loop {
        let token = owner_token()?;
        let desired = token.as_ref().map(|(session, _)| *session);
        if runtime
            .as_ref()
            .is_some_and(|r| Some(r.session) != desired || !r.alive())
        {
            runtime.take();
        }
        if runtime.is_none() {
            if let Some((session, token)) = token {
                runtime = Some(Runtime::start(session, token)?);
            }
        }
        if let Some(runtime) = &runtime {
            refresh_heartbeat(&runtime.heartbeat).map_err(|e| e.to_string())?;
        }
        if !matches!(
            rx.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            break;
        }
    }
    Ok(())
}

pub(super) fn host(id: &str) -> Result<(), String> {
    if yomika_compute_transport::server::current_user_sid().map_err(|e| e.to_string())?
        != super::configuration()?.owner
    {
        return Err("处理进程的 Windows 用户不匹配".into());
    }
    let heartbeat = marker(id)?;
    let (tx, rx) = mpsc::channel();
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    let watcher = std::thread::spawn(move || {
        while !finished.load(Ordering::Relaxed) {
            let fresh = std::fs::metadata(&heartbeat)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < Duration::from_secs(20));
            if !fresh || heartbeat.with_extension("stop").exists() {
                let _ = tx.send(());
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
    let result = super::serve_until_stopped(&rx, || Ok(()));
    done.store(true, Ordering::Relaxed);
    let _ = watcher.join();
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn refreshing_an_existing_heartbeat_updates_its_timestamp() {
        let path = std::env::temp_dir().join(format!("yomika-heartbeat-{}", std::process::id()));
        super::refresh_heartbeat(&path).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old)).unwrap();
        super::refresh_heartbeat(&path).unwrap();
        let age = std::fs::metadata(&path).unwrap().modified().unwrap().elapsed().unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(age < std::time::Duration::from_secs(5), "heartbeat remained stale: {age:?}");
    }

    #[test]
    fn a_runtime_identifier_cannot_escape_its_directory() {
        for id in ["", "../other", "abc/def", "x", &"a".repeat(65)] {
            assert!(super::marker(id).is_err());
        }
    }
}
