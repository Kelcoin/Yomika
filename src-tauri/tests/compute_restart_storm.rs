//! §12.4 ⑥ 的 20 轮「启动计算 → 取消/强杀 → 重启 → 读同页」。
//!
//! 每一轮都冲着**同一页**去：起一件任务，用取消或强杀把它打断，等 supervisor 收拾干净，
//! 再把同一页原样提交一次——它必须照样算出来。20 轮下来要有四样东西一个都不出现：
//! 孤儿进程、staging 遗留、重复终态、错误的 cache。
//!
//! 熔断是这套东西的一部分，不是意外。`end_session(…, restart = true)` 每打断一次记一笔，
//! 60 秒窗口里超过 `MAX_RESTARTS_PER_WINDOW` 就把 worker 判成 `Broken`，此后**只有**用户在
//! 界面上点「重试」（[`ComputeManager::retry_worker`]）才会再起。这里就按界面的做法走：
//! 看见 `Broken` 就点一次重试——不然那一段代码在自动化里永远没人走。
//!
//! 熔断还有两件必须钉死的事，各有一条用例：① 熔断亮着的时候交上来的活**当场**拿结论
//! （`COMPUTE_WORKER_UNAVAILABLE`），不许躺在队列里等用户动手；② 「任务先记终态、熔断随后
//! 才亮」这条缝里交上来的活，答案与 ① 相同——同一种现场两种时序要给同一个答案。
//! ① 由 `a_tripped_breaker_judges_the_queued_page_and_waits_for_an_explicit_retry` 钉，
//! ② 由下面这条 20 轮用例的读同页循环钉。
//!
//! 「无错误 cache」不靠"没报错"来证。内容寻址那一层的文件名**就是**摘要，所以这里逐文件
//! 复核：`cache/images/**` 里的每一份都要哈希回自己的文件名，另外整棵树里不许留下
//! `.<摘要前16位>.part-<pid>-<纳秒>` 这种写到一半的临时件。

#![cfg(windows)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use yomika_lib::compute::artifacts::BLOB_PREFIX;
use yomika_lib::compute::manager::{
    no_events, ComputeManager, SourceFile, SubmitRequest, SupervisorConfig, WorkerStatus,
};
use yomika_lib::compute::scheduler::{CancelOutcome, JobKey, JobState, Priority};
use yomika_compute_protocol::{EnginePolicy, PipelineStage, RunInput};

/// 一轮里「取消」与「强杀」交替；取消那条路上宿主等的是自己的宽限期（2 秒），所以让
/// worker 每一页都算得比宽限期久一点，好让取消一定落在「正在算」的时候。
const STAGE_DELAY_MS: u64 = 2_500;
const ROUNDS: usize = 20;

/// 轮数：§12.4 ⑥ 写的是 20，三连里跑的就是它。
///
/// 变异检查需要一个便宜一点的口子——每一条红都要先把整轮循环跑完才轮得到断言。
/// 但下限写在代码里（少于 6 轮连熔断都点不亮，那条断言就永远绿），而且缺省永远是 20。
fn rounds() -> usize {
    std::env::var("YOMIKA_STORM_ROUNDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|count| *count >= 6)
        .unwrap_or(ROUNDS)
}
const HANDOFF: Duration = Duration::from_secs(60);

fn worker_exe() -> PathBuf {
    let profile = std::env::current_exe().expect("测试自己的路径");
    let profile = profile.parent().expect("target/<profile>");
    let profile = profile.parent().expect("target");
    build_worker(profile);
    profile.join("yomika-compute-worker.exe")
}

/// `cargo test` 与 worker 各自可能在不同的 profile 下编译过；这里按需要补一次，
/// 免得测试拿到上一轮的旧进程。
fn build_worker(profile_dir: &Path) {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let mut command = ProcessCommand::new(env!("CARGO"));
    command
        .arg("build")
        .arg("--manifest-path")
        .arg(manifest)
        .arg("-p")
        .arg("yomika-compute-worker");
    if profile_dir
        .file_name()
        .is_some_and(|name| name == "release")
    {
        command.arg("--release");
    }
    let status = command.status().expect("起 cargo build");
    assert!(status.success(), "worker 没编译出来：{status}");
}

struct Sandbox {
    root: PathBuf,
    staging: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时钟")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "yomika-restart-storm-{name}-{}-{nanos}",
            std::process::id()
        ));
        let staging = root.join("compute").join("staging");
        std::fs::create_dir_all(&staging).expect("建沙箱");
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
    // 这一轮要测的是「打断之后收拾干净」，不是闲置回收：把闲置那一路推远。
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    config.extra_env = vec![
        (
            "YOMIKA_WORKER_TEST_DELAY_MS".to_string(),
            STAGE_DELAY_MS.to_string(),
        ),
        // 故意让 worker 不看取消牌：这样取消那条路只能靠宿主的宽限期收族，
        // 也就是 §12.4 ⑥ 里说的「强杀」那一半的邻居。
        (
            "YOMIKA_WORKER_TEST_IGNORE_CANCEL".to_string(),
            "1".to_string(),
        ),
    ];
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

