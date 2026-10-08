//! 宿主 supervisor 的真进程闭环（docs/71 §11 Task 4、§8）。
//!
//! 这些测试**不 mock worker**：它们 spawn 真的 `yomika-compute-worker.exe`，走真的命名管道，
//! 用真的事件回调看状态。因为「worker 崩了界面会不会挂」「取消要等多久才收族」这类问题，
//! 只有真进程能回答。
//!
//! worker 的测试钩子（`YOMIKA_WORKER_TEST_*`）通过 [`SupervisorConfig::extra_env`] 传进去；
//! 生产路径上它是空的。

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use yomika_lib::compute::manager::{
    no_events, ComputeManager, PressureGauge, PressureSource, SourceFile, SubmitRequest,
    SupervisorConfig, WorkerStatus, HOST_BUILD_COMMIT,
};
use yomika_lib::compute::resource_policy::PressureReading;
use yomika_lib::compute::scheduler::{
    CancelOutcome, JobKey, JobState, Priority, SubmitError, Submitted,
};
use yomika_compute_protocol::{EnginePolicy, PipelineStage, RunInput};

const HANDOFF: Duration = Duration::from_secs(20);

/// worker 可执行文件。测试自己的路径是 `target/<profile>/deps/xxx.exe`，
/// 所以 `target/<profile>` 是可以反推出来的——和 `CARGO_TARGET_DIR` 无关。
///
/// **每次都先编一遍**（已经编过就是零点几秒）。只判断「文件在不在」不行：那样会拿上一轮的
/// 旧 worker 去跑，测试钩子改了也不生效，看起来就像功能没实现。
fn worker_exe() -> PathBuf {
    let exe = std::env::current_exe().expect("测试自己的路径");
    let profile_dir = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>")
        .to_path_buf();
    build_worker(&profile_dir);
    let worker = profile_dir.join("yomika-compute-worker.exe");
    assert!(
        worker.exists(),
        "编完之后还是找不到 worker：{}",
        worker.display()
    );
    worker
}

