//! 宿主侧 supervisor：worker 进程的一生 + 队列派发 + 取消升级 + 失败重启
//! （docs/71 §6.5、§8、§11 Task 4）。
//!
//! 三条纪律决定了这里的形状：
//!
//! 1. **界面线程不碰进程、不碰管道、不等待**。spawn、accept、握手、写管道、等进程退出、
//!    算哈希全在 supervisor 线程里；对外的入口只做「锁一下状态 → 登记/读取 → 放锁 → 通知」。
//! 2. **绝不把状态锁带进等待**（§11 Task 4 ⑤）。控制线程锁状态时只做纯计算，锁里不做 IO。
//! 3. **并发 1**。真正能同时跑的重计算只有一件（§8.1）；排队、合并、让路都在
//!    [`super::scheduler`] 里，这里不靠「多开几个 worker」解决排队。

use std::collections::{HashMap, VecDeque};
// 只有测试与 staging 清扫用文件系统（生产路径上的产物都走 `artifacts` 那层）。
#[cfg(test)]
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use yomika_compute_protocol::{
    encode, parse, read_frame, write_frame, ArtifactReady, ArtifactRef, Budgets, BuildInfo,
    EngineFallback, EpochOnly, HelloAck, JobRef, Message, PipelineStage, Run, RunInput,
    StageProgress, WorkspacesReleased, MAX_FRAME_BYTES, PROTOCOL_MAJOR,
};
// `Ping` 是唯一没被协议 crate 的根再导出的消息类型，得从模块里拿。
use yomika_compute_protocol::messages::Ping;
use yomika_compute_transport::pipe::PipeStream;
use yomika_compute_transport::server::PipeServer;

use super::job_object::{JobLimits, JobObject};
use super::resource_policy::{
    self, Admission, CANCEL_GRACE_MS, DEFAULT_DEADLINE_MS, HANDSHAKE_TIMEOUT_MS, IDLE_RELEASE_MS,
    IDLE_SHUTDOWN_MS, MAX_RESTARTS_PER_WINDOW, PING_INTERVAL_MS, PROGRESS_MIN_INTERVAL_MS,
    RESTART_WINDOW_MS, SHUTDOWN_GRACE_MS,
};
use super::scheduler::{
    CancelOutcome, Dispatched, DroppedGeneration, JobKey, JobSnapshot, JobState, Priority,
    PromoteOutcome, Scheduler, SubmitError, Submitted, WorkerEvent, WORKER_UNAVAILABLE_CODE,
};

/// 落盘之后、`artifact_ack` 之前宿主自己核出来的产物记录。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub job_id: String,
    pub stage_id: String,
    pub artifact_id: String,
    /// worker 自己给的名字（staging 根下的裸文件名）。
    pub staging_name: String,
    /// 宿主发布之后真正的落点。配了发布根时是内容寻址路径，否则还在 staging 里。
    pub path: PathBuf,
    /// 内容寻址的相对路径。`None` = 没有发布根（开发/测试），产物只留在 staging。
    pub cache_relative: Option<String>,
    pub byte_length: u64,
    pub content_hash: String,
    /// 图片声明经过宿主文件头核验；非图片 echo 探针仅保留协议元数据。
    pub width: u32,
    pub height: u32,
    pub engine_id: String,
    pub engine_precision: String,
    /// 这一阶段**被问的是哪条引擎政策**（`auto`/`cpu`/`gpu`）。`None` = 那次报告没
    /// 交代（老 worker，或事实驱动的那条路），不是「跑的是 CPU」。
    pub engine_policy: Option<String>,
    /// 真回退时的交代（想要谁 / 用了谁 / 为什么）。没有回退就是 `None`。
    /// 界面靠它把「我点名要显卡」与「自动退回去」分开说，见 docs/71:126。
    pub engine_fallback: Option<EngineFallback>,
    pub pipeline_revision: String,
    /// 宿主自己重算过哈希、对过长度。
    pub verified: bool,
}

/// 宿主自己的账目对不上时用的错误码（比如排到一件任务却没有它的派发模板）。
/// 这不是 worker 的错，所以不用 `COMPUTE_WORKER_LOST` 冒充。
const INTERNAL_CODE: &str = "COMPUTE_INTERNAL";

/// 「这一页的输入宿主都摆不出来」时用的错误码：没有源文件、读不出来、或者摆进只读
/// 输入根失败。它与 worker 报的同名码是一回事——**输入不对**，只是发现得更早。
const INPUT_INVALID_CODE: &str = "COMPUTE_INPUT_INVALID";

/// 探不到物理内存时的兜底：宁可把阈值算小（更早停后台），也不要假装内存无限。
const FALLBACK_RAM_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// 控制线程的节拍。所有期限（握手、心跳、取消宽限、闲置、退避）都在这个粒度上检查，
/// 所以它要明显小于最短的那个期限（2 秒）。
const TICK: Duration = Duration::from_millis(200);

/// 等 worker 回一句「交回了几份工作区」的上限（§8.4）。
///
/// 交回是**一问一答**：NGX 的工作区在 worker 进程里，宿主只能请它交。它可能在算别的、
/// 管道也可能堵着，所以这个等待必须有底——到点就答 0 走人，界面不等 GPU。取 1.5 s：
/// 超过 [`TICK`] 好几拍（真交回就是一次 delete），又短到用户按下去不至于觉得卡住。
const RELEASE_REPLY_TIMEOUT: Duration = Duration::from_millis(1500);

/// 前端的进度提示（§8.2 节流到 5 Hz）。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub stage_id: String,
    pub percent: f32,
    pub updated_ms: u64,
}

/// 宿主眼里 worker 的状态。**不撒谎**：没起来就是没起来，限制没生效就说没生效。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
// `rename_all` 只改**变体名**；结构体变体的**字段**要 `rename_all_fields` 才会跟着改。
// 桥那头（`src/domain/compute.ts` 的 `ComputeWorkerStatusSchema`）只认 camelCase，
// 少了这一句，`compute_worker_status` 的响应在界面上永远解不出来。
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum WorkerStatus {
    /// 没有要跑的东西，也就没有 worker。不是「坏了」。
    Stopped,
    Starting {
        epoch: u64,
    },
    Ready {
        epoch: u64,
        peer_pid: u32,
        /// Job Object 是否真的套上了。没套上不等于不能算，但界面上必须分得开。
        limits_applied: bool,
        limits_note: Option<String>,
    },
    /// 重启上限用完：不再自动重试，等用户手动重试（§8.3）。
    Broken {
        reason: String,
    },
}

/// 宿主自己那一份构建戳（`build.rs` 编进来的那个串）。
///
/// 放在 lib 里而不是某个函数里：集成测试是独立 crate，`env!` 在那儿取不到宿主的构建
/// 环境，只有 lib 里这个常量才是「主 exe 里真正嵌着的那串」。worker 报的是同一件事，
/// 两串一对，就知道这一份 worker 是不是给这个宿主编的（Task 10 第 2 条）。
pub const HOST_BUILD_COMMIT: &str = env!("YOMIKA_BUILD_COMMIT");

/// 两边的构建戳能不能拼在一起。
///
/// 三种现场必须分得开，因为处置不一样：一样 ⇒ 用；宿主自己没戳 ⇒ 判不出来，只能放行
/// 并留一句话（没 git 的机器上从源码编出来的两份都是这样）；对不上或对面根本没报 ⇒
/// 拒跑——「不拼旧 worker 新 host」是 Task 10 的原文。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StampVerdict {
    Same,
    HostUnknown,
    Mismatch { host: String, worker: String },
}

/// 判两串构建戳（纯函数，好让三种现场各自有一条断言）。
pub fn build_stamp_verdict(host: &str, worker: &str) -> StampVerdict {
    if host.is_empty() {
        return StampVerdict::HostUnknown;
    }
    if host == worker {
        return StampVerdict::Same;
    }
    StampVerdict::Mismatch {
        host: host.to_string(),
        worker: worker.to_string(),
    }
}

/// 事件出口。Task 6 会把它接到 Tauri 的 `emit` 上；测试里就是个记事本。
///
/// 约束：**回调里不许再调 [`ComputeManager`] 的方法**（它会回头锁状态，而事件正是从状态
/// 锁里推出来的）。这里保证回调一定在锁外被调用。
pub type EventSink = Arc<dyn Fn(&JobSnapshot) + Send + Sync>;

pub fn no_events() -> EventSink {
    Arc::new(|_| {})
}

/// 派发一件任务需要的全部输入。`job_id` / `worker_epoch` / `generation` / `budgets`
/// 由 manager 在派发那一刻补上——它们取决于「哪一代 worker」和「排到谁」，不是调用方的事。
#[derive(Clone, Debug)]
pub struct SubmitRequest {
    pub key: JobKey,
    pub priority: Priority,
    pub input: RunInput,
    pub pipeline: Vec<PipelineStage>,
    pub output_grant_id: String,
    pub deadline_ms: u64,
    /// 这一页的源文件：宿主自己解析出来的位置 + 索引里说的那一份。
    ///
    /// 前端**给不了**这份东西（`compute::commands::plan` 会当场拒掉自带 `relativePath`
    /// 的提交，docs/71 §7.1）：一页图到底对应哪个文件，是宿主从归档/缓存里读出来的
    /// 事实。`None` = 这次提交不带源图（只有回声引擎需要这种提交，见 `prepare_run`）。
    ///
    /// 哈希不是顺手带上的：内容寻址的位置理论上不可能装着别的字节，但真要是被写坏了、
    /// 或者数据目录被人动过，派发前准备**必须当场发现**，而不是拿别的页去算一遍再交出
    /// 一张看着正常的图（见 `prepare_run`）。
    pub source: Option<SourceFile>,
    /// 去码阶段要摆进只读输入根的东西：检测器 + 两份修补模型的磁盘路径。
    ///
    /// 与 `source` 同一个道理：那是**宿主自己**才有的位置，渲染进程给不了。`prepare_run`
    /// 把它读出来、按内容寻址摆进输入根，再换成阶段上那份 `DecensorGrant`——调用方（包括
    /// 命令层）从头到尾说不出任何输入根里的文件名。
    pub inpaint: Option<super::decensor::InpaintPreparation>,
}

/// 宿主解析出来的一份源图：位置 + 它自称的那一份哈希与长度。
///
/// 三个字段都来自**索引**（`cache::cached_blob_location` 读的主键行），不是文件系统。
/// 文件系统那边的说法由 `prepare_run` 当场量：哈希对不上就停下（长度由它自己测出来）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFile {
    pub path: PathBuf,
    pub content_hash: String,
    pub byte_length: u64,
}

/// 索引查到的那一行，就是一份源文件。
///
/// 为什么要有这个转换：查位置（`cache::cached_blob_location`）与「交一份源图」是两件事，
/// 但字段是同一份。少了它，命令层与阅读器那道门会各自手抄一遍三个字段——那种抄写迟早
/// 会在某一处漏掉一个字段，而漏掉的那一处看起来仍然能跑（哈希对不上才会在派发前炸，
/// 值得少一次机会）。`cache` 是私有模块，所以这个 `impl` 放在 `SourceFile` 自己家里。
impl From<crate::cache::CachedBlobLocation> for SourceFile {
    fn from(located: crate::cache::CachedBlobLocation) -> Self {
        Self {
            path: located.path,
            content_hash: located.content_hash,
            byte_length: located.byte_length,
        }
    }
}

/// worker 用哪个引擎（`--engine`）。
///
/// 为什么不按「有没有模型」猜：那样生产路径上「忘了带模型」会安静地交出一张回声
/// 产物，而用户看到的是一张 64×64 的假图。引擎是构建时决定的能力，说清楚。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerEngine {
    /// 只走协议、不算图的回声引擎：进程/协议测试用。
    Echo,
    /// 真的跑 ONNX。这一条要求每个阶段都带着自己的模型授权。
    Onnx,
}

impl WorkerEngine {
    pub fn as_arg(self) -> &'static str {
        match self {
            WorkerEngine::Echo => "echo",
            WorkerEngine::Onnx => "onnx",
        }
    }
}

/// 压力读数的一个「仪表盘」：测试用它把机器伪装成吃紧的样子；生产走
/// [`PressureSource::Measured`]，由 supervisor 自己量。
///
/// 为什么要有注入口：真把机器压到 4 GiB 提交内存上再断言「后台停了」，换台机器就是随机红。
/// 压力是**读数**，而读数应该能被喂进来——`resource_policy` 那一侧也是同一个道理：
/// 它只算档位，谁来量由调用方决定。
#[derive(Clone, Debug, Default)]
pub struct PressureGauge(Arc<Mutex<resource_policy::PressureReading>>);

impl PressureGauge {
    pub fn new(reading: resource_policy::PressureReading) -> Self {
        Self(Arc::new(Mutex::new(reading)))
    }