/// 每一轮读的都是**同一页**：同一个 `input_id`、同一个 `settings_id`、同一个 revision。
/// 上一件已经终态（key 也从 `by_key` 里摘了），所以再提交就是真算一遍，不是合并。
fn request(input_id: &str, page: u32) -> SubmitRequest {
    SubmitRequest {
        key: key(input_id, page),
        priority: Priority::Foreground,
        input: RunInput {
            input_id: format!("{input_id}#{page}"),
            content_hash: "0".repeat(64),
            byte_length: 1024,
            relative_path: None,
        },
        pipeline: vec![PipelineStage {
            accelerator: None,
            stage_id: "stage-a".to_string(),
            model_spec_id: "echo".to_string(),
            model: None,
            dlssnr: None,
            builtin: None,
            min_input_edge: None,
            output_scale: None,
            engine_policy: EnginePolicy::Cpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-1".to_string(),
        deadline_ms: 0,
        source: None::<SourceFile>,
    }
}

fn wait_until<T>(what: &str, budget: Duration, probe: impl Fn() -> Option<T>) -> T {
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

fn terminal_of(manager: &ComputeManager, job_id: &str) -> Option<JobState> {
    manager
        .job(job_id)
        .map(|snapshot| snapshot.state)
        .filter(|state| state.is_terminal())
}

/// 谁在算的时候被打断，这一轮就算在谁头上（查孤儿进程要用）。
fn worker_pid(manager: &ComputeManager) -> Option<u32> {
    match manager.worker_status() {
        WorkerStatus::Ready { peer_pid, .. } => Some(peer_pid),
        _ => None,
    }
}

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

fn kill_process(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).expect("打开 worker 进程");
        let _ = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
    }
}

/// 一个计算进程的身份。
///
/// 光有进程号不够：Windows 会把进程号发给新进程，20 轮里同一个号完全可能落到后一轮的 worker
/// 上——那时「这个号还活着」并不代表第 3 轮那个进程没被收掉（这条断言就这么误报过一次：
/// 报出来的那个号在几分钟后已经不存在了，也就是说它当时是**别人的**号）。
/// 创建时间把「同一个号」和「同一个进程」分开。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct WorkerId {
    pid: u32,
    created: u64,
}

/// 这个进程号现在对应哪一个进程（拿创建时间当身份）。进程不在就是 `None`。
fn worker_identity(pid: u32) -> Option<WorkerId> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        Some(WorkerId { pid, created })
    }
}

/// 「那一个进程还活着吗」要问退出码，也要对身份。
///
/// 退出码那半句是必需的：刚被杀掉的进程可能在别处还挂着一个句柄，`OpenProcess` 照样成功，
/// 只有退出码会说实话。**但退出码挡不住进程号被复用**——号一旦被发给了新进程，
/// 拿旧号问出来的「活着」是另一件事，所以创建时间必须一起比。
fn same_process_alive(id: WorkerId) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Some(now) = worker_identity(id.pid) else {
        return false;
    };
    if now.created != id.created {
        // 这个号已经被发给别人了：当初那个进程不在了。
        return false;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id.pid) else {
            return false;
        };
        let mut code = 0u32;
        let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        alive
    }
}

