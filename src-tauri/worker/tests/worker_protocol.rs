//! Task 3 的协议会话测试（docs/71 §11 Task 3 的 ①③④⑤ 条）。
//!
//! 这里用**内存双工**冒充宿主：会话状态机对 `Read`/`Write` 泛型，所以握手、version
//! 不符、一帧跨两次读（prefix 分包）、双 run busy、边算边 ping/cancel、控制面与
//! 计算互不阻塞这些事都能在进程内确定性地测到。真命名管道（DACL/PID/nonce、隐藏
//! 窗口、最小环境）是 Task 4 的 supervisor 负责的那一半。

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use yomika_compute_protocol::messages::{
    ArtifactRef, BuildInfo, Budgets, EnginePolicy, EngineReport, EpochOnly, HelloAck, JobRef,
    Message, PipelineStage, Precision, Priority, Run, RunInput, PROTOCOL_MAJOR,
};
use yomika_compute_protocol::{encode, parse, write_frame, MAX_FRAME_BYTES};
use yomika_compute_worker::engine::{Engine, StageError, StageOutput, StageRequest};
use yomika_compute_worker::protocol::{run, SessionError, SessionOptions, SessionOutcome};

/// 会话身份的前缀，只为了让人一眼看出这是测试造的号。
const EPOCH_PREFIX: &str = "epoch-7";
const TIMEOUT: Duration = Duration::from_secs(5);

thread_local! {
    /// 当前这条用例的会话身份。
    ///
    /// 核心的取消注册表是**进程级**的（`crates/compute-core/src/cancel.rs`），键是
    /// `epoch/job_id`；而同一个测试二进制里的用例是**并行**跑的。早先这里所有人都用
    /// 手写常量 `epoch-7` 当身份，于是 A 用例发给自己的那条 `Cancel` 会命中 B 用例
    /// 同名的 `job-1`——实测看到过 `pings_and_progress…` 在 `stage_started` 之前就
    /// 收到 `Cancelled`。生产上宿主每次 spawn 都随机生成 epoch（`worker/src/protocol.rs`
    /// 顶部写明的约定），夹具照同一条不变式来：**一个夹具一个身份**。
    ///
    /// 放线程局部是因为 `cargo test` 一条用例一个线程，而消息构造函数（`run_message`
    /// 之类）是自由函数；身份随夹具走，调用点就不必人手转发一遍。
    static SESSION_EPOCH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// 造一个新的会话身份。`label` 给人看，唯一性靠进程内的序号。
fn fresh_epoch(label: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{EPOCH_PREFIX}-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// 当前线程的会话身份（由 `Harness::new` 设好）。
fn epoch() -> String {
    SESSION_EPOCH.with(|cell| cell.borrow().clone())
}

// ---------------------------------------------------------------- 内存双工

/// 宿主的假管道：`to_worker` 是 worker 读的那一头，`from_worker` 是它写的那一头。
/// `chunk` 限制 worker 每次 `read` 最多拿到几个字节，用来制造「一帧跨两次读」。
struct Duplex {
    inner: Mutex<DuplexInner>,
    in_cv: Condvar,
    out_cv: Condvar,
    chunk: usize,
}

struct DuplexInner {
    to_worker: VecDeque<u8>,
    open: bool,
    from_worker: Vec<u8>,
}

impl Duplex {
    fn new(chunk: usize) -> Self {
        Self {
            inner: Mutex::new(DuplexInner {
                to_worker: VecDeque::new(),
                open: true,
                from_worker: Vec::new(),
            }),
            in_cv: Condvar::new(),
            out_cv: Condvar::new(),
            chunk,
        }
    }

    fn push_message(&self, message: &Message) {
        let body = encode(message)
            .unwrap_or_else(|error| panic!("测试自己编码失败：{error:?}"));
        let mut frame = Vec::new();
        write_frame(&mut frame, body.as_bytes()).expect("测试自己写帧失败");
        self.push_bytes(&frame);
    }

    fn push_bytes(&self, bytes: &[u8]) {
        let mut inner = self.inner.lock().unwrap();
        inner.to_worker.extend(bytes);
        self.in_cv.notify_all();
    }

    fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.open = false;
        self.in_cv.notify_all();
    }

    /// 从 worker 写出来的字节流里取出一整帧（不足则返回 `None`，不阻塞）。
    fn take_out_frame(&self, consumed: &mut usize) -> Option<Vec<u8>> {
        let inner = self.inner.lock().unwrap();
        let bytes = inner.from_worker.as_slice();
        if bytes.len() < *consumed + 4 {
            return None;
        }
        let declared = u32::from_le_bytes(
            bytes[*consumed..*consumed + 4]
                .try_into()
                .expect("四个字节就是 u32"),
        ) as usize;
        assert!(
            declared <= MAX_FRAME_BYTES,
            "worker 不许发超过帧上限的消息（声称 {declared} 字节）"
        );
        if bytes.len() < *consumed + 4 + declared {
            return None;
        }
        let body = bytes[*consumed + 4..*consumed + 4 + declared].to_vec();
        *consumed += 4 + declared;
        Some(body)
    }

    fn wait_for_output(&self, timeout: Duration) {
        let inner = self.inner.lock().unwrap();
        let _ = self.out_cv.wait_timeout(inner, timeout).unwrap();
    }
}

/// worker 会话读到的那一半。
struct WorkerReader(Arc<Duplex>);

impl Read for WorkerReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut inner = self.0.inner.lock().unwrap();
        loop {
            if !inner.to_worker.is_empty() {
                break;
            }
            if !inner.open {
                return Ok(0);
            }
            inner = self.0.in_cv.wait(inner).unwrap();
        }
        let take = buffer.len().min(self.0.chunk).min(inner.to_worker.len());
        for slot in buffer[..take].iter_mut() {
            *slot = inner.to_worker.pop_front().expect("上面已确认非空");
        }
        Ok(take)
    }
}