/// 集成测试不会自动编译同 workspace 里另一个包的 bin，所以这里自己编一次。
/// **不静默跳过**：编不过就直接失败。
fn build_worker(profile_dir: &Path) {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let mut command = ProcessCommand::new(env!("CARGO"));
    command
        .arg("build")
        .arg("--manifest-path")
        .arg(&manifest)
        .arg("-p")
        .arg("yomika-compute-worker");
    if profile_dir.file_name().is_some_and(|name| name == "release") {
        command.arg("--release");
    }
    let output = command.output().expect("跑 cargo build 起 worker");
    assert!(
        output.status.success(),
        "编 worker 失败：\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Sandbox {
    root: PathBuf,
    staging: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "yomika-manager-it-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn config(sandbox: &Sandbox) -> SupervisorConfig {
    let mut config = SupervisorConfig::new(worker_exe(), &sandbox.staging);
    config.handshake_timeout = Duration::from_secs(10);
    // 测试里不让闲置回收插手：那会让「下一件任务还能不能跑」变得说不清。
    config.idle_shutdown = Duration::from_secs(600);
    // 正式落点是沙箱根，于是「发布到哪儿了」和「staging 在哪儿」都看得见。
    config.publish_root = Some(sandbox.root.clone());
    config
}

fn key(input_id: &str, page: u32) -> JobKey {
    JobKey {
        input_id: input_id.to_string(),
        settings_id: format!("settings-{page}"),
        source_revision: "rev-1".to_string(),
        backend: "cpu".to_string(),
        generation: 1,
    }
}

fn request(input_id: &str, page: u32, deadline_ms: u64) -> SubmitRequest {
    yomika_lib::compute::manager::SubmitRequest {
        key: key(input_id, page),
        priority: Priority::Foreground,
        input: RunInput {
            input_id: format!("{input_id}#{page}"),
            content_hash: "0".repeat(64),
            byte_length: 1024,
            relative_path: None,
        },
        pipeline: vec![PipelineStage {
            stage_id: "stage-a".to_string(),
            model_spec_id: "echo".to_string(),
            // 这条 IT 走的是宿主默认的 echo 引擎（宿主此刻不传 `--engine`）：没有模型，
            // 也没有模型要求的最小边长。
            model: None,
            decensor: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: None,
            engine_policy: EnginePolicy::Cpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-1".to_string(),
        deadline_ms,
        // 这条 IT 走回声引擎，它不读图：源图留空（真超分引擎那条路见
        // `tests/compute_model_chain.rs`，那里宿主必须给出源文件）。
        source: None,
        inpaint: None,
    }
}

fn wait_until<T>(what: &str, budget: Duration, mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "等了 {} 秒还没等到：{what}",
            budget.as_secs()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 事件回调只做记录：它由控制线程调用，所以拿不到「被阻塞的界面」这种结论——
/// 这正是要证明的（派发不经过 UI 线程）。
#[derive(Clone, Default)]
struct Recorder {
    seen: Arc<Mutex<Vec<(String, JobState)>>>,
}

impl Recorder {
    fn sink(&self) -> yomika_lib::compute::manager::EventSink {
        let seen = Arc::clone(&self.seen);
        Arc::new(move |snapshot: &yomika_lib::compute::scheduler::JobSnapshot| {
            seen.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((snapshot.job_id.clone(), snapshot.state.clone()));
        })
    }

    fn states(&self) -> Vec<(String, JobState)> {
        self.seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

fn terminal_of(manager: &ComputeManager, job_id: &str) -> Option<JobState> {
    manager
        .job(job_id)
        .map(|snapshot| snapshot.state)
        .filter(|state| state.is_terminal())
}

fn submit_foreground(manager: &ComputeManager, name: &str, page: u32) -> Submitted {
    manager
        .submit(request(name, page, 0))
        .expect("应该收下这件任务")
}

fn submit_background(manager: &ComputeManager, name: &str, page: u32) -> Submitted {
    let mut queued = request(name, page, 0);
    queued.priority = Priority::Background;
    manager.submit(queued).expect("应该收下这件后台任务")
}

/// 机器吃紧的时候（§8.1 软/硬阈值、§8.4 显存预留）：排队中的后台预扫先丢掉，新任务按档位
/// 挡回去，**在跑的那件不因为清队列而被杀**；压力过去，同一页还得能算。
///
/// 读数用仪表盘喂（[`PressureSource::Injected`]）：真去压机器的话，这条断言在别人的电脑上
/// 就是随机红——压力是读数，读数就该能被喂进来。
#[test]
fn a_machine_under_pressure_sheds_the_background_and_still_takes_the_page_you_opened() {
    let sandbox = Sandbox::new("pressure");
    let mut config = config(&sandbox);
    let ram = config.physical_ram_bytes;
    let soft = yomika_lib::compute::resource_policy::soft_commit_limit(ram);
    let hard = yomika_lib::compute::resource_policy::hard_commit_limit(ram);
    let roomy = |commit: u64| PressureReading {
        private_commit_bytes: Some(commit),
        gpu_free_bytes: Some(16 * 1024 * 1024 * 1024),
        gpu_total_bytes: Some(32 * 1024 * 1024 * 1024),
    };
    let gauge = PressureGauge::new(PressureReading::unknown());
    config.pressure_source = PressureSource::Injected(gauge.clone());
    // 让在跑的那件慢下来，好让「谁在跑、谁在排队」看得见。
    config.extra_env = vec![("YOMIKA_WORKER_TEST_DELAY_MS".to_string(), "5000".to_string())];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let running = submit_background(&manager, "sweep", 0);
    let queued: Vec<Submitted> = (1..=3)
        .map(|page| submit_background(&manager, "sweep", page))
        .collect();
    wait_until("后台那件被派出去", HANDOFF, || {
        manager
            .job(&running.job_id)
            .filter(|snapshot| snapshot.state.holds_running())
            .map(|snapshot| snapshot.state.clone())
    });
    assert_eq!(
        manager.job(&queued[0].job_id).map(|snapshot| snapshot.state),
        Some(JobState::Queued),
        "后面几件该在队里等着"
    );

    // 压力上来了：过了软阈值，后台预扫该让路。
    gauge.set(roomy(soft + 1));
    wait_until("排队中的后台预扫被丢掉", HANDOFF, || {
        queued
            .iter()
            .all(|submitted| {
                terminal_of(&manager, &submitted.job_id) == Some(JobState::Cancelled)
            })
            .then_some(())
    });
    let state = manager
        .job(&running.job_id)
        .map(|snapshot| snapshot.state)
        .expect("在跑的那件还在");
    assert!(
        state.holds_running(),
        "清队列不该顺手把正在算的那件也杀掉：{state:?}"
    );
    // 新任务按档位挡：后台不再收，前台照收。
    let mut background = request("sweep", 9, 0);
    background.priority = Priority::Background;
    assert_eq!(
        manager.submit(background).err(),
        Some(SubmitError::Pressure),
        "压力没过去之前，新起的后台预扫该被挡回去"
    );
    let foreground = submit_foreground(&manager, "book", 0);

    // 硬压力：连在跑的后台那件也收（前台那件是用户等着的，不动）。
    gauge.set(roomy(hard + 1));
    let terminal = wait_until("在跑的后台那件被收掉", HANDOFF, || {
        terminal_of(&manager, &running.job_id)
    });
    assert_eq!(terminal, JobState::Cancelled, "后台让路的结果是取消");
    assert_eq!(
        manager.cancel_reason(&running.job_id).is_some(),
        true,
        "取消要给得出理由（界面要说清为什么这一页没算）"
    );
    assert_eq!(
        manager.submit(request("book", 1, 0)).err(),
        Some(SubmitError::Pressure),
        "硬压力下连前台也不收——收下也是失败，不如让界面报能重试的错"
    );
    assert!(
        manager
            .job(&foreground.job_id)
            .is_some_and(|snapshot| !snapshot.state.is_terminal() || snapshot.state == JobState::Completed),
        "已经收下的前台任务不该被硬压力反悔"
    );

    // 压力过去：同一页重新提交要能算完（拒收不是「这一页永远不算」）。
    gauge.set(PressureReading::unknown());
    let after = submit_foreground(&manager, "book", 1);
    let state = wait_until("压力过去之后任务跑完", HANDOFF, || {
        terminal_of(&manager, &after.job_id)
    });
    assert_eq!(state, JobState::Completed, "压力过去就得能算完");
}

#[test]
fn a_job_runs_end_to_end_through_a_real_worker_process() {
    let sandbox = Sandbox::new("e2e");
    let recorder = Recorder::default();
    let manager = ComputeManager::start(config(&sandbox), recorder.sink()).expect("起 supervisor");

    let started = Instant::now();
    let submitted = submit_foreground(&manager, "book", 0);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "submit 不该等计算：等了 {:?}",
        started.elapsed()
    );
    assert_eq!(submitted.snapshot.state, JobState::Queued);

    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "echo 引擎应该跑完");

    // 产物是宿主**自己**核过长度和哈希的（不是 worker 说了算）。
    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert!(artifact.byte_length > 0);
    // 核过之后要落进内容寻址存储，而不是留在 worker 能随手改写的 staging 里
    let relative = artifact
        .cache_relative
        .clone()
        .expect("配了发布根就该发布");
    assert!(
        relative.starts_with("cache/images/"),
        "发布路径该是内容寻址的：{relative}"
    );
    assert!(
        !artifact.path.starts_with(&sandbox.staging),
        "发布之后不该还待在 staging 里：{}",
        artifact.path.display()
    );
    assert!(
        artifact.path.exists(),
        "产物应该落在正式缓存里：{}",
        artifact.path.display()
    );
    let on_disk = std::fs::read(&artifact.path).expect("读产物");
    assert_eq!(on_disk.len() as u64, artifact.byte_length);
    assert_eq!(
        blake3::hash(&on_disk).to_hex().to_string(),
        artifact.content_hash
    );
    // staging 里的原件还在（宿主只读它，不改它）；正式缓存里那份是独立的一整份
    assert!(
        sandbox.staging.join(&artifact.staging_name).exists(),
        "staging 原件不该被搬走：{}",
        artifact.staging_name
    );

    // worker 真的起来了，而且 Job Object 套上了（能限住内存才敢说「限制了」）。
    match manager.worker_status() {
        WorkerStatus::Ready {
            peer_pid,
            limits_applied,
            ..
        } => {
            assert_ne!(peer_pid, 0);
            assert!(
                limits_applied,
                "在这台机器上 Job Object 应该能套上（套不上也要如实报）"
            );
        }
        other => panic!("任务都跑完了，worker 应该是 Ready：{other:?}"),
    }

    // 事件流里必须出现过 accepted/running 之类的中途状态，而不是只有一个终态。
    let states = recorder.states();
    assert!(
        states
            .iter()
            .any(|(job_id, _)| job_id == &submitted.job_id),
        "事件回调应该收到这件任务"
    );

    manager.shutdown();
}

#[test]
fn the_engines_the_worker_reports_at_handshake_are_kept_until_the_session_ends() {
    // 宿主**问不出**「我这份二进制里有没有 DLSSNR」：垫片在 worker 那一侧。所以 worker
    // 握手时报的构建事实（`BuildInfo.engines`）必须留下来，`crate::dlssnr::engine_facts`
    // 才有第二手消息可读；换一代就作废——留着上一代的答案等于按一个已经不存在的进程
    // 给设置页和算力中心作答。
    let sandbox = Sandbox::new("build-facts");
    let manager =
        ComputeManager::start(config(&sandbox), Recorder::default().sink()).expect("起 supervisor");
    // 还没排过队 ⇒ worker 还没起来（§8.1）⇒ 还没有任何一手消息。
    assert!(
        manager.worker_build().is_none(),
        "没握过手就不该有构建事实"
    );

    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed);

    let build = manager.worker_build().expect("握过手就该留下构建事实");
    // 这条 IT 走宿主默认的 echo 引擎，它自己报的就是 `["echo"]`：也就是「这一代 worker
    // 说自己没有 DLSSNR」。引擎那一侧的话要压过宿主这边的装配事实。
    assert_eq!(build.engines, vec!["echo".to_string()]);
    assert!(!build.version.is_empty(), "构建事实里的版本号不该是空的");

    // 这一代死掉之后，上一代的答案必须跟着作废。
    let peer_pid = match manager.worker_status() {
        WorkerStatus::Ready { peer_pid, .. } => peer_pid,
        other => panic!("任务都跑完了，worker 应该是 Ready：{other:?}"),
    };
    kill_process(peer_pid);
    wait_until("这一代被收走", HANDOFF, || match manager.worker_status() {
        WorkerStatus::Ready { .. } => None,
        _ => Some(()),
    });
    assert!(
        manager.worker_build().is_none(),
        "上一代走了，它的构建事实也该没了"
    );

    manager.shutdown();
}

#[test]
fn a_leftover_staging_file_is_swept_when_the_next_worker_hands_over() {
    // 上一代 worker 死在半路留下的产物：名字与内容都合法，就是没人认领（任务早没了，
    // 行也没挂）。它可以一直占着盘，因为配额是按 DB 行算的——只有交接那一刻能安全地收。
    let sandbox = Sandbox::new("staging-sweep");
    let leftover = sandbox.staging.join("abandoned.bin");
    std::fs::write(&leftover, b"half-published").expect("写残留物");

    let recorder = Recorder::default();
    let manager = ComputeManager::start(config(&sandbox), recorder.sink()).expect("起 supervisor");

    // worker 是**按需**起的：没有任务它不会出现，也就没有交接可谈。先派一件任务，
    // 交接就发生在它被领走之前——清扫必须在那一刻把它收掉。
    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed);
    assert!(
        !leftover.exists(),
        "交接成功那一刻就该把上一代的残留收掉：{}",
        leftover.display()
    );

    // 清扫不该把交接本身弄坏：产物照样落进正式缓存。
    let artifacts = manager.job_artifacts(&submitted.job_id);
    let artifact = artifacts.first().expect("有一件产物");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert!(
        artifact
            .cache_relative
            .as_deref()
            .is_some_and(|relative| relative.starts_with("cache/images/")),
        "发布路径该是内容寻址的：{:?}",
        artifact.cache_relative
    );
    manager.shutdown();
}

/// §11 Task 7-a：宿主把一张真图摆进输入根，worker 在开始算之前自己复核一遍。
///
/// 这条是「安全交接」在真进程上的闭环：宿主侧的名字/内容由 `compute::inputs::stage`
/// 决定，worker 侧用另一份实现（`yomika_compute_core::inputs`）复核。两边对不上的
/// 情况（hash 被改坏）必须在**开始算之前**失败。
#[test]
fn a_granted_input_is_staged_by_the_host_and_verified_by_the_worker() {
    let sandbox = Sandbox::new("input-handoff");
    // 一份源文件（就像缓存里的一个 blob）。宿主按内容把它放进输入根。
    let source = sandbox.root.join("source-page.bin");
    let bytes = b"host-staged-page-bytes";
    std::fs::write(&source, bytes).expect("写源文件");
    let hash = blake3::hash(bytes).to_hex().to_string();

    let inputs = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    let relative =
        yomika_lib::compute::inputs::stage(&inputs, &source, &hash).expect("宿主暂存输入");
    assert!(
        inputs.join(&relative).is_file(),
        "暂存之后 worker 该能在这个位置找到它：{}",
        inputs.join(&relative).display()
    );

    let recorder = Recorder::default();
    let manager = ComputeManager::start(config(&sandbox), recorder.sink()).expect("起 supervisor");

    let mut granted = request("book", 0, 0);
    granted.input.content_hash = hash.clone();
    granted.input.byte_length = bytes.len() as u64;
    granted.input.relative_path = Some(relative.clone());
    let submitted = manager.submit(granted).expect("应该收下这件任务");
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "输入对得上就该跑完");

    // 产物里留着「这一阶段被交到手上的输入是谁」——这是宿主能看到的、输入真的走到了
    // 引擎手边的证据（不是只在执行器里核过就完事）。
    let artifacts = manager.job_artifacts(&submitted.job_id);
    let artifact = artifacts.first().expect("有一件产物");
    let produced = std::fs::read(&artifact.path).expect("读产物");
    assert!(
        String::from_utf8_lossy(&produced).contains(&format!("granted={relative}")),
        "产物里该记着这次输入：{}",
        String::from_utf8_lossy(&produced)
    );

    // 声明 hash 改坏：宿主照收不误（它不替 worker 猜），worker 必须在开始算之前拒掉。
    let mut tampered = request("book", 1, 0);
    tampered.input.content_hash = "f".repeat(64);
    tampered.input.byte_length = bytes.len() as u64;
    tampered.input.relative_path = Some(relative.clone());
    let tampered_job = manager.submit(tampered).expect("应该收下这件任务");
    let state = wait_until("坏输入收尾", HANDOFF, || {
        terminal_of(&manager, &tampered_job.job_id)
    });
    match state {
        JobState::Failed { code } => assert_eq!(code, "COMPUTE_INPUT_INVALID", "声明对不上"),
        other => panic!("声明与内容不符必须失败，实际 {other:?}"),
    }

    manager.shutdown();
}

#[test]
fn a_cancel_that_the_worker_ignores_ends_with_the_process_being_collected() {
    let sandbox = Sandbox::new("cancel-grace");
    let mut config = config(&sandbox);
    // 每次「算」10 秒，而且故意不看取消牌 —— 只能靠 2 秒宽限到点收族。
    config.extra_env = vec![
        ("YOMIKA_WORKER_TEST_DELAY_MS".to_string(), "10000".to_string()),
        (
            "YOMIKA_WORKER_TEST_IGNORE_CANCEL".to_string(),
            "1".to_string(),
        ),
    ];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    // 等到 worker 真的接手（进入非排队状态）再取消，否则测的是排队取消。
    wait_until("worker 接手", HANDOFF, || {
        manager
            .job(&submitted.job_id)
            .filter(|snapshot| snapshot.state != JobState::Queued)
            .map(|_| ())
    });

    let started = Instant::now();
    let outcome = manager.cancel(&submitted.job_id, submitted.subscription_id);
    assert!(
        matches!(outcome, CancelOutcome::CancelRequested { .. }),
        "在跑的任务应该进入「已请求取消」：{outcome:?}"
    );

    let state = wait_until("取消落地", Duration::from_secs(8), || {
        terminal_of(&manager, &submitted.job_id)
    });
    let elapsed = started.elapsed();
    assert_eq!(
        state,
        JobState::Cancelled,
        "是我们让它停的，结论应该是「被取消」而不是「worker 丢了」"
    );
    assert!(
        elapsed >= Duration::from_millis(1_500),
        "不该比宽限还快就收族（{:?}）——那说明走的是别的路径",
        elapsed
    );
    assert!(
        elapsed < Duration::from_secs(6),
        "2 秒宽限 + 收族不该拖这么久：{:?}",
        elapsed
    );
    assert_eq!(
        manager.cancel_reason(&submitted.job_id).as_deref(),
        Some("用户取消")
    );

    // 槽位真的腾出来了：下一件还能跑（worker 换了一代重来）。
    let next = submit_foreground(&manager, "book", 1);
    let state = wait_until("下一件跑完", HANDOFF, || {
        terminal_of(&manager, &next.job_id)
    });
    assert_eq!(state, JobState::Completed);

    manager.shutdown();
}

#[test]
fn a_worker_that_dies_mid_job_marks_it_worker_lost_and_the_next_one_still_runs() {
    let sandbox = Sandbox::new("crash");
    let mut config = config(&sandbox);
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_DELAY_MS".to_string(),
        "10000".to_string(),
    )];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    let pid = wait_until("worker 接手", HANDOFF, || match manager.worker_status() {
        WorkerStatus::Ready { peer_pid, .. } => Some(peer_pid),
        _ => None,
    });
    // 确认它已经在算（不是还排在队列里）。
    wait_until("进入非排队状态", HANDOFF, || {
        manager
            .job(&submitted.job_id)
            .filter(|snapshot| snapshot.state != JobState::Queued)
            .map(|_| ())
    });

    kill_process(pid);

    let state = wait_until("worker 丢失被记下来", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_LOST".to_string()
        },
        "进程没了，这件任务的结论必须是 worker_lost"
    );

    // 退避 1 秒之后自己起来，下一件照跑。
    let next = submit_foreground(&manager, "book", 1);
    let state = wait_until("重启后跑完下一件", Duration::from_secs(30), || {
        terminal_of(&manager, &next.job_id)
    });
    assert_eq!(state, JobState::Completed, "重启之后要能接着干");

    manager.shutdown();
}