    pub fn set(&self, reading: resource_policy::PressureReading) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = reading;
    }

    pub fn read(&self) -> resource_policy::PressureReading {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 压力读数从哪儿来。
#[derive(Clone, Debug, Default)]
pub enum PressureSource {
    /// 宿主自己量：worker 的私有提交（`GetProcessMemoryInfo`）＋ DXGI 的显存预算。
    /// 量不到的项留空——「不知道」不该被当成「没压力」。
    #[default]
    Measured,
    /// 外面喂进来的读数（测试专用）。
    Injected(PressureGauge),
}

#[derive(Clone, Debug)]
pub struct SupervisorConfig {
    pub worker_path: PathBuf,
    pub staging_root: PathBuf,
    /// 只读输入根：宿主把要算的图按内容放这儿，worker 只被允许从这儿读输入
    /// （docs/71 §7.1）。与 staging 是兄弟目录，两者的生命周期完全不同——staging
    /// 里的东西是 worker 写的半成品，这里的东西是宿主放的源图。
    pub inputs_root: PathBuf,
    /// 正式内容寻址存储的根（数据根）。`None` = 不发布，产物留在 staging。
    ///
    /// 为什么要分开：staging 是 worker 可以随便写的地方（进程崩了、写了一半都在那儿），
    /// 正式缓存只能由宿主**核过之后**往里放。两者在同一个目录树里但由不同的人管。
    pub publish_root: Option<PathBuf>,
    /// 已安装模型的位置（`models/<id>/<version>/`）。`None` = 不解析模型，阶段必须
    /// 自己带好 `model` 声明（进程/协议测试就这么跑：它们的 worker 是回声引擎）。
    pub models: Option<crate::compute::models::ModelCatalog>,
    /// 传给 worker 的 `--engine`。
    pub worker_engine: WorkerEngine,
    pub physical_ram_bytes: u64,
    pub handshake_timeout: Duration,
    pub shutdown_grace: Duration,
    pub idle_shutdown: Duration,
    /// 长闲置多久先把**能交回的原生内存**交回去（§12.4「idle30 秒释放模型/workspace」）。
    ///
    /// 与 [`SupervisorConfig::idle_shutdown`] 是两条独立的钟：这一条只放缓存（NGX 的工作区、
    /// ONNX 会话和它挂着的权重），下一件任务自己会把要用到的那份再装回来；那一条是收摊换
    /// 进程。缺了这一条，跑过一次的模型会一直占着内存直到进程退出——而用户只是切走了两分钟。
    pub idle_release: Duration,
    pub intra_threads: u32,
    /// Job Object 的内存硬限；`None` = 不设（算不出物理内存的时候）。
    pub hard_commit_bytes: Option<u64>,
    /// 压力读数从哪儿来（§8.1/§8.4）。生产是 [`PressureSource::Measured`]。
    pub pressure_source: PressureSource,
    /// 额外传给 worker 的环境变量。**生产恒空**，只有测试用它打开 worker 的测试钩子。
    pub extra_env: Vec<(String, String)>,
    /// 宿主认为**自己**是什么构建（Task 10 第 2 条）。
    ///
    /// 生产就是编进主 exe 的 [`HOST_BUILD_COMMIT`]，由 [`SupervisorConfig::new`] 填好，
    /// 谁也不该改它；有这一栏是为了让集成测试能扮演「包里的两半不是一对」那一幕——
    /// 那一幕在真机上要重编一份 worker 才能造出来，而这条反应（拒跑、不进退避账）
    /// 恰恰是最该被钉住的东西。
    pub host_build_commit: String,
}

impl SupervisorConfig {
    pub fn new(worker_path: impl Into<PathBuf>, staging_root: impl Into<PathBuf>) -> Self {
        let ram = physical_ram_bytes().unwrap_or(FALLBACK_RAM_BYTES);
        let cores = thread::available_parallelism()
            .map(|cores| cores.get())
            .unwrap_or(1);
        let staging_root = staging_root.into();
        Self {
            worker_path: worker_path.into(),
            // 输入根由 staging 推导，所以 `new` 的签名不用改：调用方本来就只该关心
            // 数据根在哪，输入与半成品的相对位置是这里的实现细节。
            inputs_root: crate::compute::inputs::inputs_root_for(&staging_root),
            staging_root,
            publish_root: None,
            // 缺省两件都「还没有」：现有测试用它跑回声引擎 + 自带 `model` 声明的阶段，
            // 生产由 `compute::start` 两件都补上。
            models: None,
            worker_engine: WorkerEngine::Echo,
            physical_ram_bytes: ram,
            handshake_timeout: Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            shutdown_grace: Duration::from_millis(SHUTDOWN_GRACE_MS),
            idle_shutdown: Duration::from_millis(IDLE_SHUTDOWN_MS),
            idle_release: Duration::from_millis(IDLE_RELEASE_MS),
            intra_threads: resource_policy::worker_intra_threads(cores),
            hard_commit_bytes: Some(resource_policy::hard_commit_limit(ram)),
            pressure_source: PressureSource::Measured,
            extra_env: Vec::new(),
            // 主 exe 里真正嵌着的那一串：判 worker 是不是给这个宿主编的，用的就是它。
            host_build_commit: HOST_BUILD_COMMIT.to_string(),
        }
    }
}

/// 对外的门面。克隆多个也共用同一个 supervisor 线程。
pub struct ComputeManager {
    shared: Arc<Shared>,
    commands: Sender<Command>,
    control: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    state: Mutex<State>,
    events: EventSink,
    config: SupervisorConfig,
    origin: Instant,
    /// 自动交回发生过几次（§12.4 那条钟）。**只记「宿主说了」**：一次自动交回是控制线程
    /// 自己决定发出去的，没有人等回信——数字在这里就是「这件事发生过几次」的证据。
    idle_releases: AtomicU32,
}

struct State {
    scheduler: Scheduler,
    status: WorkerStatus,
    /// 当前这一代 worker 在握手里报的构建事实（它认得哪些引擎、有哪些运行库）。
    ///
    /// **不参与派发**：派发用的是宿主自己配的 [`SupervisorConfig::worker_engine`]。存它
    /// 是为了别的层能问「引擎那一侧到底带着什么」——DLSSNR 的垫片就在那一侧，宿主只能
    /// 听它说（`crate::dlssnr::engine_facts`）。换一代就作废。
    build: Option<BuildInfo>,
    /// job_id → 派发模板。终态之后就没用了。
    templates: HashMap<String, SubmitRequest>,
    artifacts: HashMap<String, Vec<ArtifactRecord>>,
    progress: HashMap<String, JobProgress>,
    cancel_reasons: HashMap<String, String>,
    /// 最近一次压力读数（§8.1/§8.4）。由 supervisor 每拍采一次；`Injected` 时它是摆设，
    /// 准入判断现读仪表盘。
    pressure: resource_policy::PressureReading,
}

enum Command {
    /// 有新任务/取消/提升，起来看看该不该派发。
    Wake,
    /// 用户手动重试（§8.3 熔断之后只有这一条路）。
    RetryWorker,
    /// 请这一代 worker 把缓存的引擎工作区交回系统（§8.4），`reply` 收到交回了几份。
    ///
    /// 走控制线程而不是直接写管道：管道只有控制线程碰得到（纪律 1），而且「现在能不能
    /// 交回」是个会变的事实（正在算、刚换了代），只有它手上有。
    ReleaseIdle { reply: Sender<u32> },
    /// 请这一代 worker 退下（换了 DLL 片段/换了引擎版本），`reply` 收到「当时有没有会话」。
    RetireWorker { reason: String, reply: Sender<bool> },
    Shutdown,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // 谁 panic 了都不该把整个计算功能带走：拿回中毒的锁继续用。
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let mut state = self.lock();
        f(&mut state)
    }

    fn emit(&self, ids: &[String]) {
        // 先在锁里把快照抄出来，出了锁再回调：回调里做什么都不影响状态锁。
        let snapshots: Vec<JobSnapshot> = {
            let state = self.lock();
            ids.iter()
                .filter_map(|job_id| state.scheduler.snapshot(job_id))
                .collect()
        };
        for snapshot in &snapshots {
            (self.events)(snapshot);
        }
    }

    fn emit_all(&self) {
        let ids = self.with_state(|state| {
            state
                .scheduler
                .all()
                .into_iter()
                .map(|snapshot| snapshot.job_id)
                .collect::<Vec<String>>()
        });
        self.emit(&ids);
    }

    /// 这台机器现在收不收新任务（§8.1 软/硬阈值、§8.4 显存预留）。
    ///
    /// `Injected` 现读仪表盘（测试可以在 submit 前一刻改读数）；`Measured` 用 tick 采下来的
    /// 那一份——采样要 worker 的进程句柄，只有 supervisor 手里有，所以读数由它更新、
    /// 判断在这里现取。
    fn admission(&self, state: &State) -> Admission {
        let reading = match &self.config.pressure_source {
            PressureSource::Injected(gauge) => gauge.read(),
            PressureSource::Measured => state.pressure,
        };
        resource_policy::admission(&reading, self.config.physical_ram_bytes)
    }

    /// 记一次自动交回，返回累计次数。
    fn note_idle_release(&self) -> u32 {
        self.idle_releases.fetch_add(1, Ordering::Relaxed) + 1
    }
}

impl ComputeManager {
    /// 起一个 supervisor 线程。它现在**不会**碰 worker——worker 是按需起来的
    /// （第一次 submit 之后），所以启动界面不为它付代价。
    pub fn start(config: SupervisorConfig, events: EventSink) -> io::Result<Arc<Self>> {
        let (commands, inbox) = mpsc::channel();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                scheduler: Scheduler::new(1),
                status: WorkerStatus::Stopped,
                build: None,
                templates: HashMap::new(),
                artifacts: HashMap::new(),
                progress: HashMap::new(),
                cancel_reasons: HashMap::new(),
                pressure: resource_policy::PressureReading::unknown(),
            }),
            events,
            config,
            origin: Instant::now(),
            idle_releases: AtomicU32::new(0),
        });
        let supervisor = Supervisor {
            shared: Arc::clone(&shared),
            session: None,
            restarts: VecDeque::new(),
            spawn_at: None,
            idle_since: None,
            idle_released: false,
            broken: None,
        };
        let handle = thread::Builder::new()
            .name("yomika-compute-supervisor".to_string())
            .spawn(move || supervisor.run(inbox))
            .map_err(|error| io::Error::other(format!("起 supervisor 线程失败：{error}")))?;
        Ok(Arc::new(Self {
            shared,
            commands,
            control: Mutex::new(Some(handle)),
        }))
    }

    /// 登记一件任务。**不等待计算**：只入队，立刻返回它当前的快照。
    pub fn submit(&self, request: SubmitRequest) -> Result<Submitted, SubmitError> {
        let now_ms = self.shared.now_ms();
        let key = request.key.clone();
        let priority = request.priority;
        let result = self.shared.with_state(|state| {
            let admission = self.shared.admission(state);
            match state
                .scheduler
                .submit_under(key, priority, now_ms, admission)
            {
                Ok(submitted) => {
                    state.templates.entry(submitted.job_id.clone()).or_insert(request);
                    Ok(submitted)
                }
                Err(error) => Err(error),
            }
        });
        if let Ok(submitted) = &result {
            // 合并进来的订阅者不需要新模板：同身份共享同一份输入。
            self.shared.emit(std::slice::from_ref(&submitted.job_id));
            self.wake();
        }
        result
    }

    /// 某个界面放手了。只有所有订阅者都放手，才真的去打扰 worker（§8.1）。
    pub fn cancel(&self, job_id: &str, subscription_id: u64) -> CancelOutcome {
        let now_ms = self.shared.now_ms();
        let outcome = self
            .shared
            .with_state(|state| state.scheduler.cancel(job_id, subscription_id, now_ms));
        if let CancelOutcome::CancelRequested { .. } = &outcome {
            self.shared.with_state(|state| {
                state
                    .cancel_reasons
                    .insert(job_id.to_string(), "用户取消".to_string());
            });
        }
        self.shared.emit(&[job_id.to_string()]);
        self.wake();
        outcome
    }

    /// 后台任务提升成前台：换队，不重算（§8.1）。
    pub fn promote(&self, job_id: &str) -> PromoteOutcome {
        let outcome = self
            .shared
            .with_state(|state| state.scheduler.promote(job_id));
        self.shared.emit(&[job_id.to_string()]);
        self.wake();
        outcome
    }

    /// 新的阅读器世代上来，旧的排队任务作废（§8.1）。在跑的那件不动。
    pub fn drop_generation(&self, input_id: &str, generation: u64) -> DroppedGeneration {
        let now_ms = self.shared.now_ms();
        let dropped = self.shared.with_state(|state| {
            state
                .scheduler
                .drop_generation(input_id, generation, now_ms)
        });
        self.wake();
        dropped
    }

    /// 熔断之后用户手动重试（§8.3）。
    pub fn retry_worker(&self) {
        let _ = self.commands.send(Command::RetryWorker);
    }

    pub fn job(&self, job_id: &str) -> Option<JobSnapshot> {
        self.shared
            .with_state(|state| state.scheduler.snapshot(job_id))
    }

    /// 断订阅之后按 id 批量恢复（§11 Task 4 ⑥）。
    pub fn jobs(&self, job_ids: &[String]) -> Vec<JobSnapshot> {
        self.shared
            .with_state(|state| state.scheduler.snapshots(job_ids))
    }

    /// 全部还留着的快照（含终态）。worker 换代之后界面靠它把状态对齐。
    pub fn all_jobs(&self) -> Vec<JobSnapshot> {
        self.shared.with_state(|state| state.scheduler.all())
    }

    pub fn job_artifacts(&self, job_id: &str) -> Vec<ArtifactRecord> {
        self.shared.with_state(|state| {
            state.artifacts.get(job_id).cloned().unwrap_or_default()
        })
    }

    pub fn job_progress(&self, job_id: &str) -> Option<JobProgress> {
        self.shared
            .with_state(|state| state.progress.get(job_id).cloned())
    }

    /// 这件任务为什么被取消（用户 / 前台插队 / 超过 deadline）。状态回答「是什么」，
    /// 这里回答「谁让它停的」。
    pub fn cancel_reason(&self, job_id: &str) -> Option<String> {
        self.shared
            .with_state(|state| state.cancel_reasons.get(job_id).cloned())
    }

    pub fn worker_status(&self) -> WorkerStatus {
        self.shared.with_state(|state| state.status.clone())
    }

    /// 当前这一代 worker 在握手里报的构建事实；没有活着的 worker 时是 `None`。
    ///
    /// 问它的口气是「引擎那一侧自己怎么说」，不是「我这份二进制里有什么」——两者在
    /// 宿主里永远不同（宿主的答案永远是「没有 NGX」，见 `crate::dlssnr::engine_facts`）。
    pub fn worker_build(&self) -> Option<BuildInfo> {
        self.shared.with_state(|state| state.build.clone())
    }

    /// worker 唯一允许读文件的根。
    ///
    /// 交给调用方是**有意**的：宿主自己摆输入时走的是同一份 [`crate::compute::inputs`]
    /// 代码（`prepare_run` 里就是这么做的），不必为了「把一张图摆进去」再开一套
    /// 只有宿主知道的第二实现——两条路一条根，摆进去的名字才会被 worker 认。
    pub fn inputs_root(&self) -> &Path {
        &self.shared.config.inputs_root
    }

    pub fn queued(&self, priority: Priority) -> usize {
        self.shared
            .with_state(|state| state.scheduler.queued(priority))
    }

    /// 请这一代 worker 把缓存的引擎工作区交回系统（§8.4），返回交回了几份。
    ///
    /// 三件刻意为之的事：
    ///
    /// - **不会为了交回把 worker 拉起来**。没有会话、还没握手、有活正在跑或排队，都当场
    ///   答 0：交回不是启动计算的理由，而在有活的时候交回只会在下一件任务派发时让 worker
    ///   把刚放掉的工作区重建成一模一样的东西。调用方那边「交回了 0 份」与「没交回」是
    ///   同一个数——但这两件事都不是错。
    /// - **等一个回合，不等一张图**。上限 [`RELEASE_REPLY_TIMEOUT`]（[`TICK`] 再加一点
    ///   余量给命令排队），到点答 0。
    /// - **交回只放纹理，不结束会话**：下一件任务还要在同一代 worker 上跑完。
    pub fn release_idle(&self) -> u32 {
        let (reply, answers) = mpsc::channel();
        if self.commands.send(Command::ReleaseIdle { reply }).is_err() {
            return 0;
        }
        answers
            .recv_timeout(RELEASE_REPLY_TIMEOUT + TICK)
            .unwrap_or(0)
    }

    /// 自动交回发生过几次（§12.4 的 30 秒那条钟）。
    ///
    /// 这是**诊断读数**，不是一次询问：它答的是「这段空闲里宿主动过手没有」，而不是
    /// worker 现在手里还剩几份。要问后者得走 [`ComputeManager::release_idle`]。
    pub fn idle_releases(&self) -> u32 {
        self.shared.idle_releases.load(Ordering::Relaxed)
    }

    /// 请这一代 worker 退下，返回「当时有没有会话可以退」。**同步**：回来时它已经不在了。
    ///
    /// 什么时候要这么做：换了 DLL 片段、换了一代引擎——**进程里的原生状态已经不对了**。
    /// NGX 的 context 活在 worker 进程里（`compute-core/src/dlssnr/device.rs` 的
    /// `static CONTEXT`），同一个 context 上换不了片段；而这个进程手里那份旧片段还在，
    /// 用户点完「导入」看到的会是旧片段的结论。
    ///
    /// 为什么**必须等它真的退**：装新片段那一步要替换一个可能正被它映射着的文件
    /// （`dlssnr/release.rs` 的 `put_in_place` 先删再改名），映射着的镜像删不掉——不等，
    /// 用户看到的就是「如果应用正在用它，重启应用后再试」。
    ///
    /// 代价与边界：这一代的在飞任务如实报 `worker_lost`（换代就是换代），epoch 前进，
    /// 旧代迟到的消息从此对不上号；下一个任务才起新进程。它是**故意**的，所以不进退避账、
    /// 不点亮熔断（见 `Command::RetireWorker` 那一支）。
    pub fn retire_worker(&self, reason: &str) -> bool {
        let (reply, answers) = mpsc::channel();
        if self
            .commands
            .send(Command::RetireWorker {
                reason: reason.to_string(),
                reply,
            })
            .is_err()
        {
            return false;
        }
        answers
            .recv_timeout(self.shared.config.shutdown_grace * 2 + TICK)
            .unwrap_or(false)
    }

    /// 同上，但**不等**回信——关闭窗口那条路要的是窗口马上消失（§8.4「UI 马上返回」）。
    ///
    /// 回信没人接就等于这次不记账：worker 那边该交的还是交了。这条路上**不报错**，
    /// 因为「窗口关着还要不要把话说清楚」本身就不该由用户承担。
    pub fn release_idle_async(&self) {
        let (reply, _answers) = mpsc::channel();
        let _ = self.commands.send(Command::ReleaseIdle { reply });
    }

    /// 优雅收尾：送 shutdown、等它自己退（最多 [`SHUTDOWN_GRACE_MS`]）、再回收进程。
    /// **会阻塞到进程真的退出**——只在退出路径上调。
    pub fn shutdown(&self) {
        let _ = self.commands.send(Command::Shutdown);
        let handle = self
            .control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }

    fn wake(&self) {
        let _ = self.commands.send(Command::Wake);
    }
}

