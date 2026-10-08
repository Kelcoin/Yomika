//! 会话状态机（docs/71 §6.1–§6.5、§11 Task 3）。
//!
//! 对 `Read`/`Write` 泛型，所以整条协议能在内存双工上被测到。三件事在这里定死：
//!
//! - **控制面与计算面分开**：主线程只做读帧与派发（ping/cancel/shutdown 立刻响应），
//!   重任务在[`crate::executor`]的独立线程里串行跑；两边共用一条字节流，靠
//!   [`Writer`] 里那把锁保证任何一帧都是一次写完的。
//! - **只服务一个重任务**：第二个 `run` 一律回 `failed{code=COMPUTE_WORKER_BUSY}`，
//!   不藏队列（协议里没有 `busy` 变体，就用终态明说）。
//! - **旧 epoch 一律不处理**：换过 worker 之后迟到的消息不得再影响任何东西。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};

use yomika_compute_core::cancel::{self, TaskGuard};
use yomika_compute_protocol::frame::{read_frame, write_frame};
use yomika_compute_protocol::messages::{
    self, BuildInfo, Failed, Hello, JobRef, Message, ProtocolError, Run, WorkspacesReleased,
    PROTOCOL_MAJOR,
};

use crate::engine::Engine;
use crate::executor;

/// 这个 worker 进程的身份是宿主给的：`worker_epoch` 由宿主随机生成，worker 不许自己编。
pub struct SessionOptions {
    /// 宿主为本次 spawn 生成的身份；worker 的一切消息都带它。
    pub worker_epoch: String,
    /// 握手用的 nonce。协议消息里没有单独的字段，宿主把它编进 `worker_epoch`
    /// （两边都靠这个不可猜的身份串确认「对面就是本次 spawn 的那一个」）；这里留着
    /// 是为了日志与 Task 4 的管道 peer 校验。
    pub nonce: u64,
    /// 宿主授权的 staging 根目录，产物只能写在这下面。
    pub staging_root: PathBuf,
    /// 宿主授权的只读输入根目录（docs/71 §7.1）。任务里那个 `relative_path` 只在
    /// 这下面解析，绝不接受绝对路径或 `..`。
    pub input_root: PathBuf,
    /// `hello` 里报给宿主的构建信息。
    pub build: BuildInfo,
    /// 诊断输出（stderr）的字节上限——诊断通道永远不许被写爆（§6.1）。
    pub log_budget: usize,
    /// 把这一代进程里缓存的引擎工作区交回系统，返回交回了几份。
    ///
    /// 由调用方递进来（与核心 `set_skip_logger` 同一个手法）：真工作区只有在真 NGX 跑过
    /// 之后才数得出来，而协议要**据实**回答——测试进程里没有那份 DLL，一个编出来的数字
    /// 比没有更坏（界面会拿它当「内存已经回落了」）。
    pub release_workspaces: fn() -> u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionOutcome {
    /// 父进程关掉了管道（正常收场）。
    PeerClosed,
    /// 宿主发了 `shutdown`。
    Shutdown,
    /// 对面说的协议大版本不是我们能说的那个（§6.2：立刻拒绝，不猜）。
    VersionMismatch,
    /// 对面在找一个**另一个** worker 实例。
    EpochMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    Io(String),
    Frame(String),
    Protocol(String),
}

/// 有上限的 stderr 诊断。协议帧只走管道，stdout/stderr 只是诊断（§6.1/§6.2）。
#[derive(Clone)]
pub(crate) struct Log {
    budget: Arc<AtomicUsize>,
}

impl Log {
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            budget: Arc::new(AtomicUsize::new(budget)),
        }
    }

    pub(crate) fn line(&self, message: &str) {
        let remaining = self.budget.load(Ordering::Relaxed);
        if remaining == 0 {
            return;
        }
        let text: String = message.chars().take(remaining.min(512)).collect();
        let used = text.len();
        let _ = self
            .budget
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(used))
            });
        eprintln!("[worker] {text}");
    }
}

/// 写帧的那个口子。执行器线程与会话主线程共用它：**锁必须盖住整帧**，否则两个
/// 线程交替写同一个流，后面的每一帧都会错位（这是「无半帧死锁」那条的正面要求）。
pub(crate) struct Writer<W: Write> {
    inner: Mutex<W>,
    log: Log,
}

impl<W: Write> Writer<W> {
    fn new(inner: W, log: Log) -> Self {
        Self {
            inner: Mutex::new(inner),
            log,
        }
    }