/// worker 会话写到的那一半。
struct WorkerWriter(Arc<Duplex>);

impl Write for WorkerWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut inner = self.0.inner.lock().unwrap();
        inner.from_worker.extend_from_slice(buffer);
        drop(inner);
        self.0.out_cv.notify_all();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------- 假宿主

struct Host {
    duplex: Arc<Duplex>,
    consumed: usize,
}

impl Host {
    fn send(&self, message: &Message) {
        self.duplex.push_message(message);
    }

    fn next(&mut self, timeout: Duration) -> Option<Message> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(body) = self.duplex.take_out_frame(&mut self.consumed) {
                return Some(
                    parse(&body)
                        .unwrap_or_else(|error| panic!("worker 发出的帧必须合法：{error:?}")),
                );
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            self.duplex.wait_for_output(deadline - now);
        }
    }

    fn expect(&mut self, kind: &str) -> Message {
        match self.next(TIMEOUT) {
            Some(message) => {
                assert_eq!(
                    message.kind(),
                    kind,
                    "期待的下一帧是 {kind}，收到 {message:?}"
                );
                message
            }
            None => panic!("等 {kind} 超时"),
        }
    }

    /// 一直读到 `kind` 为止，把路上的帧按顺序交出来。
    fn collect_until(&mut self, kind: &str) -> Vec<Message> {
        let mut collected = Vec::new();
        loop {
            let message = match self.next(TIMEOUT) {
                Some(message) => message,
                None => panic!("等 {kind} 超时，只收到 {collected:?}"),
            };
            let done = message.kind() == kind;
            collected.push(message);
            if done {
                return collected;
            }
        }
    }
}

// ---------------------------------------------------------------- 假引擎

#[derive(Clone, Default)]
struct TestEngine(Arc<TestEngineInner>);

#[derive(Default)]
struct TestEngineInner {
    entered: Mutex<Vec<String>>,
    entered_cv: Condvar,
    blocked: AtomicBool,
    released: Mutex<bool>,
    released_cv: Condvar,
    honor_cancel: AtomicBool,
    delay_ms: AtomicU64,
    progress_steps: AtomicU32,
    fail_code: Mutex<Option<String>>,
    bad_name: AtomicBool,
    written: Mutex<Vec<(String, u64)>>,
}

impl TestEngine {
    fn new() -> Self {
        Self::default()
    }

    fn block(&self) {
        self.0.blocked.store(true, Ordering::SeqCst);
        self.0.honor_cancel.store(true, Ordering::SeqCst);
    }

    fn release(&self) {
        let mut released = self.0.released.lock().unwrap();
        *released = true;
        self.0.released_cv.notify_all();
    }