#[test]
fn a_worker_that_never_connects_does_not_block_the_caller_and_eventually_breaks_the_breaker() {
    let sandbox = Sandbox::new("no-handshake");
    let mut config = config(&sandbox);
    // 连管道之前先卡 20 秒：握手一定超时。
    config.handshake_timeout = Duration::from_millis(400);
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_HANG_MS".to_string(),
        "20000".to_string(),
    )];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let started = Instant::now();
    let submitted = submit_foreground(&manager, "book", 0);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "worker 起不来也不许挂住调用方：等了 {:?}",
        started.elapsed()
    );
    assert_eq!(
        submitted.snapshot.state,
        JobState::Queued,
        "还没派发就只是排队"
    );

    // 1s/3s/10s 三次退避用完 → 熔断，排队中的任务诚实失败，而不是永远转圈。
    let state = wait_until("熔断把排队任务结算掉", Duration::from_secs(40), || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string()
        }
    );
    match manager.worker_status() {
        WorkerStatus::Broken { reason } => {
            assert!(reason.contains("重启"), "熔断原因要说清是重启到顶：{reason}");
        }
        other => panic!("重启到顶之后应该是 Broken：{other:?}"),
    }

    // 用户手动重试是唯一的路（§8.3）。
    manager.retry_worker();
    let again = submit_foreground(&manager, "book", 0);
    wait_until("手动重试之后又能排队", Duration::from_secs(5), || {
        manager.job(&again.job_id).map(|_| ())
    });

    manager.shutdown();
}

