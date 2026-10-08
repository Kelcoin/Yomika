//! Heavy blocking workers must not compete at the UI thread's priority.
//! The guard restores a reused Tokio pool thread even when work panics.
#[cfg(windows)]
pub(super) struct WorkerPriority {
    previous: Option<i32>,
    // Must restore priority on the thread that entered, never after a Send.
    _thread_bound: std::marker::PhantomData<std::rc::Rc<()>>,
}
#[cfg(not(windows))]
pub(super) struct WorkerPriority;

impl WorkerPriority {
    pub fn enter() -> Self {
        #[cfg(windows)]
        {
            use windows::Win32::System::Threading::*;
            let previous = unsafe { GetThreadPriority(GetCurrentThread()) };
            let changed = previous != i32::MAX
                && previous > THREAD_PRIORITY_BELOW_NORMAL.0
                && unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) }
                    .is_ok();
            Self {
                previous: changed.then_some(previous),
                _thread_bound: std::marker::PhantomData,
            }
        }
        #[cfg(not(windows))]
        Self
    }
}
#[cfg(windows)]
impl Drop for WorkerPriority {
    fn drop(&mut self) {
        if let Some(previous) = self.previous {
            use windows::Win32::System::Threading::*;
            let _ = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(previous)) };
        }
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn worker_priority_is_lowered_and_restored_on_unwind() {
        std::thread::spawn(|| {
            use windows::Win32::System::Threading::*;
            let before = unsafe { GetThreadPriority(GetCurrentThread()) };
            let result = std::panic::catch_unwind(|| {
                let _guard = WorkerPriority::enter();
                assert!(unsafe { GetThreadPriority(GetCurrentThread()) } < before);
                panic!("test cleanup");
            });
            assert!(result.is_err());
            assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, before);
        })
        .join()
        .unwrap();
    }
}