    /// 等到引擎真的进了某个阶段为止（`stage_started` 是在进入引擎**之前**发的，
    /// 所以要断言「引擎已经卡住」必须等这个）。
    fn wait_entered(&self) {
        let deadline = Instant::now() + TIMEOUT;
        let mut entered = self.0.entered.lock().unwrap();
        while entered.is_empty() {
            let now = Instant::now();
            assert!(now < deadline, "引擎一直没被进入");
            entered = self
                .0
                .entered_cv
                .wait_timeout(entered, deadline - now)
                .unwrap()
                .0;
        }
    }

    fn delay(&self, milliseconds: u64) {
        self.0.delay_ms.store(milliseconds, Ordering::SeqCst);
    }

    fn progress_steps(&self, steps: u32) {
        self.0.progress_steps.store(steps, Ordering::SeqCst);
    }

    fn fail_with(&self, code: &str) {
        *self.0.fail_code.lock().unwrap() = Some(code.to_string());
    }

    fn return_an_escaping_name(&self) {
        self.0.bad_name.store(true, Ordering::SeqCst);
    }

    fn written(&self) -> Vec<(String, u64)> {
        self.0.written.lock().unwrap().clone()
    }
}

impl Engine for TestEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        {
            let mut entered = self.0.entered.lock().unwrap();
            entered.push(request.stage.stage_id.clone());
            self.0.entered_cv.notify_all();
        }

        if self.0.blocked.load(Ordering::SeqCst) {
            let mut released = self.0.released.lock().unwrap();
            while !*released {
                // 每 5ms 醒一次看一眼取消牌：真引擎在长任务里也是「等一会儿检查一次」，
                // 这样「取消确实到达了引擎」是确定性的，而不是跟 `release` 抢时间。
                if self.0.honor_cancel.load(Ordering::SeqCst) && request.cancel.cancelled() {
                    return Err(StageError::cancelled());
                }
                released = self
                    .0
                    .released_cv
                    .wait_timeout(released, Duration::from_millis(5))
                    .unwrap()
                    .0;
            }
            if self.0.honor_cancel.load(Ordering::SeqCst) && request.cancel.cancelled() {
                return Err(StageError::cancelled());
            }
        }

        let delay = self.0.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            thread::sleep(Duration::from_millis(delay));
            // 真引擎的检查点就长这样：长任务必须自己在能停的地方看取消牌。
            if request.cancel.cancelled() {
                return Err(StageError::cancelled());
            }
        }

        let steps = self.0.progress_steps.load(Ordering::SeqCst);
        if steps > 0 {
            for index in 0..steps {
                (request.progress)((index + 1) * 100 / steps);
                thread::sleep(Duration::from_millis(2));
            }
        }

        if let Some(code) = self.0.fail_code.lock().unwrap().clone() {
            return Err(StageError::failed(code, "engine said no"));
        }

        let name = if self.0.bad_name.load(Ordering::SeqCst) {
            "../escape.bin".to_string()
        } else {
            format!("{}.bin", request.stage.stage_id)
        };
        let payload = format!(
            "stage={} job={} generation={}\n",
            request.stage.stage_id, request.run.job_id, request.run.generation
        )
        .into_bytes();
        // 引擎不自己拼路径：它只能往执行器给的 sink 里写，sink 负责把非法名字
        // （`../`、分隔符）挡在写之前——产物目录的安全不靠引擎自觉。
        let written = request.sink.write(&name, &payload)?;
        self.0
            .written
            .lock()
            .unwrap()
            .push((name.clone(), written.byte_length));

        Ok(StageOutput {
            relative_name: name,
            mime: "application/octet-stream".to_string(),
            byte_length: written.byte_length,
            width: 512,
            height: 768,
            content_hash: written.content_hash,
            engine: EngineReport {
                id: "echo".to_string(),
                version: "test".to_string(),
                precision: Precision::Fp32,
                device_id: "cpu".to_string(),
                // 夹具照请求里被问的政策回答；它不挑运行库，所以永远没有回退。
                policy: Some(request.stage.engine_policy),
                fallback: None,
            },
        })
    }
}

// ---------------------------------------------------------------- 会话夹具

/// 这个进程里没有真的缓存工作区（协议测试跑在测试进程里，没有 NGX）。
fn no_workspaces() -> u32 {
    0
}

/// 一个「确实交回了几份」的世界：真工作区数不出来，但**数字要走完整条路**。
fn seven_workspaces() -> u32 {
    7
}

