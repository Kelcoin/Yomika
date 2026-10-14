//! Freeze a candidate before validation, and serialize all DLL installations.
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

static INSTALL: Mutex<()> = Mutex::new(());
static NEXT_CANDIDATE: AtomicU64 = AtomicU64::new(0);

struct CandidateDirectory(std::path::PathBuf);
impl Drop for CandidateDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn with_install_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = INSTALL.lock().map_err(|_| "DLL 安装事务不可用".to_string())?;
    operation()
}

pub fn run<T, P>(
    source: &Path,
    temporary_root: &Path,
    validate: impl FnOnce(&Path, &Path) -> Result<(), String>,
    probe: impl FnOnce(&Path) -> Result<P, String>,
    commit: impl FnOnce(&Path, &P) -> Result<T, String>,
) -> Result<(T, P), String> {
    with_install_lock(|| {
        std::fs::create_dir_all(temporary_root).map_err(|error| format!("建 DLL 验证目录失败：{error}"))?;
        let directory = loop {
            let path = temporary_root.join(format!("candidate-{}-{}", std::process::id(), NEXT_CANDIDATE.fetch_add(1, Ordering::Relaxed)));
            match std::fs::create_dir(&path) {
                Ok(()) => break CandidateDirectory(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("建 DLL 候选目录失败：{error}")),
            }
        };
        let candidate = directory.0.join("dlssnr").join("nvngx_dlssnr.dll");
        std::fs::create_dir_all(candidate.parent().expect("candidate parent"))
            .map_err(|error| format!("建 DLL 暂存目录失败：{error}"))?;
        std::fs::copy(source, &candidate).map_err(|error| format!("暂存 DLL 失败：{error}"))?;
        validate(&candidate, &directory.0)?;
        let report = probe(&directory.0)?;
        let installed = commit(&candidate, &report)?;
        Ok((installed, report))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("yomika-import-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn unknown_candidate_is_frozen_before_probe_and_success_commits_that_copy() {
        let fixture = Fixture::new();
        let source = fixture.0.join("custom.dll");
        let installed = fixture.0.join("installed.dll");
        fs::write(&source, b"unknown new version").unwrap();
        fs::write(&installed, b"old version").unwrap();
        let (version, verified) = run(&source, &fixture.0,
            |candidate, _| { assert_eq!(fs::read(candidate).unwrap(), b"unknown new version"); Ok(()) },
            |candidate_data| {
                let candidate = candidate_data.join("dlssnr").join("nvngx_dlssnr.dll");
                fs::write(&source, b"source changed during probe").unwrap();
                assert_eq!(fs::read(&installed).unwrap(), b"old version");
                assert_eq!(fs::read(&candidate).unwrap(), b"unknown new version");
                Ok(true)
            },
            |candidate, _| { fs::copy(candidate, &installed).unwrap(); Ok("311.0") },
        ).unwrap();
        assert_eq!(version, "311.0");
        assert!(verified);
        assert_eq!(fs::read(&installed).unwrap(), b"unknown new version");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2, "candidate directory must be cleaned");
    }

    #[test]
    fn failed_or_timed_out_probe_never_commits_and_cleans_candidate() {
        for reason in ["validation failed", "validation timed out"] {
            let fixture = Fixture::new();
            let source = fixture.0.join("custom.dll");
            let installed = fixture.0.join("installed.dll");
            fs::write(&source, b"new").unwrap();
            fs::write(&installed, b"old").unwrap();
            let result: Result<((), ()), _> = run(&source, &fixture.0,
                |_, _| Ok(()), |_| Err(reason.to_string()),
                |_, _| { fs::write(&installed, b"new").unwrap(); Ok(()) });
            assert_eq!(result.unwrap_err(), reason);
            assert_eq!(fs::read(&installed).unwrap(), b"old");
            assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
        }
    }

    #[test]
    fn static_rejection_never_runs_worker_or_commit() {
        let fixture = Fixture::new();
        let source = fixture.0.join("bad.dll");
        fs::write(&source, b"damaged DLL").unwrap();
        let result: Result<((), ()), _> = run(&source, &fixture.0,
            |_, _| Err("invalid PE/signature".to_string()),
            |_| panic!("invalid candidate must not execute"),
            |_, _| panic!("invalid candidate must not install"));
        assert_eq!(result.unwrap_err(), "invalid PE/signature");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_install_operations_are_serialized() {
        let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
        let handles: Vec<_> = (0..4).map(|_| {
            let active = active.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                with_install_lock(|| {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    std::thread::yield_now();
                    assert_eq!(active.fetch_sub(1, Ordering::SeqCst), 1);
                    Ok(())
                }).unwrap();
            })
        }).collect();
        barrier.wait();
        for handle in handles { handle.join().unwrap(); }
    }
}
