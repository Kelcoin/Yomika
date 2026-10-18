//! 「宿主把已安装的模型摆进只读输入根 → worker 用真引擎算出一张真图」的真进程闭环
//! （docs/71 §11 Task 7-b-iii、§7.2）。
//!
//! `compute_manager.rs` 证明的是协议闭环（回声引擎）；这里证明的是**产品路径**：
//! 模型和页面走**同一条**授权输入根、清单里的 `minInputEdge` 一路走到引擎、产物是一张
//! 真的被模型算过的 PNG（不是最近邻放大，也不再是回声产物）。
//!
//! 真模型素材不进仓库（`docs/models/*.onnx` 是本地文件），所以 A 组找不到它就明说并跳过；
//! B/C 两组不需要模型，任何机器上都跑。

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use yomika_lib::compute::manager::{
    no_events, ComputeManager, SourceFile, SubmitRequest, SupervisorConfig, WorkerEngine,
    WorkerStatus,
};
use yomika_lib::compute::models::ModelCatalog;
use yomika_lib::compute::reader::{self, ReaderPageRequest, READER_UPSCALE_GRANT_ID};
use yomika_lib::compute::scheduler::{JobKey, JobState, Priority};
use yomika_compute_protocol::{EnginePolicy, PipelineStage, RunInput};

/// 真 ONNX 会话 + CPU 超分：第一次开模型要几秒，给足。
const HANDOFF: Duration = Duration::from_secs(120);

/// 源图 24×16，2× 放大后该是 48×32。
const PAGE_WIDTH: u32 = 24;
const PAGE_HEIGHT: u32 = 16;
const SCALE: u32 = 2;

/// 模型素材不进仓库：本机没有就**明说**跳过，不要假装测过。
fn local_model(name: &str) -> Option<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/models")
        .join(format!("{name}.onnx"));
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            eprintln!("跳过 A 组：本机没有 {}（{error}）", path.display());
            None
        }
    }
}

/// worker 可执行文件：测试自己的路径是 `target/<profile>/deps/xxx.exe`，反推得到
/// `target/<profile>`（与 `CARGO_TARGET_DIR` 无关）。**每次都先编一遍**，否则会拿上一轮
/// 的旧 worker 跑，功能改了也不生效。
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

/// 集成测试不会自动编译同 workspace 里另一个包的 bin，所以自己编一次。编不过就失败。
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