struct Harness {
    host: Host,
    worker: JoinHandle<Result<SessionOutcome, SessionError>>,
    staging: PathBuf,
    engine: TestEngine,
    /// 这次会话的身份：每个夹具各不相同，见 `SESSION_EPOCH` 的说明。
    epoch: String,
}

impl Harness {
    fn new(label: &str, chunk: usize, engine: TestEngine) -> Self {
        Self::with_release(label, chunk, engine, no_workspaces)
    }

    /// 同一个夹具，只是把「交回了几份工作区」换成可控的。
    ///
    /// 真工作区只有真 NGX 跑过之后才数得出来，进程测试里没有那份 DLL，所以这一格只能由
    /// 测试递进来——顺带钉住「宿主拿到的是实测数字，不是一句『收到了』」。
    fn with_release(
        label: &str,
        chunk: usize,
        engine: TestEngine,
        release_workspaces: fn() -> u32,
    ) -> Self {
        let epoch = fresh_epoch(label);
        SESSION_EPOCH.with(|cell| *cell.borrow_mut() = epoch.clone());
        let duplex = Arc::new(Duplex::new(chunk));
        let staging = std::env::temp_dir().join(format!("yomika-worker-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).expect("建临时 staging 失败");
        // 输入根与 staging 平级：这个夹具不发授权输入，但 `--inputs` 的对应物必须是
        // 一个真实存在的目录（与 worker 主程序对两个根的要求一致）。
        let inputs = staging.join("inputs");
        fs::create_dir_all(&inputs).expect("建临时 inputs 失败");

        let reader = WorkerReader(duplex.clone());
        let writer = WorkerWriter(duplex.clone());
        let options = SessionOptions {
            worker_epoch: epoch.clone(),
            nonce: 4_242,
            staging_root: staging.clone(),
            input_root: inputs,
            build: BuildInfo {
                version: "worker-test".to_string(),
                runtimes: vec!["echo".to_string()],
                engines: vec!["echo".to_string()],
                model_formats: vec!["onnx".to_string()],
                // 这一栏是给「主 exe 与 worker 构建戳一致」用的，谁对得上由宿主决定；
                // 这一份测试夹具只关心协议，不假装自己是谁编的。
                commit: String::new(),
            },
            log_budget: 4096,
            release_workspaces,
        };
        let engine_for_thread = engine.clone();
        let worker = thread::spawn(move || run(reader, writer, engine_for_thread, options));

        Self {
            host: Host {
                duplex,
                consumed: 0,
            },
            worker,
            staging,
            engine,
            epoch,
        }
    }

    /// 握手：worker 先发 `hello`，宿主回 `hello_ack`。
    fn handshake(&mut self) {
        let hello = self.host.expect("hello");
        match hello {
            Message::Hello(hello) => {
                assert_eq!(hello.protocol_version, PROTOCOL_MAJOR);
                assert_eq!(hello.worker_epoch, self.epoch);
                assert_eq!(hello.build.version, "worker-test");
            }
            other => panic!("第一条消息必须是 hello，收到 {other:?}"),
        }
        self.ack("feature-a");
    }

    fn ack(&self, feature: &str) {
        self.host.send(&Message::HelloAck(HelloAck {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch(),
            features: vec![feature.to_string()],
            max_frame_bytes: MAX_FRAME_BYTES as u32,
        }));
    }

    fn accept_artifacts(&mut self, messages: &[Message], reason: Option<&str>) {
        for message in messages {
            if let Message::ArtifactReady(ready) = message {
                let reference = ArtifactRef {
                    protocol_version: PROTOCOL_MAJOR,
                    worker_epoch: epoch(),
                    job_id: ready.job_id.clone(),
                    artifact_id: ready.artifact_id.clone(),
                    reason: reason.map(str::to_string),
                };
                let reply = match reason {
                    Some(_) => Message::ArtifactRejected(reference),
                    None => Message::ArtifactAck(reference),
                };
                self.host.send(&reply);
            }
        }
    }

    fn finish(self) -> Result<SessionOutcome, SessionError> {
        let outcome = self.worker.join().expect("worker 会话线程不该 panic");
        let _ = fs::remove_dir_all(&self.staging);
        outcome
    }
}

fn run_message(job_id: &str, stages: &[&str]) -> Message {
    Message::Run(Run {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
        job_id: job_id.to_string(),
        generation: 1,
        input: RunInput {
            input_id: "input-1".to_string(),
            content_hash: "0".repeat(64),
            byte_length: 1024,
            relative_path: None,
        },
        pipeline: stages
            .iter()
            .map(|stage| PipelineStage {
                stage_id: (*stage).to_string(),
                model_spec_id: "realcugan-2x-conservative".to_string(),
                // 协议会话测试用 echo 引擎：没有模型授权（模型那一路由
                // `crates/compute-protocol/tests/messages.rs` 与真进程测试各测一遍）。
                model: None,
                dlssnr: None,
                builtin: None,
                min_input_edge: None,
                output_scale: None,
                engine_policy: EnginePolicy::Auto,
                scale: Some(2),
                tile: Some(256),
                layers: None,
                settings_id: None,
            })
            .collect(),
        output_grant_id: "grant-1".to_string(),
        priority: Priority::Foreground,
        deadline_ms: 60_000,
        budgets: Budgets {
            max_pixels: 64_000_000,
            max_output_bytes: 1_073_741_824,
            intra_threads: 2,
        },
    })
}

fn job_ref(job_id: &str) -> JobRef {
    JobRef {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
        job_id: job_id.to_string(),
        generation: 1,
    }
}

// ---------------------------------------------------------------- 测试

#[test]
fn a_handshake_then_a_two_stage_run_reaches_completed() {
    let mut harness = Harness::new("two-stage", 4096, TestEngine::new());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a", "stage-b"]));

    let accepted = harness.host.expect("accepted");
    match accepted {
        Message::Accepted(reference) => assert_eq!(reference.job_id, "job-1"),
        other => panic!("收到 {other:?}"),
    }

    let first = harness.host.collect_until("artifact_ready");
    assert_eq!(first[0].kind(), "stage_started");
    let ready = match first.last().unwrap() {
        Message::ArtifactReady(ready) => ready.clone(),
        other => panic!("收到 {other:?}"),
    };
    assert_eq!(ready.stage_id, "stage-a");
    assert_eq!(ready.job_id, "job-1");
    assert_eq!(ready.generation, 1);
    assert_eq!(ready.output_grant_id, "grant-1");
    assert_eq!(ready.width, 512);
    assert_eq!(ready.height, 768);
    assert_eq!(ready.mime, "application/octet-stream");
    assert_eq!(ready.engine.id, "echo");
    assert!(!ready.pipeline_revision.is_empty());
    assert_eq!(ready.artifact_id, "job-1:1:stage-a");

    // worker 报的 hash 必须和它真的写到磁盘上的字节一致（宿主还会自己再 stream
    // 一遍，但 worker 这一栏不能是编的）。
    let path = harness.staging.join(&ready.relative_name);
    let bytes = fs::read(&path).expect("产物必须真的落在 staging 里");
    assert_eq!(bytes.len() as u64, ready.byte_length);
    assert_eq!(blake3::hash(&bytes).to_hex().to_string(), ready.content_hash);

    harness.accept_artifacts(&first, None);

    let second = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&second, None);

    let tail = harness.host.collect_until("completed");
    match tail.last().unwrap() {
        Message::Completed(reference) => assert_eq!(reference.job_id, "job-1"),
        other => panic!("收到 {other:?}"),
    }
    assert_eq!(harness.engine.written().len(), 2);
    // 长度按引擎真正写的那段 payload 算，别在测试里编一个数（原来手写 42，
    // 实际是 37）。
    let payload = |stage: &str| format!("stage={stage} job=job-1 generation=1\n");
    assert_eq!(
        harness.engine.written(),
        vec![
            ("stage-a.bin".to_string(), payload("stage-a").len() as u64),
            ("stage-b.bin".to_string(), payload("stage-b").len() as u64)
        ]
    );
}

#[test]
fn a_frame_split_across_several_reads_is_reassembled() {
    // chunk = 1：worker 每次 `read` 只拿到一个字节，任何一帧都必须跨很多次读才凑齐。
    let mut harness = Harness::new("split-frame", 1, TestEngine::new());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    let ready = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&ready, None);
    harness.host.collect_until("completed");
}

