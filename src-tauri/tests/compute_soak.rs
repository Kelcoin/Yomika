//! §12.4 那笔账：一页页跑下去，计算进程的内存去了哪里、又什么时候回来。
//!
//! 这一条是 **soak**（`#[ignore]`）：每页都要开一次真 ONNX 会话、输入 512×768，跑几十上百页
//! 是分钟级的活，不该塞进每一轮的 18 步三连。它是
//! `.github/scripts/measure-compute-responsiveness.ps1` 的读数来源，也可以单跑：
//!
//! ```text
//! cargo test -p yomika --test compute_soak -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 页数由 `YOMIKA_SOAK_PAGES` 给（缺省 12；32 与 100 是 §12.4 的两个档）。`#[ignore]` 的
//! 理由与 `compute-core` 里那条 DLSSNR soak 一样：**读数要独占一段安静的时间**，别的测试
//! 同时在开模型的话，量出来的是别人的账。
//!
//! 这一条只量**这个进程（宿主）＋ worker 进程**的私有提交。§12.4 ⑤ 要的「host＋worker＋
//! renderer/GPU 进程一起计」在这里做不到：renderer 是 WebView2 的进程，只有真窗口那条路
//! 才点得着（见 `docs/117` 的「真窗口未测」）。所以这里的数字是**下界**，不是总数——
//! 报告里也按这个口径写。

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::Digest;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};
use yomika_lib::compute::manager::{
    no_events, ComputeManager, SourceFile, SubmitRequest, SupervisorConfig, WorkerEngine,
    WorkerStatus,
};
use yomika_lib::compute::models::ModelCatalog;
use yomika_lib::compute::resource_policy::PAGE_PIXEL_LIMIT;
use yomika_lib::compute::scheduler::{JobKey, JobState, Priority};
use yomika_compute_protocol::{EnginePolicy, PipelineStage, RunInput};

/// 真 ONNX 会话 + CPU 超分：第一次开模型要几秒，给足。
const HANDOFF: Duration = Duration::from_secs(120);

/// §12.4 ② 的小规格：512×768。§12.4 ③ 的大页档（5MP/10MP/25MP）要另跑，页数也另给。
const PAGE_WIDTH: u32 = 512;
const PAGE_HEIGHT: u32 = 768;

/// 模型原生倍率。
const SCALE: u32 = 2;

/// 热身页数：头几页里 ORT 的 arena 会长到自己的平台期，之后才谈得上「每页涨没涨」。
const WARMUP_PAGES: u32 = 4;

/// §12.4 ② 自己给的那个数：「预热后…commit 增量 <32 MiB 守卫保留」。这里照抄门槛，不另发明。
/// 它的分辨力取决于页数：一页涨 1 MiB 的慢漏要 32 页以上才顶得穿（所以 soak 的档位是 32/100）。
const GROWTH_LIMIT: u64 = 32 * 1024 * 1024;

/// 随产品一起发出去的那份模型（`resources/models/<id>/`）：它进仓库，所以**不用跳过**。
fn bundled_model(id: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/models")
        .join(id)
        .join("model.onnx");
    std::fs::read(&path)
        .unwrap_or_else(|error| panic!("读随产品发布的模型 {}：{error}", path.display()))
}

/// 这一跑要跑多少页（脚本按档位传，缺省是小规格那一档）。
fn pages_to_run() -> u32 {
    match std::env::var("YOMIKA_SOAK_PAGES") {
        Ok(value) => value
            .parse::<u32>()
            .unwrap_or_else(|_| panic!("YOMIKA_SOAK_PAGES 不是个页数：{value}")),
        Err(_) => 12,
    }
}

/// worker 可执行文件：反推 `target/<profile>`，**每次都先编一遍**（否则拿旧 worker 跑）。
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
            "yomika-soak-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }

    /// 造一份「已安装的模型」：`models/<id>/<version>/` 里一份清单 + 一份 ONNX。
    fn install_model(&self, id: &str, version: &str, bytes: &[u8], min_input_edge: u32) {
        self.install_model_with(id, version, bytes, min_input_edge, &["cpu"]);
    }

    /// 同上，但清单里写的是哪几条运行库。
    ///
    /// 写这一栏是为了让「装了哪份图」和「这份图说自己能在哪跑」对得上：Real-CUGAN 的 CPU
    /// 图与 DirectML 图是**两份字节不同**的文件（DML 那份把负 pad 重写成了 Slice，见
    /// `tests/realcugan_dml_parity.rs` 与 `docs/...-backend-matrix.md`），拿 CPU 那份去问
    /// 显卡，量到的就不是产品那条路。
    fn install_model_with(
        &self,
        id: &str,
        version: &str,
        bytes: &[u8],
        min_input_edge: u32,
        backends: &[&str],
    ) {
        let install = self.root.join("models").join(id).join(version);
        std::fs::create_dir_all(&install).expect("建模型安装目录");
        std::fs::write(install.join("model.onnx"), bytes).expect("写模型");
        let manifest = serde_json::json!({
            "id": id,
            "version": version,
            "format": "onnx",
            "scale": SCALE,
            "maxPixels": 64_000_000u64,
            "sha256": format!("{:x}", sha2::Sha256::digest(bytes)),
            "supportedBackends": backends,
            "minInputEdge": min_input_edge,
        });
        std::fs::write(
            install.join("yomika-model.json"),
            serde_json::to_vec_pretty(&manifest).expect("清单能序列化"),
        )
        .expect("写清单");
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
    // 闲置收摊不插手：soak 要量的是「一页页跑下去」，不是 120 秒后换一代进程。
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    config.models = Some(ModelCatalog::new(&sandbox.root));
    config.worker_engine = WorkerEngine::Onnx;
    config
}