    pub(crate) fn send(&self, message: &Message) -> Result<(), SessionError> {
        let body = messages::encode(message)
            .map_err(|error| SessionError::Protocol(format!("{error:?}")))?;
        // 锁必须盖住整帧：两次写交错出来的是半帧，后面所有帧都再也解不回来。
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_frame(&mut *guard, body.as_bytes())
            .map_err(|error| SessionError::Frame(format!("{error:?}")))?;
        Ok(())
    }

    pub(crate) fn send_or_log(&self, message: &Message) {
        if let Err(error) = self.send(message) {
            self.log
                .line(&format!("发 {} 失败：{error:?}", message.kind()));
        }
    }
}

/// 产物裁决：宿主核对了 hash/大小之后回 `artifact_ack`，否则 `artifact_rejected`；
/// 等裁决期间来的取消也要能立刻把执行器叫醒。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SlotDecision {
    Ack,
    Rejected(String),
    Cancelled,
}

pub(crate) struct ArtifactSlot {
    state: Mutex<Option<SlotDecision>>,
    cv: Condvar,
}

impl ArtifactSlot {
    fn new() -> Self {
        Self {
            state: Mutex::new(None),
            cv: Condvar::new(),
        }
    }

    fn decide(&self, decision: SlotDecision) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.is_none() {
            *state = Some(decision);
            self.cv.notify_all();
        }
    }

    pub(crate) fn wait(&self) -> SlotDecision {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.is_none() {
            state = self.cv.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state.clone().expect("上面已确认有裁决")
    }
}

pub(crate) struct Waiters {
    slots: Mutex<HashMap<String, Arc<ArtifactSlot>>>,
}

impl Waiters {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn insert(&self, artifact_id: String) -> Arc<ArtifactSlot> {
        let slot = Arc::new(ArtifactSlot::new());
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(artifact_id, slot.clone());
        slot
    }

    pub(crate) fn remove(&self, artifact_id: &str) {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(artifact_id);
    }

    pub(crate) fn decide(&self, artifact_id: &str, decision: SlotDecision) {
        let slot = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(artifact_id)
            .cloned();
        // 迟到或重复的裁决一律不处理（§6.5：终态只转换一次）。
        if let Some(slot) = slot {
            slot.decide(decision);
        }    }

    pub(crate) fn cancel_all(&self) {
        let slots: Vec<Arc<ArtifactSlot>> = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for slot in slots {
            slot.decide(SlotDecision::Cancelled);
        }
    }
}

/// 交给执行器的一个任务。
pub(crate) struct JobEnvelope {
    pub(crate) run: Run,
    pub(crate) guard: TaskGuard,
    /// 执行器跑完（不管成没成）把它置位，主线程据此判断「是否可以接下一个」。
    pub(crate) finished: Arc<AtomicBool>,
}

struct RunningJob {
    /// 取消牌在核心注册表里的键：**带 worker epoch 前缀**。
    ///
    /// 那张表是进程级的，而 job id 只在一次会话内唯一。worker 重启（新 epoch）后宿主完全
    /// 可以再用一次 `job-1`；上一轮留下的「还没登记就先到的取消」如果按裸 job id 存着，
    /// 就会把新会话的第一个任务一出生就掐掉——这是实测踩到的坑，不是理论担心。
    cancel_key: String,
    finished: Arc<AtomicBool>,
}

/// 取消注册表的键：epoch 与 job id 都要，缺一个就会跨会话串味。
fn cancel_key(epoch: &str, job_id: &str) -> String {
    format!("{epoch}/{job_id}")
}

