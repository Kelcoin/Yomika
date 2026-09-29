//! 阅读器推理任务的取消牌。
//!
//! 前端的 `AbortSignal` 只能说明「这个结果我不要了」：原生那一侧照旧把整页跑完
//! （一页 4K 在 CPU 上是十几秒），而全局只允许一件重活，于是切页、关开关之后，
//! 用户真正要看的那一页排在旧任务后面等。
//!
//! 每页一个任务号：前端排队时登记，离开阅读器 / 换开关 / 切页时取消。Rust 在
//! 几个循环之间各查一次——超分的 tile 之间、去码的检测框之间、DLSSNR 的 pass
//! 之间——这样一次取消最多让当前这一小块跑完，而不是整页。
//!
//! 取消是**一次性**的：任务号在任务结束时从表里摘掉。晚到的取消（前端先 abort
//! 再发出请求，或请求还堵在全局闸外面）记进一张有上限的待取消表，登记时立刻
//! 带上，不然那次取消会白丢。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 待取消表的容量：任务号是每页几个、带 generation 的短字符串，真会堆积说明
/// 前端在取消一批根本没发出去的号；有上限就不会把它变成一块只涨不落的内存。
const MAX_PENDING_CANCELS: usize = 256;

#[derive(Clone, Default)]
pub struct CancelToken(Option<Arc<AtomicBool>>);

impl CancelToken {
    /// 一个永远不取消的牌：任务号缺省、或者这条路径没有取消点。
    pub fn none() -> Self {
        Self(None)
    }

    pub fn cancelled(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    /// 到取消点就返回 `Cancelled`。循环与循环之间各调一次。
    pub fn check(&self) -> Result<(), crate::inference::InferenceError> {
        if self.cancelled() {
            return Err(crate::inference::InferenceError::Cancelled);
        }
        Ok(())
    }
}

struct Registry {
    live: HashMap<String, Arc<AtomicBool>>,
    pending: HashSet<String>,
    pending_order: VecDeque<String>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            live: HashMap::new(),
            pending: HashSet::new(),
            pending_order: VecDeque::new(),
        })
    })
}

/// 一个已登记的任务：活着的时候 `token()` 能看见取消，析构时自动摘号。
pub struct TaskGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl TaskGuard {
    pub fn token(&self) -> CancelToken {
        CancelToken(Some(Arc::clone(&self.flag)))
    }

    /// 同一张牌的共享句柄：给不接受 `CancelToken` 的调用点（`UpscaleOptions`
    /// 里那一格）。
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.flag)
    }

    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

impl Drop for TaskGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = registry().lock() {
            // 只摘自己那一张：同一个任务号被重新登记时（同一页重跑），旧 guard
            // 的析构不能把新任务的牌拿掉。
            if registry
                .live
                .get(&self.id)
                .is_some_and(|flag| Arc::ptr_eq(flag, &self.flag))
            {
                registry.live.remove(&self.id);
            }
        }
    }
}

/// 登记一个任务号。`None`（调用方没给）回一个不会取消的牌。
pub fn begin(task_id: Option<&str>) -> TaskGuard {
    let Some(id) = task_id.filter(|value| !value.is_empty()) else {
        return TaskGuard {
            id: String::new(),
            flag: Arc::new(AtomicBool::new(false)),
        };
    };
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut registry) = registry().lock() {
        // 取消先到、任务后到：那次取消现在就生效。
        if registry.pending.remove(id) {
            registry.pending_order.retain(|entry| entry != id);
            flag.store(true, Ordering::Relaxed);
        }
        registry.live.insert(id.to_string(), Arc::clone(&flag));
    }
    TaskGuard {
        id: id.to_string(),
        flag,
    }
}

/// 取消一个任务号。返回是否命中：命中表示要么正在跑/在排队，要么记成了待取消。
pub fn cancel(task_id: &str) -> bool {
    if task_id.is_empty() {
        return false;
    }
    let Ok(mut registry) = registry().lock() else {
        return false;
    };
    if let Some(flag) = registry.live.get(task_id) {
        flag.store(true, Ordering::Relaxed);
        return true;
    }
    if registry.pending.insert(task_id.to_string()) {
        registry.pending_order.push_back(task_id.to_string());
        while registry.pending_order.len() > MAX_PENDING_CANCELS {
            if let Some(evicted) = registry.pending_order.pop_front() {
                registry.pending.remove(&evicted);
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_task_sees_its_cancellation() {
        let guard = begin(Some("page-1"));
        let token = guard.token();
        assert!(!token.cancelled());
        assert!(cancel("page-1"));
        assert!(token.cancelled());
        assert!(guard.cancelled());
    }

    #[test]
    fn a_cancellation_that_arrives_first_still_counts() {
        // 前端 abort 之后请求才到（或者请求还堵在全局闸外面）：那次取消不能白丢，
        // 否则旧任务照样占着 GPU 跑完。
        assert!(cancel("page-late"));
        let guard = begin(Some("page-late"));
        assert!(guard.cancelled(), "迟到的取消必须在登记时就生效");
    }

    #[test]
    fn every_task_gets_its_own_flag_and_is_forgotten_when_it_ends() {
        let first = begin(Some("page-a"));
        let second = begin(Some("page-b"));
        assert!(cancel("page-a"));
        assert!(first.cancelled());
        assert!(!second.cancelled(), "另一个任务号不能被连坐");

        let token = second.token();
        drop(second);
        // 已经结束的任务号不再是「正在跑」；取消它会记成待取消，留给下一次
        // 同号任务（同一页重跑）——那时它立刻看到取消。
        assert!(cancel("page-b"));
        assert!(!token.cancelled(), "任务结束之后旧牌不再有主人");
        let again = begin(Some("page-b"));
        assert!(again.cancelled());
    }

    #[test]
    fn an_unnamed_task_can_never_be_cancelled() {
        let guard = begin(None);
        assert!(!guard.token().cancelled());
        assert!(!CancelToken::none().cancelled());
    }

    #[test]
    fn the_pending_table_stays_bounded() {
        for index in 0..(MAX_PENDING_CANCELS * 2) {
            cancel(&format!("never-runs-{index}"));
        }
        let registry = registry().lock().expect("registry");
        assert!(registry.pending.len() <= MAX_PENDING_CANCELS);
    }
}