/// 一个数据根：模型装在 `<root>/models/`，staging 在 `<root>/staging`。
/// 产品路径上数据根是应用数据目录，这里换成临时目录，**布局完全一样**。
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
            "yomika-model-chain-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }

    /// 造一份「已安装的模型」：`models/<id>/<version>/` 里一份清单 + 一份 ONNX。
    /// 这正是宿主的下载/解压流程最后留下的形状（`docs/71` §7.2）。
    fn install_model(&self, id: &str, version: &str, bytes: &[u8], min_input_edge: u32) {
        let install = self.root.join("models").join(id).join(version);
        std::fs::create_dir_all(&install).expect("建模型安装目录");
        std::fs::write(install.join("model.onnx"), bytes).expect("写模型");
        let manifest = serde_json::json!({
            "id": id,
            "version": version,
            "format": "onnx",
            "scale": SCALE,
            "maxPixels": 64_000_000u64,
            "sha256": format!("{:x}", Sha256::digest(bytes)),
            "supportedBackends": ["cpu"],
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
    // 测试里不让闲置回收插手：那会让「下一件任务还能不能跑」变得说不清。
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    // 数据根就是这份沙箱：模型装在它下面的 `models/`，与产品路径同一套布局。
    config.models = Some(ModelCatalog::new(&sandbox.root));
    // 真引擎。回声引擎那一侧由 `compute_manager.rs` 覆盖。
    config.worker_engine = WorkerEngine::Onnx;
    config
}

/// 一份提交：输入声明是**假的**（哈希全 0、长度 1024），真值由宿主在派发前从源文件算
/// 出来——这也正是「渲染进程不许自带 `relativePath`」的另一面。
///
/// 带了源文件时那份**自称**（`SourceFile`）是真的：派发前准备会拿它去和磁盘上的字节
/// 对一次（`manager::prepare_run`），对不上就当场失败——这条链条要验的是模型与页面走
/// 同一条输入根，不该靠「说它是哪一份就是哪一份」蒙过去。
fn request(model_id: &str, source: Option<&Path>) -> SubmitRequest {
    SubmitRequest {
        key: JobKey {
            input_id: "book#0".to_string(),
            settings_id: "settings-1".to_string(),
            source_revision: "rev-1".to_string(),
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
            stage_id: "stage-a".to_string(),
            model_spec_id: model_id.to_string(),
            // 模型授权与最小边长都留给宿主填：调用方不许指名模型文件。
            model: None,
            dlssnr: None,
            builtin: None,
            min_input_edge: None,
            // 这条链条只验「模型和页面走同一条输入根」，交出去的尺寸与模型原生倍率一致。
            output_scale: None,
            engine_policy: EnginePolicy::Cpu,
            scale: Some(SCALE),
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: "grant-1".to_string(),
        deadline_ms: 0,
        source: source.map(|path| {
            let (byte_length, content_hash) =
                yomika_lib::compute::artifacts::hash_file(path).expect("源文件该读得出来");
            SourceFile {
                path: path.to_path_buf(),
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

/// 输入根里的 blob。相对路径是 `<哈希前两位>/<哈希>.<扩展名>`，所以要下钻一层。
fn input_blobs(inputs: &Path) -> Vec<(PathBuf, u64)> {
    let mut found = Vec::new();
    let Ok(prefixes) = std::fs::read_dir(inputs) else {
        return found;
    };
    for prefix in prefixes.flatten() {
        let Ok(files) = std::fs::read_dir(prefix.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.is_file() {
                let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                found.push((path, length));
            }
        }
    }
    found
}

/// 一张 4×4 棋盘格的结构图：硬边 + 大色差。最近邻放大在块心一模一样、在边界一定是跳变，
/// 而模型会在边界给出中间值/振铃——所以「与最近邻的差别」这条断言有东西可看。
fn make_page(path: &Path) {
    let mut image = image::RgbaImage::new(PAGE_WIDTH, PAGE_HEIGHT);
    for y in 0..PAGE_HEIGHT {
        for x in 0..PAGE_WIDTH {
            let light = ((x / 4) + (y / 4)) % 2 == 0;
            let pixel = if light {
                image::Rgba([255, 32, 32, 255])
            } else {
                image::Rgba([16, 200, 240, 255])
            };
            image.put_pixel(x, y, pixel);
        }
    }
    image.save(path).expect("存源图 PNG");
}

/// G 组：内置超分链（Anime4K）走产品路径——**这台机器上一份模型都没有**，却要算出一张
/// 真被放大过的图。
///
/// 这一条就是缺陷 6 的判据。修之前这一档只编在宿主进程里，宿主读到它就去模型目录找文件、
/// 找不到就当场 `COMPUTE_MODEL_UNAVAILABLE`；worker 那份构建里根本没有这条链，所以
/// 「在 worker 里跑它」在那时是**做不到**的事，不是一个坏掉的参数。解析器与两个执行体都
/// 搬进 `yomika-compute-core` 之后，这条链以「一句身份」（`builtin` 那一栏）过协议，
/// 于是这一段要证三件事：
///   ① 没有模型目录也能算（这条链不需要文件，需要的是两边编着同一份着色器）；
///   ② 产物上自报的引擎是这条链自己，而且倍率来自预设；
///   ③ `auto` 政策下要么真跑在显卡上（没有回退交代），要么把「为什么退回 CPU」说清楚
///      ——「想要显卡却什么都不说」是不许的（docs/71:126）。
#[test]
fn a_builtin_chain_upscales_a_page_without_any_model_on_disk() {
    let sandbox = Sandbox::new("builtin-chain");
    let page = sandbox.root.join("page.png");
    make_page(&page);
    // 起手就不该有模型目录：这条链要是还去模型目录里找文件，下面那一件会以
    // `COMPUTE_MODEL_UNAVAILABLE` 收场——那正是缺陷 6 的形态。
    assert!(
        !sandbox.root.join("models").exists(),
        "这一组的前提是：这台机器上一份模型都没有"
    );

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");

    // ① 点名 CPU：任何机器上都该过的一档，也是这条链最确定的形态（CPU 解释器）。
    let mut cpu = request("anime4k-hq", Some(&page));
    cpu.key.settings_id = "settings-builtin-cpu".to_string();
    let submitted = manager.submit(cpu).expect("宿主收下这件任务");
    let state = wait_until("内置链算完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "内置链必须真的算出来（缺陷 6 的判据：没有模型文件也要能放大）"
    );

    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "anime4k", "自报的引擎该是这条链自己");
    assert_eq!(artifact.engine_policy.as_deref(), Some("cpu"));
    assert!(
        artifact.engine_fallback.is_none(),
        "点名 CPU 时不存在回退这回事：{:?}",
        artifact.engine_fallback
    );
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH * SCALE, PAGE_HEIGHT * SCALE),
        "这条链是 x2，倍率该来自预设而不是调用方填的那个数"
    );
    assert!(
        artifact.pipeline_revision.starts_with("worker-v3-neutral-chroma:"),
        "revision 由这一份 run 派生：{}",
        artifact.pipeline_revision
    );
    let produced_bytes = std::fs::read(&artifact.path).expect("读产物");
    assert!(
        produced_bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "产物该是真 PNG"
    );
    let produced = image::load_from_memory(&produced_bytes)
        .expect("按内容解码产物")
        .to_rgba8();
    let source = image::open(&page).expect("读源图").to_rgba8();
    let total = (produced.width() * produced.height()) as usize;
    let mut differing = 0usize;
    for y in 0..produced.height() {
        for x in 0..produced.width() {
            let produced_pixel = produced.get_pixel(x, y).0;
            let nearest = source.get_pixel(x / SCALE, y / SCALE).0;
            if produced_pixel
                .iter()
                .zip(nearest.iter())
                .any(|(a, b)| a.abs_diff(*b) >= 8)
            {
                differing += 1;
            }
        }
    }
    assert!(
        differing > 0,
        "产物与最近邻一模一样：那说明这条链没跑，只是把图放大了（{total} 个像素）"
    );

    // 输入根里只有这一页：内置链不摆任何模型文件进去。这条断言是「它不需要文件」的
    // 另一半证据——上面那条「没有模型目录」说的是磁盘上没有，这条说的是它没从别处补。
    let inputs = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    let blobs = input_blobs(&inputs);
    assert!(
        !blobs
            .iter()
            .any(|(path, _)| path.extension().is_some_and(|ext| ext == "onnx")),
        "内置链不该往输入根里摆模型：{blobs:?}"
    );

    // ② 自动：Windows 上这条链真有显卡可要。这一条不假设显卡一定拿得到（别人的机器上
    //    可能没有），它钉的是**说实话**：要么没有回退交代（真跑在显卡上），要么交代里
    //    有「想要谁、用了谁、为什么」。
    let mut auto = request("anime4k-hq", Some(&page));
    auto.key.settings_id = "settings-builtin-auto".to_string();
    auto.key.backend = "auto".to_string();
    auto.pipeline[0].engine_policy = EnginePolicy::Auto;
    let submitted = manager.submit(auto).expect("宿主收下这件任务");
    let state = wait_until("内置链（auto）算完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "auto 也要算出来");
    let auto_artifact = manager
        .job_artifacts(&submitted.job_id)
        .into_iter()
        .next()
        .expect("有一件");
    assert_eq!(auto_artifact.engine_id, "anime4k");
    assert_eq!(auto_artifact.engine_policy.as_deref(), Some("auto"));
    if let Some(fallback) = auto_artifact.engine_fallback.as_ref() {
        assert_ne!(
            fallback.requested, fallback.used,
            "交代里「想要谁」与「用了谁」不能是同一句话：{fallback:?}"
        );
        assert!(
            !fallback.reason.trim().is_empty(),
            "退回 CPU 必须给理由：{fallback:?}"
        );
    }

    eprintln!(
        "内置链：没有模型文件也算出 {}×{} 产物，engine={} policy={} 回退={:?}，与最近邻有差别的像素 {differing}/{total}（auto 那一件 policy={:?} 回退={:?}）",
        artifact.width,
        artifact.height,
        artifact.engine_id,
        artifact.engine_policy.as_deref().unwrap_or(""),
        artifact.engine_fallback,
        auto_artifact.engine_policy.as_deref().unwrap_or(""),
        auto_artifact.engine_fallback,
    );

    manager.shutdown();
}

/// A 组：产品路径的整体闭环。找不到真模型就跳过（明说，不算通过）。
#[test]
fn the_host_hands_a_model_and_a_page_to_a_real_engine() {
    let Some(model_bytes) = local_model("realcugan-2x-conservative") else {
        return;
    };
    let sandbox = Sandbox::new("chain");
    let model_id = "realcugan-2x-conservative";
    // 清单里写 20：真实模型声明的下限就是 20，于是 16 高的源图**必须**被垫到 20 再裁回来
    // ——这条断言顺带证明清单里的 `minInputEdge` 真的一路走到了引擎。
    sandbox.install_model(model_id, "1", &model_bytes, 20);
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request(model_id, Some(&page)))
        .expect("应该收下这件任务");
    let state = wait_until("真模型算完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "应该是算完了，而不是回声或失败");

    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    // 宿主**自己**核过长度与哈希，不是 worker 说了算。
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "onnx", "真要跑模型，不是回声");
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH * SCALE, PAGE_HEIGHT * SCALE),
        "2× 放大后该是 48×32"
    );
    assert!(
        artifact.staging_name.ends_with(".png"),
        "产物该是 PNG：{}",
        artifact.staging_name
    );
    assert!(
        artifact.pipeline_revision.starts_with("worker-v3-neutral-chroma:"),
        "revision 由这一份 run 派生：{}",
        artifact.pipeline_revision
    );
    let relative = artifact
        .cache_relative
        .clone()
        .expect("配了发布根就该发布");
    assert!(
        relative.starts_with("cache/images/"),
        "发布路径该是内容寻址的：{relative}"
    );
    assert!(artifact.path.exists(), "{}", artifact.path.display());

    // 模型和页面走的是**同一条**授权输入根：两个 blob 都在，长度分别对得上。
    let inputs = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    let blobs = input_blobs(&inputs);
    let lengths: Vec<u64> = blobs.iter().map(|(_, length)| *length).collect();
    assert!(
        lengths.contains(&(model_bytes.len() as u64)),
        "模型本体该和页面待在同一条输入根里：{lengths:?}"
    );
    let page_bytes = std::fs::metadata(&page).expect("源图").len();
    assert!(
        lengths.contains(&page_bytes),
        "这一页也该在输入根里：{lengths:?}"
    );
    assert!(
        blobs
            .iter()
            .any(|(path, _)| path.extension().is_some_and(|ext| ext == "onnx")),
        "模型的源扩展名该被保留（否则 worker 看不出它是什么）：{blobs:?}"
    );

    // 产物必须**不是**最近邻放大。把引擎换回 `NearestNeighbourEngine` 就会红——这是
    // 「真跑了模型」的像素级证据，不靠文件名和自报的引擎 id。
    //
    // 注意发布后的路径是内容寻址的（`.bin`），扩展名不带信息：解码要看**内容**，
    // 这也正是资源协议按内容嗅探 MIME、而不是信扩展名的原因。
    let produced_bytes = std::fs::read(&artifact.path).expect("读产物");
    assert!(
        produced_bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "产物该是真 PNG"
    );
    let produced = image::load_from_memory(&produced_bytes)
        .expect("按内容解码产物")
        .to_rgba8();
    assert_eq!(
        produced.dimensions(),
        (PAGE_WIDTH * SCALE, PAGE_HEIGHT * SCALE)
    );
    let source = image::open(&page).expect("读源图").to_rgba8();
    let total = (produced.width() * produced.height()) as usize;
    let mut differing = 0usize;
    for y in 0..produced.height() {
        for x in 0..produced.width() {
            let produced_pixel = produced.get_pixel(x, y).0;
            let nearest = source.get_pixel(x / SCALE, y / SCALE).0;
            if produced_pixel
                .iter()
                .zip(nearest.iter())
                .any(|(a, b)| a.abs_diff(*b) >= 8)
            {
                differing += 1;
            }
        }
    }
    assert!(
        differing * 100 >= total,
        "产物看着就像最近邻放大：{differing} / {total} 个像素与最近邻有明显差别"
    );
    // 把这一轮的客观数字留在日志里：报告与文档都从这里抄，不靠回忆。
    eprintln!(
        "模型链条：模型 {} 字节 → 产物 {} 字节，{}×{} 源图 → {}×{} 产物，engine={} 精度={} revision={}，输入根 {} 个 blob（模型 + 页面同一条通道），与最近邻有明显差别的像素 {differing}/{total}",
        model_bytes.len(),
        produced_bytes.len(),
        PAGE_WIDTH,
        PAGE_HEIGHT,
        produced.width(),
        produced.height(),
        artifact.engine_id,
        artifact.engine_precision,
        artifact.pipeline_revision,
        blobs.len(),
    );

    manager.shutdown();
}

/// B 组：模型没装。失败得**在派发前**发生，而且是它自己的码，不是「输入坏了」。
#[test]
fn a_model_that_is_not_installed_fails_the_job_with_its_own_code() {
    let sandbox = Sandbox::new("model-missing");
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request("realcugan-2x-conservative", Some(&page)))
        .expect("宿主收下这件任务：缺模型是派发时才知道的");
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    match state {
        JobState::Failed { code } => {
            assert_eq!(code, "COMPUTE_MODEL_UNAVAILABLE", "缺模型该有自己的码")
        }
        other => panic!("缺模型必须失败，实际 {other:?}"),
    }
    assert!(
        manager.job_artifacts(&submitted.job_id).is_empty(),
        "没算成就不该有产物"
    );
    manager.shutdown();
}

/// C 组：没有源图。宿主在派发前就该拒绝——真引擎没有源图能干的事是**零**，
/// 与其让它回声出一张假图，不如当场说清楚。
#[test]
fn a_submission_without_a_source_page_is_refused_by_the_host() {
    let sandbox = Sandbox::new("no-source");
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request("realcugan-2x-conservative", None))
        .expect("宿主收下这件任务");
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    match state {
        JobState::Failed { code } => {
            assert_eq!(code, "COMPUTE_INPUT_INVALID", "没有源图就是输入不对")
        }
        other => panic!("没有源图必须失败，实际 {other:?}"),
    }
    assert!(manager.job_artifacts(&submitted.job_id).is_empty());
    let inputs = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    assert!(
        input_blobs(&inputs).is_empty(),
        "源图都没有，谈不上往输入根里摆东西：{}",
        inputs.display()
    );
    manager.shutdown();
}

/// D 组：阅读器那条来路（docs/71 §9、Task 7-b-vii）。
///
/// 前端只说得出「哪一页、什么设置」，而任务身份（`settingsId` / `sourceRevision` / 管线）
/// 里含着模型指纹、声明后端、运行时库版本——只有宿主算得出来，所以由 `compute::reader`
/// 铸、由这条测试证明它真能算出一张图。
///
/// 找不到真模型就跳过（明说，不算通过）。
#[test]
fn a_reader_page_identity_becomes_a_real_run() {
    let Some(model_bytes) = local_model("realcugan-2x-conservative") else {
        return;
    };
    let sandbox = Sandbox::new("reader-page");
    let model_id = "realcugan-2x-conservative";
    sandbox.install_model(model_id, "1", &model_bytes, 20);
    let page = sandbox.root.join("page.png");
    make_page(&page);
    let (byte_length, content_hash) =
        yomika_lib::compute::artifacts::hash_file(&page).expect("源图该读得出来");
    // 阅读器那道门查完索引交出来的形状，与产品里 `SourceFile::from(cached_blob_location())`
    // 是同一份东西。
    let source = || SourceFile {
        path: page.clone(),
        content_hash: content_hash.clone(),
        byte_length,
    };

    let request = ReaderPageRequest {
        scope_id: "scope-a".to_string(),
        archive_id: "archive-a".to_string(),
        page_index: 11,
        model_id: model_id.to_string(),
        generation: 3,
        priority: Priority::Foreground,
        deadline_ms: 0,
    };
    let planned = reader::into_request(
        reader::plan_reader_page(&sandbox.root, &request).expect("这台机器上装了这个模型"),
        source(),
    );
    let repeated = reader::into_request(
        reader::plan_reader_page(&sandbox.root, &request).expect("同一个问题问两次"),
        source(),
    );

    // 「同一页 + 同一份设置 = 同一件任务」只有宿主自己铸才成立：渲染进程要是自己拼一个
    // settingsId，同一页会被当成两件任务，缓存永远不命中（这也是这一层存在的理由）。
    assert_eq!(planned.key, repeated.key, "同一个问题必须铸出同一个身份");
    assert_eq!(planned.key.input_id, "scope-a:archive-a:11");
    assert_eq!(planned.key.source_revision, "reader-page");
    // 后端那一栏是**引擎政策**，要按这台机器的**事实**说：有硬件候选就问（auto），没有就
    // 老实说只有 CPU。这里绝不写「反正先按 CPU 跑」——那正是这轮要消灭的谎话。
    #[cfg(windows)]
    assert_eq!(
        planned.key.backend, "auto",
        "Windows 上有硬件候选，后端标签必须说实话"
    );
    #[cfg(not(windows))]
    assert_eq!(
        planned.key.backend, "cpu",
        "这台机器没有硬件候选，后端标签老实说只有 CPU"
    );
    assert!(
        matches!(planned.key.backend.as_str(), "auto" | "cpu" | "gpu"),
        "这一栏放的是政策（auto/cpu/gpu），不是某条运行库的名字：{}",
        planned.key.backend
    );
    assert_eq!(planned.output_grant_id, READER_UPSCALE_GRANT_ID);
    assert!(
        planned.input.relative_path.is_none(),
        "这一页在哪由宿主的 source 那只手带，调用方没有话要说"
    );
    assert_eq!(planned.input.content_hash, content_hash);
    assert_eq!(planned.input.byte_length, byte_length);
    assert_eq!(
        planned.source.as_ref().map(|file| file.content_hash.clone()),
        Some(content_hash.clone()),
        "索引说的那一份要原样交给派发前那一侧去核"
    );

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager.submit(planned).expect("应该收下这件任务");
    let state = wait_until("阅读器那一页算完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "阅读器那一页该真算出来");

    // 交上去的身份与铸出来的必须是同一把尺子：调度器按它去重、按它找产物。
    assert_eq!(submitted.snapshot.key.input_id, "scope-a:archive-a:11");
    assert_eq!(submitted.snapshot.key.source_revision, "reader-page");

    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "onnx", "真要跑模型，不是回声");
    // 调度器合并用的标签与产物上那份交代必须是同一个政策：worker 把宿主交给它的政策原样
    // 回显，宿主再抄进产物。两者对不上，界面就会把「想要谁」和「跑的是谁」说成两码事
    // （docs/71:126：强制 GPU 不许静默变成 CPU，auto 可以显式回退并说明原因）。
    assert_eq!(
        Some(submitted.snapshot.key.backend.as_str()),
        artifact.engine_policy.as_deref(),
        "后端标签与产物上的引擎政策必须同一句话"
    );
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH * SCALE, PAGE_HEIGHT * SCALE),
        "2× 放大后该是 48×32"
    );
    let relative = artifact
        .cache_relative
        .clone()
        .expect("配了发布根就该发布");
    assert!(
        relative.starts_with("cache/images/"),
        "发布路径该是内容寻址的（阅读器那条 URL 就挂在它上面）：{relative}"
    );
    assert!(artifact.path.exists(), "{}", artifact.path.display());

    eprintln!(
        "阅读器那一页：身份 {} / {} → 产物 {} 字节，{}×{} → {}×{}，engine={} revision={}，发布到 {}",
        submitted.snapshot.key.input_id,
        submitted.snapshot.key.settings_id,
        std::fs::metadata(&artifact.path).map(|meta| meta.len()).unwrap_or(0),
        PAGE_WIDTH,
        PAGE_HEIGHT,
        artifact.width,
        artifact.height,
        artifact.engine_id,
        artifact.pipeline_revision,
        relative,
    );

    manager.shutdown();
}