/// 跑一条会话：先自报家门，然后一直读到对面关闭、`shutdown` 或协议不符为止。
///
/// 执行器线程是**分离**的（返回时不 join）：重任务没法被安全打断，宿主按 §6.5
/// 超时杀进程，而不是等 worker 自己体面收尾。返回前会给当前任务置取消牌，
/// 让守规矩的引擎自己停下。
pub fn run<R, W, E>(
    reader: R,
    writer: W,
    engine: E,
    options: SessionOptions,
) -> Result<SessionOutcome, SessionError>
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
    E: Engine,
{
    let log = Log::new(options.log_budget);
    let writer = Arc::new(Writer::new(writer, log.clone()));

    writer.send(&Message::Hello(Hello {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: options.worker_epoch.clone(),
        build: options.build.clone(),
    }))?;
    log.line(&format!(
        "hello 已发：epoch={} nonce={}",
        options.worker_epoch, options.nonce
    ));

    let waiters = Arc::new(Waiters::new());
    let (sender, receiver) = mpsc::channel::<JobEnvelope>();
    let current: Arc<Mutex<Option<RunningJob>>> = Arc::new(Mutex::new(None));
    let last_job: Arc<Mutex<Option<JobRef>>> = Arc::new(Mutex::new(None));

    // 执行器线程是**分离**的：句柄直接丢掉，返回时不 join。重任务没法被安全打断，
    // 宿主按 §6.5 超时杀进程，而不是等 worker 自己体面收尾。
    //
    // 引擎用 `Arc` 传两份而不是整份搬进执行器：会话主线程也要用同一个引擎——闲置回收
    // 那一步要把它缓存的模型交回去（§12.4），而那份缓存就在这个对象里。`Engine` 的实现
    // 必须线程安全（trait 上就有 `Send + Sync`），两份引用只共享一个对象。
    let engine = Arc::new(engine);
    drop(executor::spawn(
        Arc::clone(&engine),
        writer.clone(),
        waiters.clone(),
        options.staging_root.clone(),
        options.input_root.clone(),
        options.worker_epoch.clone(),
        receiver,
        log.clone(),
    ));

    let mut reader = reader;
    let mut handshaken = false;
    loop {
        let body = match read_frame(&mut reader) {
            Ok(Some(body)) => body,
            Ok(None) => {
                log.line("父进程关掉了管道，收摊");
                stop_running(&current);
                return Ok(SessionOutcome::PeerClosed);
            }
            Err(error) => {
                stop_running(&current);
                return Err(SessionError::Frame(format!("{error:?}")));
            }
        };
        let message = match messages::parse(&body) {
            Ok(message) => message,
            // 大版本不符要在看正文之前就拒绝，不能在未知形状上猜（§6.2）。
            Err(ProtocolError::UnknownVersion { found }) => {
                log.line(&format!("对面说的是协议 {found}，不是 {PROTOCOL_MAJOR}"));
                stop_running(&current);
                return Ok(SessionOutcome::VersionMismatch);
            }
            Err(ProtocolError::MissingVersion) => {
                log.line("对面没带 protocolVersion");
                stop_running(&current);
                return Ok(SessionOutcome::VersionMismatch);
            }
            Err(error) => {
                stop_running(&current);
                return Err(SessionError::Protocol(format!("{error:?}")));
            }
        };

        // 握手先于 epoch 过滤：epoch 不对正是我们要回答的那种情况。
        if let Message::HelloAck(ack) = &message {
            if handshaken {
                log.line("重复的 hello_ack，忽略");
                continue;
            }
            if ack.worker_epoch != options.worker_epoch {
                log.line(&format!(
                    "对面在找 {}，我们是 {}",
                    ack.worker_epoch, options.worker_epoch
                ));
                stop_running(&current);
                return Ok(SessionOutcome::EpochMismatch);
            }
            handshaken = true;
            log.line(&format!("握手完成，宿主支持 feature：{:?}", ack.features));
            continue;
        }

        if !message.matches_epoch(&options.worker_epoch) {
            // 旧 worker 迟到/串台的消息：不处理，但也别把整个会话弄死（§6.2）。
            log.line(&format!(
                "忽略不属于本 epoch 的 {}（{}）",
                message.kind(),
                message.epoch()
            ));
            continue;
        }

        match message {
            Message::Run(run) => {
                if !handshaken {
                    writer.send_or_log(&failure(
                        &options.worker_epoch,
                        &run,
                        "COMPUTE_PROTOCOL_MISMATCH",
                        "还没有握手就发 run",
                    ));
                    continue;
                }
                if let Err(error) = messages::validate_message(&Message::Run(run.clone())) {
                    writer.send_or_log(&failure(
                        &options.worker_epoch,
                        &run,
                        "COMPUTE_PROTOCOL_MISMATCH",
                        &format!("run 越界：{error:?}"),
                    ));
                    continue;
                }
                if is_busy(&current) {
                    // 只服务一个重任务：第二个明说 busy，让宿主自己排队（§6.3）。
                    writer.send_or_log(&failure(
                        &options.worker_epoch,
                        &run,
                        "COMPUTE_WORKER_BUSY",
                        "已经有一个正在执行的任务",
                    ));
                    continue;
                }
                let reference = JobRef {
                    protocol_version: PROTOCOL_MAJOR,
                    worker_epoch: options.worker_epoch.clone(),
                    job_id: run.job_id.clone(),
                    generation: run.generation,
                };
                let finished = Arc::new(AtomicBool::new(false));
                let key = cancel_key(&options.worker_epoch, &run.job_id);
                *current.lock().unwrap_or_else(|p| p.into_inner()) = Some(RunningJob {
                    cancel_key: key.clone(),
                    finished: finished.clone(),
                });
                *last_job.lock().unwrap_or_else(|p| p.into_inner()) = Some(reference.clone());
                writer.send_or_log(&Message::Accepted(reference));
                let guard = cancel::begin(Some(&key));
                if sender
                    .send(JobEnvelope {
                        run,
                        guard,
                        finished,
                    })
                    .is_err()
                {
                    log.line("执行器没了，无法派发");
                }
            }
            Message::Cancel(reference) => {
                // 立刻置牌：引擎在下一个检查点停下；等裁决的那一份也一并叫醒。
                let cancelled = cancel::cancel(&cancel_key(
                    &options.worker_epoch,
                    &reference.job_id,
                ));
                waiters.cancel_all();
                log.line(&format!(
                    "取消 {}：{}",
                    reference.job_id,
                    if cancelled { "已置牌" } else { "没有在跑的任务" }
                ));
            }
            Message::ArtifactAck(reference) => waiters.decide(&reference.artifact_id, SlotDecision::Ack),
            Message::ArtifactRejected(reference) => waiters.decide(
                &reference.artifact_id,
                SlotDecision::Rejected(
                    reference
                        .reason
                        .unwrap_or_else(|| "宿主拒绝但没给理由".to_string()),
                ),
            ),
            Message::Ping(ping) => writer.send_or_log(&Message::Pong(ping)),
            Message::ReleaseIdle(_) => {
                // §6.3/§8.4：宿主在闲置时把工作区收回去。这件事分两步说清楚——
                // **真的交回**（引擎的 D3D12 工作区与模型缓存只在这个进程里），然后报
                // 「交回了几份」。前者是动作，后者是结果：只有一句「收到了」等于让宿主猜
                // 内存有没有回落。
                //
                // 两半各归各的：进程级那半（NGX 工作区，兼测试钩子）走选项里的函数指针，
                // 模型缓存那半走引擎自己——ONNX 会话与修补的三个会话位都不在协议这一层，
                // 而它们恰恰是闲置时最占内存的部分（§12.4「idle30 秒释放模型/workspace」）。
                let workspaces = (options.release_workspaces)();
                let models = engine.release_cached_models();
                let count = workspaces + models;
                log.line(&format!(
                    "release_idle：交回 {count} 份（模型/会话 {models}，NGX 工作区 {workspaces}）"
                ));
                // worker 自己不持有宿主侧的 grant；有过的最后一个任务就是额度回执的载体。
                // 一个任务都没有时协议里没有「无名 released」，记一笔就够（`released` 不是
                // 终态，宿主只拿它把额度对上号）。
                let job = last_job.lock().unwrap_or_else(|p| p.into_inner()).clone();
                match job {
                    Some(reference) => writer.send_or_log(&Message::Released(reference)),
                    None => log.line("release_idle 时还没有任何任务，没有额度回执可发"),
                }
                writer.send_or_log(&Message::WorkspacesReleased(WorkspacesReleased {
                    protocol_version: PROTOCOL_MAJOR,
                    worker_epoch: options.worker_epoch.clone(),
                    count,
                }));
            }
            Message::Shutdown(_) => {
                log.line("收到 shutdown");
                stop_running(&current);
                return Ok(SessionOutcome::Shutdown);
            }
            other => {
                let kind = other.kind();
                if worker_only(kind) {
                    stop_running(&current);
                    return Err(SessionError::Protocol(format!(
                        "宿主发来了只该 worker 发的 {kind}"
                    )));
                }
                log.line(&format!("忽略 {kind}"));
            }
        }
    }
}