/// 手里的 worker 不是给这个宿主编的时：**拒跑一次，不进退避账**（Task 10 第 2 条）。
///
/// 配套的那一对：主程序编进去的那一串戳，worker 报回来必须是同一串。
///
/// 与下面那条各钉一半。只钉「对不上就拒跑」是不够的——worker 根本不报戳（空串）时
/// `build_stamp_verdict` 照样给 `Mismatch`，「拒跑」那条用例照样绿：它证明不了这一串
/// 真的在文件里。所以这里量正面：配套的一代要能干活，且报回来的就是主程序那一串。
#[test]
fn a_worker_from_the_same_build_reports_the_stamp_this_host_was_built_with() {
    let sandbox = Sandbox::new("same-build");
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("配套的一代把这一件算完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "两边同戳就该正常干活，判戳不是拦路虎");

    let build = manager.worker_build().expect("握过手就该有一份构建事实");
    assert_eq!(
        build.commit, HOST_BUILD_COMMIT,
        "worker 报的戳要与主程序编进去的那一串一致（不一致就会被判成「不是同一次构建」）"
    );

    manager.shutdown();
}

/// 这一幕在真机上要重编一份 worker 才能造出来，所以这里让宿主**自称**另一个构建
/// （`host_build_commit`，生产由 `SupervisorConfig::new` 填成主 exe 里那一串）：
/// worker 是真的、管道是真的、握手里的那一串也是真的（它会报自己那份戳），
/// 只有「两边是不是一对」这一问是假的——而这一问正是要钉的东西。
///
/// 两条断言各自钉一件事：任务当场被诚实退回（不是挂在那儿转圈），以及**不按崩溃处理**
/// ——修好之前它不该靠重试蒙过去，所以状态是 `Broken` 且原因里没有「重启次数到顶」。
#[test]
fn a_worker_from_another_build_is_refused_instead_of_retried_as_a_crash() {
    let sandbox = Sandbox::new("foreign-worker");
    let mut config = config(&sandbox);
    config.host_build_commit = "0000000000ff".to_string();
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("那一件任务被诚实退回", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string()
        },
        "worker 不能用就得当场退回，不能挂在那儿等一个永远不来的算力"
    );

    let reason = match manager.worker_status() {
        WorkerStatus::Broken { reason } => reason,
        other => panic!("不配套的 worker 该落 Broken（它要人动手换包）：{other:?}"),
    };
    assert!(
        reason.contains("不是同一次构建"),
        "原因要说清是「两半不是一对」，而不是含混的起不来：{reason}"
    );
    assert!(
        !reason.contains("重启次数到顶"),
        "「这份 exe 不是给这个宿主编的」换一代解决不了，不该按崩溃重试到熔断：{reason}"
    );
    assert!(
        manager.worker_build().is_none(),
        "拒跑的那一代没有握手成功，构建事实也不该留在账上"
    );

    // 它不自己重试：等一段比第一次退避（1 秒）长得多的时间，状态与原因都不许变。
    let before = manager.worker_status();
    std::thread::sleep(Duration::from_millis(2_500));
    assert_eq!(
        manager.worker_status(),
        before,
        "拒跑之后不该自己再起一代（那只会把同一件事重说一遍）"
    );

    // 换回配套的包之后，界面上那一下「重试」是唯一的路（§8.3）：点了之后它肯再起一代
    // ——只是这一份还是不配套，于是第二件任务照样被诚实退回。这条同时证明「重试」真的
    // 把 `broken` 那道闸抬起来了（抬不起来的话第二件会一直躺在队列里，等不到终态）。
    manager.retry_worker();
    let again = submit_foreground(&manager, "book", 1);
    let again_state = wait_until("点过重试之后又起了一代、又拒了一次", HANDOFF, || {
        terminal_of(&manager, &again.job_id)
    });
    assert_eq!(
        again_state,
        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string()
        },
        "不配套的包重试多少次都是同一句话，但每一次都得当场说清楚"
    );

    manager.shutdown();
}