/// 随产品一起发出去的那份模型（`resources/models/<id>/`）。它进仓库、也进安装包，所以
/// 用它的测试**不用跳过**：这条链要的是一份能开得起来的 ONNX，而不是某台机器上碰巧有的
/// 素材（`local_model` 那一类才是「本机没有就明说」）。
fn bundled_model(id: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/models")
        .join(id)
        .join("model.onnx");
    std::fs::read(&path)
        .unwrap_or_else(|error| panic!("读随产品发布的模型 {}：{error}", path.display()))
}

/// 两段一条链：第二阶段的输入是第一阶段交出来的那一份（`docs/71` §9.1 那条来路，
/// 产品里由 `compute::reader` 铸、这里按同一形状手写一份）。
fn chained_request(first_model: &str, second_model: &str, page: &Path) -> SubmitRequest {
    let mut chained = request(first_model, Some(page));
    let mut second = chained.pipeline.first().expect("第一阶段").clone();
    second.stage_id = "stage-b".to_string();
    second.model_spec_id = second_model.to_string();
    chained.pipeline.push(second);
    chained
}

/// staging 里还留着的东西（递归，用来断言「收干净了」）。相对路径 + 排序，报错读得懂。
fn staged_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(path);
            } else {
                found.push(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .display()
                        .to_string(),
                );
            }
        }
    }
    found.sort();
    found
}