/// 「那一个进程还活着吗」一旦只认号，上面那条孤儿断言就等于没在问孤儿进程。
///
/// 20 轮里进程号被复用不是每次都能撞上（撞上了才红，那叫运气），所以这条判据单独量一次：
/// 拿自己当实验品——号对、创建时间错，必须是「不是同一个进程」。
#[test]
fn a_recycled_process_id_is_not_the_same_process() {
    let me = std::process::id();
    let real = worker_identity(me).expect("自己总该在");
    assert!(same_process_alive(real), "自己当然还活着");
    let recycled = WorkerId {
        pid: real.pid,
        created: real.created + 1,
    };
    assert!(
        !same_process_alive(recycled),
        "号一样、创建时间不一样，那就不是同一个进程 —— 只比号会把别人的进程算成自己的"
    );
}

/// staging 顶层的文件（名字 + 修改时间）。名字在每一代之间会重复（`stage-a.bin`），
/// 所以「这一份还在不在」要靠名字加时间戳一起认。
fn staging_entries(staging: &Path) -> Vec<(String, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        found.push((entry.file_name().to_string_lossy().to_string(), modified));
    }
    found.sort();
    found
}

fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(kind) if kind.is_file() => found.push(path),
                _ => {}
            }
        }
    }
    found.sort();
    found
}

fn blake3_of(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("读 {}：{error}", path.display()));
    blake3::hash(&bytes).to_hex().to_string()
}