/// 便携目录里少了一个 worker 文件时（杀软删了、拷漏了、解压到一半），界面要**当场**
/// 知道「这台机器上没有它」，而不是等三次退避之后再报一句模棱两可的「起不来」。
///
/// 这条同时是 Task 10 出口条件里「协议不符不阻断主窗」的另一半：计算进程不能用的时候，
/// 主窗的命令必须照样答话——任务提交拿得到编号、账读得到、补上文件点一下「重试」就能
/// 接着干活。计算不在，应用还得能用。
#[test]
fn a_missing_worker_file_is_reported_at_once_and_does_not_block_the_window() {
    let sandbox = Sandbox::new("no-worker");
    let mut config = config(&sandbox);
    // 指到一个名字上，但那个文件不存在（`config()` 给的是真 worker 的路径）。
    let missing = sandbox.root.join("yomika-compute-worker.exe");
    assert!(!missing.is_file(), "这条用例要的就是「文件不在」这一幕");
    config.worker_path = missing.clone();
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("缺文件的那一件当场被退回", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string()
        },
        "缺文件不是「等一等就会好」，排队的任务要当场拿到结论"
    );

    let reason = match manager.worker_status() {
        WorkerStatus::Broken { reason } => reason,
        other => panic!("缺 worker 文件该落 Broken（它要人动手补文件）：{other:?}"),
    };
    assert!(
        reason.contains("找不到 worker 可执行文件"),
        "原因要把「文件不在」说出来，不能只说「不可用」：{reason}"
    );
    assert!(
        !reason.contains("重启次数到顶"),
        "文件不在不是崩溃，不该按崩溃重试到熔断：{reason}"
    );
    assert!(
        manager.worker_build().is_none(),
        "没握过手就没有构建事实，账上不该有东西"
    );
    assert!(
        manager.job_artifacts(&submitted.job_id).is_empty(),
        "一件没算的任务不该有产物"
    );

    // 它不自己重试：等一段比第一次退避（1 秒）长得多的时间，状态与原因都不许变。
    let before = manager.worker_status();
    std::thread::sleep(Duration::from_millis(2_500));
    assert_eq!(
        manager.worker_status(),
        before,
        "缺文件时不该自己再起一代（重试只会把同一句「没有这个文件」再说一遍）"
    );

    // 主窗没有卡住：提交照样当场拿到编号与订阅号（界面看的是这两个），账照样读得到。
    let queued = submit_foreground(&manager, "book", 1);
    assert_ne!(queued.job_id, submitted.job_id);
    assert!(queued.subscription_id > 0, "没有 worker 也不该把命令挡回去");

    // 把文件补上、点界面那一下「重试」：缺件是**能自己好起来**的一种坏法，不该逼用户
    // 重启应用（这与「换一份配套的包」走的是同一条路）。
    std::fs::copy(worker_exe(), &missing).expect("把 worker 补进便携目录");
    manager.retry_worker();
    let repaired = submit_foreground(&manager, "book", 2);
    let repaired_state = wait_until("补上文件、点过重试之后能算完", HANDOFF, || {
        terminal_of(&manager, &repaired.job_id)
    });
    assert_eq!(
        repaired_state,
        JobState::Completed,
        "文件补回去之后该能干活：坏的是包，不是这台机器"
    );

    manager.shutdown();
}

/// 索引说的那一份与磁盘上的字节不是同一份时，**派发前**就要停下。
///
/// 内容寻址的位置本来不该装着别的字节，但那一行是从数据库里读出来的说法，文件却是文件
/// 系统给的事实。两者不一致还接着算，就是拿别的页去交一张看着正常的图——产物确实是一张
/// 真图，用户根本发现不了。这条用回声引擎：失败发生在准备阶段，引擎还没轮到上场。
#[test]
fn a_source_that_is_not_the_file_the_index_claims_is_refused_before_dispatch() {
    let sandbox = Sandbox::new("tamper");
    let page = b"\x89PNG\r\n\x1a\nnot really a page".to_vec();
    std::fs::write(sandbox.root.join("page.png"), &page).expect("写一页");
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");

    let mut tampered = request("book", 9, 0);
    tampered.source = Some(SourceFile {
        path: sandbox.root.join("page.png"),
        // 索引里说的是这一份，磁盘上是另一份。
        content_hash: "a".repeat(64),
        byte_length: page.len() as u64,
    });
    let submitted = manager.submit(tampered).expect("应该收下这件任务");

    let state = wait_until("篡改在准备阶段就被发现", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_INPUT_INVALID".to_string()
        },
        "不一致要报成输入问题，而且必须在这一步就失败"
    );
    assert!(
        manager.job_artifacts(&submitted.job_id).is_empty(),
        "连一次产物都不该有"
    );

    manager.shutdown();
}