impl Drop for ComputeManager {
    fn drop(&mut self) {
        // 最后一个门面走了就通知控制线程收摊。它的 sender 一断，控制线程自己也会退。
        let _ = self.commands.send(Command::Shutdown);
    }
}

/// 一个 worker 会话。所有字段都只有控制线程碰得到。
struct Session {
    epoch: u64,
    /// 传给 worker 的 `worker_epoch`。协议里没有独立的 nonce 字段，就编在这里面：
    /// 两边靠这个不可猜的串确认「对面就是本次 spawn 的那一个」。
    epoch_tag: String,
    peer_pid: u32,
    child: Child,
    stream: PipeStream,
    reports: Receiver<Report>,
    job: Option<JobObject>,
    limits_applied: bool,
    limits_note: Option<String>,
    spawned_at: Instant,
    handshaked: bool,
    ping_at: Instant,
    /// 连发了几次 ping 还没等到匹配的 pong（§8.2：连续 3 次算丢失）。
    misses: u32,
    ping_nonce: u64,
    running: Option<Running>,
    /// 正在等 worker 回答「交回了几份」。有了它，第二次请求不会再发一帧（一个回合只有
    /// 一份回信），而没有它就没法把「交回 0 份」与「没交回」分开。
    release_reply: Option<Sender<u32>>,
    /// 这一代 worker 手上有一帧 `release_idle` 还没回。**与 `release_reply` 分开**：
    /// 自动交回那条路没人等回信（`release_reply` 是 `None`），但「一帧在飞」这件事仍然
    /// 成立，不能因为没人接账就允许第二帧。
    release_pending: bool,
    /// 这份等待的期限（见 [`RELEASE_REPLY_TIMEOUT`]）。
    release_at: Option<Instant>,
}

struct Running {
    job_id: String,
    deadline_at: Instant,
    /// 已经请求取消的时刻。到点还在跑就收族（§8.2）。
    cancel_at: Option<Instant>,
    requested: bool,
}

enum Report {
    /// 装进 `Box` 是刻意的：`Message` 里最大的变体（`ArtifactReady`）带着一整套哈希/尺寸/
    /// 引擎报告，直接内联会让整个 `Report` 按那个尺寸走，而这条通道每帧都要过一次。
    /// 每帧一次分配，换通道槽位小一个数量级。
    Message(Box<Message>),
    Closed(String),
    /// 对面不是给这个宿主编的（协议大版本不符、构建戳对不上）：**换一代解决不了**，
    /// 所以它不能走崩溃那条路（重试三次再熔断只会把同一件事重说三遍）。
    Refused(String),
}

struct Supervisor {
    shared: Arc<Shared>,
    session: Option<Session>,
    /// 60 秒窗口内安排过的重启（§8.3）。
    restarts: VecDeque<Instant>,
    /// 想起来了：到这个时刻去 spawn。
    spawn_at: Option<Instant>,
    idle_since: Option<Instant>,
    /// 这一段空闲里已经交回过了。**一段空闲只交一遍**：交回是「把缓存放掉」，下一件任务
    /// 会重建，一拍一遍地交等于让 worker 反复放掉再装回。
    ///
    /// 它必须跟着 `idle_since` 一起清（见 [`Supervisor::reset_idle`]）：只留「交过没有」
    /// 一个布尔而不清，第二段空闲就永远不交了——那正是这个字段最容易写错的地方。
    idle_released: bool,
    broken: Option<String>,
}