#[test]
fn twenty_rounds_of_cancel_and_kill_leave_nothing_behind() {
    let sandbox = Sandbox::new("storm");
    let recorder = Recorder::default();
    let manager = ComputeManager::start(config(&sandbox), recorder.sink()).expect("起 supervisor");

    let mut interrupted: Vec<WorkerId> = Vec::new();
    let mut cancelled = 0usize;
    let mut lost = 0usize;
    let mut broken_rounds = 0usize;
    let mut judged_in_the_gap = 0usize;
    let count = rounds();

    for round in 0..count {
        let cancel_this_round = round % 2 == 0;
        let started = Instant::now();
        let submitted = manager
            .submit(request("storm-book", 0))
            .expect("同一页再提交一次也该收下");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "submit 不该等计算：等了 {:?}",
            started.elapsed()
        );
        // 取消/强杀都要打在「正在算」的时候，不然测的是排队取消。
        wait_until(&format!("第 {round} 轮开始算"), HANDOFF, || {
            manager
                .job(&submitted.job_id)
                .filter(|snapshot| snapshot.state != JobState::Queued)
                .map(|_| ())
        });
        let pid = wait_until(&format!("第 {round} 轮拿到 worker 进程号"), HANDOFF, || {
            worker_pid(&manager)
        });
        // 身份在**打断之前**取：打断之后这个号可能立刻被下一代拿走。
        let identity = wait_until(&format!("第 {round} 轮认出这一代 worker"), HANDOFF, || {
            worker_identity(pid)
        });

        if cancel_this_round {
            let outcome = manager.cancel(&submitted.job_id, submitted.subscription_id);
            assert!(
                matches!(outcome, CancelOutcome::CancelRequested { .. }),
                "第 {round} 轮：在跑的任务应该进入「已请求取消」：{outcome:?}"
            );
        } else {
            kill_process(pid);
        }

        let state = wait_until(&format!("第 {round} 轮收尾"), HANDOFF, || {
            terminal_of(&manager, &submitted.job_id)
        });
        match (&state, cancel_this_round) {
            (JobState::Cancelled, true) => cancelled += 1,
            (JobState::Failed { code }, false) => {
                assert_eq!(
                    code, "COMPUTE_WORKER_LOST",
                    "第 {round} 轮：被强杀的那件该记成 worker 丢了"
                );
                lost += 1;
            }
            _ => panic!(
                "第 {round} 轮（{}）的结论不对：{state:?}",
                if cancel_this_round { "取消" } else { "强杀" }
            ),
        }
        interrupted.push(identity);

        // 打断三次就会把熔断点亮，界面这时候会给出「重试」。这里按界面的做法办：
        // 点了重试再往下走——这一段路径没人走的话，它在自动化里就等于不存在。
        if matches!(manager.worker_status(), WorkerStatus::Broken { .. }) {
            broken_rounds += 1;
            manager.retry_worker();
        }

        // 读同页。key 一模一样：上一件已经终态，所以这必须是**另一件**任务，
        // 而不是被合并进上一件。
        //
        // 这一轮的重试点：打断本身就可能是熔断那一下（`end_session` 先把任务判完、再去
        // 重启记账，中间那一段是缝），所以「读到 UNAVAILABLE 且此刻没有一个能干活的
        // worker」就该照界面再点一次重试，而不是判它失败。**只有这一种现场**允许重来：
        // 状态是 `Ready` 就说明这一代还活着，那 UNAVAILABLE 别的原因，照旧红。
        let mut attempt = 0u32;
        let (again, read) = loop {
            attempt += 1;
            let again = manager
                .submit(request("storm-book", 0))
                .expect("读同页该收下");
            assert_ne!(
                again.job_id, submitted.job_id,
                "第 {round} 轮：终态之后同一页该是一件新任务"
            );
            let read = wait_until(&format!("第 {round} 轮读同页"), HANDOFF, || {
                terminal_of(&manager, &again.job_id)
            });
            if read == JobState::Completed {
                break (again, read);
            }
            let judged_unavailable = matches!(
                &read,
                JobState::Failed { code } if code == "COMPUTE_WORKER_UNAVAILABLE"
            );
            // 熔断亮着、退避里等着、或者干脆没有会话 —— 三种情况下这一代都接不了活。
            let no_worker_can_take_it = !matches!(manager.worker_status(), WorkerStatus::Ready { .. });
            if judged_unavailable && no_worker_can_take_it && attempt < 3 {
                broken_rounds += 1;
                judged_in_the_gap += 1;
                manager.retry_worker();
                continue;
            }
            panic!(
                "第 {round} 轮：读同页没算出来（第 {attempt} 次提交）：{read:?}，此刻 worker = {:?}",
                manager.worker_status()
            );
        };
        assert_eq!(read, JobState::Completed, "第 {round} 轮：读同页没算出来");

        // 手里这一份必须是核过的，而且落下来的字节要哈希回它自己声明的摘要。
        let artifacts = manager.job_artifacts(&again.job_id);
        assert_eq!(artifacts.len(), 1, "第 {round} 轮：一个阶段一件产物");
        let artifact = artifacts.first().expect("有一件");
        assert!(artifact.verified, "第 {round} 轮：宿主必须自己核过");
        let relative = artifact
            .cache_relative
            .clone()
            .expect("配了发布根就该发布");
        assert!(
            relative.starts_with(BLOB_PREFIX),
            "第 {round} 轮：发布路径该是内容寻址的：{relative}"
        );
        assert_eq!(
            blake3_of(&artifact.path),
            artifact.content_hash,
            "第 {round} 轮：读同页落下来的那份和它自己声明的摘要不符"
        );
    }

    assert_eq!(cancelled, count / 2, "取消那一半该是 {count} 半");
    assert_eq!(lost, count / 2, "强杀那一半该是 {count} 半");
    assert!(
        broken_rounds >= 1,
        "{count} 轮打断下来熔断一次都没亮过 —— 那说明这套用例没走进「重试」那段路"
    );
    println!(
        "{count} 轮：取消 {cancelled} 次、强杀 {lost} 次；熔断亮了 {broken_rounds} 次，每次都按界面的做法点了重试；其中 {judged_in_the_gap} 次是「读同页」撞上那条缝被当场判掉的"
    );
    // 进程号被复用这件事不是猜的：把这一跑里重复出现过的号数出来。数大于 0 就说明
    // 「拿号问活着」这类断言在这一跑里本来就会问错人（见 `WorkerId`）。
    let mut seen: Vec<u32> = interrupted.iter().map(|id| id.pid).collect();
    seen.sort_unstable();
    let reused = seen.windows(2).filter(|pair| pair[0] == pair[1]).count();
    println!("这一跑里进程号被复用过 {reused} 次（{count} 个被打断的进程）");

    // ① 无孤儿进程：每一轮被打断的那个 worker 现在都得是不在的。比的是身份（号 + 创建时间），
    // 不是号——号会被发给下一代 worker。
    for id in &interrupted {
        assert!(
            !same_process_alive(*id),
            "worker {} 还活着（孤儿进程）",
            id.pid
        );
    }

    // ② 无 staging 遗留。先记下这一刻 staging 里有什么（上一件读同页留下的产物副本），
    // 然后**收摊**：这是这条用例里唯一一次「结束会话之后不会再握手」的收尾，所以它能把
    // `end_session` 里那次 `reclaim_staging` 单独钉住。换成「杀掉闲置的 worker」就钉不住——
    // 那条路会重启换代，新一代握手时还有一次清扫，`end_session` 那次删掉了也照样绿。
    let leftovers = staging_entries(&sandbox.staging);
    assert!(
        !leftovers.is_empty(),
        "这一轮结束时 staging 里该留着上一件读同页的产物副本，不然这条断言什么都没在测"
    );
    // 收摊前先把这一代的身份记下来：`shutdown()` 之后号可能已经归了别人。
    let idle_pid = worker_pid(&manager).expect("跑完这些轮之后 worker 还在");
    let idle_identity = worker_identity(idle_pid).expect("收摊之前这一代 worker 该还在");
    manager.shutdown();
    wait_until("收摊之后 staging 该收回去", HANDOFF, || {
        let left = staging_entries(&sandbox.staging);
        left.is_empty().then_some(())
    });
    assert!(
        !same_process_alive(idle_identity),
        "收摊之后 worker {idle_pid} 还活着（孤儿进程）"
    );
    interrupted.push(idle_identity);

    // ③ 无错误 cache：内容寻址那一层的文件名就是摘要，逐份哈希回去看。
    let blobs = files_under(&sandbox.root.join(BLOB_PREFIX));
    assert!(
        !blobs.is_empty(),
        "{} 底下应该有这一轮落下来的产物",
        sandbox.root.join(BLOB_PREFIX).display()
    );
    for blob in &blobs {
        let name = blob
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem = name.strip_suffix(".bin").unwrap_or(&name);
        assert_eq!(
            stem,
            blake3_of(blob),
            "cache 里这一份和它的文件名（摘要）不符：{}",
            blob.display()
        );
    }
    // 写到一半的临时件不许留下：`publish_blob` 的临时名是 `.<摘要前16位>.part-<pid>-<纳秒>`。
    let half_written: Vec<String> = files_under(&sandbox.root)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().contains(".part-"))
                .unwrap_or(false)
        })
        .map(|path| path.display().to_string())
        .collect();
    assert!(
        half_written.is_empty(),
        "留下了写到一半的临时件：{half_written:?}"
    );

    // ④ 无重复终态：一件任务只许有一个结论，而且结论之后再不许有非终态的事件。
    let mut conclusions: HashMap<String, Vec<JobState>> = HashMap::new();
    let mut terminal_jobs: HashSet<String> = HashSet::new();
    let mut unsettled: Vec<String> = Vec::new();
    for (job_id, state) in recorder.states() {
        if state.is_terminal() {
            conclusions.entry(job_id.clone()).or_default().push(state);
            terminal_jobs.insert(job_id);
        } else if terminal_jobs.contains(&job_id) {
            unsettled.push(job_id);
        }
    }
    for (job_id, states) in &conclusions {
        let mut distinct: Vec<String> = states.iter().map(|state| format!("{state:?}")).collect();
        distinct.sort();
        distinct.dedup();
        assert_eq!(
            distinct.len(),
            1,
            "同一件任务出现了 {distinct:?} 两种结论：{job_id}"
        );
    }
    assert!(
        unsettled.is_empty(),
        "已经收尾的任务又发出了非终态的变化：{unsettled:?}"
    );
    assert!(
        terminal_jobs.len() >= count * 2,
        "{count} 轮打断加 {count} 次读同页，至少该有 {} 件任务走到终态，实际 {}",
        count * 2,
        terminal_jobs.len()
    );

    manager.shutdown();
}