/// 闲置交回（docs/71 §8.4）：工作区在 worker 进程里，所以 `release_idle` 是一条**真的
/// 往返**——宿主发请求，worker 交回并报数字，宿主把数字交出来。
///
/// 这个进程里没有真 NGX，交回不了真的工作区，所以「交回了几份」用 worker 的测试钩子
/// 递一个 7 进去：这一条要证的是**数字确实走完了整条路**，而不是本机交回了几份。
/// 也正因此它能把「超时回 0」与「真的交回 0 份」分开——没有这个非零数字，两条路都答 0。
#[test]
fn a_release_idle_goes_to_the_running_worker_and_comes_back_with_its_number() {
    let sandbox = Sandbox::new("release-idle");
    let recorder = Recorder::default();
    let mut config = config(&sandbox);
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_RELEASED_WORKSPACES".to_string(),
        "7".to_string(),
    )];
    let manager = ComputeManager::start(config, recorder.sink()).expect("起 supervisor");

    // 还没有 worker：没有工作区可交回，而且**交回不是启动计算的理由**。
    assert_eq!(manager.release_idle(), 0, "没起过 worker 就没有工作区可交回");
    assert!(
        matches!(manager.worker_status(), WorkerStatus::Stopped),
        "为了交回就把 worker 拉起来是本末倒置：{:?}",
        manager.worker_status()
    );

    let submitted = submit_foreground(&manager, "book", 0);
    let state = wait_until("任务收尾", HANDOFF, || terminal_of(&manager, &submitted.job_id));
    assert_eq!(state, JobState::Completed);

    let started = Instant::now();
    let count = manager.release_idle();
    let waited = started.elapsed();
    assert_eq!(count, 7, "worker 报回的数字要原样交出来");
    assert!(
        waited < Duration::from_secs(2),
        "交回是等一个回合，不是等一张图：等了 {waited:?}"
    );

    // 交回不该顺手把会话弄死：下一件任务还要在同一代 worker 上跑完。
    let next = submit_foreground(&manager, "book", 1);
    let state = wait_until("第二件任务收尾", HANDOFF, || terminal_of(&manager, &next.job_id));
    assert_eq!(state, JobState::Completed, "交回只放纹理，worker 还该活着");
    assert!(
        matches!(manager.worker_status(), WorkerStatus::Ready { .. }),
        "交回之后这一代 worker 还该在：{:?}",
        manager.worker_status()
    );

    manager.shutdown();
}

/// 换了 DLL 片段 = 换一代 worker（docs/71:640「模型/DLL换版本重启worker；不能热切同NGX
/// context的DLL；通过epoch清旧结论与source/output revision」）。
///
/// 为什么非退不可：片段是 `LoadLibrary` 进来的原生库，NGX 的 context 活在**进程里**
/// （`crates/compute-core/src/dlssnr/device.rs` 的 `static CONTEXT`）。同一份 context 上换不了
/// 片段，而这个进程手里那份还在——用户点完「导入」看到的是**旧片段**的结论，而且新的片段
/// 文件还可能替换不了（被映射着的镜像删不掉）。所以这一代必须退，下一个任务起的是另一个进程。
///
/// 「真的换了」不能只看状态字符串：`peer_pid` 变了才算换了进程，`epoch` 前进才算旧结论作废。
#[test]
fn a_new_dll_snippet_retires_the_worker_that_still_has_the_old_context() {
    let sandbox = Sandbox::new("retire-dll");
    let mut config = config(&sandbox);
    // 让阶段停一会儿，才有「正在算的时候用户换了片段」这个局面可测。
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_DELAY_MS".to_string(),
        "1500".to_string(),
    )];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let submitted = submit_foreground(&manager, "book", 0);
    let before = wait_until("worker 接手", HANDOFF, || match manager.worker_status() {
        WorkerStatus::Ready {
            epoch, peer_pid, ..
        } => Some((epoch, peer_pid)),
        _ => None,
    });
    // 确认它已经在算，不是还排在队列里：退役要看的是「在飞的任务怎么收尾」。
    wait_until("进入非排队状态", HANDOFF, || {
        manager
            .job(&submitted.job_id)
            .filter(|snapshot| snapshot.state != JobState::Queued)
            .map(|_| ())
    });

    assert!(
        manager.retire_worker("DLSSNR 片段换了版本"),
        "有会话在的时候，换代要说「退掉了」"
    );
    // **同步**：它回来的时候这一代已经不在了——装新片段那一步就在这一句之后，
    // 而换一个被映射着的 DLL 会失败，所以「等你真退」是这条命令的一部分。
    assert!(
        matches!(manager.worker_status(), WorkerStatus::Stopped),
        "退役要等这一代真的退下再回来：{:?}",
        manager.worker_status()
    );

    let state = wait_until("在飞的任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_LOST".to_string()
        },
        "换代时正在算的那一件必须有一个诚实的结论，不能留在「正在跑」"
    );

    let next = submit_foreground(&manager, "book", 1);
    let state = wait_until("新一代跑完下一件", HANDOFF, || {
        terminal_of(&manager, &next.job_id)
    });
    assert_eq!(state, JobState::Completed, "换代后要能接着干");

    let after = match manager.worker_status() {
        WorkerStatus::Ready {
            epoch, peer_pid, ..
        } => (epoch, peer_pid),
        other => panic!("下一件任务跑完该是 Ready：{other:?}"),
    };
    assert_eq!(
        after.0,
        before.0 + 1,
        "换代要推进 epoch：旧代迟到的消息从此对不上号"
    );
    assert_ne!(
        after.1, before.1,
        "换了片段之后必须是另一个进程——旧的还握着旧 context"
    );

    manager.shutdown();
}