impl Supervisor {
    fn run(mut self, commands: Receiver<Command>) {
        loop {
            let mut shutdown = false;
            match commands.recv_timeout(TICK) {
                Ok(command) => self.handle_command(command, &mut shutdown),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => shutdown = true,
            }
            while !shutdown {
                match commands.try_recv() {
                    Ok(command) => self.handle_command(command, &mut shutdown),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        shutdown = true;
                        break;
                    }
                }
            }
            if shutdown {
                break;
            }

            self.drain_reports();
            self.tick();
            self.maybe_spawn();
            self.maybe_dispatch();
        }
        // 退出路径：给 worker 一次好好退的机会，超时就收族。
        self.close_session("宿主收摊");
    }

    fn handle_command(&mut self, command: Command, shutdown: &mut bool) {
        match command {
            Command::Wake => {}
            Command::RetryWorker => {
                self.broken = None;
                self.restarts.clear();
                self.spawn_at = Some(Instant::now());
            }
            Command::ReleaseIdle { reply } => {
                self.start_release_idle(Some(reply));
            }
            Command::RetireWorker { reason, reply } => {
                // **优雅收尾，不走 `lose_session`**：那一条会把这一次算成崩溃（进重启窗口的
                // 账），用户在设置页连换四次片段就会把熔断点亮——而这个进程一次都没崩过。
                // 故意的换代要有确定的结论，也不该吃退避；换完之后下一个任务也不必等。
                let had = self.session.is_some();
                if had {
                    self.close_session(reason.as_str());
                }
                let _ = reply.send(had);
            }
            Command::Shutdown => *shutdown = true,
        }
    }

    /// `ReleaseIdle` 的第一半：判断现在能不能交回，能就发请求、挂上回信口子。
    ///
    /// `reply` 是 `None` 表示**自动交回**（§12.4 那条钟）：没有人等回信，但发出去这一帧
    /// 与手动那条路完全一样——worker 那边真的放了缓存，回信照样由
    /// [`Supervisor::on_workspaces_released`] 收下（只是没人接）。
    ///
    /// 返回「这一帧真的发出去了吗」。调用方（自动那条路）用它决定要不要记一笔：说不出话
    /// 的时候不该记成一次交回。
    fn start_release_idle(&mut self, reply: Option<Sender<u32>>) -> bool {
        // 「交回 0 份」是这里唯一能给的诚实答案：没会话、还没握手都还没有工作区；
        // 有活在跑或排队时交回是白费（下一件任务会把它重建出来）；上一次交回还没回信
        // 时也不再发第二帧（一个回合只有一份回信，多挂一个人只会多一份说不清的账）。
        let ready = self
            .session
            .as_ref()
            .is_some_and(|session| session.handshaked && !session.release_pending);
        if !ready || self.has_queued() {
            if let Some(reply) = reply {
                let _ = reply.send(0);
            }
            return false;
        }
        let Some(session) = self.session.as_mut() else {
            if let Some(reply) = reply {
                let _ = reply.send(0);
            }
            return false;
        };
        if session.running.is_some() {
            if let Some(reply) = reply {
                let _ = reply.send(0);
            }
            return false;
        }
        let request = Message::ReleaseIdle(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: session.epoch_tag.clone(),
        });
        if send_frame(&mut session.stream, &request).is_err() {
            // 发都发不出去：这一代 worker 已经不可靠了，让它走正常的路去得结论
            // （心跳/读线程会把它收掉），这里只把话说完。
            if let Some(reply) = reply {
                let _ = reply.send(0);
            }
            return false;
        }
        session.release_pending = true;
        session.release_reply = reply;
        session.release_at = Some(Instant::now() + RELEASE_REPLY_TIMEOUT);
        true
    }

    /// 收 worker 发来的东西，并把宿主的答复（ack / cancel / ping）发出去。
    fn drain_reports(&mut self) {
        loop {
            let report = match self.session.as_ref() {
                Some(session) => match session.reports.try_recv() {
                    Ok(report) => report,
                    Err(TryRecvError::Empty) => return,
                    Err(TryRecvError::Disconnected) => Report::Closed("读线程没了".to_string()),
                },
                None => return,
            };
            match report {
                Report::Message(message) => self.on_message(*message),
                Report::Closed(reason) => {
                    // 对端关了管道／读帧出错：这一代 worker 到此为止。
                    self.lose_session(&reason, None);
                    return;
                }
                Report::Refused(reason) => {
                    // 「这一份 worker 不是给这个宿主编的」：换一代不解决，别记进崩溃账。
                    self.refuse_session(&reason);
                    return;
                }
            }
        }
    }

    fn on_message(&mut self, message: Message) {
        // 握手之前只认 Hello；握手之后只认这一代 epoch 的消息（§6.2）。
        let session_epoch_tag = match self.session.as_ref() {
            Some(session) => session.epoch_tag.clone(),
            None => return,
        };
        if !message.matches_epoch(&session_epoch_tag) {
            // 上一代 worker 的迟到消息：不改任何状态。
            return;
        }
        match message {
            Message::Hello(hello) => {
                if hello.worker_epoch != session_epoch_tag {
                    self.lose_session("握手时的 epoch 对不上", None);
                    return;
                }
                // 构建戳对不上的这一份 worker 不能拼（Task 10 第 2 条）。**必须在回 ack
                // 之前判**：回了 ack 就是「认下了这一代」，再拒跑等于先握手再翻脸。
                // 这是「拒跑」不是「崩溃」——换一代不会变好，所以不进退避账。
                match build_stamp_verdict(&self.shared.config.host_build_commit, &hello.build.commit)
                {
                    StampVerdict::Same => {}
                    StampVerdict::HostUnknown => {
                        // 没有 git 的机器上从源码编出来的主 exe 就没有戳：判不出来。
                        // 放行，但把这件事说在明处，别让它看起来像「验过了」。
                        eprintln!("yomika: 这一份主程序没带构建戳，不与 worker 对戳");
                    }
                    StampVerdict::Mismatch { host, worker } => {
                        let worker = if worker.is_empty() {
                            "没报（旧包）".to_string()
                        } else {
                            worker
                        };
                        self.refuse_session(&format!(
                            "这一代计算进程和主程序不是同一次构建（worker {worker} / 宿主 {host}），没有拼起来用"
                        ));
                        return;
                    }
                }
                let ack = Message::HelloAck(HelloAck {
                    protocol_version: PROTOCOL_MAJOR,
                    worker_epoch: session_epoch_tag,
                    features: vec!["progress".to_string()],
                    max_frame_bytes: MAX_FRAME_BYTES as u32,
                });
                let mut failed = false;
                let mut ready = None;
                if let Some(session) = self.session.as_mut() {
                    match send_frame(&mut session.stream, &ack) {
                        Ok(()) => {
                            session.handshaked = true;
                            ready = Some((
                                session.epoch,
                                session.peer_pid,
                                session.limits_applied,
                                session.limits_note.clone(),
                            ));
                        }
                        Err(_) => failed = true,
                    }
                }
                if failed {
                    self.lose_session("回 hello_ack 失败", None);
                    return;
                }
                if let Some((epoch, peer_pid, limits_applied, limits_note)) = ready {
                    // 交接刚谈成的那一刻是唯一「确定没有写者」的时刻：还没有任何 job
                    // 被派发（有 job 才有正在飞的产物），上一代 worker 也已经不在了，
                    // 所以这次清扫不必留宽限期。清不掉只是下次再来，握手照样算成功。
                    reclaim_staging(&self.shared);
                    // 输入根另有一套宽限：里面的东西是宿主放的，随时可能被下一件任务
                    // 复用，握手这一刻并不能证明它们没人要（§7.1 的输入生命周期）。
                    let swept = crate::compute::inputs::sweep_inputs(
                        &self.shared.config.inputs_root,
                        crate::compute::inputs::INPUT_SWEEP_GRACE,
                    );
                    if swept > 0 {
                        eprintln!("yomika: 清掉 {swept} 份过期输入");
                    }
                    self.shared.with_state(|state| {
                        // 握手里那句「我认得哪些引擎」是宿主唯一能知道引擎那一侧带着什么
                        // 的地方（NGX 垫片就在那边），登记在案给 `worker_build()` 问。
                        state.build = Some(hello.build);
                        state.status = WorkerStatus::Ready {
                            epoch,
                            peer_pid,
                            limits_applied,
                            limits_note,
                        };
                    });
                }
            }
            Message::Accepted(reference) => self.apply(
                WorkerEvent::Accepted {
                    job_id: reference.job_id.clone(),
                },
                &reference.job_id,
            ),
            Message::StageStarted(started) => self.apply(
                WorkerEvent::Stage {
                    job_id: started.job_id.clone(),
                    stage: started.stage_id.clone(),
                    index: started.stage_index,
                },
                &started.job_id,
            ),
            Message::Progress(progress) => self.on_progress(progress),
            Message::ArtifactReady(ready) => self.on_artifact(ready),
            Message::Completed(reference) => {
                self.finish_running(&reference.job_id);
                self.apply(
                    WorkerEvent::Completed {
                        job_id: reference.job_id.clone(),
                    },
                    &reference.job_id,
                );
            }
            Message::Cancelled(reference) => {
                self.finish_running(&reference.job_id);
                self.apply(
                    WorkerEvent::Cancelled {
                        job_id: reference.job_id.clone(),
                    },
                    &reference.job_id,
                );
            }
            Message::Failed(failed) => {
                self.finish_running(&failed.job_id);
                self.apply(
                    WorkerEvent::Failed {
                        job_id: failed.job_id.clone(),
                        code: failed.code.clone(),
                    },
                    &failed.job_id,
                );
            }
            Message::Pong(pong) => self.on_pong(pong),
            Message::WorkspacesReleased(released) => self.on_workspaces_released(released),
            // 其余是只该由宿主发出的类型（或我们暂时不关心的通知），忽略。
            _ => {}
        }
    }

    /// `ReleaseIdle` 的第二半：worker 报了数字，把话交回给等着的人。
    ///
    /// 没有等待者（`release_idle_async` 那条路）也照样清掉期限：这一次交回**已经发生**
    /// 了，账只是没人接。
    fn on_workspaces_released(&mut self, released: WorkspacesReleased) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        session.release_at = None;
        session.release_pending = false;
        if let Some(reply) = session.release_reply.take() {
            let _ = reply.send(released.count);
        }
    }

    fn apply(&mut self, event: WorkerEvent, job_id: &str) {
        let Some(epoch) = self.session.as_ref().map(|session| session.epoch) else {
            return;
        };
        let now_ms = self.shared.now_ms();
        let changed = self
            .shared
            .with_state(|state| state.scheduler.apply_worker_event(epoch, event, now_ms));
        if changed {
            self.shared.emit(&[job_id.to_string()]);
        }
    }

    fn on_progress(&mut self, progress: StageProgress) {
        let now_ms = self.shared.now_ms();
        let job_id = progress.job_id.clone();
        self.shared.with_state(|state| {
            // worker 那边的 10 ms 节流是它自己喘气用的；这里再按界面能承受的节奏压到 5 Hz。
            let fresh = state.progress.get(&job_id).is_none_or(|held| {
                now_ms.saturating_sub(held.updated_ms) >= PROGRESS_MIN_INTERVAL_MS
            });
            if !fresh {
                return;
            }
            state.progress.insert(
                job_id,
                JobProgress {
                    stage_id: progress.stage_id,
                    percent: progress.percent,
                    updated_ms: now_ms,
                },
            );
        });
    }

    fn on_pong(&mut self, pong: Ping) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        if pong.nonce == session.ping_nonce {
            session.misses = 0;
        }
    }

    /// 产物落盘：宿主**自己**核长度与哈希，核过了才 `artifact_ack`（§6.4、§8.2）。
    fn on_artifact(&mut self, ready: ArtifactReady) {
        let belongs = self.session.as_ref().is_some_and(|session| {
            self.shared.with_state(|state| {
                state.templates.get(&ready.job_id).zip(state.scheduler.snapshot(&ready.job_id))
                    .is_some_and(|(template, snapshot)| artifact_belongs_to_run(&ready, template, &snapshot, session.running.as_ref().map(|running| running.job_id.as_str())))
            })
        });
        if !belongs {
            self.lose_session("worker 返回了不属于当前授权任务的产物", None);
            return;
        }
        let staging_root = self.shared.config.staging_root.clone();
        let publish_root = self.shared.config.publish_root.clone();
        let (record, reject_reason) =
            match verify_artifact(&staging_root, publish_root.as_deref(), &ready) {
                Ok(record) => (record, None),
                // 具体哪一条不符由 `verify_artifact` 说；把它原样回给 worker，让 worker 的日志
                // 里有可查的原因，而不是一句「失败了」。
                Err(reason) => (
                    ArtifactRecord {
                        job_id: ready.job_id.clone(),
                        stage_id: ready.stage_id.clone(),
                        artifact_id: ready.artifact_id.clone(),
                        staging_name: ready.relative_name.clone(),
                        path: staging_root.join(&ready.relative_name),
                        cache_relative: None,
                        byte_length: ready.byte_length,
                        content_hash: ready.content_hash.clone(),
                        width: ready.width,
                        height: ready.height,
                        engine_id: ready.engine.id.clone(),
                        engine_precision: format!("{:?}", ready.engine.precision),
                        engine_policy: ready
                            .engine
                            .policy
                            .map(|policy| policy.as_str().to_string()),
                        engine_fallback: ready.engine.fallback.clone(),
                        pipeline_revision: ready.pipeline_revision.clone(),
                        verified: false,
                    },
                    Some(reason),
                ),
            };
        let reference = ArtifactRef {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: ready.worker_epoch.clone(),
            job_id: ready.job_id.clone(),
            artifact_id: ready.artifact_id.clone(),
            reason: reject_reason,
        };
        let message = if record.verified {
            Message::ArtifactAck(reference)
        } else {
            Message::ArtifactRejected(reference)
        };
        let mut failed = false;
        if let Some(session) = self.session.as_mut() {
            failed = send_frame(&mut session.stream, &message).is_err();
        }
        if failed {
            self.lose_session("回 artifact 裁决失败", None);
            return;
        }
        self.shared.with_state(|state| {
            state
                .artifacts
                .entry(ready.job_id.clone())
                .or_default()
                .push(record);
        });
    }

    /// 在跑的那件有结论了：本地记账也跟着腾出来。
    fn finish_running(&mut self, job_id: &str) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        if session
            .running
            .as_ref()
            .is_some_and(|running| running.job_id == job_id)
        {
            session.running = None;
        }
    }

    /// 定时器：握手、心跳、取消宽限、deadline、闲置。
    fn tick(&mut self) {
        let now = Instant::now();
        let mut lose: Option<String> = None;
        let mut ask_cancel: Option<String> = None;
        let mut idle_done = false;
        let mut idle_release_due = false;
        // 订阅者全放手了（调度器已经把它置成 `CancelRequested`）：轮到我们把 `cancel` 发出去。
        // **没有这一步，用户点取消只会改状态、worker 一直算到完。**
        // 这个判断要看状态锁，所以在借 `self.session` 之前先算出来。
        let pending_cancel = self.pending_cancel_target().is_some();

        if let Some(session) = self.session.as_mut() {
            if !session.handshaked
                && now.duration_since(session.spawned_at) > self.shared.config.handshake_timeout
            {
                lose = Some(format!(
                    "握手超时（{} ms）",
                    self.shared.config.handshake_timeout.as_millis()
                ));
            } else if session.handshaked {
                // 心跳：该 ping 就 ping，连丢 3 次就当场判死（§8.2）。
                if now >= session.ping_at {
                    session.misses += 1;
                    session.ping_at = now + Duration::from_millis(PING_INTERVAL_MS);
                    session.ping_nonce = mint_nonce();
                    let ping = Message::Ping(Ping {
                        protocol_version: PROTOCOL_MAJOR,
                        worker_epoch: session.epoch_tag.clone(),
                        nonce: session.ping_nonce,
                    });
                    if send_frame(&mut session.stream, &ping).is_err() {
                        lose = Some("发 ping 失败".to_string());
                    } else if resource_policy::heartbeat_lost(session.misses) {
                        lose = Some(format!("连续 {} 次心跳没回应", session.misses));
                    }
                }

                if lose.is_none() {
                    if let Some(running) = session.running.as_mut() {
                        if running.cancel_at.is_none() && now >= running.deadline_at {
                            ask_cancel = Some("超过 deadline".to_string());
                        } else if let Some(at) = running.cancel_at {
                            if resource_policy::cancel_grace_exceeded(
                                at.elapsed().as_millis() as u64
                            ) {
                                // 合作取消没等到，收族。这件任务的结论是「被取消」，
                                // 不是「worker 丢了」——是我们要它停的。
                                lose = Some(format!("取消宽限 {} ms 用完了", CANCEL_GRACE_MS));
                            }
                        }
                    }
                }

                // 闲置回收：没有在跑的、也没有排队的，就别占着 GPU 上下文和内存（§8.4）。
                // 正等着发 cancel 也别收摊——那是另一条路的事。
                if lose.is_none() && ask_cancel.is_none() && !pending_cancel {
                    let busy = session.running.is_some() || self.has_queued();
                    if busy {
                        // 忙起来就把这一段的账清掉：空闲的钟与「这一段交过了」必须一起清，
                        // 否则第二段空闲永远不会再交（§12.4 那条钟会变成一次性开关）。
                        self.reset_idle();
                    } else {
                        let since = *self.idle_since.get_or_insert(now);
                        let idle_ms = now.duration_since(since).as_millis() as u64;
                        // 两条钟问的是同一条判据，阈值都来自配置（缺省就是
                        // `IDLE_RELEASE_MS` / `IDLE_SHUTDOWN_MS`）：先问交回、再问收摊。
                        // 顺序不能反——收摊把整个进程端掉，交回就再也轮不到了。
                        if resource_policy::idle_due(
                            idle_ms,
                            self.shared.config.idle_shutdown.as_millis() as u64,
                        ) {
                            idle_done = true;
                        } else if !self.idle_released
                            && resource_policy::idle_due(
                                idle_ms,
                                self.shared.config.idle_release.as_millis() as u64,
                            )
                        {
                            // 先交回缓存里的原生内存（模型/工作区），别等到收摊那一支——
                            // 收摊要换进程，用户只是走开两分钟不该付冷启动的代价。
                            idle_release_due = true;
                        }
                    }
                }
            }
        }

        // 交回工作区是一问一答，但答话的可能是忙着的 worker，也可能永远不回。到点就把话
        // 说完（答 0），调用方那边「没交回」与「交回了 0 份」是同一个数。
        // 这一步要重新借 `self.session`——上面那个可变借还活着的时候借不了。
        if let Some(session) = self.session.as_mut() {
            if session.release_at.is_some_and(|at| now >= at) {
                session.release_at = None;
                session.release_pending = false;
                if let Some(reply) = session.release_reply.take() {
                    let _ = reply.send(0);
                }
            }
        }

        if let Some(reason) = lose {
            // 取消宽限用完而收族：在飞那件结算成「被取消」（而不是 worker_lost）。
            let settle = self
                .session
                .as_ref()
                .and_then(|session| session.running.as_ref())
                .filter(|running| running.cancel_at.is_some())
                .map(|_| JobState::Cancelled);
            self.lose_session(&reason, settle);
            return;
        }
        if let Some(reason) = ask_cancel {
            self.request_running_cancel(&reason);
        }
        if pending_cancel {
            self.request_running_cancel("订阅者都放手了");
        }
        if idle_done {
            self.close_session("闲置回收");
            self.reset_idle();
        }
        if idle_release_due {
            // 只有**真的发出去了**才记「这一段交过了」：记在这一刻之前就成了「说过就算」，
            // 而说过没做到的那一次会被下一拍重试——重试正是这里想要的（这一代 worker 刚
            // 好在换、或还没握手时，200 毫秒之后它就在了）。清标记的时机仍然只有一处：
            // 忙起来（`reset_idle`）。
            if self.start_release_idle(None) {
                self.idle_released = true;
                self.shared.note_idle_release();
            }
        }

        // 压力让路（§8.1 的软/硬阈值、§8.4 的显存预留）：读数每拍采一次，档位一差就把
        // **排队中**的后台预扫丢掉；到了硬压力，正在跑的后台那件也收——它占的正是最贵的
        // 那份提交内存。前台那件永远不动：用户正等着看它，丢它等于丢用户的操作。
        let admission = self.apply_pressure();
        if matches!(admission, Admission::ForegroundOnly | Admission::Refuse) {
            self.shed_background();
        }
        if admission == Admission::Refuse {
            self.cancel_background_running();
        }
    }

    /// 采一份压力读数放进状态，并返回这一刻的档位。
    ///
    /// 提交内存取 **worker 进程自己的私有提交**：整机内存有别的进程的账，拿整机数字当
    /// 「这次计算会不会失败」的判据会把别人的开销算在计算头上。显存取 DXGI 本地段的
    /// 预算与用量。两项都可能量不到——量不到就留空，[`resource_policy::admission`]
    /// 不因为「不知道」把任务挡回去。
    fn apply_pressure(&self) -> Admission {
        if matches!(self.shared.config.pressure_source, PressureSource::Measured) {
            let child = self
                .session
                .as_ref()
                .filter(|session| session.handshaked)
                .map(|session| &session.child);
            let reading = sampled_pressure(child);
            self.shared.with_state(|state| state.pressure = reading);
        }
        self.shared.with_state(|state| self.shared.admission(state))
    }

    /// 把排队中的后台预扫丢掉（§8.1：「过了软阈值：应该先把后台任务丢掉，别等到分配失败」）。
    ///
    /// 只丢**还没开算**的。在跑的那件要停得走取消（要给 worker 留收尾时间、要等它应答），
    /// 那条路在 [`Self::cancel_background_running`]，两条路不混在一起。
    fn shed_background(&mut self) {
        let now = self.shared.now_ms();
        let shed = self
            .shared
            .with_state(|state| state.scheduler.shed_background(now));
        if !shed.is_empty() {
            self.shared.emit(&shed);
        }
    }

    /// 硬压力下收掉正在跑的后台那件；前台那一件不动（用户正等着看它）。
    fn cancel_background_running(&mut self) {
        let job_id = self.shared.with_state(|state| {
            state
                .scheduler
                .running_job()
                .and_then(|job_id| state.scheduler.snapshot(job_id))
                .filter(|snapshot| snapshot.priority == Priority::Background)
                .map(|snapshot| snapshot.job_id)
        });
        if let Some(job_id) = job_id {
            self.send_cancel(&job_id, "机器吃紧，先把后台预扫收掉");
        }
    }

    fn has_queued(&self) -> bool {
        self.shared.with_state(|state| {
            state.scheduler.queued(Priority::Foreground) > 0
                || state.scheduler.queued(Priority::Background) > 0
        })
    }

    /// 请 worker 合作取消在跑的那件（用户取消 / 前台插队 / 超过 deadline）。
    /// 返回 true 表示 `cancel` 已经发出去、开始算宽限。
    fn request_running_cancel(&mut self, reason: &str) -> bool {
        let Some(job_id) = self
            .session
            .as_ref()
            .and_then(|session| session.running.as_ref())
            .map(|running| running.job_id.clone())
        else {
            return false;
        };
        self.send_cancel(&job_id, reason)
    }

    /// 调度器那边已经进了 `CancelRequested`、可我们还没发过帧的那种（订阅者全放手了）。
    fn pending_cancel_target(&self) -> Option<String> {
        let local_requested = self
            .session
            .as_ref()
            .and_then(|session| session.running.as_ref())
            .is_some_and(|running| running.requested);
        if local_requested {
            return None;
        }
        self.shared.with_state(|state| {
            let job_id = state.scheduler.running_job()?;
            let snapshot = state.scheduler.snapshot(job_id)?;
            (snapshot.state == JobState::CancelRequested).then_some(snapshot.job_id)
        })
    }

    /// 发 `cancel` 给 worker，并从这一刻开始算 2 秒合作宽限。
    ///
    /// 两种来路都要走这里：调度器**已经**因为订阅者放手而进了 `CancelRequested`（这时不该再
    /// 调一次 `request_cancel`），以及宿主自己决定要它停（deadline / 前台插队）。
    fn send_cancel(&mut self, job_id: &str, reason: &str) -> bool {
        let already_requested = match self
            .session
            .as_ref()
            .and_then(|session| session.running.as_ref())
        {
            Some(running) if running.job_id == job_id => running.requested,
            _ => return false,
        };
        if already_requested {
            return false;
        }
        let generation = self.shared.with_state(|state| {
            let snapshot = state.scheduler.snapshot(job_id)?;
            match snapshot.state {
                JobState::CancelRequested => Some(snapshot.key.generation),
                _ => state
                    .scheduler
                    .request_cancel(job_id)
                    .then_some(snapshot.key.generation),
            }
        });
        let Some(generation) = generation else {
            // 已经收尾了（终态还在报告队列里没处理）。这时候**不能**记宽限，
            // 否则 2 秒后会把一个其实已经闲下来的 worker 收掉。
            return false;
        };
        let epoch_tag = {
            let Some(session) = self.session.as_mut() else {
                return false;
            };
            if let Some(running) = session.running.as_mut() {
                running.requested = true;
                running.cancel_at = Some(Instant::now());
            }
            session.epoch_tag.clone()
        };
        self.shared.with_state(|state| {
            // 第一个说出原因的人算数：用户点取消之后就别改写成「前台插队」了。
            state
                .cancel_reasons
                .entry(job_id.to_string())
                .or_insert_with(|| reason.to_string());
        });
        let cancel = Message::Cancel(JobRef {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch_tag,
            job_id: job_id.to_string(),
            generation,
        });
        let mut failed = false;
        if let Some(session) = self.session.as_mut() {
            failed = send_frame(&mut session.stream, &cancel).is_err();
        }
        self.shared.emit(&[job_id.to_string()]);
        if failed {
            self.lose_session("发 cancel 失败", None);
            return false;
        }
        true
    }

    /// worker 换代：在飞的任务标 `worker_lost`，epoch 前进（旧消息从此被丢掉）。
    fn lose_session(&mut self, reason: &str, settle: Option<JobState>) {
        let Some(session) = self.session.take() else {
            return;
        };
        self.end_session(session, reason, settle, true);
    }

    /// 拒跑这一代 worker：它**不是给这个宿主编的**（协议大版本不符、构建戳对不上）。
    ///
    /// 与 [`Supervisor::lose_session`] 的差别只有一件事，但那一件很要紧：不走 `restart`，
    /// 所以既不重试、也不进熔断那本账。换一代解决不了「这份 exe 是另一份构建」——按崩溃
    /// 处理只会把同一件事重说三遍、赔上 14 秒退避，最后给用户一句「重启次数到顶」，
    /// 而真话是「你包里的两半不是一对」。状态落 `Broken`：它要用户动手（换回配套的包），
    /// 直到那时也不该有任务往上撞。
    fn refuse_session(&mut self, reason: &str) {
        let Some(session) = self.session.take() else {
            return;
        };
        self.end_session(session, reason, None, false);
        // `end_session` 不 restart 时只落 `Stopped`（或保留已有的 broken），而这一条必须
        // 是 `Broken`：不给它自动重试的余地，任务也别再排队等着。
        let reason = reason.to_string();
        let now_ms = self.shared.now_ms();
        self.broken = Some(reason.clone());
        self.spawn_at = None;
        self.shared.with_state(|state| {
            state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms);
            state.status = WorkerStatus::Broken { reason };
        });
        self.shared.emit_all();
    }

    /// 清掉闲置的账：`idle_since`（这一段的起点）与 `idle_released`（这一段交过没有）。
    ///
    /// 两个字段必须一起清，而且**只在这里清**：分开写就会出现「闲下来不重置起点、或重置了
    /// 起点却留着『交过了』」的组合，而后者会让第二段空闲永远不交回（§12.4 那条钟变成
    /// 一次性开关）。所以「忙起来」「交回成功」「新 worker 起来」三条路都走这一个函数。
    fn reset_idle(&mut self) {
        self.idle_since = None;
        self.idle_released = false;
    }

    /// 优雅收摊：送 shutdown，等它自己退，超时收族。这不算一次失败，不进退避账。
    ///
    /// `reason` 会写进会话日志与熔断原因里——**故意的换代与「它刚才崩了」是两个原因**，
    /// 混在一起看日志就分不清是用户换了片段还是它自己死了。
    fn close_session(&mut self, reason: &str) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        let shutdown = Message::Shutdown(EpochOnly {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: session.epoch_tag.clone(),
        });
        let _ = send_frame(&mut session.stream, &shutdown);
        let deadline = Instant::now() + self.shared.config.shutdown_grace;
        while matches!(session.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let Some(session) = self.session.take() else {
            return;
        };
        self.end_session(session, reason, None, false);
    }

    fn end_session(
        &mut self,
        mut session: Session,
        reason: &str,
        settle: Option<JobState>,
        restart: bool,
    ) {
        let now_ms = self.shared.now_ms();
        // 会话要换了：还在等交回回信的人得当场拿到话，不然它会一直等到自己的期限。
        if let Some(reply) = session.release_reply.take() {
            let _ = reply.send(0);
        }
        // 这一代的握手事实随它一起作废：`worker_build()` 的答案只对当前这一代负责，
        // 留着一份上一代的构建事实比没有更坏（垫片在不在会答成上一代的答案）。
        self.shared.with_state(|state| state.build = None);
        if let Some(state) = settle {
            settle_job(&self.shared, session.epoch, &session.running, state, now_ms);
        }
        terminate_process(&mut session, self.shared.config.shutdown_grace);
        // 进程已经真退出了（`terminate_process` 等到它退出或杀掉），此刻 staging 里
        // 不会再有人写：上一代留下的半成品与 worker 攒的暂存子树都该收回去（§11 Task 8
        // 第⑤条 idle/release/shutdown 要回收所有可回收的东西）。放在 `terminate_process`
        // 之后是必须的——早一步收，可能正撞上它还在写。
        reclaim_staging(&self.shared);

        // 换代：在飞的任务不再属于任何人；epoch 前进之后迟到的旧消息再也改不了状态。
        let next_epoch = self.shared.with_state(|state| state.scheduler.epoch() + 1);
        self.shared
            .with_state(|state| state.scheduler.begin_epoch(next_epoch, now_ms));

        let mut broken_now = false;
        if restart {
            let now = Instant::now();
            self.restarts.retain(|at| {
                now.duration_since(*at) < Duration::from_millis(RESTART_WINDOW_MS)
            });
            let performed = self.restarts.len();
            if performed >= MAX_RESTARTS_PER_WINDOW {
                broken_now = true;
            } else {
                match resource_policy::restart_backoff(performed as u32 + 1) {
                    Some(delay) => {
                        self.spawn_at = Some(now + Duration::from_millis(delay));
                        self.restarts.push_back(now);
                    }
                    None => broken_now = true,
                }
            }
        } else {
            self.spawn_at = None;
        }

        if broken_now {
            let reason = format!(
                "{reason}；{} 秒内重启次数到顶，不再自动重试",
                RESTART_WINDOW_MS / 1000
            );
            self.broken = Some(reason.clone());
            self.spawn_at = None;
            self.shared.with_state(|state| {
                state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms);
                state.status = WorkerStatus::Broken { reason };
            });
        } else if self.broken.is_none() {
            self.shared.with_state(|state| {
                state.status = WorkerStatus::Stopped;
                prune_templates(state);
            });
        } else {
            self.shared.with_state(prune_templates);
        }
        self.shared.emit_all();
    }

    /// 按需起来。没有要跑的东西就不起——启动界面不为计算付代价。
    fn maybe_spawn(&mut self) {
        if self.session.is_some() || !self.has_queued() {
            return;
        }
        // 熔断亮着：这台机器/这个包在用户动手（点重试）之前都跑不了，**排队的活当场给结论**。
        // 不这么做的后果是「交上来的东西一直躺在队列里」——界面看见的是「计算进程不可用」，
        // 而任务那一边什么都没有发生；等用户点了重试，它们会被一起派下去算，算的还可能是
        // 他已经翻过去的那几页。
        if self.broken.is_some() {
            let now_ms = self.shared.now_ms();
            let failed = self.shared.with_state(|state| {
                state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms)
            });
            self.shared.emit(&failed);
            return;
        }
        // 可执行文件不在，就别按 1s/3s/10s 退避重试三次再报坏了：那不是「它刚才起崩了」，
        // 而是「这台机器上根本没有它」。一次性说清楚，并让排队的任务当场拿到结论。
        if !self.shared.config.worker_path.is_file() {
            let reason = format!(
                "找不到 worker 可执行文件：{}",
                self.shared.config.worker_path.display()
            );
            let now_ms = self.shared.now_ms();
            self.shared.with_state(|state| {
                state.status = WorkerStatus::Broken {
                    reason: reason.clone(),
                };
            });
            self.broken = Some(reason);
            let failed = self.shared.with_state(|state| {
                state.scheduler.fail_queued(WORKER_UNAVAILABLE_CODE, now_ms)
            });
            self.shared.emit(&failed);
            return;
        }
        let now = Instant::now();
        if let Some(at) = self.spawn_at {
            if now < at {
                return;
            }
        }
        self.spawn_at = None;
        match self.spawn_session() {
            Ok(session) => {
                self.shared.with_state(|state| {
                    state.status = WorkerStatus::Starting {
                        epoch: session.epoch,
                    };
                });
                self.session = Some(session);
                self.reset_idle();
            }
            // 起不来也是一次失败：走同一套退避与熔断。
            Err(error) => self.lose_session(&format!("起 worker 失败：{error}"), None),
        }
    }

    fn spawn_session(&self) -> io::Result<Session> {
        let config = &self.shared.config;
        let server = PipeServer::create()?;
        let nonce = mint_nonce();
        let epoch = self.shared.with_state(|state| state.scheduler.epoch());
        let epoch_tag = format!("{epoch}-{nonce:016x}");

        // 输入根必须**先**存在：worker 对 `--staging`/`--inputs` 都要求目录已经在了
        // （它不接受「顺手替我建一个」），这是「worker 只认已授权的根」的一半。
        // `create_dir_all` 幂等，所以这里再确认一次不算重复劳动。
        std::fs::create_dir_all(&config.inputs_root)?;

        let mut command = ProcessCommand::new(&config.worker_path);
        command
            .arg("--pipe")
            .arg(server.name())
            .arg("--epoch")
            .arg(&epoch_tag)
            .arg("--nonce")
            .arg(nonce.to_string())
            .arg("--staging")
            .arg(&config.staging_root)
            .arg("--inputs")
            .arg(&config.inputs_root)
            // 引擎是构建时决定的能力：生产用真的 ONNX，测试用回声（它只走协议不算图）。
            .arg("--engine")
            .arg(config.worker_engine.as_arg())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 只给系统变量：worker 不该顺手读走用户环境里的任何东西。
            .env_clear()
            .env("SystemRoot", std::env::var("SystemRoot").unwrap_or_default())
            .env("TEMP", std::env::var("TEMP").unwrap_or_default());
        for (key, value) in &config.extra_env {
            command.env(key, value);
        }
        hide_console(&mut command);
        let mut child = command.spawn()?;

        let limits = JobLimits {
            memory_bytes: config.hard_commit_bytes,
            kill_on_close: true,
        };
        let (job, limits_applied, limits_note) = match JobObject::create(None, limits) {
            Ok(job) => match job.assign(&child) {
                Ok(()) => (Some(job), true, None),
                // 「没设限制」和「设了没生效」是两件事：如实记下来，界面上分得开。
                Err(note) => (Some(job), false, Some(note)),
            },
            Err(error) => (None, false, Some(format!("建 Job Object 失败：{error}"))),
        };

        let accepted = match server.accept(config.handshake_timeout) {
            Ok(accepted) => accepted,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        if accepted.peer_pid != child.id() {
            // 连上来的不是我们 spawn 的那个进程：这正是要拒绝的情况。
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(format!(
                "连上管道的进程 id 不对：{} ≠ {}",
                accepted.peer_pid,
                child.id()
            )));
        }

        // 必须把两个输出流抽干：管道缓冲满了会把 worker 卡在写日志上，
        // 那看起来就像「worker 无响应」。
        drop(drain(child.stdout.take()));
        drop(drain(child.stderr.take()));

        let reader_stream = accepted.stream.clone();
        let (sender, reports) = mpsc::channel();
        thread::Builder::new()
            .name("yomika-compute-reader".to_string())
            .spawn(move || read_loop(reader_stream, sender))
            .map_err(|error| io::Error::other(format!("起读线程失败：{error}")))?;

        Ok(Session {
            epoch,
            epoch_tag,
            peer_pid: accepted.peer_pid,
            child,
            stream: accepted.stream,
            reports,
            job,
            limits_applied,
            limits_note,
            spawned_at: Instant::now(),
            handshaked: false,
            ping_at: Instant::now() + Duration::from_millis(PING_INTERVAL_MS),
            misses: 0,
            ping_nonce: 0,
            running: None,
            release_reply: None,
            release_pending: false,
            release_at: None,
        })
    }

    /// 真正派发。并发 1 由调度器守（`take_next` 在 running 非空时直接给 None）。
    fn maybe_dispatch(&mut self) {
        let dispatchable = self
            .session
            .as_ref()
            .is_some_and(|session| session.handshaked && session.running.is_none());
        if !dispatchable {
            return;
        }

        // 前台在排队而占着许可的是后台：先请后台让路（§8.1）。
        if let Some(target) = self
            .shared
            .with_state(|state| state.scheduler.preemption_target())
        {
            let running_is_target = self
                .session
                .as_ref()
                .and_then(|session| session.running.as_ref())
                .is_some_and(|running| running.job_id == target);
            if running_is_target {
                self.request_running_cancel("前台插队");
                return;
            }
        }

        let Some(dispatched) = self.shared.with_state(|state| state.scheduler.take_next()) else {
            return;
        };
        let now_ms = self.shared.now_ms();
        let template = self
            .shared
            .with_state(|state| state.templates.get(&dispatched.job_id).cloned());
        let Some(template) = template else {
            // 排到了却没有模板：宿主的账错了。老实报内部错误，不要假装是 worker 丢的。
            self.shared.with_state(|state| {
                let epoch = state.scheduler.epoch();
                state.scheduler.apply_worker_event(
                    epoch,
                    WorkerEvent::Failed {
                        job_id: dispatched.job_id.clone(),
                        code: INTERNAL_CODE.to_string(),
                    },
                    now_ms,
                );
            });
            self.shared.emit(&[dispatched.job_id]);
            return;
        };

        let deadline_ms = if template.deadline_ms == 0 {
            DEFAULT_DEADLINE_MS
        } else {
            template.deadline_ms
        };
        // 派发前把「只有宿主才知道」的东西补齐：这一页的源图在哪、每个阶段用哪份模型。
        // 这是全流程里**最后**一个还能做几百毫秒磁盘活的地方——命令层挂在 WebView 的
        // 消息循环上（`commands.rs` 顶部），在那儿算一次 5 MB 模型的 blake3 就是界面卡住。
        let prepared = match self.prepare_run(&template) {
            Ok(prepared) => prepared,
            Err(failure) => {
                self.settle_prepare_failure(&dispatched.job_id, &failure, now_ms);
                return;
            }
        };
        let sent = {
            let Some(session) = self.session.as_mut() else {
                return;
            };
            let run = build_run(
                &dispatched,
                &template,
                &prepared,
                &session.epoch_tag,
                self.shared.config.intra_threads,
            );
            match send_frame(&mut session.stream, &Message::Run(run)) {
                Ok(()) => {
                    session.running = Some(Running {
                        job_id: dispatched.job_id.clone(),
                        deadline_at: Instant::now() + Duration::from_millis(deadline_ms),
                        cancel_at: None,
                        requested: false,
                    });
                    true
                }
                Err(_) => false,
            }
        };
        if !sent {
            self.lose_session("发 run 失败", None);
            return;
        }
        self.shared.emit(&[dispatched.job_id]);
    }

    /// 补上「只有宿主才知道」的两件事：这一页的源图在哪、每个阶段用哪份模型。
    ///
    /// 放在派发（supervisor 线程）而不是命令层：这里要算内容哈希、可能硬链接或复制
    /// 几十 MB，而命令体挂在 WebView2 的消息循环上（`commands.rs` 顶部）——在那儿做
    /// 就是窗口几百毫秒拖不动（docs/71 §8.1、§12.3）。
    ///
    /// 失败不回滚任何东西：源图与模型都是内容寻址的，摆进输入根就摆着了，一小时后由
    /// `sweep_inputs` 收走；第二次来还会命中同一块。
    fn prepare_run(&self, template: &SubmitRequest) -> Result<PreparedRun, StageFailure> {
        let config = &self.shared.config;
        let mut input = template.input.clone();
        if input.relative_path.is_none() {
            match template.source.as_ref() {
                Some(source) => {
                    let (byte_length, content_hash) =
                        crate::compute::artifacts::hash_file(&source.path).map_err(|error| {
                            StageFailure {
                                code: INPUT_INVALID_CODE,
                                detail: format!(
                                    "读不出这一页的源图 {}：{error}",
                                    source.path.display()
                                ),
                            }
                        })?;
                    // 「索引说这一页是这一份」与「磁盘上真的是这一份」要当面对一次。
                    // 内容寻址的位置本来不该装着别的字节，但这一行是从数据库里读出来的
                    // 说法，文件却是文件系统给的事实——两者不一致还接着算，就是拿别的
                    // 页去交一张看着正常的图（`tests/compute_page_source.rs` 的 tamper
                    // 那条钉的就是这里）。
                    if source.content_hash != content_hash {
                        return Err(StageFailure {
                            code: INPUT_INVALID_CODE,
                            detail: format!(
                                "这一页的源图与索引里说的不是同一份（索引 {}，磁盘 {content_hash}）",
                                source.content_hash
                            ),
                        });
                    }
                    // 一页装不下就别往下摆了。worker 自己也会拒（`dlssnr.rs` 里拿
                    // `budgets.max_pixels` 比一次就是），但那时它已经把图读完、把模型或
                    // 165 MB 的片段装好、上下文也建起来了——拒绝的代价是几十秒的 GPU 时间。
                    // 而这一页到底多大，读一下图头就知道，连那几十兆都不必先摆进输入根。
                    //
                    // 位置在身份对账**之后**：被写坏的源图仍然报「与索引不是同一份」，
                    // 不会被一句「太大」盖过去。量不到就放行——判据是量出来的那个数，不是
                    // 「没量到」本身；多拦一页的代价是用户永远算不了它，少放一件只是白花
                    // 一次 GPU 时间（与 `resource_policy::admission` 对读数不好使同一条规矩）。
                    if let Some(pixels) = super::page_budget::measure(&source.path) {
                        if !pixels.within_limit() {
                            return Err(StageFailure {
                                code: super::leases::RESOURCE_LIMIT_CODE,
                                detail: format!(
                                    "这一页 {}×{} 是 {} 像素，超过一页 {} 像素的上限：这一档算不了它（原图还在）",
                                    pixels.width,
                                    pixels.height,
                                    pixels.count(),
                                    resource_policy::PAGE_PIXEL_LIMIT
                                ),
                            });
                        }
                        // 同一笔预算的另一端：源图自己装得下，**乘上倍率**就未必了。worker
                        // 一直在判这一条（`upscale.rs` 拿 `max_pixels / scale²` 反推源图上限
                        // 就是），但判的时候图已经读进来、模型也装好了——同样的几十秒 GPU
                        // 时间，宿主这里只花一次乘法。
                        //
                        // 为什么取的是**乘积**而不是某一个阶段的倍率：链是一阶一阶接的
                        // （`worker/src/executor.rs` 的 `previous`），第二阶段的输入就是第一
                        // 阶段交出来的那张图，所以两阶 x2 是 x16 而不是 x4。按乘积判，与 worker
                        // 逐阶段判的结果完全一致：谁先越线就在谁那儿拒。
                        let scales: Vec<u32> = template
                            .pipeline
                            .iter()
                            .filter_map(|stage| stage.scale)
                            .collect();
                        let projected =
                            resource_policy::chain_output_pixels(pixels.count(), &scales);
                        if projected > resource_policy::PAGE_PIXEL_LIMIT {
                            return Err(StageFailure {
                                code: super::leases::RESOURCE_LIMIT_CODE,
                                detail: format!(
                                    "这一页 {}×{} 是 {} 像素，这条流水线（倍率 {}）算出来是 {} 像素，超过一档 {} 像素的预算：这一档算不了它（原图还在）",
                                    pixels.width,
                                    pixels.height,
                                    pixels.count(),
                                    scales
                                        .iter()
                                        .map(|scale| format!("x{scale}"))
                                        .collect::<Vec<_>>()
                                        .join("→"),
                                    projected,
                                    resource_policy::PAGE_PIXEL_LIMIT
                                ),
                            });
                        }
                    }
                    let relative_path = crate::compute::inputs::stage(
                        &config.inputs_root,
                        &source.path,
                        &content_hash,
                    )
                    .map_err(|error| StageFailure {
                        code: error.code(),
                        detail: error.message(),
                    })?;
                    input.relative_path = Some(relative_path);
                    input.content_hash = content_hash;
                    input.byte_length = byte_length;
                }
                // 没有源图：只有回声引擎能这么跑（它不读图，只走协议，进程/协议测试
                // 靠它）。真的超分引擎没有源图就无事可做，必须当场说清楚。
                None => {
                    if config.worker_engine != WorkerEngine::Echo {
                        return Err(StageFailure {
                            code: INPUT_INVALID_CODE,
                            detail: "这次提交没有源图，而 worker 跑的是真的超分引擎".to_string(),
                        });
                    }
                }
            }
        }
        let mut pipeline = template.pipeline.clone();
        for stage in pipeline.iter_mut() {
            // 阶段自带声明就不动它：宿主只补缺的那部分。
            //
            // DLSSNR 那一档（`stage.dlssnr`）也必须在这里被跳过，理由不只是「它自带声明」：
            // 它的两份授权由 `proxy::dlssnr` 按内容摆好了，而**这一栏 `model_spec_id` 不是
            // 模型目录里的 id**（它是「这一档叫什么」）。不跳过的后果是宿主拿着这一档的名字
            // 去模型目录里找一个叫 `dlssnr` 的模型，找不到就报 `COMPUTE_MODEL_UNAVAILABLE`
            // ——一条看起来像「模型没下载」的错，而这一页根本不需要任何模型。
            if stage.model.is_some() || stage.decensor.is_some() || stage.dlssnr.is_some() {
                continue;
            }
            // 去码那条路不走模型目录：它的三件套（检测器 + 两份修补模型）在**这一台机器**上，
            // 由宿主自己摆进输入根。摆在派发前而不是提交时，是为了让「这一页用的是这三份」
            // 与「磁盘上真的是这三份」在同一个地方对账（`stage_inpaint`）。
            if stage.stage_id == super::decensor::DECENSOR_STAGE_ID {
                let Some(preparation) = template.inpaint.as_ref() else {
                    return Err(StageFailure {
                        code: INPUT_INVALID_CODE,
                        detail: "这条去码阶段没有三件套：宿主没有说清这一页用哪三份模型"
                            .to_string(),
                    });
                };
                stage.decensor = Some(
                    super::decensor::stage_inpaint(&config.inputs_root, preparation).map_err(
                        |error| StageFailure {
                            code: error.code,
                            detail: error.message,
                        },
                    )?,
                );
                continue;
            }
            if let Some(models) = config.models.as_ref() {
                let staged = models
                    .stage(&config.inputs_root, &stage.model_spec_id)
                    .map_err(|error| StageFailure {
                        code: error.code(),
                        detail: error.message(),
                    })?;
                stage.model = Some(staged.grant);
                stage.min_input_edge = Some(staged.min_input_edge);
            }
        }
        Ok(PreparedRun { input, pipeline })
    }

    /// 派发前准备失败：按一次「这一代 worker 回失败」结算。
    ///
    /// 走的仍是调度器那条失败通道（与模板丢了、worker 报了 Failed 同一个出口），所以
    /// 队列、代际、事件、重试全都照旧——这里只是失败的**来源**不同。
    fn settle_prepare_failure(&self, job_id: &str, failure: &StageFailure, now_ms: u64) {
        eprintln!(
            "yomika: 派发前准备失败（{}）：{}",
            failure.code, failure.detail
        );
        self.shared.with_state(|state| {
            let epoch = state.scheduler.epoch();
            state.scheduler.apply_worker_event(
                epoch,
                WorkerEvent::Failed {
                    job_id: job_id.to_string(),
                    code: failure.code.to_string(),
                },
                now_ms,
            );
        });
        self.shared.emit(&[job_id.to_string()]);
    }
}

