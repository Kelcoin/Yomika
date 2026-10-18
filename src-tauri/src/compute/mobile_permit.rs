use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
static BUSY: AtomicBool = AtomicBool::new(false);
pub fn is_busy() -> bool {
    BUSY.load(Ordering::Acquire)
}
pub struct Permit;
impl Permit {
    pub fn acquire() -> io::Result<Self> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "上一件移动端原生计算尚未退出；不能并发启动替代执行器",
                )
            })
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_execution_holds_permit_until_actual_exit() {
        let permit = Permit::acquire().unwrap();
        let (release, wait) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let _permit = permit;
            wait.recv().unwrap();
        });
        // A timed-out control session no longer owns the execution thread. A new
        // session must still be rejected until that thread really drops its engine.
        assert!(is_busy());
        assert_eq!(
            Permit::acquire().err().unwrap().kind(),
            io::ErrorKind::WouldBlock
        );
        release.send(()).unwrap();
        thread.join().unwrap();
        assert!(!is_busy());
        assert!(Permit::acquire().is_ok());
    }
}