/// 故意的换代不是崩溃（§8.3 的窗口内最多 3 次重启、超过就熔断到用户手动重试为止）。
///
/// 「它刚才崩了」与「我们请它退下」是两件事：前者要退避、要记账、要熔断；后者是用户自己
/// 点的导入/下载。要是走同一条路，用户在设置页连换四次片段就把 worker 判死了——而它一次
/// 都没崩过，之后每一件任务都会报「没有可用的计算进程」。
#[test]
fn deliberate_retirements_do_not_count_as_a_crash_loop() {
    let sandbox = Sandbox::new("retire-loop");
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");

    let mut last_epoch = None;
    for page in 0..4_u32 {
        let submitted = submit_foreground(&manager, "book", page);
        let state = wait_until("任务收尾", HANDOFF, || terminal_of(&manager, &submitted.job_id));
        assert_eq!(state, JobState::Completed);
        let epoch = wait_until("worker 接手", HANDOFF, || match manager.worker_status() {
            WorkerStatus::Ready { epoch, .. } => Some(epoch),
            _ => None,
        });
        if let Some(previous) = last_epoch {
            assert!(epoch > previous, "每换一次片段 epoch 都要前进：{previous} → {epoch}");
        }
        last_epoch = Some(epoch);

        assert!(manager.retire_worker("又换了一次片段"), "第 {page} 次换代要成功");
        assert!(
            matches!(manager.worker_status(), WorkerStatus::Stopped),
            "第 {page} 次换代之后该是 Stopped：{:?}",
            manager.worker_status()
        );
    }

    assert!(
        !matches!(manager.worker_status(), WorkerStatus::Broken { .. }),
        "四次故意的换代不该把熔断点亮：{:?}",
        manager.worker_status()
    );

    let last = submit_foreground(&manager, "book", 9);
    let state = wait_until("换代不封锁后续任务", HANDOFF, || {
        terminal_of(&manager, &last.job_id)
    });
    assert_eq!(state, JobState::Completed, "换代之后还得能算");

    manager.shutdown();
}

/// 一页装不下就别摆进输入根、更别交给 worker：判据是**源图自己的像素**，与 worker 那份
/// `budgets.max_pixels` 是同一个上限（`resource_policy::PAGE_PIXEL_LIMIT`）。
///
/// 为什么要在派发前判：worker 也会拒（`dlssnr.rs` 拿 `max_pixels` 比一次就是），但那时它
/// 已经把图读进来、把模型或 165 MB 的片段装好、上下文也建起来了——拒绝的代价是几十秒的
/// GPU 时间。而「这一页到底多大」在派发前是**量得出来的**：读一页图的头就够，不用把像素
/// 解出来。错的码仍然是资源上限，于是界面侧的处置不变：原图留着，这一页不算「做过」。
///
/// 后半段是**对照**：同一台机器、同一份 worker，界限之内的那一页照样算得出来——一道在
/// 派发前落下的刀，第一件要证明的是它没砍到不该砍的东西。
#[test]
fn a_page_over_the_pixel_limit_is_refused_before_the_worker_is_asked() {
    let sandbox = Sandbox::new("over-limit");
    // 8193×8192 = 67 117 056 像素，比上限（64×1024×1024 = 67 108 864）多一行。
    let page = sandbox.root.join("page.png");
    write_page(&page, 8193, 8192);
    let (byte_length, content_hash) =
        yomika_lib::compute::artifacts::hash_file(&page).expect("源图该读得出来");

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let mut oversized = request("book", 601, 0);
    oversized.source = Some(SourceFile {
        path: page.clone(),
        content_hash: content_hash.clone(),
        byte_length,
    });
    let submitted = manager.submit(oversized).expect("收下这件任务，判决在派发前那一步");
    let state = wait_until("超限那一页该被拒", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_RESOURCE_LIMIT".to_string()
        },
        "67 117 056 像素超过 67 108 864 像素的上限：派发前就该拒，措辞是资源上限"
    );
    assert!(
        manager.job_artifacts(&submitted.job_id).is_empty(),
        "既然拒了，就不该有产物落到手里"
    );

    // 身份错了优先于尺寸错了：同一张超限的图，只要索引说的那一份对不上，答的就必须是
    // 「不是同一份」——不然一条更靠前的拒绝会把真问题（索引指向了别的字节）盖过去，而
    // 那件事比「太大」严重得多。
    let mut wrong_identity = request("book", 603, 0);
    wrong_identity.source = Some(SourceFile {
        path: page.clone(),
        content_hash: "a".repeat(64),
        byte_length,
    });
    let submitted = manager.submit(wrong_identity).expect("收下");
    let state = wait_until("身份对不上要先说身份", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_INPUT_INVALID".to_string()
        },
        "同一张超限的图：索引对不上时答的是身份问题，不是「太大」"
    );

    let small = sandbox.root.join("small.png");
    write_page(&small, 64, 64);
    let (small_length, small_hash) =
        yomika_lib::compute::artifacts::hash_file(&small).expect("源图该读得出来");
    let mut inside = request("book", 602, 0);
    inside.source = Some(SourceFile {
        path: small,
        content_hash: small_hash,
        byte_length: small_length,
    });
    let submitted = manager.submit(inside).expect("收下");
    let state = wait_until("界限之内的那一页要算得出来", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "上限之内的页不能被一起拦掉");

    manager.shutdown();
}

/// 一页自己装得下、**乘上倍率**就装不下了——同一把刀，换一根算术。
///
/// 为什么这一条也要在派发前判：worker 那边其实一直在判（`upscale.rs` 拿
/// `budgets.max_pixels / scale²` 反推源图上限，就是这一条），但那时它已经把图读进来、把模型
/// 或 165 MB 的片段装好、上下文也建起来了。宿主手里那两个数在派发前就齐了：源图多大是刚量
/// 出来的，倍率是这条流水线自己写的。判在这里，被拒的代价只剩「读一个图头」，worker 一个
/// 字节都没见过。
///
/// 后半段是**对照**：同一台机器、同一份 worker，倍率乘完仍在预算之内的那一页照样算得出来。
#[test]
fn a_page_that_fits_alone_is_refused_once_the_scale_is_applied() {
    let sandbox = Sandbox::new("over-budget");
    // 5000×4000 = 20 000 000 像素：一页的上限（64×1024×1024 = 67 108 864）装得下；
    // x2 之后是 80 000 000，装不下。
    let page = sandbox.root.join("page.png");
    write_page(&page, 5000, 4000);
    let (byte_length, content_hash) =
        yomika_lib::compute::artifacts::hash_file(&page).expect("源图该读得出来");

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let mut over = request("book", 611, 0);
    over.pipeline[0].scale = Some(2);
    over.source = Some(SourceFile {
        path: page,
        content_hash,
        byte_length,
    });
    let submitted = manager.submit(over).expect("收下这件任务，判决在派发前那一步");
    let state = wait_until("倍率乘完超预算的那一页该被拒", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_RESOURCE_LIMIT".to_string()
        },
        "20 000 000 像素 x2 = 80 000 000 超过 67 108 864 的预算：派发前就该拒"
    );
    assert!(
        manager.job_artifacts(&submitted.job_id).is_empty(),
        "既然拒了，就不该有产物落到手里"
    );
    let inputs_root = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    let staged = std::fs::read_dir(&inputs_root)
        .map(|entries| entries.filter_map(Result::ok).count())
        .unwrap_or(0);
    assert_eq!(
        staged, 0,
        "被拒的那一页不该被摆进输入根：派发前拒的意思就是 worker 连源图的字节都没见过"
    );

    let small = sandbox.root.join("small.png");
    write_page(&small, 2000, 2000);
    let (small_length, small_hash) =
        yomika_lib::compute::artifacts::hash_file(&small).expect("源图该读得出来");
    let mut inside = request("book", 612, 0);
    inside.pipeline[0].scale = Some(2);
    inside.source = Some(SourceFile {
        path: small,
        content_hash: small_hash,
        byte_length: small_length,
    });
    let submitted = manager.submit(inside).expect("收下");
    let state = wait_until("预算之内的那一页要算得出来", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "预算之内的页不能被一起拦掉");

    manager.shutdown();
}

