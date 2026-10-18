//! Mobile uses the existing framed worker protocol inside this process.
//! The permit belongs to the engine, not its control thread: protocol shutdown can
//! return while a native call is still executing on the detached executor.
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use yomika_compute_protocol::BuildInfo;
use yomika_compute_worker::engine::{EchoEngine, Engine, StageError, StageOutput, StageRequest};
use yomika_compute_worker::pipeline::PipelineEngine;
use yomika_compute_worker::protocol::{run, SessionOptions};

pub const LIMITS_NOTE: &str = "移动端进程内串行计算；无进程内存硬限制。取消在分块边界生效，原生调用不能强杀；超时丢弃迟到结果，旧执行退出前不启动新计算。原生驱动崩溃可能终止应用。";
pub use super::mobile_permit::is_busy;
use super::mobile_permit::Permit;
struct GuardedEngine {
    inner: Box<dyn Engine>,
    _permit: Permit,
}
impl Engine for GuardedEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        self.inner.execute(request)
    }
    fn release_cached_models(&self) -> u32 {
        self.inner.release_cached_models()
    }
}

pub struct Stream(UnixStream);
impl Clone for Stream {
    fn clone(&self) -> Self {
        Self(self.0.try_clone().expect("clone local worker socket"))
    }
}
impl Stream {
    pub fn shutdown(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}
impl Read for Stream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl Write for Stream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}
pub struct Child {
    finished: Arc<AtomicBool>,
}
impl Child {
    pub fn id(&self) -> u32 {
        std::process::id()
    }
    pub fn try_wait(&mut self) -> io::Result<Option<String>> {
        Ok(self
            .finished
            .load(Ordering::Acquire)
            .then(|| "mobile session ended".into()))
    }
}
pub fn spawn(
    epoch: String,
    nonce: u64,
    staging_root: PathBuf,
    input_root: PathBuf,
    echo: bool,
) -> io::Result<(Child, Stream)> {
    let permit = Permit::acquire()?;
    static PROFILE_SETUP: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    PROFILE_SETUP
        .get_or_init(|| {
            let root = staging_root
                .parent()
                .ok_or_else(|| "staging root has no parent".to_string())?;
            yomika_compute_core::runtime::set_profile_directory(root.join("runtime-profiles"))
        })
        .clone()
        .map_err(io::Error::other)?;
    // The permit proves the previous detached executor has stopped writing.
    // Do this before the new executor exists, never at timeout while it can write.
    let _ = crate::compute::artifacts::sweep_staging(&staging_root, std::time::Duration::ZERO);
    let (host, worker) = UnixStream::pair()?;
    // Unix sockets provide bounded kernel buffers and private, unnamed endpoints.
    let reader = worker.try_clone()?;
    let finished = Arc::new(AtomicBool::new(false));
    let done = finished.clone();
    thread::Builder::new()
        .name("yomika-mobile-worker".into())
        .spawn(move || {
            let engine: Box<dyn Engine> = if echo {
                Box::new(EchoEngine::default())
            } else {
                Box::new(PipelineEngine::new(input_root.clone()))
            };
            let build = BuildInfo {
                version: env!("CARGO_PKG_VERSION").into(),
                runtimes: if echo {
                    vec![]
                } else {
                    yomika_compute_core::runtime::available_runtimes()
                        .into_iter()
                        .map(|id| id.as_str().into())
                        .collect()
                },
                engines: if echo {
                    vec!["echo".into()]
                } else {
                    vec![
                        "onnx".into(),
                        yomika_compute_protocol::ANIME4K_ENGINE_ID.into(),
                    ]
                },
                model_formats: vec!["onnx".into()],
                commit: yomika_compute_worker::BUILD_COMMIT.into(),
            };
            let _ = run(
                reader,
                worker,
                GuardedEngine {
                    inner: engine,
                    _permit: permit,
                },
                SessionOptions {
                    worker_epoch: epoch,
                    nonce,
                    staging_root,
                    input_root,
                    build,
                    log_budget: 64 * 1024,
                    release_workspaces: || 0,
                },
            );
            done.store(true, Ordering::Release);
        })?;
    Ok((Child { finished }, Stream(host)))
}