/// E 组：一条链的第二阶段在**运行时**失败——模型装是装上了，但那几个字节不是一份能开的
/// ONNX。宿主在派发前只核「文件在不在、指纹对不对」，开不开得起来只有真跑到它才知道，
/// 所以这正是「阶段错误」而不是「派发前拒绝」。
///
/// `docs/71:642` 的两句话在这一条测试里必须**同时**成立：
/// ① 「phase error 只丢该失败版本，成功中间阶段可显示」——产物表里只有第一阶段那件，
///    它 `verified`、有内容寻址的落点、盘上那份真是一张 PNG，界面因此还取得到它；
/// ② 「idle/release/shutdown 回收所有可回收资源」——收摊之后 staging 里不该再留着上一件
///    事的副本，而**已经发布到正式目录的那一版不许被顺手收走**。
///
/// 这两条必须一起测：只测①会把「不敢收」写死，只测②会把「还能显示的那一版」也扫掉。
#[test]
fn a_phase_error_keeps_the_stage_that_already_landed() {
    let sandbox = Sandbox::new("phase-error");
    let kept_model = "waifu2x-upconv7";
    sandbox.install_model(kept_model, "1", &bundled_model(kept_model), 1);
    // 第二阶段：文件在、清单的 sha256 也对（宿主按盘上的字节算），但它不是 ONNX。
    sandbox.install_model("half-installed", "1", "这不是一份 ONNX".as_bytes(), 1);
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(chained_request(kept_model, "half-installed", &page))
        .expect("宿主收下这条链");
    let state = wait_until("第二段失败", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    let JobState::Failed { code } = state.clone() else {
        panic!("第二段开不起来，这件任务必须失败，实际 {state:?}");
    };
    let artifacts = manager.job_artifacts(&submitted.job_id);
    // 失败码今天答的是 `COMPUTE_INPUT_INVALID`：`compute-core/src/onnx.rs:100` 把「session
    // 开不起来」归成 `InvalidInput`。这条测试要证的是**产物账**（下面那些断言），不是码表，
    // 所以这里只把它记下来——「开不起来该有自己的码」是 Task 9 那张故障码表的事，记在欠账里。
    let _ = &code;

    // ① 只丢失败的那一版。
    assert_eq!(artifacts.len(), 1, "失败的阶段不该留下产物：{artifacts:?}");
    let kept = artifacts.first().expect("第一阶段那件");
    assert_eq!(kept.stage_id, "stage-a");
    assert!(kept.verified, "宿主必须自己核过：{kept:?}");
    assert_eq!(kept.engine_id, "onnx", "第一阶段真跑了模型");
    let published = kept.path.clone();
    let published_relative = kept
        .cache_relative
        .clone()
        .expect("配了发布根就该发布");
    assert!(
        published_relative.starts_with("cache/images/"),
        "发布路径该是内容寻址的：{published_relative}"
    );
    assert!(published.exists(), "{}", published.display());
    let before = std::fs::read(&published).expect("读第一阶段的产物");
    assert!(
        before.starts_with(&[0x89, b'P', b'N', b'G']),
        "第一阶段该产出一张真 PNG（界面那条路按 MIME 收它）"
    );

    // ② 收摊只收暂存。
    let leftovers_before = staged_files(&sandbox.staging);
    manager.shutdown();
    let leftovers = staged_files(&sandbox.staging);
    assert!(
        leftovers.is_empty(),
        "收摊之后 staging 里不该还留着上一件事的东西：{leftovers:?}（收摊前 {leftovers_before:?}）"
    );
    assert!(
        published.exists(),
        "已经落地的那一版不许被回收带走：{}",
        published.display()
    );
    assert_eq!(
        std::fs::read(&published).expect("再读一次"),
        before,
        "正式目录里那份字节必须一模一样"
    );

    eprintln!(
        "阶段错误：第二段失败码 {code}，第一阶段产物 {} 字节留在 {published_relative}，收摊前 staging 里 {leftovers_before:?}、收摊后 {leftovers:?}",
        before.len(),
    );
}

/// F 组：用完的模型在「没人再要它」的时候要还回去（`docs/71` §12.4 的门槛原文：
/// 「idle30 秒释放模型/workspace」）。
///
/// 门槛里那两样东西都活在这个进程里：NGX 的工作区，和**模型引擎缓存**——超分的 ONNX 会话
/// （权重就挂在它上面）、检测器、两种修补引擎。在 9-c 之前，「交回」这条路只够得着前者：
/// 三处模型缓存从建起来到进程退出不会有人碰，一件跑完的真模型会一直占着几十到几百 MB，
/// 直到 120 秒的闲置收摊把它整个端掉。这一条测试钉的是**后者也能交回去**。
///
/// 为什么用「份数」而不是私有提交字节数：字节级的回落要看 ORT arena 自己的脾气（放掉
/// session 不等于把地址空间还给系统），而这一刻的事实是**缓存里有没有那件东西**——份数
/// 说的是这件事，字节留给 §12.4 的 soak 去量。所以这里只断言「至少还回来一份」，并把
/// 交回前后的份数记下来。
///
/// 后半段是**对照**：交回不是拆掉这一代 worker——同一份模型还得能再开一次，而且再跑完
/// 之后还得能再交回一次。
#[test]
fn a_model_that_is_done_working_is_handed_back_where_nobody_needs_it() {
    let sandbox = Sandbox::new("hand-back-model");
    let model = "waifu2x-upconv7";
    sandbox.install_model(model, "1", &bundled_model(model), 1);
    let first_page = sandbox.root.join("first.png");
    make_page(&first_page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");

    let mut first = request(model, Some(&first_page));
    first.key.settings_id = "settings-first".to_string();
    let submitted = manager.submit(first).expect("宿主收下第一件");
    let state = wait_until("第一件真跑完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "先得让真模型跑过一次");
    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(
        artifacts.first().map(|record| record.engine_id.as_str()),
        Some("onnx"),
        "这一件必须真跑过 ONNX 引擎，才谈得上「把模型交回去」：{artifacts:?}"
    );

    let handed_back = manager.release_idle();
    assert!(
        handed_back >= 1,
        "跑过的模型在没人要它的时候该还回去：实际交回 {handed_back} 份（缓存里那件 ONNX 会话没被碰到）"
    );

    // 还回去不等于拆掉：同一份模型要能再开一次（缓存未命中 → 重新加载）。
    let second_page = sandbox.root.join("second.png");
    make_page(&second_page);
    let mut second = request(model, Some(&second_page));
    second.key.settings_id = "settings-second".to_string();
    let resubmitted = manager.submit(second).expect("宿主收下第二件");
    let state = wait_until("第二件也真跑完", HANDOFF, || {
        terminal_of(&manager, &resubmitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "交回模型只该让它重新加载一次，不该把这一代 worker 弄不能干活"
    );
    match manager.worker_status() {
        WorkerStatus::Ready { .. } => {}
        other => panic!("交回模型之后这一代 worker 还该在：{other:?}"),
    }

    // 第二次用过之后同样要还回去——「交过一遍」这件事不许把后面的交回吃掉。
    let again = manager.release_idle();
    assert!(
        again >= 1,
        "第二件任务又把模型装回缓存了，收工后同样该还回去：实际交回 {again} 份"
    );

    eprintln!("模型交回：第一件之后 {handed_back} 份，第二件之后 {again} 份");

    manager.shutdown();
}
