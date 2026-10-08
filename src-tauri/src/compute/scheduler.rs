//! 宿主的队列与状态机：只做决定，不做计算（`docs/71` §8.1、§8.2）。
//!
//! 这个文件里**没有 Tauri、没有 IO、没有时钟**——时间由调用方（supervisor）传进来。这样
//! 「什么会被排上、什么会被撤下、什么时候发终态」这些容易写错的规则可以纯测试钉住，
//! 不用开进程、不用起 GPU。
//!
//! 几条规则是刻意的，别顺手「优化」掉：
//!
//! - **并发 1**：重计算同一时刻只有一件在跑（`take_next` 在 running 非空时恒返回 `None`）。
//!   前台优先不是「多开几个 session 一起跑」。
//! - **后台的预扫只留游标**：整本 500 页不能变成 500 个排队对象。队列满了就停下，槽位空
//!   出来再物化下一页（[`Scheduler::next_sweep_page`]）。
//! - **前台不该被后台挤成「队列已满」**：队列到顶时，前台到达替换**最旧的后台占位**，
//!   并把被替换的那件结算成 `Cancelled`（订阅者要收到终态，不能静默消失）。
//! - **合并不是重复计算**：同 `JobKey` 的请求共用一个 job，各持一个 subscription；只有
//!   全部订阅者都放手，任务才真的取消。
//! - **epoch 过滤**：旧 worker 的迟到消息一律丢，不能把新任务的状态改掉。
//! - **终态只结算一次**，且终态快照有界（最近 [`MAX_TERMINAL_SNAPSHOTS`] 个或 10 分钟），
//!   否则「任务状态」会变成一个只涨不落的内存池。
//! - **压力先丢后台**（§8.1/§8.4）：机器吃紧时新任务按 [`Admission`] 挡，排队中的后台
//!   预扫先被 [`Scheduler::shed_background`] 丢掉；在跑的那件不动（要停它得走取消）。

use std::collections::{BTreeMap, HashMap, VecDeque};

use super::resource_policy::Admission;

/// 前台队列上限（§8.1 的初始值）。
pub const FOREGROUND_SLOTS: usize = 4;
/// 后台队列上限（§8.1 的初始值）。
pub const BACKGROUND_SLOTS: usize = 8;
/// 队列总量上限：前台到达可以从这里换掉最旧的后台占位。
pub const TOTAL_SLOTS: usize = FOREGROUND_SLOTS + BACKGROUND_SLOTS;
/// 终态快照保留条数上限（§11 Task 4 的「最近 128 个」）。
pub const MAX_TERMINAL_SNAPSHOTS: usize = 128;
/// 终态快照保留时长（§11 Task 4 的「10 分钟」）。
pub const TERMINAL_TTL_MS: u64 = 10 * 60 * 1000;
/// 一件在飞的任务因为 worker 换代而失败的固定错误码。
pub const WORKER_LOST_CODE: &str = "COMPUTE_WORKER_LOST";
/// worker 已经熔断（重启上限用完），排队中的任务等不到它了。
pub const WORKER_UNAVAILABLE_CODE: &str = "COMPUTE_WORKER_UNAVAILABLE";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Foreground,
    Background,
}

/// 任务身份：同一身份的请求合并成一个 job（§8.1）。
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobKey {
    pub input_id: String,
    /// 设置/参数指纹：换了设置就是另一个任务。
    pub settings_id: String,
    /// 源文件修订号：文件变了，旧结果不能复用。
    pub source_revision: String,
    /// 引擎选择（`cpu`/`directml`/`cuda`/…）：换后端必须重算。
    pub backend: String,
    /// 阅读器世代：on/off 变化会换代（§9.1）。
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Dispatched,
    Accepted,
    Running { stage: String, index: u32 },
    /// 已请求取消、等 worker 的终态。**不能**在这一刻就把 running 许可当空闲（§6.5）。
    CancelRequested,
    Completed,
    Cancelled,
    Failed { code: String },
}