#[test]
fn a_second_run_while_one_is_running_is_reported_busy() {
    let engine = TestEngine::new();
    engine.block();
    let mut harness = Harness::new("busy", 4096, engine.clone());
    harness.handshake();

    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");
    engine.wait_entered();

    // 第二个任务不许排队——没有 `busy` 消息变体，所以用终态 `failed` 明说，
    // 宿主据此把队列里那一份的 grant 放掉（docs/71 §6.3）。
    harness.host.send(&run_message("job-2", &["stage-b"]));
    match harness.host.expect("failed") {
        Message::Failed(failed) => {
            assert_eq!(failed.job_id, "job-2");
            assert_eq!(failed.code, "COMPUTE_WORKER_BUSY");
            assert_eq!(failed.generation, 1);
        }
        other => panic!("收到 {other:?}"),
    }

    // 第一个任务不受影响，照常走完。
    engine.release();
    let ready = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&ready, None);
    harness.host.collect_until("completed");
}

#[test]
fn a_ping_is_answered_while_the_engine_is_busy() {
    let engine = TestEngine::new();
    engine.delay(3000);
    let mut harness = Harness::new("ping-while-busy", 4096, engine);
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");

    // 计算线程正在睡 3 秒（§11 Task 3 第 ⑤ 条的原话），控制面必须立刻回 pong。
    let sent_at = Instant::now();
    harness.host.send(&Message::Ping(yomika_compute_protocol::messages::Ping {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
        nonce: 99,
    }));
    match harness.host.expect("pong") {
        Message::Pong(pong) => assert_eq!(pong.nonce, 99),
        other => panic!("收到 {other:?}"),
    }
    let answered = sent_at.elapsed();
    assert!(
        answered < Duration::from_millis(500),
        "计算在睡觉时 pong 也必须及时，实际 {answered:?}"
    );

    let ready = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&ready, None);
    harness.host.collect_until("completed");
}

