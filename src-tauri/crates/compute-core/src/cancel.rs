//! 阅读器推理任务的取消牌。
//!
//! 前端的 `AbortSignal` 只能说明「这个结果我不要了」：原生那一侧照旧把整页跑完
//! （一页 4K 在 CPU 上是十几秒），而全局只允许一件重活，于是切页、关开关之后，
//! 用户真正要看的那一页排在旧任务后面等。
//!
//! 每页一个任务号：前端排队时登记，离开阅读器 / 换开关 / 切页时取消。计算核心
//! 在几个循环之间各查一次——超分的 tile 之间、去码的检测框之间、DLSSNR 的 pass
//! 之间——这样一次取消最多让当前这一小块跑完，而不是整页。
//!
//! 取消是**一次性**的：任务号在任务结束时从表里摘掉。晚到的取消（前端先 abort
//! 再发出请求，或请求还堵在全局闸外面）记进一张有上限的待取消表，登记时立刻
//! 带上，不然那次取消会白丢。
//!
//! 这里**不认识**宿主的错误类型：取消点返回自己的 [`Cancelled`]，由宿主把它
//! 映射成自己的 `InferenceError`（docs/71 §5.1：核心不许依赖宿主）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 待取消表的容量：任务号是每页几个、带 generation 的短字符串，真会堆积说明
/// 前端在取消一批根本没发出去的号；有上限就不会把它变成一块只涨不落的内存。
pub const MAX_PENDING_CANCELS: usize = 256;

/// 取消点在检查时返回的错误。宿主负责把它翻成自己的错误类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl fmt::Display for Cancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the task was cancelled")
    }
}

impl std::error::Error for Cancelled {}

#[derive(Debug, Clone, Default)]
pub struct CancelToken(Option<Arc<AtomicBool>>);

impl CancelToken {
    /// 一个永远不取消的牌：任务号缺省、或者这条路径没有取消点。
    pub fn none() -> Self {
        Self(None)
    }

    /// 用一张外部的旗子造牌：调用方自己置位、管道自己查，两端看到同一个原子量。
    /// 宿主从 `TaskGuard::flag()` 得到的就是这张旗子，于是「谁取消」和「谁看见」
    /// 不需要共享注册表。
    pub fn watch(flag: Arc<AtomicBool>) -> Self {
        Self(Some(flag))
    }

    pub fn cancelled(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    /// 到取消点就返回 [`Cancelled`]。循环与循环之间各调一次。
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.cancelled() {
            return Err(Cancelled);
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

/// 待取消表当前的长度。给诊断/指标看：它应该始终接近 0，长期贴上限说明前端在
/// 取消一批根本没发出去的号。
pub fn pending_count() -> usize {
    registry().lock().map(|registry| registry.pending.len()).unwrap_or(0)
}