/// 这一跑用多大的分块（§12.4 的 tile 那一栏）。
///
/// 产品路径上 `stage.tile` **一直是 `None`**（宿主每一处构造都写 `None`，worker 于是用核心的
/// `DEFAULT_TILE_SIZE`）。所以这里给的是一个**只在这条仪器上存在**的旋钮：它的用处是量出
/// 「换个块大小，峰值提交与每页耗时会不会动」，好回答「那个 128 是不是拍出来的数」。
/// 量完不写回产品——要改产品那几个字面量，得有比一条环境变量更硬的证据。
fn soak_tile() -> Option<u32> {
    match std::env::var("YOMIKA_SOAK_TILE") {
        Ok(value) => Some(
            value
                .parse::<u32>()
                .unwrap_or_else(|_| panic!("YOMIKA_SOAK_TILE 不是个块大小：{value}")),
        ),
        Err(_) => None,
    }
}

/// 一份提交：输入声明是假的（哈希全 0、长度 1024），真值由宿主在派发前从源文件算出来。
fn request(model_id: &str, source: &Path, settings_id: &str) -> SubmitRequest {
    request_with_policy(model_id, source, settings_id, EnginePolicy::Cpu)
}

/// 同上，但点名要哪条引擎政策。
///
/// 分开一个函数是为了让「这一跑问的是谁」在调用点就看得见：CPU 那两条 soak 写 `Cpu`，显卡
/// 那条写 `Gpu`——**政策是请求里的一栏**，不是 worker 自己猜的。点名 `Gpu` 之后只有两种结局
/// （真用上显卡，或者失败），所以「报回来的是 gpu」本身就是一个能钉住的事实。
fn request_with_policy(
    model_id: &str,
    source: &Path,
    settings_id: &str,
    policy: EnginePolicy,
) -> SubmitRequest {
    SubmitRequest {
        key: JobKey {
            input_id: "book#soak".to_string(),
            settings_id: settings_id.to_string(),
            source_revision: "rev-soak".to_string(),
            backend: "cpu".to_string(),
            generation: 1,
        },
        priority: Priority::Foreground,
        input: RunInput {
            input_id: "page-0".to_string(),
            content_hash: "0".repeat(64),
            byte_length: 1024,
            relative_path: None,
        },
        pipeline: vec![PipelineStage {
            accelerator: None,
            stage_id: "stage-a".to_string(),
            model_spec_id: model_id.to_string(),
            model: None,
            dlssnr: None,
            builtin: None,
            min_input_edge: None,
            output_scale: None,
            engine_policy: policy,
            scale: Some(SCALE),
            tile: soak_tile(),
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-soak".to_string(),
        deadline_ms: 0,
        source: Some({
            let (byte_length, content_hash) =
                yomika_lib::compute::artifacts::hash_file(source).expect("源文件该读得出来");
            SourceFile {
                path: source.to_path_buf(),
                content_hash,
                byte_length,
            }
        }),
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

fn terminal_of(manager: &ComputeManager, job_id: &str) -> Option<JobState> {
    manager
        .job(job_id)
        .map(|snapshot| snapshot.state)
        .filter(|state| state.is_terminal())
}

/// 一张 512×768 的棋盘格：硬边 + 大色差（模型的活是真的，不是空跑一个恒等映射）。
fn make_page(path: &Path) {
    let mut image = image::RgbaImage::new(PAGE_WIDTH, PAGE_HEIGHT);
    for y in 0..PAGE_HEIGHT {
        for x in 0..PAGE_WIDTH {
            let light = ((x / 8) + (y / 8)) % 2 == 0;
            let pixel = if light {
                image::Rgba([255, 32, 32, 255])
            } else {
                image::Rgba([16, 200, 240, 255])
            };
            image.put_pixel(x, y, pixel);
        }
    }
    image.save(path).expect("写一张测试页");
}

/// 某个进程此刻的（私有提交，历史峰值提交）。
///
/// `PeakPagefileUsage` 是**进程活到现在**的峰值，所以一页页读下来就是「每页的 peak」。
/// 量不到（进程已退出、权限不够）返回 `None`——「不知道」不是 0。
fn private_commit(pid: u32) -> Option<(u64, u64)> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            false,
            pid,
        )
        .ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
        let queried = GetProcessMemoryInfo(
            handle,
            &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        );
        let _ = CloseHandle(handle);
        queried.ok()?;
        Some((
            counters.PrivateUsage as u64,
            counters.PeakPagefileUsage as u64,
        ))
    }
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// 最近秩（nearest-rank）分位：样本只有几十个，插值会把「量到的最坏那一次」抹平。
/// 报的时候要连着样本数一起报——16 个样本里的 p99 就是最大值，不是「99 分位」。
fn percentile(values: &[u128], percent: u32) -> u128 {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let rank = ((percent as usize * sorted.len()).div_ceil(100)).max(1);
    sorted[rank - 1]
}

/// `docs/models/` 里那份本地夹具：**不进仓库**，缺了就跳过（与 `compute_model_chain.rs`
/// 对本地 Real-CUGAN 的处理同一口径——夹具不在不是产品坏了）。
fn local_model(name: &str) -> Option<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("docs")
        .join("models")
        .join(name);
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            eprintln!("跳过：读不到 {}（{error}）", path.display());
            None
        }
    }
}

/// 适配器（显卡）自己的显存读数，DXGI 本地段。
///
/// 它是**整张卡**的数，不是这个进程的数：本机上浏览器等进程也在吃显存，而
/// `\GPU Process Memory(*)\Dedicated Usage` 这个计数器集在这台机器上是空的（Task 0 记过），
/// per-process 显存量不到。所以这一栏只能连着「这一段 soak 的起止」一起读，读的是
/// **这段活把整卡的已用显存抬了多少**，不是这一件任务独占了多少。
struct AdapterMemory {
    used: u64,
    budget: u64,
}

fn adapter_memory() -> Option<AdapterMemory> {
    let memory = yomika_compute_core::dlssnr::gpu::video_memory()?;
    Some(AdapterMemory {
        used: memory.used_bytes,
        budget: memory.budget_bytes,
    })
}