#[test]
fn a_cancelled_job_is_reported_as_cancelled_not_failed() {
    let engine = TestEngine::new();
    engine.block();
    let mut harness = Harness::new("cancel-running", 4096, engine.clone());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");
    engine.wait_entered();

    harness.host.send(&Message::Cancel(job_ref("job-1")));

    // 这里**不能**再 `engine.release()`：那样 release 可能先于取消被处理，引擎就会
    // 正常产出产物，测到的是「报完产物再取消」那条路（下面那条测试专门测它）。
    // 引擎在卡住时会每 5ms 看一次取消牌，所以取消到达引擎是确定性的。
    let tail = harness.host.collect_until("cancelled");
    assert!(
        !tail.iter().any(|message| message.kind() == "artifact_ready"),
        "取消之后不许再报产物：{tail:?}"
    );
    match tail.last().unwrap() {
        Message::Cancelled(reference) => assert_eq!(reference.job_id, "job-1"),
        other => panic!("收到 {other:?}"),
    }
    assert!(engine.written().is_empty(), "取消的阶段不该留下产物");
}

#[test]
fn disconnect_while_waiting_for_artifact_ack_releases_executor() {
    let engine = TestEngine::new();
    let mut harness = Harness::new("disconnect-awaiting-ack", 4096, engine.clone());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.collect_until("artifact_ready");
    harness.host.duplex.close();
    assert!(matches!(harness.finish(), Ok(SessionOutcome::PeerClosed)));
    let deadline = Instant::now() + TIMEOUT;
    // The detached executor owns an engine reference until its artifact waiter exits.
    while Arc::strong_count(&engine.0) != 1 {
        assert!(Instant::now() < deadline, "executor retained engine after peer disconnected awaiting ACK");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_cancel_while_waiting_for_the_artifact_ack_ends_the_job() {
    // 产物已经报了、宿主还没裁决时来的取消，走的是等待槽那条路，与上面的引擎
    // 检查点是两条独立路径。
    let mut harness = Harness::new("cancel-while-waiting", 4096, TestEngine::new());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");
    harness.host.expect("artifact_ready");

    harness.host.send(&Message::Cancel(job_ref("job-1")));
    let tail = harness.host.collect_until("cancelled");
    assert_eq!(tail.len(), 1, "等 ACK 期间取消只应来一条终态：{tail:?}");
}

#[test]
fn a_rejected_artifact_fails_the_job() {
    let mut harness = Harness::new("rejected-artifact", 4096, TestEngine::new());
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    let ready = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&ready, Some("宿主核对 hash 不一致"));

    match harness.host.expect("failed") {
        Message::Failed(failed) => {
            assert_eq!(failed.job_id, "job-1");
            assert_eq!(failed.code, "COMPUTE_ARTIFACT_REJECTED");
            assert!(
                failed.message.contains("宿主核对 hash 不一致"),
                "拒绝理由要转述给宿主：{}",
                failed.message
            );
        }
        other => panic!("收到 {other:?}"),
    }
}

#[test]
fn an_engine_failure_becomes_a_failed_frame() {
    let engine = TestEngine::new();
    engine.fail_with("GPU_OUTPUT_INVALID");
    let mut harness = Harness::new("engine-failure", 4096, engine);
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");

    match harness.host.expect("failed") {
        Message::Failed(failed) => {
            assert_eq!(failed.code, "GPU_OUTPUT_INVALID");
            assert_eq!(failed.message, "engine said no");
        }
        other => panic!("收到 {other:?}"),
    }
}

#[test]
fn an_engine_that_invents_a_path_fails_the_job() {
    // 引擎给的 relativeName 会原样进 `artifact_ready`，所以路径形状必须在 worker
    // 这一侧就拦下来：不能指望宿主替我们挡目录穿越（§7.3）。
    let escaped = std::env::temp_dir().join("escape.bin");
    let _ = fs::remove_file(&escaped);
    let engine = TestEngine::new();
    engine.return_an_escaping_name();
    let mut harness = Harness::new("escaping-name", 4096, engine);
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");

    match harness.host.expect("failed") {
        Message::Failed(failed) => assert_eq!(failed.code, "COMPUTE_ARTIFACT_INVALID"),
        other => panic!("收到 {other:?}"),
    }
    assert!(!escaped.exists(), "穿越出去的路径一个字节都不该写");
    assert!(harness.engine.written().is_empty());
}

#[test]
fn a_peer_that_speaks_another_major_version_is_refused() {
    let mut harness = Harness::new("version-mismatch", 4096, TestEngine::new());
    harness.host.expect("hello");
    harness.host.send(&Message::HelloAck(HelloAck {
        protocol_version: PROTOCOL_MAJOR + 1,
        worker_epoch: epoch(),
        features: Vec::new(),
        max_frame_bytes: MAX_FRAME_BYTES as u32,
    }));

    match harness.finish() {
        Ok(SessionOutcome::VersionMismatch) => {}
        other => panic!("major 不符必须拒绝会话，得到 {other:?}"),
    }
}

#[test]
fn a_peer_that_names_another_worker_epoch_is_refused() {
    let mut harness = Harness::new("epoch-mismatch", 4096, TestEngine::new());
    harness.host.expect("hello");
    harness.host.send(&Message::HelloAck(HelloAck {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: "epoch-other".to_string(),
        features: Vec::new(),
        max_frame_bytes: MAX_FRAME_BYTES as u32,
    }));

    match harness.finish() {
        Ok(SessionOutcome::EpochMismatch) => {}
        other => panic!("epoch 不是我们的就不该开工，得到 {other:?}"),
    }
}

#[test]
fn a_closed_pipe_ends_the_session() {
    let mut harness = Harness::new("peer-closed", 4096, TestEngine::new());
    harness.host.expect("hello");
    harness.host.duplex.close();

    match harness.finish() {
        Ok(SessionOutcome::PeerClosed) => {}
        other => panic!("父进程关掉管道就该退出，得到 {other:?}"),
    }
}

#[test]
fn a_shutdown_frame_ends_the_session() {
    let mut harness = Harness::new("shutdown", 4096, TestEngine::new());
    harness.handshake();
    harness.host.send(&Message::Shutdown(EpochOnly {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
    }));

    match harness.finish() {
        Ok(SessionOutcome::Shutdown) => {}
        other => panic!("shutdown 必须让会话收摊，得到 {other:?}"),
    }
}

#[test]
fn a_release_idle_after_a_job_answers_with_released() {
    // §6.3 的 `release_idle`：宿主在闲置时把额度收回去。worker 自己不持有 grant，
    // 回执的载体是它跑过的最后一个任务，所以宿主必须能从中对上号。
    let engine = TestEngine::new();
    let mut harness = Harness::new("release-idle", 4096, engine);
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    let ready = harness.host.collect_until("artifact_ready");
    harness.accept_artifacts(&ready, None);
    harness.host.collect_until("completed");

    harness.host.send(&Message::ReleaseIdle(EpochOnly {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
    }));
    match harness.host.expect("released") {
        Message::Released(reference) => {
            assert_eq!(reference.job_id, "job-1");
            assert_eq!(reference.generation, 1);
            assert_eq!(reference.worker_epoch, epoch());
        }
        other => panic!("收到 {other:?}"),
    }
    // 紧接着是**交回了几份**。0 也要报：宿主分不清「交回 0 份」与「没回话」的话，
    // 界面上的 0 就既可能是真话也可能是超时。
    match harness.host.expect("workspaces_released") {
        Message::WorkspacesReleased(released) => {
            assert_eq!(released.count, 0, "这个夹具没有真工作区");
            assert_eq!(released.worker_epoch, epoch());
        }
        other => panic!("收到 {other:?}"),
    }

    // 收到 shutdown 后必须干净收场：`released` 不能被当成终态。
    harness.host.send(&Message::Shutdown(EpochOnly {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
    }));
    match harness.finish() {
        Ok(SessionOutcome::Shutdown) => {}
        other => panic!("得到 {other:?}"),
    }
}

#[test]
fn a_release_idle_says_how_many_workspaces_went_back() {
    // 一个任务都没跑过：协议里没有「无名 released」，所以没有那条回执——但**交回的数字**
    // 照样要报。宿主把 idle 当成一次真的资源动作，不是一句「收到了」。
    let mut harness =
        Harness::with_release("release-count", 4096, TestEngine::new(), seven_workspaces);
    harness.handshake();
    harness.host.send(&Message::ReleaseIdle(EpochOnly {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
    }));
    match harness.host.expect("workspaces_released") {
        Message::WorkspacesReleased(released) => {
            assert_eq!(released.count, 7, "交回了几份是实测数字");
            assert_eq!(released.protocol_version, PROTOCOL_MAJOR);
            assert_eq!(released.worker_epoch, epoch());
        }
        other => panic!("收到 {other:?}"),
    }

    harness.host.send(&Message::Shutdown(EpochOnly {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch(),
    }));
    match harness.finish() {
        Ok(SessionOutcome::Shutdown) => {}
        other => panic!("得到 {other:?}"),
    }
}

#[test]
fn pings_and_progress_share_one_stream_without_corrupting_frames() {
    // 执行器线程与会话主线程共用一条字节流，任何一次「半帧写入」都会让后面的帧
    // 解析不出来（`Host::next` 会 panic）。这里让两边真的并发写。
    let engine = TestEngine::new();
    engine.progress_steps(50);
    let mut harness = Harness::new("interleaved", 4096, engine);
    harness.handshake();
    harness.host.send(&run_message("job-1", &["stage-a"]));
    harness.host.expect("accepted");
    harness.host.expect("stage_started");

    let duplex = harness.host.duplex.clone();
    // 身份是**线程局部**的（见 `SESSION_EPOCH`）：ping 线程读不到它，得在这里先取出来
    // 搬进去。忘了搬的话每条 ping 都带着空 epoch，worker 会当成别人的会话拒掉。
    let session_epoch = epoch();
    let pinger = thread::spawn(move || {
        for nonce in 0..40u64 {
            duplex.push_message(&Message::Ping(yomika_compute_protocol::messages::Ping {
                protocol_version: PROTOCOL_MAJOR,
                worker_epoch: session_epoch.clone(),
                nonce,
            }));
            thread::sleep(Duration::from_millis(2));
        }
    });

    let mut pongs = 0usize;
    let mut progress = 0usize;
    let mut completed = false;
    let mut pinger = Some(pinger);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "并发写把会话卡住了");
        // 终态之后还要把剩下的 pong 读完：会话在宿主关管道之前一直是活的，最后一个
        // ping 也可能在 completed 之后才被处理。
        if completed && pongs == 40 {
            break;
        }
        let message = match harness.host.next(TIMEOUT) {
            Some(message) => message,
            None => panic!("等帧超时，pongs={pongs} progress={progress} completed={completed}"),
        };
        match message.kind() {
            "pong" => pongs += 1,
            "progress" => progress += 1,
            "artifact_ready" => {
                let single = [message];
                harness.accept_artifacts(&single, None);
            }
            "completed" => {
                completed = true;
                if let Some(pinger) = pinger.take() {
                    pinger.join().unwrap();
                }
            }
            other => panic!("并发流里出现意外消息 {other}"),
        }
    }
    assert_eq!(pongs, 40, "每个 ping 都该有 pong");
    assert!(progress >= 5, "进度帧也该挤进来，实际 {progress} 条");
}