fn is_busy(current: &Mutex<Option<RunningJob>>) -> bool {
    current
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .is_some_and(|running| !running.finished.load(Ordering::SeqCst))
}

fn stop_running(current: &Mutex<Option<RunningJob>>) {
    let target = current
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|running| {
            // 已经跑完的任务不要再「取消」一遍：核心的取消表会把查不到的号存成
            // 「还没登记就先到的取消」，那些号永远不会有人来认领，只是白占有限的槽位。
            if running.finished.load(Ordering::SeqCst) {
                None
            } else {
                Some(running.cancel_key.clone())
            }
        });
    if let Some(cancel_key) = target {
        cancel::cancel(&cancel_key);
    }
}

/// 只该 worker 往外发的那些类型。宿主发来它们就是走错了方向。
fn worker_only(kind: &str) -> bool {
    matches!(
        kind,
        "hello"
            | "stage_started"
            | "progress"
            | "artifact_ready"
            | "completed"
            | "cancelled"
            | "failed"
            | "released"
            | "workspaces_released"
            | "pong"
    )
}

fn failure(epoch: &str, run: &Run, code: &str, message: &str) -> Message {
    Message::Failed(Failed {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch.to_string(),
        job_id: run.job_id.clone(),
        generation: run.generation,
        code: code.to_string(),
        message: message.to_string(),
    })
}