impl JobState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobState::Completed | JobState::Cancelled | JobState::Failed { .. }
        )
    }

    /// 占了 running 许可的状态：从派发到终态之间。
    pub fn holds_running(&self) -> bool {
        !self.is_terminal() && !matches!(self, JobState::Queued)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub job_id: String,
    pub key: JobKey,
    pub priority: Priority,
    pub state: JobState,
    pub subscribers: usize,
    /// 单调序号：前端事件排序用，也是「谁更旧」的判据。
    pub sequence: u64,
    pub created_ms: u64,
    /// 只有终态有值。
    pub settled_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitError {
    /// 队列满且没有可替换的后台占位。
    ForegroundFull,
    /// 后台槽位用完（整本预扫到这里就停下，等槽位）。
    BackgroundFull,
    /// 这台机器现在吃紧：这一件先不收（§8.1 软/硬阈值、§8.4 显存预留）。
    /// 不是「这一页不能算」，是「现在不算」——压力过去同一页要能重新提交。
    Pressure,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submitted {
    pub job_id: String,
    pub subscription_id: u64,
    pub coalesced: bool,
    pub snapshot: JobSnapshot,
    /// 被这次提交换掉的后台占位（订阅者要收到终态）。
    pub evicted: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelOutcome {
    /// 还有别的订阅者要这个结果，任务继续。
    DroppedSubscription { remaining: usize },
    /// 最后一个订阅者放手：排队中的直接结算，在跑的转 `CancelRequested`。
    CancelRequested { running: bool },
    AlreadyTerminal,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PromoteOutcome {
    Promoted,
    AlreadyForeground,
    AlreadyTerminal,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dispatched {
    pub job_id: String,
    pub snapshot: JobSnapshot,
}

/// worker 回的、会改变任务状态的事件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkerEvent {
    Accepted { job_id: String },
    Stage { job_id: String, stage: String, index: u32 },
    Completed { job_id: String },
    Cancelled { job_id: String },
    Failed { job_id: String, code: String },
}

impl WorkerEvent {
    pub fn job_id(&self) -> &str {
        match self {
            WorkerEvent::Accepted { job_id }
            | WorkerEvent::Stage { job_id, .. }
            | WorkerEvent::Completed { job_id }
            | WorkerEvent::Cancelled { job_id }
            | WorkerEvent::Failed { job_id, .. } => job_id,
        }
    }

    /// 结算用的状态；`Stage`/`Accepted` 不是终态。
    fn terminal_state(&self) -> Option<JobState> {
        match self {
            WorkerEvent::Completed { .. } => Some(JobState::Completed),
            WorkerEvent::Cancelled { .. } => Some(JobState::Cancelled),
            WorkerEvent::Failed { code, .. } => Some(JobState::Failed { code: code.clone() }),
            WorkerEvent::Accepted { .. } | WorkerEvent::Stage { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedGeneration {
    pub queued: usize,
    pub running: usize,
}

struct Job {
    snapshot: JobSnapshot,
    subscriptions: Vec<u64>,
}

/// 调度器。**它不拥有 worker**：只管「谁排队、谁在跑、谁的许可还没还」。
///
/// epoch 由宿主任命（§6.2 每个状态都带 workerEpoch），所以构造时就要给一个：
/// 一个默认 0 的 epoch 会让「宿主忘了换代」变成「所有 worker 事件被静默丢弃」。
pub struct Scheduler {
    jobs: BTreeMap<String, Job>,
    by_key: HashMap<JobKey, String>,
    foreground: VecDeque<String>,
    background: VecDeque<String>,
    running: Option<String>,
    sweeps: HashMap<String, Sweep>,
    epoch: u64,
    next_job: u64,
    next_subscription: u64,
    next_sequence: u64,
}

struct Sweep {
    total: u32,
    next: u32,
}

impl Scheduler {
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            ..Self::empty()
        }
    }

    fn empty() -> Self {
        Self {
            jobs: BTreeMap::new(),
            by_key: HashMap::new(),
            foreground: VecDeque::new(),
            background: VecDeque::new(),
            running: None,
            sweeps: HashMap::new(),
            epoch: 0,
            next_job: 0,
            next_subscription: 0,
            next_sequence: 0,
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// 分配一个订阅号。订阅号只增不减，取消过的号不会复用（宿主拿旧号来取消必须落空）。
    fn new_subscription(&mut self) -> u64 {
        self.next_subscription += 1;
        self.next_subscription
    }

    /// 结算成终态：摘掉身份映射（同一个身份之后要能重新提交）、腾出 running、清出队列，
    /// 并顺手回收过期/超量的终态快照。**只该被调用一次**。
    fn settle(&mut self, job_id: &str, state: JobState, now_ms: u64) {
        debug_assert!(state.is_terminal());
        let Some(job) = self.jobs.get_mut(job_id) else {
            return;
        };
        job.snapshot.state = state;
        job.snapshot.settled_ms = Some(now_ms);
        let key = job.snapshot.key.clone();
        self.by_key.remove(&key);
        if self.running.as_deref() == Some(job_id) {
            self.running = None;
        }
        self.foreground.retain(|queued| queued != job_id);
        self.background.retain(|queued| queued != job_id);
        self.retain(now_ms);
    }

    pub fn submit(
        &mut self,
        key: JobKey,
        priority: Priority,
        now_ms: u64,
    ) -> Result<Submitted, SubmitError> {
        self.submit_under(key, priority, now_ms, Admission::Run)
    }

    /// 和 [`Scheduler::submit`] 一样，只是多一个「这台机器现在收不收」的档位（§8.1、§8.4）。
    ///
    /// **先合并、后看压力**：同一件已经在算的任务再来一个订阅者不增加任何工作，把订阅挡回去
    /// 只会让界面丢掉它本来该收到的通知（用户来回翻页正是这种情形）。只有**新任务**才受档位
    /// 影响：`ForegroundOnly` 拒后台预扫，`Refuse` 连前台也拒。
    pub fn submit_under(
        &mut self,
        key: JobKey,
        priority: Priority,
        now_ms: u64,
        admission: Admission,
    ) -> Result<Submitted, SubmitError> {
        // 同身份的任务还在进行 → 合并，只加一个订阅者（不重复计算）。
        if let Some(existing) = self.by_key.get(&key).cloned() {
            let alive = self
                .jobs
                .get(&existing)
                .map(|job| !job.snapshot.state.is_terminal())
                .unwrap_or(false);
            if alive {
                let subscription_id = self.new_subscription();
                let snapshot = {
                    let job = self.jobs.get_mut(&existing).expect("刚才还在");
                    job.subscriptions.push(subscription_id);
                    job.snapshot.subscribers = job.subscriptions.len();
                    job.snapshot.clone()
                };
                return Ok(Submitted {
                    job_id: existing,
                    subscription_id,
                    coalesced: true,
                    snapshot,
                    evicted: None,
                });
            }
        }

        // 合并走完了，剩下的才是新任务：这时候才该问「这台机器还受不受得了」。
        match (admission, priority) {
            (Admission::Refuse, _) => return Err(SubmitError::Pressure),
            (Admission::ForegroundOnly, Priority::Background) => return Err(SubmitError::Pressure),
            (Admission::Run, _) | (Admission::ForegroundOnly, Priority::Foreground) => {}
        }

        let mut evicted = None;
        match priority {
            Priority::Foreground => {
                // 前台不该被后台挤成「队列已满」：到顶时替换最旧的后台**占位**
                // （只可能是排队中的后台任务——在跑的那件不在队列里）。
                if self.foreground.len() >= FOREGROUND_SLOTS
                    || self.foreground.len() + self.background.len() >= TOTAL_SLOTS
                {
                    match self.background.pop_front() {
                        Some(victim) => {
                            self.settle(&victim, JobState::Cancelled, now_ms);
                            evicted = Some(victim);
                        }
                        None => return Err(SubmitError::ForegroundFull),
                    }
                }
            }
            Priority::Background => {
                if self.background.len() >= BACKGROUND_SLOTS {
                    return Err(SubmitError::BackgroundFull);
                }
            }
        }

        self.next_job += 1;
        self.next_sequence += 1;
        let job_id = format!("job-{}", self.next_job);
        let subscription_id = self.new_subscription();
        let snapshot = JobSnapshot {
            job_id: job_id.clone(),
            key: key.clone(),
            priority,
            state: JobState::Queued,
            subscribers: 1,
            sequence: self.next_sequence,
            created_ms: now_ms,
            settled_ms: None,
        };
        self.jobs.insert(
            job_id.clone(),
            Job {
                snapshot: snapshot.clone(),
                subscriptions: vec![subscription_id],
            },
        );
        self.by_key.insert(key, job_id.clone());
        match priority {
            Priority::Foreground => self.foreground.push_back(job_id.clone()),
            Priority::Background => self.background.push_back(job_id.clone()),
        }
        Ok(Submitted {
            job_id,
            subscription_id,
            coalesced: false,
            snapshot,
            evicted,
        })
    }

    /// 压力上来了：把**排队中**的后台任务丢掉（§8.1：过了软阈值先丢后台，别等到分配失败）。
    ///
    /// 只丢队里的：**在跑的那件不在队列里**——清队列不该顺手把正在算的一页也杀了，要停它得
    /// 走取消，由调用方按档位决定。返回被丢掉的任务号，宿主拿它把终态发给订阅者。
    pub fn shed_background(&mut self, now_ms: u64) -> Vec<String> {
        let victims: Vec<String> = self.background.iter().cloned().collect();
        for job_id in &victims {
            self.settle(job_id, JobState::Cancelled, now_ms);
        }
        victims
    }

    pub fn cancel(&mut self, job_id: &str, subscription_id: u64, now_ms: u64) -> CancelOutcome {
        let (remaining, running) = {
            let Some(job) = self.jobs.get_mut(job_id) else {
                return CancelOutcome::Unknown;
            };
            // 先认订阅号：拿一个从没发出去（或已经被摘掉）的号来取消，是调用方的问题，
            // 不能因为任务恰好已经终态就回一句「已经结束了」把它掩盖掉。
            let Some(position) = job
                .subscriptions
                .iter()
                .position(|issued| *issued == subscription_id)
            else {
                return CancelOutcome::Unknown;
            };
            if job.snapshot.state.is_terminal() {
                return CancelOutcome::AlreadyTerminal;
            }
            job.subscriptions.remove(position);
            job.snapshot.subscribers = job.subscriptions.len();
            (job.subscriptions.len(), job.snapshot.state.holds_running())
        };

        if remaining > 0 {
            return CancelOutcome::DroppedSubscription { remaining };
        }
        if running {
            // 还占着 running：只置「已请求」，等 worker 的终态（§6.5）。这一步**不能**
            // 把许可当空闲，否则宿主会立刻派下一件，两件重任务就并排跑起来了。
            if let Some(job) = self.jobs.get_mut(job_id) {
                job.snapshot.state = JobState::CancelRequested;
            }
        } else {
            // 还在排队：没有 worker 参与，直接结算。
            self.settle(job_id, JobState::Cancelled, now_ms);
        }
        CancelOutcome::CancelRequested { running }
    }

    pub fn promote(&mut self, job_id: &str) -> PromoteOutcome {
        let queued = {
            let Some(job) = self.jobs.get(job_id) else {
                return PromoteOutcome::Unknown;
            };
            if job.snapshot.state.is_terminal() {
                return PromoteOutcome::AlreadyTerminal;
            }
            if job.snapshot.priority == Priority::Foreground {
                return PromoteOutcome::AlreadyForeground;
            }
            job.snapshot.state == JobState::Queued
        };
        if let Some(job) = self.jobs.get_mut(job_id) {
            job.snapshot.priority = Priority::Foreground;
        }
        if queued {
            // 同一个 job 换队，不新建任务——「提升」不该变成「重算」。
            self.background.retain(|id| id != job_id);
            self.foreground.push_front(job_id.to_string());
        }
        PromoteOutcome::Promoted
    }

    /// 运行中的后台任务该不该为前台让路（§8.1）。返回要被合作取消的 job。
    pub fn preemption_target(&self) -> Option<String> {
        let running = self.running.as_deref()?;
        let job = self.jobs.get(running)?;
        if job.snapshot.priority != Priority::Background {
            return None;
        }
        let waiting = self
            .foreground
            .iter()
            .any(|id| self.jobs.get(id).is_some_and(|j| j.snapshot.state == JobState::Queued));
        if waiting {
            Some(running.to_string())
        } else {
            None
        }
    }

    pub fn take_next(&mut self) -> Option<Dispatched> {
        if self.running.is_some() {
            // 并发 1：前台优先不是「多开几个 session 一起跑」。
            return None;
        }
        loop {
            let next = self
                .foreground
                .pop_front()
                .or_else(|| self.background.pop_front())?;
            let Some(job) = self.jobs.get_mut(&next) else {
                continue;
            };
            if job.snapshot.state != JobState::Queued {
                continue;
            }
            job.snapshot.state = JobState::Dispatched;
            let snapshot = job.snapshot.clone();
            self.running = Some(next.clone());
            return Some(Dispatched {
                job_id: next,
                snapshot,
            });
        }
    }

    /// 宿主自己发起的取消（前台插队、超过 deadline）。它与「订阅者取消」的区别是
    /// **不动订阅计数**：没有哪个界面放手了，是宿主决定这件别算了。
    ///
    /// 返回 `true` 表示它确实还在跑、已经进入 `CancelRequested`（宿主该去发 `cancel`）。
    pub fn request_cancel(&mut self, job_id: &str) -> bool {
        let Some(job) = self.jobs.get_mut(job_id) else {
            return false;
        };
        match job.snapshot.state {
            // 只有「worker 那边真的在跑」才需要打扰它。排队中的用订阅取消就够，
            // 终态的更是无从取消。
            JobState::Dispatched | JobState::Accepted | JobState::Running { .. } => {
                job.snapshot.state = JobState::CancelRequested;
                true
            }
            _ => false,
        }
    }

    /// 宿主判定 worker 已经熔断：排队中的任务不再等，全部结算成失败，返回它们的 id。
    /// **在飞的那件不在其列**——它的结局由 [`Scheduler::begin_epoch`] 决定。
    pub fn fail_queued(&mut self, code: &str, now_ms: u64) -> Vec<String> {
        let waiting: Vec<String> = self
            .foreground
            .iter()
            .chain(self.background.iter())
            .filter(|job_id| {
                self.jobs
                    .get(*job_id)
                    .is_some_and(|job| job.snapshot.state == JobState::Queued)
            })
            .cloned()
            .collect();
        for job_id in &waiting {
            self.settle(
                job_id,
                JobState::Failed {
                    code: code.to_string(),
                },
                now_ms,
            );
        }
        waiting
    }

    /// 全部快照（含终态），按 `sequence` 升序。命令层的「断订阅后重新查一遍」和
    /// 宿主侧的「worker 换代了，把受影响的状态都推给界面」都要用。
    pub fn all(&self) -> Vec<JobSnapshot> {
        let mut all: Vec<JobSnapshot> = self
            .jobs
            .values()
            .map(|job| job.snapshot.clone())
            .collect();
        all.sort_by_key(|snapshot| snapshot.sequence);
        all
    }

    pub fn open_sweep(&mut self, input_id: &str, total_pages: u32) {
        self.sweeps.insert(
            input_id.to_string(),
            Sweep {
                total: total_pages,
                next: 0,
            },
        );
    }

    /// 有后台槽位时给出下一页；没有就 `None`（游标不动）。
    pub fn next_sweep_page(&mut self, input_id: &str) -> Option<u32> {
        if self.background.len() >= BACKGROUND_SLOTS {
            return None;
        }
        let sweep = self.sweeps.get_mut(input_id)?;
        if sweep.next >= sweep.total {
            return None;
        }
        let page = sweep.next;
        sweep.next += 1;
        Some(page)
    }

    /// 新的阅读器世代上来，旧的排队任务已经没有显示价值。
    pub fn drop_generation(
        &mut self,
        input_id: &str,
        generation: u64,
        now_ms: u64,
    ) -> DroppedGeneration {
        let stale: Vec<String> = self
            .jobs
            .values()
            .filter(|job| {
                job.snapshot.key.input_id == input_id && job.snapshot.key.generation < generation
            })
            .map(|job| job.snapshot.job_id.clone())
            .collect();
        let mut dropped = DroppedGeneration {
            queued: 0,
            running: 0,
        };
        for job_id in stale {
            let state = match self.jobs.get(&job_id) {
                Some(job) => job.snapshot.state.clone(),
                None => continue,
            };
            if state.is_terminal() {
                continue;
            }
            if state == JobState::Queued {
                self.settle(&job_id, JobState::Cancelled, now_ms);
                dropped.queued += 1;
            } else {
                // 在跑的那件不能凭空消失：等它自己收尾，宿主只把结果丢掉。
                dropped.running += 1;
            }
        }
        dropped
    }

    /// worker 换代：在飞的任务全标 `worker_lost`，返回件数。
    pub fn begin_epoch(&mut self, epoch: u64, now_ms: u64) -> usize {
        self.epoch = epoch;
        let inflight: Vec<String> = self
            .jobs
            .values()
            .filter(|job| job.snapshot.state.holds_running())
            .map(|job| job.snapshot.job_id.clone())
            .collect();
        let count = inflight.len();
        for job_id in inflight {
            self.settle(
                &job_id,
                JobState::Failed {
                    code: WORKER_LOST_CODE.to_string(),
                },
                now_ms,
            );
        }
        count
    }

    /// 应用 worker 事件；旧 epoch 或已终态的事件返回 `false`。
    pub fn apply_worker_event(&mut self, epoch: u64, event: WorkerEvent, now_ms: u64) -> bool {
        if epoch != self.epoch {
            // 上一代 worker 的迟到消息绝不能改这一代任务的状态（§6.2）。
            return false;
        }
        let job_id = event.job_id().to_string();
        let state = match self.jobs.get(&job_id) {
            Some(job) => job.snapshot.state.clone(),
            None => return false,
        };
        if state.is_terminal() {
            // 终态只结算一次；重复的 completed/cancelled 不再发布事件。
            return false;
        }
        if let Some(terminal) = event.terminal_state() {
            self.settle(&job_id, terminal, now_ms);
            return true;
        }
        match event {
            WorkerEvent::Accepted { .. } => {
                if state == JobState::Dispatched {
                    self.set_state(&job_id, JobState::Accepted);
                }
            }
            WorkerEvent::Stage { stage, index, .. } => {
                // 已经请求取消的任务：不再改阶段，但事件本身是有效的（它确实还在跑）。
                if matches!(state, JobState::Accepted | JobState::Running { .. }) {
                    self.set_state(&job_id, JobState::Running { stage, index });
                }
            }
            WorkerEvent::Completed { .. }
            | WorkerEvent::Cancelled { .. }
            | WorkerEvent::Failed { .. } => unreachable!("终态在上面已经结算"),
        }
        true
    }

    fn set_state(&mut self, job_id: &str, state: JobState) {
        if let Some(job) = self.jobs.get_mut(job_id) {
            job.snapshot.state = state;
        }
    }

    /// 回收过期终态快照，返回回收条数。
    pub fn retain(&mut self, now_ms: u64) -> usize {
        let mut dropped = 0;
        let stale: Vec<String> = self
            .jobs
            .values()
            .filter(|job| {
                job.snapshot.state.is_terminal()
                    && job
                        .snapshot
                        .settled_ms
                        .is_some_and(|settled| now_ms.saturating_sub(settled) > TERMINAL_TTL_MS)
            })
            .map(|job| job.snapshot.job_id.clone())
            .collect();
        for job_id in stale {
            self.jobs.remove(&job_id);
            dropped += 1;
        }

        let mut terminals: Vec<(u64, String)> = self
            .jobs
            .values()
            .filter(|job| job.snapshot.state.is_terminal())
            .map(|job| (job.snapshot.sequence, job.snapshot.job_id.clone()))
            .collect();
        terminals.sort();
        let excess = terminals.len().saturating_sub(MAX_TERMINAL_SNAPSHOTS);
        for (_, job_id) in terminals.into_iter().take(excess) {
            self.jobs.remove(&job_id);
            dropped += 1;
        }
        dropped
    }

    pub fn snapshot(&self, job_id: &str) -> Option<JobSnapshot> {
        self.jobs.get(job_id).map(|job| job.snapshot.clone())
    }

    /// 断订阅之后按 id 批量恢复（`job_get_many`）。
    pub fn snapshots(&self, job_ids: &[String]) -> Vec<JobSnapshot> {
        job_ids
            .iter()
            .filter_map(|job_id| self.snapshot(job_id))
            .collect()
    }

    pub fn queued(&self, priority: Priority) -> usize {
        match priority {
            Priority::Foreground => self.foreground.len(),
            Priority::Background => self.background.len(),
        }
    }

    pub fn running_job(&self) -> Option<&str> {
        self.running.as_deref()
    }

    pub fn snapshot_count(&self) -> usize {
        self.jobs.len()
    }

    pub fn terminal_count(&self) -> usize {
        self.jobs
            .values()
            .filter(|job| job.snapshot.state.is_terminal())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPOCH: u64 = 1;

    fn key(input: &str, page: u32) -> JobKey {
        JobKey {
            input_id: input.to_string(),
            settings_id: format!("settings-{page}"),
            source_revision: "rev-1".to_string(),
            backend: "directml".to_string(),
            generation: 1,
        }
    }

    fn key_of_generation(input: &str, page: u32, generation: u64) -> JobKey {
        JobKey {
            generation,
            ..key(input, page)
        }
    }

    fn state_of(scheduler: &Scheduler, job_id: &str) -> JobState {
        scheduler
            .snapshot(job_id)
            .expect("任务不见了")
            .state
    }

    /// 界面点一下要等多久：`submit`/`cancel`/`promote` 三个 ACK 的 p50/p95/p99（§12.3 第一条：
    /// 「ready 条件下 submit/cancel/promote ACK p95<=100ms，UI 无需等待 task terminal 才更新」）。
    ///
    /// 这条用例量的是**调度器这一侧**：不碰 worker、不碰管道、不碰界面，把队列压到最满再压一
    /// 遍。也就是说它量的是「native 至少也要花这么多」——真正的端到端 ACK 还要过命令通道与事件
    /// 回执（`docs/121` 的 `notMeasured` 里还挂着的那几条），那一侧只会更慢、不会更快，所以
    /// 这里如果超标，产品一定超标；反过来不成立，这一点在报告里照实写。
    ///
    /// 门槛不是「越快越好」：100 ms 是 §12.3 写下的界，比实测值大三个数量级——写成断言是为了
    /// 挡住**病态**实现（每次提交都扫全队列、在锁里做事、把 O(1) 退化成 O(n²)），不是为了让这
    /// 条用例在忙机器上随机翻红。
    ///
    /// 队列压满的方式是照产品来的：4 个前台 + 8 个后台占满 `TOTAL_SLOTS`，之后每轮都走一遍
    /// 「满队列提交前台先替换最旧的后台占位」那一条（`settle` 就在里面）。
    #[test]
    fn the_acks_the_interface_waits_for_stay_under_the_ui_threshold() {
        use std::time::Instant;

        let mut scheduler = Scheduler::new(EPOCH);
        let mut now = 0_u64;
        for page in 0..FOREGROUND_SLOTS as u32 {
            scheduler
                .submit_under(
                    key_of_generation("book", page, 1),
                    Priority::Foreground,
                    now,
                    Admission::Run,
                )
                .expect("队列还没满");
            now += 1;
        }
        for page in 100..100 + BACKGROUND_SLOTS as u32 {
            scheduler
                .submit_under(
                    key_of_generation("book", page, 1),
                    Priority::Background,
                    now,
                    Admission::Run,
                )
                .expect("后台还有位置");
            now += 1;
        }

        let mut samples: Vec<u128> = Vec::new();
        let mut measure = |started: Instant, samples: &mut Vec<u128>| {
            samples.push(started.elapsed().as_micros());
        };
        for round in 0..200_u32 {
            now += 1;
            let started = Instant::now();
            let foreground = scheduler
                .submit_under(
                    key_of_generation("book", 1_000 + round, 1),
                    Priority::Foreground,
                    now,
                    Admission::Run,
                )
                .expect("满队列也要收下前台：它替换最旧的后台占位");
            measure(started, &mut samples);

            let started = Instant::now();
            scheduler.cancel(&foreground.job_id, foreground.subscription_id, now);
            measure(started, &mut samples);

            now += 1;
            let started = Instant::now();
            let background = scheduler
                .submit_under(
                    key_of_generation("book", 2_000 + round, 1),
                    Priority::Background,
                    now,
                    Admission::Run,
                )
                .expect("刚腾出来一个后台位");
            measure(started, &mut samples);

            let started = Instant::now();
            let promoted = scheduler.promote(&background.job_id);
            measure(started, &mut samples);
            assert_eq!(
                promoted,
                PromoteOutcome::Promoted,
                "排队中的后台任务该能被提到前台"
            );

            let started = Instant::now();
            scheduler.cancel(&background.job_id, background.subscription_id, now);
            measure(started, &mut samples);

            // 提到前台那件结算掉之后腾出来的**后台**位要补上：不补的话每轮净少一个后台位，
            // 八轮之后 `background.pop_front()` 就空了，下一轮的前台提交会走成
            // `ForegroundFull`——那是队列被这条用例自己抽干，不是产品的问题。
            now += 1;
            let started = Instant::now();
            scheduler
                .submit_under(
                    key_of_generation("book", 3_000 + round, 1),
                    Priority::Background,
                    now,
                    Admission::Run,
                )
                .expect("后台位该回到满");
            measure(started, &mut samples);
        }

        // 空表交不了差：每一轮 6 次取样，少一次就说明有一条路根本没走到。
        assert_eq!(
            samples.len(),
            200 * 6,
            "预期每轮 6 次取样（前台提交、取消、后台提交、提升、取消、补后台）"
        );
        let mut sorted = samples.clone();
        sorted.sort_unstable();
        let pick = |percent: usize| -> u128 {
            let rank = (sorted.len() * percent).div_ceil(100).max(1) - 1;
            sorted[rank.min(sorted.len() - 1)]
        };
        let (p50, p95, p99) = (pick(50), pick(95), pick(99));
        let worst = *sorted.last().expect("至少有一样");
        println!(
            "队列 ACK（调度器这一侧，{} 次取样）：p50 {:.3} ms、p95 {:.3} ms、p99 {:.3} ms、最坏 {:.3} ms（§12.3 的界 100 ms）",
            samples.len(),
            p50 as f64 / 1_000.0,
            p95 as f64 / 1_000.0,
            p99 as f64 / 1_000.0,
            worst as f64 / 1_000.0
        );
        assert!(
            p95 <= 100_000,
            "submit/cancel/promote 的 p95 是 {:.3} ms，超过了 §12.3 的 100 ms：界面还没等到判决就先卡住了",
            p95 as f64 / 1_000.0
        );
    }

    #[test]
    fn pressure_lets_the_background_go_and_keeps_the_foreground() {
        let mut scheduler = Scheduler::new(EPOCH);
        let mut background = Vec::new();
        for page in 0..3 {
            let submitted = scheduler
                .submit_under(key("book", page), Priority::Background, 0, Admission::Run)
                .expect("没压力时后台也收");
            background.push(submitted.job_id);
        }
        let foreground = scheduler
            .submit_under(
                key("book", 9),
                Priority::Foreground,
                0,
                Admission::ForegroundOnly,
            )
            .expect("只让后台停下，不该拦前台");

        // 软压力下**新起的**后台预扫也不收。少这一条的话，把准入里那一臂删掉照样绿：
        // 清队列只清得掉已经在队里的，新来的会源源不断塞进来。
        let refused = scheduler.submit_under(
            key("book", 5),
            Priority::Background,
            1,
            Admission::ForegroundOnly,
        );
        assert_eq!(
            refused.err(),
            Some(SubmitError::Pressure),
            "软压力下新起的后台预扫该被挡回去"
        );

        let shed = scheduler.shed_background(10);
        assert_eq!(shed.len(), 3, "排队中的后台都该被丢掉：{shed:?}");
        for job_id in &background {
            assert_eq!(
                state_of(&scheduler, job_id),
                JobState::Cancelled,
                "{job_id} 该是取消"
            );
        }
        assert_eq!(
            state_of(&scheduler, &foreground.job_id),
            JobState::Queued,
            "前台不该被连坐"
        );
        assert_eq!(scheduler.queued(Priority::Background), 0, "后台队列该空了");
        assert!(
            scheduler.shed_background(20).is_empty(),
            "已经丢干净了，再说一次不该又丢出一批"
        );

        // 压力过去，后台重新收。
        let again = scheduler
            .submit_under(key("book", 4), Priority::Background, 30, Admission::Run)
            .expect("压力过去就该重新收");
        assert_eq!(state_of(&scheduler, &again.job_id), JobState::Queued);
    }

    #[test]
    fn a_machine_that_can_not_take_anything_refuses_even_the_foreground() {
        let mut scheduler = Scheduler::new(EPOCH);
        let refused =
            scheduler.submit_under(key("book", 0), Priority::Foreground, 0, Admission::Refuse);
        assert_eq!(
            refused.err(),
            Some(SubmitError::Pressure),
            "硬压力下连前台也不接"
        );
        assert_eq!(scheduler.snapshot_count(), 0, "拒收不该留下半个任务");

        // 拒收不是「这一页永远不算」：压力过去，同一页要能重新提交。
        let accepted = scheduler
            .submit_under(key("book", 0), Priority::Foreground, 1, Admission::Run)
            .expect("压力过去要能收");
        assert_eq!(state_of(&scheduler, &accepted.job_id), JobState::Queued);
    }

    #[test]
    fn pressure_does_not_hide_a_job_that_is_already_running() {
        let mut scheduler = Scheduler::new(EPOCH);
        let first = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收");
        // 同一页又来一个订阅者（用户来回翻页），此刻机器已经吃紧：这件任务**已经在算了**，
        // 把它挡回去只会让界面丢掉它该收到的通知。
        let second = scheduler
            .submit_under(key("book", 0), Priority::Foreground, 5, Admission::Refuse)
            .expect("合并要先于压力判断");
        assert!(second.coalesced, "第二个订阅者是一次合并，不是新任务");
        assert_eq!(second.job_id, first.job_id);
    }

    #[test]
    fn a_queued_sweep_does_not_touch_the_job_that_is_running() {
        let mut scheduler = Scheduler::new(EPOCH);
        let running = scheduler
            .submit(key("book", 0), Priority::Background, 0)
            .expect("收");
        let dispatched = scheduler.take_next().expect("派一件出去");
        assert_eq!(dispatched.job_id, running.job_id);
        let queued = scheduler
            .submit(key("book", 1), Priority::Background, 1)
            .expect("收");
        let shed = scheduler.shed_background(2);
        assert_eq!(shed, vec![queued.job_id.clone()], "只该丢排队中的那件");
        assert!(
            state_of(&scheduler, &running.job_id).holds_running(),
            "在跑的那件还得跑着（要停它是取消，不是清队列）：{:?}",
            state_of(&scheduler, &running.job_id)
        );
    }

    #[test]
    fn four_foreground_and_eight_background_are_the_limits() {
        let mut scheduler = Scheduler::new(EPOCH);
        for page in 0..FOREGROUND_SLOTS {
            scheduler
                .submit(key("book", page as u32), Priority::Foreground, 0)
                .expect("前台前四件必须收下");
        }
        for page in 0..BACKGROUND_SLOTS {
            scheduler
                .submit(
                    key("other", page as u32),
                    Priority::Background,
                    (FOREGROUND_SLOTS + page) as u64,
                )
                .expect("后台前八件必须收下");
        }
        assert_eq!(scheduler.queued(Priority::Foreground), FOREGROUND_SLOTS);
        assert_eq!(scheduler.queued(Priority::Background), BACKGROUND_SLOTS);
        assert_eq!(
            scheduler.submit(key("other", 99), Priority::Background, 99),
            Err(SubmitError::BackgroundFull),
            "后台槽位用完就该停下，让预扫保留游标"
        );
    }

    #[test]
    fn a_foreground_submit_evicts_the_oldest_background_placeholder() {
        let mut scheduler = Scheduler::new(EPOCH);
        let mut background = Vec::new();
        for page in 0..BACKGROUND_SLOTS {
            let submitted = scheduler
                .submit(key("other", page as u32), Priority::Background, page as u64)
                .expect("后台前八件必须收下");
            background.push(submitted.job_id);
        }
        for page in 0..FOREGROUND_SLOTS {
            scheduler
                .submit(key("book", page as u32), Priority::Foreground, 50)
                .expect("前台前四件必须收下");
        }

        let submitted = scheduler
            .submit(key("book", 4), Priority::Foreground, 60)
            .expect("前台不该因为后台占满而报满");
        assert_eq!(submitted.evicted.as_deref(), Some(background[0].as_str()));
        assert_eq!(
            state_of(&scheduler, &background[0]),
            JobState::Cancelled,
            "被换掉的那件要给订阅者一个终态，不能静默消失"
        );
        assert_eq!(
            state_of(&scheduler, &background[1]),
            JobState::Queued,
            "只换最旧的那一件"
        );
        assert_eq!(scheduler.queued(Priority::Foreground), FOREGROUND_SLOTS + 1);
        assert_eq!(scheduler.queued(Priority::Background), BACKGROUND_SLOTS - 1);
    }

    #[test]
    fn the_same_identity_is_one_job_with_one_subscription_each() {
        let mut scheduler = Scheduler::new(EPOCH);
        let first = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        let second = scheduler
            .submit(key("book", 0), Priority::Foreground, 10)
            .expect("同身份必须能再次订阅");
        assert_eq!(first.job_id, second.job_id);
        assert!(!first.coalesced);
        assert!(second.coalesced);
        assert_eq!(
            scheduler
                .snapshot(&first.job_id)
                .expect("任务在")
                .subscribers,
            2
        );

        // 换了设置就是另一件任务，不能合并。
        let other = scheduler
            .submit(key("book", 1), Priority::Foreground, 20)
            .expect("收下");
        assert_ne!(other.job_id, first.job_id);
        assert_eq!(scheduler.snapshot_count(), 2);
    }

    #[test]
    fn a_shared_job_is_only_cancelled_when_every_consumer_lets_go() {
        let mut scheduler = Scheduler::new(EPOCH);
        let first = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        let second = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");

        assert_eq!(
            scheduler.cancel(&first.job_id, first.subscription_id, 100),
            CancelOutcome::DroppedSubscription { remaining: 1 }
        );
        assert_eq!(state_of(&scheduler, &first.job_id), JobState::Queued);

        assert_eq!(
            scheduler.cancel(&first.job_id, second.subscription_id, 200),
            CancelOutcome::CancelRequested { running: false }
        );
        assert_eq!(state_of(&scheduler, &first.job_id), JobState::Cancelled);
        assert!(scheduler.take_next().is_none(), "取消了的排队任务不许再派发");
        assert_eq!(
            scheduler.cancel(&first.job_id, second.subscription_id, 300),
            CancelOutcome::Unknown,
            "订阅号已经失效"
        );
    }

    #[test]
    fn only_one_job_runs_at_a_time_and_foreground_goes_first() {
        let mut scheduler = Scheduler::new(EPOCH);
        let background = scheduler
            .submit(key("other", 0), Priority::Background, 0)
            .expect("收下");
        let foreground = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");

        let first = scheduler.take_next().expect("队列里有活");
        assert_eq!(first.job_id, foreground.job_id, "前台优先");
        assert!(scheduler.take_next().is_none(), "并发只能是 1");
        assert_eq!(scheduler.running_job(), Some(foreground.job_id.as_str()));

        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Completed {
                job_id: foreground.job_id.clone()
            },
            10
        ));
        assert_eq!(state_of(&scheduler, &foreground.job_id), JobState::Completed);
        assert_eq!(scheduler.running_job(), None, "终态要腾出 running 许可");

        let second = scheduler.take_next().expect("后台接着上");
        assert_eq!(second.job_id, background.job_id);
    }

    #[test]
    fn a_waiting_foreground_job_preempts_a_running_background_one() {
        let mut scheduler = Scheduler::new(EPOCH);
        let background = scheduler
            .submit(key("other", 0), Priority::Background, 0)
            .expect("收下");
        let dispatched = scheduler.take_next().expect("后台也能先跑");
        assert_eq!(dispatched.job_id, background.job_id);
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Accepted {
                job_id: background.job_id.clone()
            },
            1
        ));
        assert!(
            scheduler.preemption_target().is_none(),
            "没有前台在等，不该无谓地打断后台"
        );

        let foreground = scheduler
            .submit(key("book", 0), Priority::Foreground, 2)
            .expect("收下");
        assert_eq!(
            scheduler.preemption_target().as_deref(),
            Some(background.job_id.as_str())
        );
        assert!(
            scheduler.take_next().is_none(),
            "还没腾出 running，不许并排跑第二件"
        );

        // 合作取消走完，worker 回终态，许可才回来。
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Cancelled {
                job_id: background.job_id.clone()
            },
            3
        ));
        let next = scheduler.take_next().expect("running 空了");
        assert_eq!(next.job_id, foreground.job_id);

        // 提升一个后台任务不产生新 job（不重复计算）。
        let other = scheduler
            .submit(key("other", 1), Priority::Background, 4)
            .expect("收下");
        assert_eq!(scheduler.promote(&other.job_id), PromoteOutcome::Promoted);
        assert_eq!(scheduler.promote(&other.job_id), PromoteOutcome::AlreadyForeground);
        assert_eq!(
            scheduler
                .snapshot(&other.job_id)
                .expect("任务在")
                .subscribers,
            1
        );
    }

    #[test]
    fn a_background_sweep_keeps_a_cursor_and_only_materializes_what_fits() {
        let mut scheduler = Scheduler::new(EPOCH);
        scheduler.open_sweep("book", 500);

        let mut materialized = 0;
        while let Some(page) = scheduler.next_sweep_page("book") {
            let submitted = scheduler
                .submit(key("book", page), Priority::Background, page as u64)
                .expect("游标只在我们确认有槽位时才前进");
            assert!(!submitted.coalesced);
            materialized += 1;
            assert!(materialized <= BACKGROUND_SLOTS);
        }
        assert_eq!(materialized, BACKGROUND_SLOTS);
        assert_eq!(
            scheduler.snapshot_count(),
            BACKGROUND_SLOTS,
            "500 页不该变成 500 个排队对象"
        );

        // 让一件上 running：队列腾出一个后台槽位，游标才继续。
        let dispatched = scheduler.take_next().expect("后台可以上");
        let page = scheduler.next_sweep_page("book").expect("腾出一个槽位");
        assert_eq!(page, BACKGROUND_SLOTS as u32);
        // 游标只给页码，不替我们建任务：必须自己确认收下，散热才算数。
        scheduler
            .submit(key("book", page), Priority::Background, page as u64)
            .expect("收下");
        assert_eq!(scheduler.snapshot_count(), BACKGROUND_SLOTS + 1);
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Completed {
                job_id: dispatched.job_id
            },
            100
        ));
        // 上一件收尾了，但队列又满了（8 个排队），游标照样不许动：它看的是**可派发的槽位**。
        assert_eq!(scheduler.next_sweep_page("book"), None);
        let next = scheduler.take_next().expect("队列里还有活");
        assert_eq!(scheduler.next_sweep_page("book"), Some(page + 1));
        assert!(!next.job_id.is_empty());
        assert_eq!(scheduler.next_sweep_page("unknown-book"), None);
    }

    #[test]
    fn a_new_reader_generation_drops_the_queued_jobs_of_the_old_one() {
        let mut scheduler = Scheduler::new(EPOCH);
        let running = scheduler
            .submit(key_of_generation("book", 0, 1), Priority::Background, 0)
            .expect("收下");
        let dispatched = scheduler.take_next().expect("上 running");
        assert_eq!(dispatched.job_id, running.job_id);
        let queued_a = scheduler
            .submit(key_of_generation("book", 1, 1), Priority::Background, 0)
            .expect("收下");
        let queued_b = scheduler
            .submit(key_of_generation("book", 2, 1), Priority::Background, 0)
            .expect("收下");
        let fresh = scheduler
            .submit(key_of_generation("book", 3, 2), Priority::Background, 0)
            .expect("收下");

        let dropped = scheduler.drop_generation("book", 2, 0);
        assert_eq!(dropped.queued, 2);
        assert_eq!(
            dropped.running, 1,
            "在跑的那件不能凭空消失，等它自己收尾"
        );
        assert_eq!(
            state_of(&scheduler, &queued_a.job_id),
            JobState::Cancelled
        );
        assert_eq!(
            state_of(&scheduler, &queued_b.job_id),
            JobState::Cancelled
        );
        assert_eq!(state_of(&scheduler, &running.job_id), JobState::Dispatched);
        assert_eq!(state_of(&scheduler, &fresh.job_id), JobState::Queued);
    }

    #[test]
    fn events_from_an_old_worker_epoch_are_ignored() {
        let mut scheduler = Scheduler::new(EPOCH);
        let submitted = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Accepted {
                job_id: submitted.job_id.clone()
            },
            1
        ));

        assert!(
            !scheduler.apply_worker_event(
                EPOCH + 1,
                WorkerEvent::Completed {
                    job_id: submitted.job_id.clone()
                },
                2
            ),
            "下一代 worker 的终态不能结算这一代的任务"
        );
        assert!(!state_of(&scheduler, &submitted.job_id).is_terminal());

        // worker 换代：在飞的标 worker_lost。
        assert_eq!(scheduler.begin_epoch(EPOCH + 1, 2), 1);
        assert_eq!(
            state_of(&scheduler, &submitted.job_id),
            JobState::Failed {
                code: WORKER_LOST_CODE.to_string()
            }
        );
        assert_eq!(scheduler.epoch(), EPOCH + 1);
        assert_eq!(scheduler.running_job(), None);
    }

    #[test]
    fn a_terminal_state_is_only_settled_once() {
        let mut scheduler = Scheduler::new(EPOCH);
        let submitted = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Completed {
                job_id: submitted.job_id.clone()
            },
            5
        ));
        assert!(
            !scheduler.apply_worker_event(
                EPOCH,
                WorkerEvent::Completed {
                    job_id: submitted.job_id.clone()
                },
                6
            ),
            "重复的终态不能再发一次"
        );
        assert!(!scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Failed {
                job_id: submitted.job_id.clone(),
                code: "X".to_string()
            },
            7
        ));
        assert_eq!(state_of(&scheduler, &submitted.job_id), JobState::Completed);
        assert!(!scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Stage {
                job_id: submitted.job_id.clone(),
                stage: "s".to_string(),
                index: 1
            },
            8
        ));
    }

    #[test]
    fn terminal_snapshots_are_capped() {
        let mut scheduler = Scheduler::new(EPOCH);
        let mut ids = Vec::new();
        for page in 0..(MAX_TERMINAL_SNAPSHOTS as u32 + 72) {
            let submitted = scheduler
                .submit(key("book", page), Priority::Background, page as u64)
                .expect("一件一件来，槽位总是有的");
            let dispatched = scheduler.take_next().expect("上 running");
            assert_eq!(dispatched.job_id, submitted.job_id);
            assert!(scheduler.apply_worker_event(
                EPOCH,
                WorkerEvent::Completed {
                    job_id: submitted.job_id.clone()
                },
                page as u64 + 1
            ));
            ids.push(submitted.job_id);
        }
        assert!(
            scheduler.terminal_count() <= MAX_TERMINAL_SNAPSHOTS,
            "终态快照必须有上限，实得 {}",
            scheduler.terminal_count()
        );
        assert!(
            scheduler.snapshot(&ids[0]).is_none(),
            "最老的终态要被回收"
        );
        let recent = ids.last().expect("有任务").clone();
        assert!(
            scheduler.snapshot(&recent).is_some(),
            "最近的终态还要能查（断订阅恢复用）"
        );
        assert_eq!(
            scheduler.snapshots(&[recent.clone(), ids[0].clone()]).len(),
            1
        );
    }

    #[test]
    fn a_stale_terminal_is_recycled_by_ttl() {
        let mut scheduler = Scheduler::new(EPOCH);
        let submitted = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Completed {
                job_id: submitted.job_id.clone()
            },
            1
        ));
        assert_eq!(scheduler.retain(TERMINAL_TTL_MS), 0, "还没到点");
        assert_eq!(scheduler.retain(TERMINAL_TTL_MS + 10), 1);
        assert!(scheduler.snapshot(&submitted.job_id).is_none());
    }

    #[test]
    fn a_worker_failure_becomes_a_terminal_with_its_code() {
        let mut scheduler = Scheduler::new(EPOCH);
        let submitted = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        assert!(scheduler.apply_worker_event(
            EPOCH,
            WorkerEvent::Failed {
                job_id: submitted.job_id.clone(),
                code: "GPU_OUTPUT_INVALID".to_string()
            },
            3
        ));
        assert_eq!(
            state_of(&scheduler, &submitted.job_id),
            JobState::Failed {
                code: "GPU_OUTPUT_INVALID".to_string()
            }
        );
        assert_eq!(scheduler.running_job(), None);
        assert_eq!(
            scheduler.cancel(&submitted.job_id, 1, 4),
            CancelOutcome::AlreadyTerminal
        );
    }

    #[test]
    fn a_host_side_cancel_does_not_spend_a_subscription() {
        let mut scheduler = Scheduler::new(EPOCH);
        let submitted = scheduler
            .submit(key("book", 0), Priority::Background, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        assert!(
            scheduler.request_cancel(&submitted.job_id),
            "在跑的后台任务：宿主可以要求它让路"
        );
        assert_eq!(
            state_of(&scheduler, &submitted.job_id),
            JobState::CancelRequested,
            "置成「已请求」，等 worker 的终态回来"
        );
        assert_eq!(
            scheduler.running_job(),
            Some(submitted.job_id.as_str()),
            "许可不能因为「请求了取消」就当成空闲"
        );
        assert!(
            !scheduler.request_cancel(&submitted.job_id),
            "已经在取消中的不能再置一次"
        );
        assert!(
            !scheduler.request_cancel("不存在的号"),
            "不知道的任务就是 false"
        );
    }

    #[test]
    fn a_broken_worker_fails_everything_that_was_still_waiting() {
        let mut scheduler = Scheduler::new(EPOCH);
        let running = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        scheduler.take_next().expect("上 running");
        let waiting = scheduler
            .submit(key("book", 1), Priority::Background, 0)
            .expect("收下");
        let also_waiting = scheduler
            .submit(key("book", 2), Priority::Background, 0)
            .expect("收下");
        let done = scheduler
            .submit(key("book", 3), Priority::Foreground, 0)
            .expect("收下");
        scheduler
            .apply_worker_event(
                EPOCH,
                WorkerEvent::Completed {
                    job_id: done.job_id.clone(),
                },
                0,
            );
        let failed = scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, 5);
        assert_eq!(failed.len(), 2, "只清排队中的两件");
        assert_eq!(
            state_of(&scheduler, &waiting.job_id),
            JobState::Failed {
                code: WORKER_UNAVAILABLE_CODE.to_string()
            }
        );
        assert_eq!(
            state_of(&scheduler, &also_waiting.job_id),
            JobState::Failed {
                code: WORKER_UNAVAILABLE_CODE.to_string()
            }
        );
        assert_eq!(
            state_of(&scheduler, &running.job_id),
            JobState::Dispatched,
            "在飞的由 begin_epoch 收尾，不在这里动"
        );
        assert_eq!(
            state_of(&scheduler, &done.job_id),
            JobState::Completed,
            "已经结束的不再改"
        );
    }

    #[test]
    fn all_snapshots_come_back_in_a_stable_order() {
        let mut scheduler = Scheduler::new(EPOCH);
        let first = scheduler
            .submit(key("book", 0), Priority::Foreground, 0)
            .expect("收下");
        let second = scheduler
            .submit(key("book", 1), Priority::Foreground, 1)
            .expect("收下");
        let all = scheduler.all();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].job_id, first.job_id, "按序号升序，先来的在前");
        assert_eq!(all[1].job_id, second.job_id);
    }
}