/// 派发前补齐之后真正要发出去的那份 run（宿主自己解析出来的源图与模型授权）。
struct PreparedRun {
    input: RunInput,
    pipeline: Vec<PipelineStage>,
}

/// 派发前准备失败：一个前端认识的错误码 + 一句给人看的理由。
struct StageFailure {
    code: &'static str,
    detail: String,
}

fn build_run(
    dispatched: &Dispatched,
    template: &SubmitRequest,
    prepared: &PreparedRun,
    epoch_tag: &str,
    intra_threads: u32,
) -> Run {
    Run {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch_tag.to_string(),
        job_id: dispatched.job_id.clone(),
        generation: dispatched.snapshot.key.generation,
        // 输入与阶段来自 `prepare_run`（补上了源图与模型），其余照抄模板。
        input: prepared.input.clone(),
        pipeline: prepared.pipeline.clone(),
        output_grant_id: template.output_grant_id.clone(),
        priority: match template.priority {
            Priority::Foreground => yomika_compute_protocol::Priority::Foreground,
            Priority::Background => yomika_compute_protocol::Priority::Background,
        },
        deadline_ms: if template.deadline_ms == 0 {
            DEFAULT_DEADLINE_MS
        } else {
            template.deadline_ms
        },
        budgets: Budgets {
            max_pixels: resource_policy::PAGE_PIXEL_LIMIT,
            max_output_bytes: crate::compute::artifacts::MAX_ARTIFACT_BYTES,
            intra_threads,
        },
    }
}