/// 熔断亮着的时候，交上来的活**当场**拿结论。
///
/// 这是「重启风暴」的另一面。熔断把 worker 判成不可用之后，界面会给一个「重试」；在用户动手
/// 之前，任何新交上来的活都不许躺在队列里——界面说的是「计算进程不可用」，任务那一边就得有
/// 对应的一句话。曾经不是这样：`maybe_spawn` 第一句就把「熔断亮着」和「没有活要跑」一起
/// `return` 掉了，于是活进来之后再没人看它一眼（`submit` 收下、`Queued` 一直挂着），直到用户
/// 点了重试才被一起派下去——算的还可能是他已经翻过去的那几页。
///
/// 这一条钉的是「熔断**已经**亮着」时交上来的活；「熔断正好在提交与检查之间亮起」那一幕
/// 由上面 20 轮用例的读同页循环钉（两种时序要给同一个答案）。
#[test]
fn a_tripped_breaker_judges_the_queued_page_and_waits_for_an_explicit_retry() {
    let sandbox = Sandbox::new("breaker");
    let recorder = Recorder::default();
    let manager = ComputeManager::start(config(&sandbox), recorder.sink()).expect("起 supervisor");

    // 60 秒窗口里第 4 次打断才点亮熔断（前三次按 1/3/10 秒退避），所以这里连打 4 次。
    let mut interrupted: Vec<WorkerId> = Vec::new();
    for round in 0..4u32 {
        let submitted = manager
            .submit(request("breaker-book", 0))
            .expect("熔断亮之前，这活该收下");
        // 退避结束、新一代握过手、这活真被派下去——到这一刻 `Ready` 里的号才是这一代的。
        wait_until(&format!("第 {round} 轮开始算"), HANDOFF, || {
            manager
                .job(&submitted.job_id)
                .filter(|snapshot| snapshot.state != JobState::Queued)
                .map(|_| ())
        });
        let pid = wait_until(&format!("第 {round} 轮拿到 worker 进程号"), HANDOFF, || {
            worker_pid(&manager)
        });
        let identity = wait_until(&format!("第 {round} 轮认出这一代 worker"), HANDOFF, || {
            worker_identity(pid)
        });
        if let Some(previous) = interrupted.last() {
            assert_ne!(
                *previous, identity,
                "第 {round} 轮该是新一代 worker：上一代被打断之后不许接着用"
            );
        }
        kill_process(pid);
        let state = wait_until(&format!("第 {round} 轮收尾"), HANDOFF, || {
            terminal_of(&manager, &submitted.job_id)
        });
        assert!(
            matches!(&state, JobState::Failed { code } if code == "COMPUTE_WORKER_LOST"),
            "第 {round} 轮：被强杀的那件该记成 worker 丢了：{state:?}"
        );
        interrupted.push(identity);
    }

    let reason = wait_until("打断到第 4 次该把熔断点亮", HANDOFF, || {
        match manager.worker_status() {
            WorkerStatus::Broken { reason } => Some(reason),
            _ => None,
        }
    });
    assert!(
        reason.contains("重启次数到顶"),
        "熔断的理由该说清是重启次数到顶：{reason}"
    );

    // 熔断亮着时交上来的活：当场拿结论，不许躺着等用户动手。
    let queued = manager
        .submit(request("breaker-book", 0))
        .expect("熔断亮着时这活也该被收下，然后当场判掉");
    let state = wait_until(
        "熔断亮着时交的活该当场有结论",
        Duration::from_secs(15),
        || terminal_of(&manager, &queued.job_id),
    );
    assert_eq!(
        state,
        JobState::Failed {
            code: "COMPUTE_WORKER_UNAVAILABLE".to_string(),
        },
        "熔断亮着时交上来的活该拿 COMPUTE_WORKER_UNAVAILABLE"
    );
    assert!(
        matches!(manager.worker_status(), WorkerStatus::Broken { .. }),
        "判掉一件排队的活不该把熔断本身抬起来"
    );
    assert!(
        manager.job_artifacts(&queued.job_id).is_empty(),
        "被当场判掉的活不该留下任何产物"
    );
    assert!(
        recorder
            .states()
            .iter()
            .any(|(job_id, state)| job_id == &queued.job_id && state.is_terminal()),
        "这个结论得**发出去**：界面是靠事件流知道一件活已经完了"
    );

    // 用户点了重试：这一代才算重新开始，同一页照样算得出来。
    manager.retry_worker();
    let again = manager
        .submit(request("breaker-book", 0))
        .expect("点过重试之后这活该收下");
    let state = wait_until("点过重试之后读同页", HANDOFF, || {
        terminal_of(&manager, &again.job_id)
    });
    assert_eq!(state, JobState::Completed, "点过重试之后同一页该算出来");
    let artifacts = manager.job_artifacts(&again.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过");
    let relative = artifact
        .cache_relative
        .clone()
        .expect("配了发布根就该发布");
    assert!(
        relative.starts_with(BLOB_PREFIX),
        "发布路径该是内容寻址的：{relative}"
    );

    manager.shutdown();
    assert_eq!(interrupted.len(), 4, "这一跑该打断过 4 次，不然熔断那一段没走到");
    for id in &interrupted {
        assert!(
            !same_process_alive(*id),
            "worker {} 还活着（孤儿进程）",
            id.pid
        );
    }
}