/// 显卡档一页的读数：三个进程/设备的字节都要，因为 §12.4 ⑤ 要的是「一起计」。
struct GpuReading {
    page: u32,
    worker_commit: u64,
    worker_peak: u64,
    host_commit: u64,
    adapter_used: Option<u64>,
    adapter_budget: Option<u64>,
    elapsed: Duration,
}

/// 一页的读数。
struct PageReading {
    page: u32,
    worker_commit: u64,
    worker_peak: u64,
    host_commit: u64,
    elapsed: Duration,
}

/// 这一条真跑：装模型 → 热身 → 一页页跑 → 记每页峰 → 交回 → 收摊。
///
/// 断言分两段：**结构**那一段（每页都得 Completed、staging 收干净、worker 真的退出）当场就
/// 钉得住；**字节**那一段（涨没涨、交回掉不掉）的口径来自这一跑量出来的数字，写在这条测试
/// 的判据里，不是照抄别人的门槛。
#[test]
#[ignore = "soak：分钟级、要独占真 GPU/ONNX 一段时间，由 .github/scripts/measure-compute-responsiveness.ps1 单跑"]
fn a_page_soak_shows_where_the_compute_process_memory_goes() {
    let pages = pages_to_run();
    assert!(
        pages > WARMUP_PAGES,
        "页数要比重热身页多，否则没有可看的区间：{pages} <= {WARMUP_PAGES}"
    );

    let sandbox = Sandbox::new("pages");
    let model = "waifu2x-upconv7";
    sandbox.install_model(model, "1", &bundled_model(model), 1);
    let page = sandbox.root.join("soak-page.png");
    make_page(&page);
    let page_bytes = std::fs::metadata(&page).expect("刚写的页").len();

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    // 还没提交过任何东西时**没有** worker（`Stopped` 不是「坏了」），所以进程号要在第一页
    // 跑起来之后再问——`Ready` 那一支才带着 `peer_pid`。
    assert_eq!(
        manager.worker_status(),
        WorkerStatus::Stopped,
        "一件任务都没有的时候不该有 worker"
    );
    let mut pid: Option<u32> = None;

    let mut rows: Vec<PageReading> = Vec::new();
    for index in 1..=pages {
        let started = Instant::now();
        let settings = format!("settings-{index}");
        let submitted = manager
            .submit(request(model, &page, &settings))
            .unwrap_or_else(|error| panic!("宿主该收下第 {index} 页：{error:?}"));
        let state = wait_until(&format!("第 {index} 页跑完"), HANDOFF, || {
            terminal_of(&manager, &submitted.job_id)
        });
        assert_eq!(state, JobState::Completed, "第 {index} 页该成功");
        let artifacts = manager.job_artifacts(&submitted.job_id);
        assert_eq!(
            artifacts.first().map(|record| record.engine_id.as_str()),
            Some("onnx"),
            "第 {index} 页必须真跑过模型：{artifacts:?}"
        );
        let pid = match (pid, manager.worker_status()) {
            (Some(known), _) => known,
            (None, WorkerStatus::Ready { peer_pid, .. }) => {
                pid = Some(peer_pid);
                peer_pid
            }
            (None, other) => panic!("第 {index} 页跑完了，worker 该是 Ready：{other:?}"),
        };
        let (worker_commit, worker_peak) =
            private_commit(pid).expect("worker 该还活着，量得到私有提交");
        let host_commit = private_commit(std::process::id())
            .expect("自己有进程")
            .0;
        rows.push(PageReading {
            page: index,
            worker_commit,
            worker_peak,
            host_commit,
            elapsed: started.elapsed(),
        });
    }
    let pid = pid.expect("跑过页就该有 worker 进程号");

    eprintln!(
        "soak：{pages} 页 {PAGE_WIDTH}×{PAGE_HEIGHT}（源图 {page_bytes} 字节，热身 {WARMUP_PAGES} 页，分块 {}）",
        match soak_tile() {
            Some(tile) => format!("{tile}（这次跑指定的）"),
            None => "核心缺省 128（产品路径就是这一档）".to_string(),
        }
    );
    eprintln!("页\tworker 提交 MiB\tworker 峰值 MiB\t宿主提交 MiB\t本页耗时 ms");
    for row in &rows {
        eprintln!(
            "{}\t{:.1}\t{:.1}\t{:.1}\t{}",
            row.page,
            mib(row.worker_commit),
            mib(row.worker_peak),
            mib(row.host_commit),
            row.elapsed.as_millis()
        );
    }

    let warm = &rows[WARMUP_PAGES as usize - 1];
    let after = &rows[rows.len() - 1];
    // 两个观察量都要看：**当前**提交会随分配器的脾气上下跳，**峰值**是单调的——真漏了的话
    // 峰值一定一页页往上爬，而当前值可能因为一次恰好发生的释放看不出来。
    let worst = rows[WARMUP_PAGES as usize..]
        .iter()
        .map(|row| row.worker_commit)
        .max()
        .expect("热身之后还有页");
    let growth = worst.saturating_sub(warm.worker_commit);
    let peak_growth = after.worker_peak.saturating_sub(warm.worker_peak);
    eprintln!(
        "热身之后：worker 提交 {:.1} MiB，最坏一页 {:.1} MiB（涨 {:.1} MiB），峰值 {:.1} MiB（涨 {:.1} MiB）",
        mib(warm.worker_commit),
        mib(worst),
        mib(growth),
        mib(after.worker_peak),
        mib(peak_growth)
    );
    // §12.4 ②：预热之后不许再涨出 32 MiB。两跑实测 0.0 与 1.6 MiB，还有二十倍余量。
    assert!(
        growth < GROWTH_LIMIT,
        "预热之后每页还在涨：最坏一页比平台高 {:.1} MiB（门槛 {:.1} MiB）",
        mib(growth),
        mib(GROWTH_LIMIT)
    );
    assert!(
        peak_growth < GROWTH_LIMIT,
        "峰值提交在涨（这个量是单调的，涨了就是真漏）：{:.1} MiB（门槛 {:.1} MiB）",
        mib(peak_growth),
        mib(GROWTH_LIMIT)
    );
    // 延迟分位：这一档量的不是 UI 手感（那是 §12.3，要真窗口），是**一页的端到端**
    // （提交 → 终态）在这台机器上多久。样本只有几十个，报分位必须连着样本数。
    let elapsed: Vec<u128> = rows.iter().map(|row| row.elapsed.as_millis()).collect();
    let p50 = percentile(&elapsed, 50) as u64;
    let p95 = percentile(&elapsed, 95) as u64;
    let p99 = percentile(&elapsed, 99) as u64;
    eprintln!(
        "每页端到端（提交→终态）：p50 {p50} ms，p95 {p95} ms，p99 {p99} ms（{} 个样本）",
        elapsed.len()
    );

    // 交回：那件 ONNX 会话（权重挂在上面）该被放掉。字节掉多少是 ORT arena 的脾气，
    // 所以这里把交回前后的数都记下来，判据按这一跑量到的口径写。
    //
    // 走**两遍**「交回 → 再跑一页 → 交回」：一遍只能证明「这一刻恰好低了一点」，
    // 两遍才说明回落是跟着「缓存里有没有那件会话」来的，而不是某次分配的巧合。
    let before_handback = private_commit(pid).expect("交回前 worker 还在").0;
    let handed_back = manager.release_idle();
    let after_handback = private_commit(pid).expect("交回后 worker 还在").0;
    eprintln!(
        "交回：报了 {handed_back} 份，worker 提交 {:.1} MiB → {:.1} MiB（掉 {:.1} MiB）",
        mib(before_handback),
        mib(after_handback),
        mib(before_handback.saturating_sub(after_handback))
    );

    // 结构那一段：交回不是收摊，交回之后这一代 worker 还得能干活。
    match manager.worker_status() {
        WorkerStatus::Ready { peer_pid, .. } => assert_eq!(peer_pid, pid, "交回不该换进程"),
        other => panic!("交回不该把这一代 worker 弄没：{other:?}"),
    }
    let after_page = sandbox.root.join("after-handback.png");
    make_page(&after_page);
    let resubmitted = manager
        .submit(request(model, &after_page, "settings-after-handback"))
        .expect("交回之后宿主还该收下任务");
    let state = wait_until("交回之后再跑一页", HANDOFF, || {
        terminal_of(&manager, &resubmitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "交回模型只该让它重新加载一次");
    let reloaded = private_commit(pid).expect("再跑一页之后 worker 还在").0;
    eprintln!(
        "交回之后再跑一页：worker 提交回到 {:.1} MiB",
        mib(reloaded)
    );
    let handed_again = manager.release_idle();
    let after_again = private_commit(pid).expect("第二次交回后 worker 还在").0;
    eprintln!(
        "第二次交回：报了 {handed_again} 份，{:.1} MiB → {:.1} MiB（掉 {:.1} MiB）",
        mib(reloaded),
        mib(after_again),
        mib(reloaded.saturating_sub(after_again))
    );
    // 交回的判据是「份数」与「两次都在」，**不是**字节幅度：在这个尺寸的模型上，私有提交
    // 的页间振荡（±1.5 MiB）足以把「放掉一件 2.2 MiB 权重的会话」淹掉——实测的 0.1 与 3.1 MiB
    // 就是被淹过的那种数。字节如实报出来（下面 JSON 里），不拿它当门槛。
    assert!(
        handed_back >= 1,
        "跑过模型之后第一次交回该交出东西：报了 {handed_back} 份"
    );
    assert!(
        handed_again >= 1,
        "再跑一页之后第二次交回也该交出东西：报了 {handed_again} 份"
    );

    // 收摊：进程真的走掉，它那份私有提交才真的归零。
    manager.shutdown();
    let gone = wait_until("worker 进程退出", Duration::from_secs(10), || {
        private_commit(pid).is_none().then_some(())
    });
    let _ = gone;
    eprintln!("收摊：pid {pid} 已经不在了，它的私有提交按定义归零");

    // 给 `measure-compute-responsiveness.ps1` 读的那一行：人看的是上面的表，脚本读这一行。
    // 数字只在这里出现一次，两边不许各算一遍（两处算同一件事，早晚会不一致）。
    let report = serde_json::json!({
        "test": "a_page_soak_shows_where_the_compute_process_memory_goes",
        "pages": pages,
        "warmup": WARMUP_PAGES,
        "page": { "width": PAGE_WIDTH, "height": PAGE_HEIGHT, "sourceBytes": page_bytes },
        "tile": soak_tile(),
        "tileNote": "产品路径上 stage.tile 一直是 None，worker 于是用核心的 DEFAULT_TILE_SIZE=128；这个字段只在仪器上被指定时才有值",
        "rows": rows.iter().map(|row| serde_json::json!({
            "page": row.page,
            "workerCommitMib": (mib(row.worker_commit) * 10.0).round() / 10.0,
            "workerPeakMib": (mib(row.worker_peak) * 10.0).round() / 10.0,
            "hostCommitMib": (mib(row.host_commit) * 10.0).round() / 10.0,
            "elapsedMs": row.elapsed.as_millis() as u64,
        })).collect::<Vec<_>>(),
        "warmCommitMib": (mib(warm.worker_commit) * 10.0).round() / 10.0,
        "finalCommitMib": (mib(after.worker_commit) * 10.0).round() / 10.0,
        "growthMib": (mib(growth) * 10.0).round() / 10.0,
        "peakMib": (mib(after.worker_peak) * 10.0).round() / 10.0,
        "peakGrowthMib": (mib(peak_growth) * 10.0).round() / 10.0,
        "latencyMs": {
            "samples": elapsed.len(),
            "p50": p50,
            "p95": p95,
            "p99": p99,
            "note": "每页端到端（提交→终态），不是 §12.3 的输入到呈现",
        },
        "handback": {
            "count": handed_back,
            "beforeMib": (mib(before_handback) * 10.0).round() / 10.0,
            "afterMib": (mib(after_handback) * 10.0).round() / 10.0,
            "droppedMib": (mib(before_handback.saturating_sub(after_handback)) * 10.0).round() / 10.0,
            "reloadedMib": (mib(reloaded) * 10.0).round() / 10.0,
            "secondCount": handed_again,
            "secondAfterMib": (mib(after_again) * 10.0).round() / 10.0,
            "secondDroppedMib": (mib(reloaded.saturating_sub(after_again)) * 10.0).round() / 10.0,
        },
        "workerPid": pid,
        "workerGoneAfterShutdown": true,
    });
    eprintln!(
        "SOAK_JSON {}",
        serde_json::to_string(&report).expect("读数能序列化")
    );
}

/// §12.4 ③ 的三档：5 MP → 10 MP → 25 MP（按 512×768 那个比例放大，像素数是量出来的）。
const LARGE_TIERS: [(u32, u32); 3] = [(2_500, 2_000), (3_650, 2_740), (6_100, 4_100)];

/// 大页档里被预算门挡住的那一档要跑多少页（缺省 100，§12.4 ③ 的原话）。
///
/// 这一档**不真算**：worker 在超分那一步先按 `max_pixels / scale²` 算源图上限（scale=2 时
/// 是 16.7 MP），超了就直接回 `COMPUTE_RESOURCE_LIMIT`，一页只花几十毫秒。真正的成本在
/// 下面那两个「真算」的档上。
fn large_pages_to_run() -> u32 {
    match std::env::var("YOMIKA_SOAK_LARGE_PAGES") {
        Ok(value) => value
            .parse::<u32>()
            .unwrap_or_else(|_| panic!("YOMIKA_SOAK_LARGE_PAGES 不是个页数：{value}")),
        Err(_) => 100,
    }
}

/// 5 MP 与 10 MP 这两档**每档**真算几页（缺省 3）。
///
/// 「（设备预算许可的部分）」在这里落地：这两档预算许可，可 CPU 上跑一页 5 MP 是几十秒、
/// 10 MP 是分钟级，100 页要几个小时——所以真算的那部分按这个数给，被门挡住的那一档照原话
/// 跑满 100 页。跑了几页、哪一档没跑满，报告里如实写。
fn large_real_pages() -> u32 {
    match std::env::var("YOMIKA_SOAK_LARGE_REAL") {
        Ok(value) => value
            .parse::<u32>()
            .unwrap_or_else(|_| panic!("YOMIKA_SOAK_LARGE_REAL 不是个页数：{value}")),
        Err(_) => 3,
    }
}

/// 一档大页。用**纯色**而不是棋盘格：6100×4100 的棋盘格 PNG 编出来几十兆，纯色只有几十 KB，
/// 而这一档要看的是像素数带来的算力与内存，不是压缩率。
fn make_large_page(path: &Path, width: u32, height: u32) {
    let image = image::GrayImage::from_pixel(width, height, image::Luma([0x40]));
    image.save(path).expect("写一张大页");
}

/// 大页档的一行读数。`verdict` 是这一页的结论（`Completed` 或预算门回的那个码）。
struct LargeReading {
    page: u32,
    width: u32,
    height: u32,
    verdict: String,
    /// 热身页。**按档分开比**：10 MP 那档本来就比 5 MP 占得多，拿两档横着比会得出假的红。
    warmup: bool,
    worker_commit: u64,
    worker_peak: u64,
    elapsed: Duration,
}

/// Repeated real inference at 5, 10 and 25 MP, with independent warmup and
/// bounded commit growth per tier. The relaxed budget permits all three tiers.
#[test]
#[ignore = "大页 soak：分钟级，由 .github/scripts/measure-compute-responsiveness.ps1 -LargePages 单跑"]
fn a_hundred_large_pages_complete_without_taking_the_process_down() {
    let refused_pages = large_pages_to_run();
    let real_pages = large_real_pages();
    let allowed_source = PAGE_PIXEL_LIMIT / u64::from(SCALE).pow(2);
    let pixels = |(width, height): (u32, u32)| u64::from(width) * u64::from(height);

    let sandbox = Sandbox::new("large");
    let model = "waifu2x-upconv7";
    sandbox.install_model(model, "1", &bundled_model(model), 1);
    let mut pages: Vec<(PathBuf, (u32, u32))> = Vec::new();
    for tier in LARGE_TIERS {
        let path = sandbox.root.join(format!("large-{}x{}.png", tier.0, tier.1));
        make_large_page(&path, tier.0, tier.1);
        pages.push((path, tier));
    }

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let mut pid: Option<u32> = None;
    let mut rows: Vec<LargeReading> = Vec::new();
    let mut computed = 0u32;

    // 真算的那两档：跑之前先热身几页（同一个尺寸上连跑，让 ORT 的 arena 到平台期）。
    let run_tier = |index: usize,
                        count: u32,
                        warmup: bool,
                        manager: &ComputeManager,
                        pid: &mut Option<u32>,
                        rows: &mut Vec<LargeReading>,
                        computed: &mut u32| {
        let (path, tier) = &pages[index];
        for round in 0..count {
            let started = Instant::now();
            let settings = format!("large-{}-{round}", tier.0);
            let submitted = manager
                .submit(request(model, path, &settings))
                .unwrap_or_else(|error| panic!("宿主该收下这一页：{error:?}"));
            let state = wait_until(&format!("{}×{} 第 {round} 页", tier.0, tier.1), HANDOFF, || {
                terminal_of(&manager, &submitted.job_id)
            });
            assert_eq!(
                state,
                JobState::Completed,
                "{}×{}（{} 像素）在预算之内，应该算得出来",
                tier.0,
                tier.1,
                pixels(*tier)
            );
            let artifacts = manager.job_artifacts(&submitted.job_id);
            assert_eq!(
                artifacts.first().map(|record| record.engine_id.as_str()),
                Some("onnx"),
                "这一页必须真跑过模型：{artifacts:?}"
            );
            let known = match (*pid, manager.worker_status()) {
                (Some(known), _) => known,
                (None, WorkerStatus::Ready { peer_pid, .. }) => {
                    *pid = Some(peer_pid);
                    peer_pid
                }
                (None, other) => panic!("跑完一页之后 worker 该是 Ready：{other:?}"),
            };
            let (commit, peak) = private_commit(known).expect("worker 该还活着");
            *computed += 1;
            rows.push(LargeReading {
                page: rows.len() as u32 + 1,
                width: tier.0,
                height: tier.1,
                verdict: "Completed".to_string(),
                warmup,
                worker_commit: commit,
                worker_peak: peak,
                elapsed: started.elapsed(),
            });
        }
    };

    // 5 MP 与 10 MP：**一档一档连着跑**（各自先热一页，再真算 `real_pages` 页），不穿插。
    // 第一次跑是穿插的（0 热、1 热、0 真、1 真），红在 5 MP 那一档的峰值上：峰值是**进程级
    // 单调量**，10 MP 那一页一走，进程峰值就从 193.9 抬到 373.1 MiB，于是「5 MP 的峰值涨了
    // 179 MiB」——涨的是大档自己的账。档与档之间只能比自己那一档的热身页。
    run_tier(0, 1, true, &manager, &mut pid, &mut rows, &mut computed);
    run_tier(0, real_pages, false, &manager, &mut pid, &mut rows, &mut computed);
    run_tier(1, 1, true, &manager, &mut pid, &mut rows, &mut computed);
    run_tier(1, real_pages, false, &manager, &mut pid, &mut rows, &mut computed);

    // 25 MP at x2 now fits the 128 MP delivery budget. Exercise repeated
    // real inference and verify the same worker survives the complete tier.
    run_tier(2, 1, true, &manager, &mut pid, &mut rows, &mut computed);
    run_tier(2, refused_pages, false, &manager, &mut pid, &mut rows, &mut computed);
    let known = pid.expect("worker started");
    let refused = 0u32;

    eprintln!("页\t尺寸\t结论\tworker 提交 MiB\tworker 峰值 MiB\t本页耗时 ms");
    for row in &rows {
        eprintln!(
            "{}\t{}×{}\t{}{}\t{:.1}\t{:.1}\t{}",
            row.page,
            row.width,
            row.height,
            row.verdict,
            if row.warmup { "（热身）" } else { "" },
            mib(row.worker_commit),
            mib(row.worker_peak),
            row.elapsed.as_millis()
        );
    }

    // 真算那两档各自的峰值与增量。**按尺寸分组**：10 MP 那档本来就比 5 MP 占得多，
    // 混在一起比会得出一个假的红。
    let mut per_tier: Vec<(u32, u32, u64, u64, u64, u64)> = Vec::new();
    for tier in LARGE_TIERS {
        let group: Vec<&LargeReading> = rows
            .iter()
            .filter(|row| row.verdict == "Completed" && row.width == tier.0 && row.height == tier.1)
            .collect();
        let base = group.first().expect("每一档都热过身");
        assert!(
            base.warmup,
            "{}×{} 的第一页该是这一档的热身页（档与档连着跑，比的就是它）",
            tier.0,
            tier.1
        );
        let worst = group
            .iter()
            .map(|row| row.worker_commit)
            .max()
            .expect("有页");
        let peak_worst = group
            .iter()
            .map(|row| row.worker_peak)
            .max()
            .expect("有页");
        let growth = worst.saturating_sub(base.worker_commit);
        let peak_growth = peak_worst.saturating_sub(base.worker_peak);
        eprintln!(
            "{}×{}（{} 页）：热身那一页 {:.1} MiB，最坏 {:.1} MiB（涨 {:.1} MiB），峰值 {:.1} MiB（涨 {:.1} MiB）",
            tier.0,
            tier.1,
            group.len(),
            mib(base.worker_commit),
            mib(worst),
            mib(growth),
            mib(peak_worst),
            mib(peak_growth)
        );
        assert!(
            growth < GROWTH_LIMIT,
            "{}×{} 这一档还在涨：最坏一页比热身那页高 {:.1} MiB（门槛 {:.1} MiB）",
            tier.0,
            tier.1,
            mib(growth),
            mib(GROWTH_LIMIT)
        );
        assert!(
            peak_growth < GROWTH_LIMIT,
            "{}×{} 这一档的峰值提交在涨：{:.1} MiB（门槛 {:.1} MiB）",
            tier.0,
            tier.1,
            mib(peak_growth),
            mib(GROWTH_LIMIT)
        );
        per_tier.push((tier.0, tier.1, growth, peak_growth, base.worker_commit, peak_worst));
    }

    manager.shutdown();
    wait_until("大页 soak 的 worker 退出", Duration::from_secs(10), || {
        private_commit(known).is_none().then_some(())
    });

    let report = serde_json::json!({
        "test": "a_hundred_large_pages_complete_without_taking_the_process_down",
        "tiers": LARGE_TIERS.iter().map(|tier| serde_json::json!({
            "width": tier.0,
            "height": tier.1,
            "pixels": pixels(*tier),
            "allowed": pixels(*tier) <= allowed_source,
        })).collect::<Vec<_>>(),
        "allowedSourcePixels": allowed_source,
        "realPages": real_pages,
        "refusedPages": refused,
        "computedPages": computed,
        "rows": rows.iter().map(|row| serde_json::json!({
            "page": row.page,
            "width": row.width,
            "height": row.height,
            "verdict": row.verdict,
            "warmup": row.warmup,
            "workerCommitMib": (mib(row.worker_commit) * 10.0).round() / 10.0,
            "workerPeakMib": (mib(row.worker_peak) * 10.0).round() / 10.0,
            "elapsedMs": row.elapsed.as_millis() as u64,
        })).collect::<Vec<_>>(),
        "perTier": per_tier.iter().map(|(width, height, growth, peak_growth, base, peak_worst)| serde_json::json!({
            "width": width,
            "height": height,
            "warmCommitMib": (mib(*base) * 10.0).round() / 10.0,
            "growthMib": (mib(*growth) * 10.0).round() / 10.0,
            "peakMib": (mib(*peak_worst) * 10.0).round() / 10.0,
            "peakGrowthMib": (mib(*peak_growth) * 10.0).round() / 10.0,
        })).collect::<Vec<_>>(),
        "growthLimitMib": (mib(GROWTH_LIMIT) * 10.0).round() / 10.0,
        "layers": {
            "measured": false,
            "why": "协议里的 layers 没有代码读；§12.4 的 1/3/5 层对应 DLSSNR 的 settings.passes，只有真 NGX + GPU 那条路跑得到",
        },
        "workerPid": known,
        "workerGoneAfterShutdown": true,
    });
    eprintln!(
        "SOAK_JSON {}",
        serde_json::to_string(&report).expect("读数能序列化")
    );
}

/// §12.4 ③⑤ 的真 GPU 档：同一张页、同一套仪器，改问显卡（DirectML）。
///
/// 与上面那条 CPU soak **分开两条、分开读数**，理由与大页档一样：混在一起的读数什么都
/// 说明不了。这一条的判据分两段——「这活真是显卡干的」（政策是 `gpu`、没有回退）是**结构性**
/// 的，当场钉得住；显存的字节是**报**出来的，不写死门槛（DXGI 那一栏是整张卡的数，浏览器
/// 之类的邻居会把 delta 抬起来，钉死它等于给自己养一条假红）。
#[test]
#[ignore = "真 GPU 档：要独占一张显卡一段时间，由 .github/scripts/measure-compute-responsiveness.ps1 -GpuSoak 单跑"]
fn a_directml_page_soak_runs_on_the_gpu_and_keeps_its_vram_bounded() {
    let pages = pages_to_run();
    assert!(
        pages > WARMUP_PAGES,
        "页数要比重热身页多，否则没有可看的区间：{pages} <= {WARMUP_PAGES}"
    );

    let Some(bytes) = local_model("realcugan-2x-conservative-dml1.onnx") else {
        return;
    };
    let model = "realcugan-2x-conservative-dml1";
    let sandbox = Sandbox::new("gpu");
    // 清单里写 directml 在前：显卡那份图与 CPU 那份是**两份字节不同**的文件，拿错一份
    // 量到的就不是产品那条路。
    sandbox.install_model_with(model, "1", &bytes, 1, &["directml", "cpu"]);
    let page = sandbox.root.join("gpu-page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let adapter_before = adapter_memory();
    let mut pid: Option<u32> = None;
    let mut rows: Vec<GpuReading> = Vec::new();

    for index in 1..=pages {
        let started = Instant::now();
        let settings = format!("settings-gpu-{index}");
        let submitted = manager
            .submit(request_with_policy(model, &page, &settings, EnginePolicy::Gpu))
            .unwrap_or_else(|error| panic!("宿主该收下第 {index} 页：{error:?}"));
        let state = wait_until(&format!("第 {index} 页跑完"), HANDOFF, || {
            terminal_of(&manager, &submitted.job_id)
        });
        assert_eq!(state, JobState::Completed, "第 {index} 页该成功");
        let artifacts = manager.job_artifacts(&submitted.job_id);
        let record = artifacts.first().expect("跑完就该有产物");
        assert_eq!(
            record.engine_id, "onnx",
            "第 {index} 页必须真跑过模型：{record:?}"
        );
        assert_eq!(
            record.engine_policy.as_deref(),
            Some("gpu"),
            "第 {index} 页该是显卡干的活（政策报成了 cpu 就说明这一跑问的根本不是显卡）：{record:?}"
        );
        assert!(
            record.engine_fallback.is_none(),
            "点名要显卡之后不该悄悄退回去：{:?}",
            record.engine_fallback
        );
        let pid = match (pid, manager.worker_status()) {
            (Some(known), _) => known,
            (None, WorkerStatus::Ready { peer_pid, .. }) => {
                pid = Some(peer_pid);
                peer_pid
            }
            (None, other) => panic!("第 {index} 页跑完了，worker 该是 Ready：{other:?}"),
        };
        let (worker_commit, worker_peak) =
            private_commit(pid).expect("worker 该还活着，量得到私有提交");
        let host_commit = private_commit(std::process::id()).expect("自己有进程").0;
        let adapter = adapter_memory();
        rows.push(GpuReading {
            page: index,
            worker_commit,
            worker_peak,
            host_commit,
            adapter_used: adapter.as_ref().map(|memory| memory.used),
            adapter_budget: adapter.as_ref().map(|memory| memory.budget),
            elapsed: started.elapsed(),
        });
    }
    let pid = pid.expect("跑过页就该有 worker 进程号");
    let adapter_after = adapter_memory();

    eprintln!("真 GPU 档（DirectML）：{pages} 页 {PAGE_WIDTH}×{PAGE_HEIGHT}，热身 {WARMUP_PAGES} 页");
    eprintln!("页\tworker 提交 MiB\tworker 峰值 MiB\t宿主提交 MiB\t整卡已用 MiB\t本页耗时 ms");
    for row in &rows {
        eprintln!(
            "{}\t{:.1}\t{:.1}\t{:.1}\t{}\t{}",
            row.page,
            mib(row.worker_commit),
            mib(row.worker_peak),
            mib(row.host_commit),
            match row.adapter_used {
                Some(used) => format!("{:.1}", mib(used)),
                None => "量不到".to_string(),
            },
            row.elapsed.as_millis()
        );
    }

    let warm = &rows[WARMUP_PAGES as usize - 1];
    let after = rows.last().expect("跑过页就有读数");
    let worst = rows[WARMUP_PAGES as usize..]
        .iter()
        .map(|row| row.worker_commit)
        .max()
        .expect("热身之后还有页");
    let growth = worst.saturating_sub(warm.worker_commit);
    let peak_growth = after.worker_peak.saturating_sub(warm.worker_peak);
    eprintln!(
        "热身之后：worker 提交 {:.1} MiB，最坏一页 {:.1} MiB（涨 {:.1} MiB），峰值 {:.1} MiB（涨 {:.1} MiB）",
        mib(warm.worker_commit),
        mib(worst),
        mib(growth),
        mib(after.worker_peak),
        mib(peak_growth)
    );
    // §12.4 ⑤：三个数**一起**报。renderer 那一份在集成测试里点不着（那是 WebView2 的进程，
    // 只有真窗口那条路才有），所以这里的总数是下界——报告里按这个口径写，不假装它是总数。
    eprintln!(
        "总内存（§12.4 ⑤ 的口径）：宿主 {:.1} MiB ＋ worker {:.1} MiB ＋ 整卡已用 {}（预算 {}）；renderer 那一份量不到（要真窗口）",
        mib(after.host_commit),
        mib(after.worker_commit),
        match adapter_after.as_ref().map(|memory| memory.used) {
            Some(used) => format!("{:.1} MiB", mib(used)),
            None => "量不到".to_string(),
        },
        match adapter_after.as_ref().map(|memory| memory.budget) {
            Some(budget) => format!("{:.1} MiB", mib(budget)),
            None => "量不到".to_string(),
        }
    );
    assert!(
        growth < GROWTH_LIMIT,
        "显卡档预热之后每页还在涨：最坏一页比平台高 {:.1} MiB（门槛 {:.1} MiB）",
        mib(growth),
        mib(GROWTH_LIMIT)
    );
    assert!(
        peak_growth < GROWTH_LIMIT,
        "显卡档的峰值提交在涨（这个量是单调的）：{:.1} MiB（门槛 {:.1} MiB）",
        mib(peak_growth),
        mib(GROWTH_LIMIT)
    );
    let elapsed: Vec<u128> = rows.iter().map(|row| row.elapsed.as_millis()).collect();
    let p50 = percentile(&elapsed, 50) as u64;
    let p95 = percentile(&elapsed, 95) as u64;
    let p99 = percentile(&elapsed, 99) as u64;
    eprintln!(
        "每页端到端（提交→终态）：p50 {p50} ms，p95 {p95} ms，p99 {p99} ms（{} 个样本）",
        elapsed.len()
    );

    manager.shutdown();
    wait_until("显卡档的 worker 退出", Duration::from_secs(10), || {
        private_commit(pid).is_none().then_some(())
    });

    let adapter_delta = match (adapter_before.as_ref(), adapter_after.as_ref()) {
        (Some(before), Some(after)) => Some(after.used as i64 - before.used as i64),
        _ => None,
    };
    match adapter_delta {
        Some(delta) => eprintln!(
            "整卡已用显存：开工前 {:.1} MiB → 收摊后 {:.1} MiB（差 {delta} 字节）",
            mib(adapter_before.as_ref().map(|memory| memory.used).unwrap_or(0)),
            mib(adapter_after.as_ref().map(|memory| memory.used).unwrap_or(0)),
        ),
        None => eprintln!("整卡已用显存：这台机器上量不到（DXGI 那一栏是空的）"),
    }

    let report = serde_json::json!({
        "test": "a_directml_page_soak_runs_on_the_gpu_and_keeps_its_vram_bounded",
        "model": model,
        "policy": "gpu",
        "pages": pages,
        "warmupPages": WARMUP_PAGES,
        "page": { "width": PAGE_WIDTH, "height": PAGE_HEIGHT },
        "rows": rows.iter().map(|row| serde_json::json!({
            "page": row.page,
            "workerCommitMib": (mib(row.worker_commit) * 10.0).round() / 10.0,
            "workerPeakMib": (mib(row.worker_peak) * 10.0).round() / 10.0,
            "hostCommitMib": (mib(row.host_commit) * 10.0).round() / 10.0,
            "adapterUsedMib": row.adapter_used.map(|used| (mib(used) * 10.0).round() / 10.0),
            "adapterBudgetMib": row.adapter_budget.map(|budget| (mib(budget) * 10.0).round() / 10.0),
            "elapsedMs": row.elapsed.as_millis() as u64,
        })).collect::<Vec<_>>(),
        "warmCommitMib": (mib(warm.worker_commit) * 10.0).round() / 10.0,
        "growthMib": (mib(growth) * 10.0).round() / 10.0,
        "peakGrowthMib": (mib(peak_growth) * 10.0).round() / 10.0,
        "growthLimitMib": (mib(GROWTH_LIMIT) * 10.0).round() / 10.0,
        "adapterUsedBeforeMib": adapter_before.as_ref().map(|memory| (mib(memory.used) * 10.0).round() / 10.0),
        "adapterUsedAfterMib": adapter_after.as_ref().map(|memory| (mib(memory.used) * 10.0).round() / 10.0),
        "adapterBudgetMib": adapter_after.as_ref().map(|memory| (mib(memory.budget) * 10.0).round() / 10.0),
        "adapterDeltaBytes": adapter_delta,
        "latencyMs": { "p50": p50, "p95": p95, "p99": p99 },
        "totalNote": "§12.4 ⑤：宿主与 worker 是各自进程的私有提交，整卡那一栏是 DXGI 本地段（整张卡的数，含别人的进程）；renderer 是 WebView2 的进程，只有真窗口那条路才点得着，集成测试里量不到——这个总数是下界，不是总量",
        "workerPid": pid,
        "workerGoneAfterShutdown": true,
    });
    eprintln!(
        "GPU_SOAK_JSON {}",
        serde_json::to_string(&report).expect("读数能序列化")
    );
}