/// 把一件正在跑的任务结算掉（取消宽限用完了、或者宿主自己收摊）。
fn settle_job(
    shared: &Shared,
    epoch: u64,
    running: &Option<Running>,
    state: JobState,
    now_ms: u64,
) {
    let Some(running) = running else {
        return;
    };
    let event = match state {
        JobState::Cancelled => WorkerEvent::Cancelled {
            job_id: running.job_id.clone(),
        },
        JobState::Completed => WorkerEvent::Completed {
            job_id: running.job_id.clone(),
        },
        JobState::Failed { code } => WorkerEvent::Failed {
            job_id: running.job_id.clone(),
            code,
        },
        _ => return,
    };
    shared.with_state(|state| state.scheduler.apply_worker_event(epoch, event, now_ms));
}

fn prune_templates(state: &mut State) {
    // 快照被回收之后模板就没用了；顺手清掉，免得这份账跟着终态快照一起无限长。
    let gone: Vec<String> = state
        .templates
        .keys()
        .filter(|job_id| state.scheduler.snapshot(job_id).is_none())
        .cloned()
        .collect();
    for job_id in gone {
        state.templates.remove(&job_id);
    }
}

/// 一具解析不了的帧该报哪一种（Task 10 第 2 条）。
///
/// 两种现场在宿主这一侧的处置不一样，所以这一句判断不能含糊：大版本不符是「这一份
/// worker 不是给这个宿主编的」，换一代解决不了，`Refused` 走拒跑；帧坏了才是它在出事，
/// `Closed` 走崩溃那本账。抽成函数是为了让这条判断本身能被单独钉住——`read_loop` 里
/// 一个 `if` 没法从测试里够到。
fn parse_failure_report(error: &yomika_compute_protocol::ProtocolError) -> Report {
    if error.is_version_mismatch() {
        Report::Refused(format!("对面的协议大版本不认识：{error}"))
    } else {
        Report::Closed(format!("协议解析失败：{error}"))
    }
}

