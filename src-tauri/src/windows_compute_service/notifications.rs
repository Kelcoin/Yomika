//! Local reload signals, handled by the unprivileged user compute host.
//! No settings or credentials cross this pipe; a connection requests a fresh DB
//! snapshot, and one byte acknowledges whether applying it succeeded.
use std::{io, path::Path, time::Duration};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions},
    runtime::{Builder, Runtime},
    sync::oneshot,
    time::{sleep, timeout},
};

fn pipe_name(data: &Path) -> io::Result<String> {
    let canonical = data.canonicalize()?.to_string_lossy().to_lowercase();
    Ok(format!(r"\\.\pipe\yomika-settings-{:x}", Sha256::digest(canonical.as_bytes())))
}

fn runtime() -> io::Result<Runtime> {
    Builder::new_current_thread().enable_all().build()
}

fn create_pipe(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    use windows::{core::HSTRING, Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES},
    }};
    let sid = yomika_compute_transport::server::current_user_sid()?;
    let sddl = HSTRING::from(format!("D:P(A;;GA;;;{sid})"));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&sddl, SDDL_REVISION_1, &mut descriptor, None) }
        .map_err(io::Error::other)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    // First-instance protection prevents silently connecting to an impostor.
    // The DACL admits only the host's user, never other users or SMB clients.
    let result = unsafe {
        ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true)
            .create_with_security_attributes_raw(name, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast())
    };
    unsafe { let _ = LocalFree(Some(HLOCAL(descriptor.0))); }
    result
}

pub(super) struct Listener {
    runtime: Runtime,
    pipe: NamedPipeServer,
    name: String,
}

impl Listener {
    /// Bind before the initial DB read, so saves racing startup cannot be lost.
    pub(super) fn bind(data: &Path) -> io::Result<Self> {
        let runtime = runtime()?;
        let name = pipe_name(data)?;
        let pipe = {
            let _entered = runtime.enter();
            create_pipe(&name, true)?
        };
        Ok(Self { runtime, pipe, name })
    }

    pub(super) fn run(self, mut stop: oneshot::Receiver<()>, mut reload: impl FnMut() -> bool) -> io::Result<()> {
        let Self { runtime, mut pipe, name } = self;
        runtime.block_on(async {
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stop => return Ok(()),
                    connected = pipe.connect() => connected?,
                }
                // Keep an instance available while applying the snapshot. Saves
                // arriving together queue here and each reloads the latest DB.
                let next = create_pipe(&name, false)?;
                let ack = u8::from(reload());
                let _ = timeout(Duration::from_millis(200), pipe.write_all(&[ack])).await;
                pipe = next;
            }
        })
    }
}

/// Bounded notification after commit. An absent/stopped service is normal.
/// The caller must release its DB lock before waiting for the acknowledgement.
pub(super) fn notify(data: &Path) -> io::Result<bool> {
    let name = pipe_name(data)?;
    runtime()?.block_on(async {
        timeout(Duration::from_secs(3), async {
            let mut client = loop {
                match ClientOptions::new().open(&name) {
                    Ok(client) => break client,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                    Err(error) if error.raw_os_error() == Some(231) => sleep(Duration::from_millis(40)).await, // ERROR_PIPE_BUSY
                    Err(error) => return Err(error),
                }
            };
            let mut ack = [0];
            client.read_exact(&mut ack).await?;
            if ack[0] == 1 { Ok(true) } else { Err(io::Error::other("Windows 后处理服务未能应用设置")) }
        }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Windows 后处理服务设置通知超时"))?
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};

    #[test]
    fn saves_reload_only_on_notification_and_stop_releases_endpoint() {
        let data = tempfile::tempdir().unwrap();
        let listener = Listener::bind(data.path()).unwrap();
        assert!(Listener::bind(data.path()).is_err());
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (stop, stopped) = oneshot::channel();
        let thread = std::thread::spawn(move || listener.run(stopped, || { calls.fetch_add(1, Ordering::SeqCst); true }));
        assert_eq!(count.load(Ordering::SeqCst), 0);
        for index in 0..4 { let result = notify(data.path()); assert!(result.is_ok(), "notification {index}: {result:?}"); assert!(result.unwrap()); }
        assert_eq!(count.load(Ordering::SeqCst), 4);
        stop.send(()).unwrap();
        thread.join().unwrap().unwrap();
        assert!(!notify(data.path()).unwrap());
        assert!(Listener::bind(data.path()).is_ok());
    }

    #[test]
    fn application_failure_is_acknowledged_without_hanging() {
        let data = tempfile::tempdir().unwrap();
        let listener = Listener::bind(data.path()).unwrap();
        let (stop, stopped) = oneshot::channel();
        let thread = std::thread::spawn(move || listener.run(stopped, || false));
        assert_eq!(notify(data.path()).unwrap_err().kind(), io::ErrorKind::Other);
        stop.send(()).unwrap();
        thread.join().unwrap().unwrap();
    }
}