/// 空到一会儿就把引擎的工作区与模型交回去（docs/71 §12.4：「idle30 秒释放模型/workspace」），
/// 但**一段空闲只交一遍**，而且绝不在有人干活的时候交。
///
/// 三段判据各有各的牙：
/// - 跑着的时候一次都不许问——那份工作区与那几个模型下一件任务就要用，交了等于自己把它们
///   拆掉再重建；
/// - 一段空闲里只交一遍——没有这条，交回请求会跟着 200 ms 的控制拍一帧帧发出去，worker
///   那边就是反复放掉又重建（每一次都可能是几百毫秒的模型加载）；
/// - **下一段空闲还会交**——把「这一段交过了」的标记在重新忙起来的时候清掉才成立。这一条
///   是这一轮最容易漏的：只留「交过没有」一个布尔，第二段空闲就永远不问。
///
/// 阈值走 [`SupervisorConfig::idle_release`]（生产缺省是 `resource_policy::IDLE_RELEASE_MS`
/// = 30 秒），所以这里能缩到几百毫秒：判据和等 30 秒的那条是同一根钟，只是钟走得快。
#[test]
fn a_worker_that_sits_idle_hands_its_workspaces_back_once_per_quiet_stretch() {
    let sandbox = Sandbox::new("idle-release");
    let mut config = config(&sandbox);
    // 300 ms 的「空闲」配 800 ms 的一件任务：干活的那段比空闲阈值长，「忙的时候不问」才看得见。
    config.idle_release = Duration::from_millis(300);
    config.extra_env = vec![("YOMIKA_WORKER_TEST_DELAY_MS".to_string(), "800".to_string())];
    let manager = ComputeManager::start(config, no_events()).expect("起 supervisor");

    let first = submit_foreground(&manager, "book", 1);
    wait_until("第一件任务跑起来", HANDOFF, || {
        manager
            .job(&first.job_id)
            .filter(|snapshot| snapshot.state.holds_running())
            .map(|_| ())
    });
    // 跑到 500 ms 的时候，空闲的钟早就该响了——但它在干活。
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        manager.idle_releases(),
        0,
        "有活在跑的时候不该交回工作区与模型：下一件任务会把它们原样重建一遍"
    );
    wait_until("第一件任务落地", HANDOFF, || {
        terminal_of(&manager, &first.job_id)
    });

    // 空闲超过阈值：交回一次。
    wait_until("空闲之后该交回一次", HANDOFF, || {
        (manager.idle_releases() >= 1).then_some(())
    });
    // 再等一段：不许跟着控制拍反复问（200 ms 一拍的话，700 ms 足够多问三次）。
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(
        manager.idle_releases(),
        1,
        "一段空闲里只该交一遍：拍一拍地问，等于让 worker 反复放掉再重建"
    );

    // 交回不是收摊：进程还在，下一件任务照样跑得完。
    let second = submit_foreground(&manager, "book", 2);
    let state = wait_until("交回之后还能接着算", HANDOFF, || {
        terminal_of(&manager, &second.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "交回工作区只该让下一件任务重建一次，不该把这一代 worker 弄不能干活"
    );
    match manager.worker_status() {
        WorkerStatus::Ready { .. } => {}
        other => panic!("交回工作区与模型之后 worker 该还在：{other:?}"),
    }

    // 第二段空闲：还会再交一遍——重新忙起来的时候那个标记必须被清掉。
    wait_until("第二段空闲该再交一遍", HANDOFF, || {
        (manager.idle_releases() >= 2).then_some(())
    });
    assert_eq!(
        manager.idle_releases(),
        2,
        "第二段空闲只该再多交一遍，不该补交上一段漏掉的"
    );

    manager.shutdown();
}

/// 写一张指定尺寸的 PNG。内容不重要（这一刀读的是**头**），只求尺寸是我们要的那个数。
fn write_page(path: &Path, width: u32, height: u32) {
    let image = image::GrayImage::from_pixel(width, height, image::Luma([0x40]));
    image.save(path).expect("存一张页图");
}

fn kill_process(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).expect("打开 worker 进程");
        let _ = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
    }
}


#[test]
fn coalescing_a_new_subscriber_does_not_replace_the_dispatched_output_grant() {
    let sandbox = Sandbox::new("coalesced-grant");
    let mut config = config(&sandbox);
    config.extra_env = vec![("YOMIKA_WORKER_TEST_DELAY_MS".into(), "500".into())];
    let manager = ComputeManager::start(config, no_events()).unwrap();
    let first = manager.submit(request("shared-grant", 0, 20_000)).unwrap();
    wait_until("worker starts shared job", HANDOFF, || {
        manager.job(&first.job_id).filter(|snapshot| matches!(snapshot.state, JobState::Running { .. }))
    });
    let mut second_request = request("shared-grant", 0, 20_000);
    second_request.output_grant_id = "different-consumer-grant".into();
    let second = manager.submit(second_request).unwrap();
    assert!(second.coalesced);
    assert_eq!(first.job_id, second.job_id);
    let result = wait_until("shared result", HANDOFF, || manager.job(&first.job_id).filter(|snapshot| snapshot.state.is_terminal()));
    assert_eq!(result.state, JobState::Completed);
    assert_eq!(manager.job_artifacts(&first.job_id).iter().filter(|artifact| artifact.verified).count(), 1);
    manager.shutdown();
}