/// 读线程：只做「读帧 → 解析 → 交给控制线程」，不碰任何共享状态。
fn read_loop(mut stream: PipeStream, sender: Sender<Report>) {
    loop {
        match read_frame(&mut stream) {
            Ok(None) => {
                let _ = sender.send(Report::Closed("对端关掉了管道".to_string()));
                return;
            }
            Ok(Some(body)) => match parse(&body) {
                Ok(message) => {
                    if sender.send(Report::Message(Box::new(message))).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(parse_failure_report(&error));
                    return;
                }
            },
            Err(error) => {
                let _ = sender.send(Report::Closed(format!("读帧失败：{error}")));
                return;
            }
        }
    }
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> Option<JoinHandle<()>> {
    let mut pipe = pipe?;
    thread::Builder::new()
        .name("yomika-compute-drain".to_string())
        .spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(read) = pipe.read(&mut buffer) {
                if read == 0 {
                    return;
                }
            }
        })
        .ok()
}

fn send_frame(stream: &mut PipeStream, message: &Message) -> io::Result<()> {
    let body = encode(message).map_err(|error| io::Error::other(format!("编码消息失败：{error}")))?;
    write_frame(stream, body.as_bytes()).map_err(|error| io::Error::other(format!("写帧失败：{error}")))
}

/// 收掉进程，并且**等它真的退出**（§8.2：没退出之前不给下一件任务许可）。
fn terminate_process(session: &mut Session, grace: Duration) {
    if let Some(job) = session.job.take() {
        let _ = job.terminate();
    }
    let deadline = Instant::now() + grace;
    loop {
        match session.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => break,
        }
    }
    let _ = session.child.kill();
    let _ = session.child.wait();
}

/// 把 staging 里上一代留下来的东西收回去。
///
/// 只在**确定没有写者**的两个时刻调用：握手刚谈成（上一代 worker 已经不在了，这批
/// job 还没派发，有 job 才有正在飞的产物）与会话收摊之后（`terminate_process` 已经把
/// 进程收掉了）。正因为这两个时刻没有写者，宽限期传 `ZERO`——在这里留宽限，只会把
/// 该收的留下来。
///
/// 收的是两样：上一代没交接完的半成品，以及 worker 自己在 staging 里攒的那棵暂存子树
/// （NGX 片段，见 `artifacts::sweep_staging`）。收不掉只是下次再来，不算错误。
///
/// **输入根不在这儿收**：里面的东西是宿主放的，排队的任务可能还要用，收摊这一刻并不能
/// 证明它们没人要。
fn reclaim_staging(shared: &Shared) {
    let staging_root = shared.config.staging_root.clone();
    match crate::compute::artifacts::sweep_staging(&staging_root, Duration::ZERO) {
        Ok(sweep) if sweep.removed_files > 0 => eprintln!(
            "yomika: 清掉 {} 个上次没交接完的产物（{} 字节）",
            sweep.removed_files, sweep.bytes_freed
        ),
        Ok(_) => {}
        Err(error) => eprintln!("yomika: 清扫 staging 失败：{error}"),
    }
}

/// 宿主自己核产物：名字、长度、哈希。**worker 说了什么都不算数。**
///
/// 核过之后，配了发布根就顺手发布进内容寻址存储——这一步同样不等任何人：正式缓存里要么
/// 没有这份内容，要么就是完整的它（先写同目录临时文件再 rename）。
fn artifact_belongs_to_run(ready: &ArtifactReady, template: &SubmitRequest, snapshot: &JobSnapshot, running_id: Option<&str>) -> bool {
    running_id == Some(ready.job_id.as_str())
        && ready.job_id == snapshot.job_id
        && ready.generation == snapshot.key.generation
        && ready.generation == template.key.generation
        && ready.output_grant_id == template.output_grant_id
        && template.pipeline.iter().any(|stage| stage.stage_id == ready.stage_id)
}

fn verify_artifact(
    staging_root: &Path,
    publish_root: Option<&Path>,
    ready: &ArtifactReady,
) -> Result<ArtifactRecord, String> {
    // 长度、哈希、路径三道门都在 artifacts 里，这里只负责把错误翻成人话
    let staged = crate::compute::artifacts::verify_staged_name(
        staging_root,
        &ready.relative_name,
        ready.byte_length,
        &ready.content_hash,
    )
    .map_err(|error| format!("产物没通过核验：{error}"))?;

    // A content hash proves the bytes, not the worker's metadata. Check headers
    // before publishing so forged dimensions cannot evade decoded-memory budgets.
    // Echo fixtures are non-image protocol probes, never renderer artifacts.
    if ready.mime.starts_with("image/") {
        let reader = image::ImageReader::open(&staged)
            .map_err(|error| format!("产物图片头打不开：{error}"))?
            .with_guessed_format()
            .map_err(|error| format!("产物图片格式读不出来：{error}"))?;
        let format = reader.format().ok_or_else(|| "产物不是可识别的图片".to_string())?;
        if format.to_mime_type() != ready.mime {
            return Err(format!("产物 MIME 与文件头不符：声明 {}，实际 {}", ready.mime, format.to_mime_type()));
        }
        let (width, height) = reader.into_dimensions()
            .map_err(|error| format!("产物图片尺寸读不出来：{error}"))?;
        if (width, height) != (ready.width, ready.height) {
            return Err(format!("产物尺寸与文件头不符：声明 {}×{}，实际 {width}×{height}", ready.width, ready.height));
        }
        if !super::resource_policy::pixels_within_page_limit(width, height) {
            return Err("产物图片超出页面像素预算".to_string());
        }
    }

    let (path, cache_relative) = match publish_root {
        Some(root) => {
            let published =
                crate::compute::artifacts::publish_blob(root, &staged, &ready.content_hash)
                    .map_err(|error| format!("产物发布失败：{error}"))?;
            (published.path, Some(published.relative))
        }
        None => (staged, None),
    };

    Ok(ArtifactRecord {
        job_id: ready.job_id.clone(),
        stage_id: ready.stage_id.clone(),
        artifact_id: ready.artifact_id.clone(),
        staging_name: ready.relative_name.clone(),
        path,
        cache_relative,
        byte_length: ready.byte_length,
        content_hash: ready.content_hash.clone(),
        width: ready.width,
        height: ready.height,
        engine_id: ready.engine.id.clone(),
        engine_precision: format!("{:?}", ready.engine.precision),
        engine_policy: ready
            .engine
            .policy
            .map(|policy| policy.as_str().to_string()),
        engine_fallback: ready.engine.fallback.clone(),
        pipeline_revision: ready.pipeline_revision.clone(),
        verified: true,
    })
}

/// 不可猜的 nonce（编进 `worker_epoch` 用）。真正的门是 DACL + 随机管道名，
/// 这个只是让「猜到同一台机器上的另一个 worker」也过不去。
fn mint_nonce() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let ticks = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    let seq = NEXT.fetch_add(1, Ordering::Relaxed);
    (ticks ^ (seq.wrapping_mul(0x9e37_79b9_7f4a_7c15))) ^ ((std::process::id() as u64) << 32)
}

#[cfg(windows)]
fn hide_console(command: &mut ProcessCommand) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut ProcessCommand) {}

#[cfg(windows)]
fn physical_ram_bytes() -> Option<u64> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    Some(status.ullTotalPhys)
}

#[cfg(not(windows))]
fn physical_ram_bytes() -> Option<u64> {
    None
}

/// 整卡本地段的显存余量（`budget - used`）与预算，问的是 DXGI。
///
/// 非 Windows 目标上没有 DXGI——`compute-core` 的 `dlssnr` 整个就是**目标门**（Android 上
/// 连那个模块都没有）——量不到就留空。「不知道」不是「没压力」，与 [`physical_ram_bytes`]
/// 同一个道理：`admission` 不会因为量不到就把任务挡回去。2026-10-03 之前这里是直接调
/// `yomika_compute_core::dlssnr::gpu::video_memory()`，Android release 构建因此编不过
/// （`error[E0433]: cannot find dlssnr in yomika_compute_core`）。
#[cfg(windows)]
fn gpu_memory_reading() -> Option<(u64, u64)> {
    let memory = yomika_compute_core::dlssnr::gpu::video_memory()?;
    Some((memory.free_bytes(), memory.budget_bytes))
}

#[cfg(not(windows))]
fn gpu_memory_reading() -> Option<(u64, u64)> {
    None
}

/// 采一份压力读数：worker 的私有提交 ＋ DXGI 本地段的显存预算（后者只有 Windows 上量得到，
/// 见 [`gpu_memory_reading`]）。
///
/// `child = None`（还没有 worker）时提交那一项留空——「不知道」不是「没压力」，
/// [`resource_policy::admission`] 不会因为量不到就把任务挡回去。
fn sampled_pressure(child: Option<&Child>) -> resource_policy::PressureReading {
    let mut reading = resource_policy::PressureReading::unknown();
    if let Some(child) = child {
        reading.private_commit_bytes = private_commit_of(child.id());
    }
    if let Some((free, total)) = gpu_memory_reading() {
        reading.gpu_free_bytes = Some(free);
        reading.gpu_total_bytes = Some(total);
    }
    reading
}

/// 某个进程此刻的私有提交（`GetProcessMemoryInfo` 的 `PrivateUsage`）。
///
/// 量这个而不是整机已用内存：Job Object 的硬限和 §8.1 的软/硬阈值量的都是**这个进程**
/// 要占的那份，整机数字里混着别人的账，拿它判「这次计算会不会失败」会误伤。
/// 量不到（进程刚走、权限不够）就返回 `None`——「不知道」不等于「没压力」。
#[cfg(windows)]
fn private_commit_of(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        // `PrivateUsage` 只在 `_EX` 那一版里；`GetProcessMemoryInfo` 的形参写的是不带 `_EX`
        // 的类型，两版前缀相同，所以按 `_EX` 的大小申请、把指针转过去。
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        let queried = GetProcessMemoryInfo(
            handle,
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        );
        let _ = CloseHandle(handle);
        queried.ok()?;
        Some(counters.PrivateUsage as u64)
    }
}

#[cfg(not(windows))]
fn private_commit_of(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use yomika_compute_protocol::{EngineFallback, EnginePolicy, EngineReport, Precision};

    /// 读数要对「量不到」诚实：没有 worker 就没有提交读数（留空，不是 0——0 会被读成
    /// 「一点内存都没占」），显存余量不该比预算大。这条同时钉住
    /// `GetProcessMemoryInfo` 那一趟（`PrivateUsage` 只在 `_EX` 那版里，写错了这里就红）。
    #[test]
    fn a_pressure_reading_is_honest_about_what_it_could_not_measure() {
        let reading = sampled_pressure(None);
        assert_eq!(
            reading.private_commit_bytes, None,
            "没有 worker 就没有提交读数，留空而不是写 0"
        );
        if let (Some(free), Some(total)) = (reading.gpu_free_bytes, reading.gpu_total_bytes) {
            assert!(free <= total, "余量不该比预算大：free={free} total={total}");
        }
        #[cfg(windows)]
        {
            let mine = private_commit_of(std::process::id())
                .expect("自己有进程，私有提交该量得到");
            assert!(mine > 0, "测试进程总归占着内存，量出来却是 0");
        }
    }

    /// worker 状态要跨过桥：那头的 schema（`src/domain/compute.ts` 的
    /// `ComputeWorkerStatusSchema`）只认 camelCase——`peerPid`/`limitsApplied`/`limitsNote`。
    /// serde 的 `rename_all` 只管**变体名**（`Ready` → `"ready"`），结构体变体的**字段**要
    /// 另写 `rename_all_fields` 才会跟着改。少了那一句，`compute_worker_status` 的响应永远解不出来
    /// （`INVALID_RESPONSE`），界面上那句「2 秒内给到正在恢复/不可用」就没地方可量——
    /// 真窗口里量到过这个 NULL：`{"kind":"ready","peer_pid":45088,"limits_applied":true,…}`。
    #[test]
    fn the_worker_status_crosses_the_bridge_with_the_field_names_the_schema_wants() {
        let ready = WorkerStatus::Ready {
            epoch: 1,
            peer_pid: 42,
            limits_applied: true,
            limits_note: Some("没套上 Job Object".to_string()),
        };
        let value = serde_json::to_value(&ready).expect("序列化 worker 状态");
        assert_eq!(value["kind"], "ready", "变体名要靠 rename_all 变成小写");
        assert_eq!(value["peerPid"], 42, "字段名也要 camelCase，不然桥那头整条响应都解不出来");
        assert_eq!(value["limitsApplied"], true, "字段名也要 camelCase");
        assert_eq!(value["limitsNote"], "没套上 Job Object", "字段名也要 camelCase");
        assert_eq!(
            value.get("peer_pid"),
            None,
            "snake_case 的字段名会让 `ComputeWorkerStatusSchema.safeParse` 失败，界面永远读不到 worker"
        );
    }

    /// 「主 exe 与 worker 构建戳一致」（Task 10 第 2 条）：不拼旧 worker 新宿主。
    ///
    /// 判据是一个纯函数：三种现场（两个戳一样／宿主自己没戳／对不上）必须能各自量到。
    /// 只有第三种该拒跑，第二种只能放行并留一句话（在没 git 的机器上从源码编出来的
    /// 两份都没有戳，那是实话）；混成一个布尔，要么把开发机构成全是错的，要么让装错的
    /// 包照跑。
    #[test]
    fn a_worker_from_another_build_is_not_paired_with_this_host() {
        assert_eq!(
            build_stamp_verdict("d4baa5cbc27c", "d4baa5cbc27c"),
            StampVerdict::Same,
            "同一个提交编出来的两半要认得出是一对"
        );
        assert_eq!(
            build_stamp_verdict("", "d4baa5cbc27c"),
            StampVerdict::HostUnknown,
            "宿主自己没带戳（没 git、或不是从仓库编的）时判不出来，只能放行"
        );
        assert_eq!(
            build_stamp_verdict("d4baa5cbc27c", ""),
            StampVerdict::Mismatch {
                host: "d4baa5cbc27c".to_string(),
                worker: String::new(),
            },
            "对面一个字都不报（老 worker 没有这个字段）就是旧包：不能拼"
        );
        let other = build_stamp_verdict("d4baa5cbc27c", "000000000000");
        assert!(
            matches!(other, StampVerdict::Mismatch { .. }),
            "两个不一样的戳要判成不配：{other:?}"
        );
    }

    /// 解析不了的那一帧走哪一条路（Task 10 第 2 条「协议不符不阻断主窗」的那一半）。
    ///
    /// 两种现场长得像（都是「读不动对面这一帧」），处置却相反：大版本不符要拒跑
    /// （换一代解决不了、别赔三次重启），帧坏了才是它在出事（该换代、该进退避账）。
    /// 判错一边的后果都不是崩溃，而是每次装错包都先白等 14 秒、或者真正的损坏被当成
    /// 「对面版本不同」永远不重试。
    #[test]
    fn a_foreign_protocol_major_is_refused_instead_of_being_treated_as_a_broken_frame() {
        let foreign = parse_failure_report(
            &yomika_compute_protocol::ProtocolError::UnknownVersion { found: 2 },
        );
        assert!(
            matches!(foreign, Report::Refused(_)),
            "大版本不符要走拒跑（`Report` 没实现 Debug，所以这里不打印它）"
        );
        let broken = parse_failure_report(&yomika_compute_protocol::ProtocolError::Malformed(
            "body 不是 JSON".to_string(),
        ));
        assert!(
            matches!(broken, Report::Closed(_)),
            "帧坏了才是这一代 worker 出事"
        );
        let missing =
            parse_failure_report(&yomika_compute_protocol::ProtocolError::MissingVersion);
        assert!(
            matches!(missing, Report::Closed(_)),
            "缺 version 是畸形消息，不是「对面说的是另一个大版本」"
        );
    }

    fn dummy_ready(relative_name: &str, byte_length: u64, content_hash: &str) -> ArtifactReady {
        ArtifactReady {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: "1-abc".to_string(),
            job_id: "job-1".to_string(),
            generation: 1,
            stage_id: "stage-a".to_string(),
            artifact_id: "artifact-1".to_string(),
            output_grant_id: "grant-1".to_string(),
            relative_name: relative_name.to_string(),
            content_hash: content_hash.to_string(),
            mime: "application/octet-stream".to_string(),
            byte_length,
            width: 64,
            height: 64,
            engine: EngineReport {
                id: "echo".to_string(),
                version: "0.1.0".to_string(),
                precision: Precision::Fp32,
                device_id: "cpu".to_string(),
                // 夹具故意带一次真回退：宿主把这两栏原样传给前端，界面就靠它把
                // 「自动退回去」说出来。
                policy: Some(EnginePolicy::Auto),
                fallback: Some(EngineFallback {
                    requested: "directml".to_string(),
                    used: "cpu".to_string(),
                    reason: "directml 在这台机器上不可用".to_string(),
                }),
            },
            pipeline_revision: "worker-v1:abcd".to_string(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yomika-manager-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn the_host_verifies_the_hash_and_the_length_itself() {
        let dir = temp_dir("verify");
        let payload = b"hello worker";
        let path = dir.join("stage-a.bin");
        fs::write(&path, payload).expect("写产物");
        let (_, digest) = crate::compute::artifacts::hash_file(&path).expect("算哈希");

        let good = verify_artifact(
            &dir,
            None,
            &dummy_ready("stage-a.bin", payload.len() as u64, &digest),
        );
        assert!(good.is_ok(), "宿主自己核过了才让它过");
        let record = good.expect("核过了");
        assert!(record.verified);
        assert_eq!(record.engine_id, "echo");
        assert_eq!(record.engine_precision, "Fp32");
        assert_eq!(
            record.engine_policy.as_deref(),
            Some("auto"),
            "被问的是哪条政策要原样传到前端"
        );
        let fallback = record.engine_fallback.expect("回退交代也要原样传到前端");
        assert_eq!(fallback.requested, "directml");
        assert_eq!(fallback.used, "cpu");
        assert_eq!(record.cache_relative, None, "没配发布根就留在 staging");

        let wrong_hash = verify_artifact(
            &dir,
            None,
            &dummy_ready("stage-a.bin", payload.len() as u64, &"0".repeat(64)),
        );
        assert!(wrong_hash.is_err(), "哈希对不上必须拒");

        let wrong_length = verify_artifact(&dir, None, &dummy_ready("stage-a.bin", 999, &digest));
        assert!(wrong_length.is_err(), "长度对不上必须拒");

        let missing = verify_artifact(&dir, None, &dummy_ready("nope.bin", 1, &digest));
        assert!(missing.is_err(), "文件不在必须拒");

        let traversal = verify_artifact(&dir, None, &dummy_ready("../escape.bin", 1, &digest));
        assert!(traversal.is_err(), "路径穿越必须拒");
    }

    /// 配了发布根：核过之后要落进内容寻址存储，而且路径由**内容**决定。
    #[test]
    fn a_verified_artifact_is_published_by_its_content() {
        let dir = temp_dir("publish");
        let data = dir.join("data");
        fs::create_dir_all(&data).expect("建数据根");
        let payload = b"hello worker";
        fs::write(dir.join("stage-a.bin"), payload).expect("写产物");
        let (_, digest) = crate::compute::artifacts::hash_file(&dir.join("stage-a.bin"))
            .expect("算哈希");

        let record = verify_artifact(
            &dir,
            Some(&data),
            &dummy_ready("stage-a.bin", payload.len() as u64, &digest),
        )
        .expect("核过并发布");

        let relative = record.cache_relative.expect("配了发布根就该有内容寻址路径");
        assert_eq!(relative, format!("cache/images/{}/{digest}.bin", &digest[..2]));
        assert_eq!(record.path, data.join(&relative));
        assert_eq!(fs::read(&record.path).expect("读回来"), payload);
    }

    #[test]
    fn nonces_do_not_repeat_within_a_process() {
        let first = mint_nonce();
        let second = mint_nonce();
        assert_ne!(first, second, "两次 spawn 不能拿到同一个 nonce");
    }

    #[test]
    fn image_artifacts_are_rejected_when_worker_dimensions_or_mime_lie() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("page.png");
        image::RgbaImage::new(2, 3).save(&path).unwrap();
        let (length, digest) = crate::compute::artifacts::hash_file(&path).unwrap();
        let mut ready = dummy_ready("page.png", length, &digest);
        ready.mime = "image/png".into();
        ready.width = 2;
        ready.height = 3;
        assert!(verify_artifact(dir.path(), None, &ready).is_ok());
        ready.width = 1;
        assert!(verify_artifact(dir.path(), None, &ready).is_err(), "verified hash does not validate claimed dimensions");
        ready.width = 2;
        ready.mime = "image/jpeg".into();
        assert!(verify_artifact(dir.path(), None, &ready).is_err(), "the worker's image type must match the file header");
    }


    #[test]
    fn artifact_grants_are_bound_to_the_running_job_generation_and_stage() {
        let mut ready = dummy_ready("stage-a.bin", 1, &"a".repeat(64));
        let template = SubmitRequest {
            key: JobKey { input_id: "page".into(), settings_id: "s".into(), source_revision: "r".into(), backend: "cpu".into(), generation: 1 },
            priority: Priority::Foreground,
            input: RunInput { input_id: "page".into(), content_hash: "a".repeat(64), byte_length: 1, relative_path: None },
            pipeline: vec![serde_json::from_value(serde_json::json!({ "stageId": "stage-a", "modelSpecId": "echo", "enginePolicy": "cpu" })).unwrap()],
            output_grant_id: "grant-1".into(), deadline_ms: 1000,
            source: None, inpaint: None,
        };
        let mut scheduler = Scheduler::new(1);
        let submitted = scheduler.submit(template.key.clone(), Priority::Foreground, 0).unwrap();
        let mut snapshot = submitted.snapshot;
        snapshot.job_id = "job-1".into();
        assert!(artifact_belongs_to_run(&ready, &template, &snapshot, Some("job-1")));
        ready.output_grant_id = "another-grant".into();
        assert!(!artifact_belongs_to_run(&ready, &template, &snapshot, Some("job-1")));
        ready.output_grant_id = "grant-1".into();
        ready.generation = 2;
        assert!(!artifact_belongs_to_run(&ready, &template, &snapshot, Some("job-1")));
        ready.generation = 1;
        ready.stage_id = "undeclared".into();
        assert!(!artifact_belongs_to_run(&ready, &template, &snapshot, Some("job-1")));
        ready.stage_id = "stage-a".into();
        assert!(!artifact_belongs_to_run(&ready, &template, &snapshot, Some("other-job")));
    }

}
