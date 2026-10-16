//! 旧命令的兼容代理（`docs/71` §11）的真进程闭环：回声引擎那一半。
//!
//! 这里证明 `compute::proxy` 自己那四件事：把这一页按内容摆进只读输入根、提交、等终态、
//! 读回宿主复核过的产物，以及**把用户的取消牌转成对 worker 的取消请求**。用回声引擎就
//! 够了，而且回声产物本身是一份证据——它把「引擎手边那份输入是谁」写进了字节里。
//!
//! 真模型那一半在同文件的第三条：**真的**把一份 2× 模型交给 worker 算，而且宿主给的「交
//! 出去多大」必须在编码之前生效。算力中心那两条字节来路（`compute_center::process` 把远端
//! 发来的字节转给 `proxy`）也在这里闭环——宿主自己那条 ONNX 会话已经拆了，所以「点了 ONNX
//! 模型却没有编排」必须明说拒绝，不能就地拿别的引擎顶替（那一条由 `compute_center.rs` 的
//! 单测钉住）。

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use yomika_compute_core::dlssnr::DlssnrSettings;
use yomika_lib::compute::inputs::inputs_root_for;
use yomika_lib::compute::manager::{no_events, ComputeManager, SupervisorConfig, WorkerEngine};
use yomika_lib::compute::models::ModelCatalog;
use yomika_lib::compute::proxy::{self, DlssnrJob, StageSpec, UpscaleJob};
use yomika_lib::compute::scheduler::{JobState, Priority};
use yomika_lib::compute_center::{process, ProcessParams};

/// 与 `compute_model_chain.rs` 同一份素材口径：源图 24×16。
const PAGE_WIDTH: u32 = 24;
const PAGE_HEIGHT: u32 = 16;

/// 回声引擎的假算时长（只在测试钩子打开时生效）。
const FAKE_WORK: Duration = Duration::from_millis(3000);

/// 用户走开之后，多久该把上面那 3 秒的假算截断。
const WALK_AWAY: Duration = Duration::from_millis(300);
const CANCEL_BUDGET: Duration = Duration::from_millis(2500);

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

/// 一个数据根：模型装在 `<root>/models/`，staging 在 `<root>/staging`，发布根就是
/// `<root>` 本身——与产品路径的数据根布局**完全一样**。
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
            "yomika-proxy-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }

    /// 造一份「已安装的模型」。回声引擎不会去解它，所以**字节内容是假的也无妨**——宿主
    /// 侧只算哈希、只按内容摆文件；清单里的 sha256 与真字节一致，这条链路才是真的。
    fn install_model(&self, id: &str, version: &str, bytes: &[u8], min_input_edge: u32, scale: u32) {
        let install = self.root.join("models").join(id).join(version);
        std::fs::create_dir_all(&install).expect("建模型安装目录");
        std::fs::write(install.join("model.onnx"), bytes).expect("写模型");
        let manifest = serde_json::json!({
            "id": id,
            "version": version,
            "format": "onnx",
            "scale": scale,
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

    /// 产物发布之后的落点（`artifacts::artifact_relative` 的形状）。
    fn published(&self, content_hash: &str) -> PathBuf {
        self.root
            .join("cache/images")
            .join(&content_hash[..2])
            .join(format!("{content_hash}.bin"))
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
    // 测试里 worker 起一次就够了，别让它因为闲下来自己退（那会把「谁算的」这件事搞乱）。
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    config.models = Some(ModelCatalog::new(&sandbox.root));
    config.worker_engine = WorkerEngine::Echo;
    config
}

/// 一张真的 24×16 PNG。格式按**内容**认——代理给相对路径挑的扩展名也是按内容嗅出来的
/// （`proxy::extension_for`），两边口径一样才谈得上「扩展名只是给人看」。
fn page_png() -> Vec<u8> {
    use image::ImageEncoder;
    let mut page = Vec::new();
    let mut rgba = Vec::with_capacity((PAGE_WIDTH * PAGE_HEIGHT * 4) as usize);
    for y in 0..PAGE_HEIGHT {
        for x in 0..PAGE_WIDTH {
            let odd = (x + y) % 2 == 0;
            rgba.extend_from_slice(if odd {
                &[255, 32, 32, 255]
            } else {
                &[16, 200, 240, 255]
            });
        }
    }
    image::codecs::png::PngEncoder::new(&mut page)
        .write_image(
            &rgba,
            PAGE_WIDTH,
            PAGE_HEIGHT,
            image::ExtendedColorType::Rgba8,
        )
        .expect("编一张 PNG");
    page
}

/// 一次提交的完整外形。**模型 id 与上限都当参数**：写死在里面的 helper 配上结构体更新语法
/// （`..proxy_job(&page)`）会悄悄留着上一个用例的模型名，而那个模型在别的沙箱里根本不存在。
fn proxy_job<'a>(
    page: &'a [u8],
    model_spec_id: &'a str,
    output_scale: Option<u32>,
) -> UpscaleJob<'a> {
    UpscaleJob {
        policy: yomika_compute_protocol::EnginePolicy::Auto,
        input_id: "scope-a:archive-a:0",
        settings_id: "rev-test",
        source_revision: "reader-page",
        priority: Priority::Foreground,
        output_scale,
        stage: StageSpec {
            stage_id: "upscale",
            model_spec_id,
            scale: 2,
            page,
        },
    }
}

/// 从回声产物那一行里取一个字段（`key=值`，空格分隔）。
fn echo_field<'a>(line: &'a str, key: &str) -> &'a str {
    let start = line
        .find(key)
        .unwrap_or_else(|| panic!("回声产物里没有 {key}：{line}"))
        + key.len();
    line[start..]
        .split_whitespace()
        .next()
        .unwrap_or_else(|| panic!("{key} 后面没有值：{line}"))
}

/// 本机没有真模型素材时**明说跳过**——跳过不等于通过。
fn local_model(name: &str) -> Option<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/models")
        .join(format!("{name}.onnx"));
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            eprintln!("跳过：本机没有 {}（{error}）", path.display());
            None
        }
    }
}

#[test]
fn the_proxy_puts_the_page_in_front_of_the_engine_and_brings_the_artifact_back() {
    let sandbox = Sandbox::new("echo");
    sandbox.install_model("probe-model", "1", b"not an onnx file", 1, 2);
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起计算编排");

    let page = page_png();
    let page_hash = blake3::hash(&page).to_hex().to_string();
    let bytes = proxy::upscale(&manager, proxy_job(&page, "probe-model", Some(2)), &|| false)
        .expect("回声引擎这一轮不该失败");
    manager.shutdown();

    let line = String::from_utf8(bytes.clone()).expect("回声产物是一行 UTF-8 文本");
    assert!(line.starts_with("echo stage=upscale "), "回声产物对不上：{line}");
    assert_eq!(
        echo_field(&line, "input="),
        "scope-a:archive-a:0",
        "任务身份没走到引擎手边：{line}"
    );
    // 输入真的从宿主摆到了引擎手边，而且摆的**就是这一页**：引擎报的相对路径，正是我们
    // 按内容算出来的那个——前两位哈希当目录、整条哈希当文件名、扩展名按内容嗅成 png。
    let granted = echo_field(&line, "granted=");
    assert_eq!(
        granted,
        format!("{}/{page_hash}.png", &page_hash[..2]),
        "引擎读到的不是这一页：{line}"
    );
    let blob = inputs_root_for(&sandbox.staging).join(granted);
    assert!(blob.exists(), "输入根里没有这一份：{}", blob.display());
    assert_eq!(
        std::fs::metadata(&blob).expect("看输入").len(),
        page.len() as u64,
        "输入根里那一份不是这一页"
    );

    // 产物是宿主**复核过**、按内容发布的那一份：它的落点就是它自己字节的哈希。
    let artifact_hash = blake3::hash(&bytes).to_hex().to_string();
    let published = sandbox.published(&artifact_hash);
    assert!(
        published.exists(),
        "产物该落在内容寻址存储里：{}",
        published.display()
    );
    assert_eq!(std::fs::read(&published).expect("读产物"), bytes);
}

#[test]
fn a_page_the_reader_walked_away_from_is_cancelled_instead_of_waited_out() {
    let sandbox = Sandbox::new("cancel");
    sandbox.install_model("probe-model", "1", b"not an onnx file", 1, 2);
    let mut config = config(&sandbox);
    // 让回声引擎「算」得久一点才测得出取消：这条钩子只在测试里开（`extra_env` 生产恒空）。
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_DELAY_MS".to_string(),
        FAKE_WORK.as_millis().to_string(),
    )];
    let manager = ComputeManager::start(config, no_events()).expect("起计算编排");

    let page = page_png();
    let walked_away = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&walked_away);
    let reader = std::thread::spawn(move || {
        std::thread::sleep(WALK_AWAY);
        flag.store(true, Ordering::SeqCst);
    });

    let started = Instant::now();
    let error = proxy::upscale(&manager, proxy_job(&page, "probe-model", Some(2)), &|| {
        walked_away.load(Ordering::SeqCst)
    })
    .expect_err("用户已经走开了，不该交出产物");
    let elapsed = started.elapsed();
    reader.join().expect("取消线程");
    manager.shutdown();

    assert_eq!(error.code, "INFERENCE_CANCELLED", "{}", error.message);
    assert!(!error.retryable, "取消是用户的选择，不是失败");
    assert!(
        elapsed < CANCEL_BUDGET,
        "取消该把 {:?} 的假算截断，实际等了 {elapsed:?}",
        FAKE_WORK
    );
    // 取消掉的那一页不该留下任何产物。
    let images = sandbox.root.join("cache/images");
    let leftovers: Vec<PathBuf> = std::fs::read_dir(&images)
        .map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect())
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "取消掉的任务留下了产物：{leftovers:?}"
    );
}

/// 宿主给的上限必须落到**编码之前**，而且真的由 worker 执行。
///
/// 用一份 2× 的真模型、要 1 倍，就能拿现有素材把这条机制钉死：模型算出来是 48×32，
/// 交出去的必须是 24×16。要是上限在代理那一层被丢掉，这里就会收到 48×32——正是产品路径
/// 上「x4 模型把 180 MB RGBA 与几十 MB PNG 白花一遍」的那个形状。
#[test]
fn the_size_the_host_asks_for_is_obeyed_before_the_page_is_encoded() {
    const MODEL: &str = "realcugan-2x-conservative";
    let Some(model_bytes) = local_model(MODEL) else {
        return;
    };
    let sandbox = Sandbox::new("cap");
    sandbox.install_model(MODEL, "1", &model_bytes, 20, 2);
    let mut config = config(&sandbox);
    config.worker_engine = WorkerEngine::Onnx;
    let manager = ComputeManager::start(config, no_events()).expect("起计算编排");

    let page = page_png();
    let bytes = proxy::upscale(&manager, proxy_job(&page, MODEL, Some(1)), &|| false)
        .expect("真模型这一轮不该失败");
    manager.shutdown();

    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "产物是一张 PNG");
    let decoded = image::load_from_memory(&bytes).expect("产物解得开");
    assert_eq!(
        (decoded.width(), decoded.height()),
        (PAGE_WIDTH, PAGE_HEIGHT),
        "宿主给的上限没有在编码之前生效"
    );
    // 缩回来的那一张是模型算出来的，不是把原图照抄回来。
    assert_ne!(bytes, page, "交出来的不该还是那一页原图");
}

/// 算力中心的超分来路：远端发来的字节也必须经过 worker，不在宿主里就地算。
///
/// 回声引擎在这里正好当判官——它的产物是**引擎手边那一行文本**，宿主自己算出来的会是一张
/// PNG。所以「交回来的不是图」本身就是「它没在宿主里算」的证据，连真模型都不必装。产物里
/// 的 `input=` 还得是中心自己铸的身份（`remote:<内容的哈希>`）：这一页确实是从那条来路进
/// 来的，不是从别处漏过去的。
#[test]
fn the_centers_upscale_op_goes_through_the_worker() {
    let sandbox = Sandbox::new("center-upscale");
    sandbox.install_model("probe-model", "1", b"not an onnx file", 1, 2);
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起计算编排");

    let page = page_png();
    let params = ProcessParams {
        chain: Vec::new(),
        op: "upscale".into(),
        model_id: Some("probe-model".into()),
        scale: Some(2),
        dlssnr: None,
    };
    let bytes = process(Some(&manager), &sandbox.root, &sandbox.root, &params, &page, &|| false)
        .expect("回声引擎这一轮不该失败");
    let jobs = manager.all_jobs();
    manager.shutdown();

    let line = String::from_utf8(bytes).expect("回声产物是一行 UTF-8 文本");
    assert!(
        line.starts_with("echo stage=upscale "),
        "算力中心没把这一页交给 worker：{line}"
    );
    let page_hash = blake3::hash(&page).to_hex().to_string();
    assert_eq!(
        echo_field(&line, "input="),
        format!("remote:{page_hash}"),
        "这一页不是算力中心那条来路进来的：{line}"
    );
    assert_eq!(
        echo_field(&line, "granted="),
        format!("{}/{page_hash}.png", &page_hash[..2]),
        "引擎手边的不是这一页：{line}"
    );
    assert_eq!(jobs.len(), 1, "该只有一件任务：{jobs:?}");
    assert_eq!(jobs[0].state, JobState::Completed, "任务没算完就算出了结果");
}

/// 算力中心的 DLSSNR 来路：这一档也不在宿主进程里算了（NGX 只在 worker 那边初始化）。
///
/// 回声引擎在这里当判官：宿主自己算出来的会是一张 PNG，而回声产物是**引擎手边那一行文本**，
/// 所以「交回来的不是图」本身就是「它没在宿主里算」的证据。三份输入也要点清：远端发来的字节
/// 必须**原样**摆过去（先在宿主里压成 PNG 的话，动图就只剩第一帧了）。
#[test]
fn the_centers_dlssnr_op_goes_through_the_worker() {
    let sandbox = Sandbox::new("center-dlssnr");
    let feature = fake_feature(&sandbox);
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起计算编排");

    let page = page_png();
    let params = ProcessParams {
        chain: Vec::new(),
        op: "dlssnr".into(),
        model_id: None,
        scale: None,
        dlssnr: None,
    };
    let bytes = process(Some(&manager), &sandbox.root, &sandbox.root, &params, &page, &|| false)
        .expect("回声引擎这一轮不该失败");
    let staged = staged_inputs(&sandbox);
    let jobs = manager.all_jobs();
    manager.shutdown();

    let line = String::from_utf8(bytes).expect("回声产物是一行 UTF-8 文本");
    assert!(
        line.starts_with("echo stage=dlssnr "),
        "算力中心没把这一页交给 worker：{line}"
    );
    let page_hash = blake3::hash(&page).to_hex().to_string();
    assert_eq!(
        echo_field(&line, "input="),
        format!("remote:{page_hash}"),
        "这一页不是算力中心那条来路进来的：{line}"
    );
    assert_eq!(
        staged.len(),
        3,
        "只读输入根里该正好是这三样（一页、一套参数、一份片段）：{} 份",
        staged.len()
    );
    assert!(
        staged.contains(&page),
        "远端发来的字节没被原样摆到引擎手边（先在宿主里压成 PNG 的话，动图就只剩第一帧了）"
    );
    assert!(
        staged.contains(&std::fs::read(&feature).expect("读那一份假片段")),
        "那一份片段没被摆进只读输入根"
    );
    assert_eq!(jobs.len(), 1, "该只有一件任务：{jobs:?}");
    assert_eq!(jobs[0].state, JobState::Completed, "任务没算完就算出了结果");
}

/// 一份「已装好的片段」：宿主只对它算哈希、只按内容摆文件，回声引擎也不会去载它。
fn fake_feature(sandbox: &Sandbox) -> PathBuf {
    let dll = sandbox.root.join("dlssnr").join("nvngx_dlssnr.dll");
    std::fs::create_dir_all(dll.parent().expect("片段目录")).expect("建片段目录");
    std::fs::write(&dll, vec![0u8; 4096]).expect("写假片段");
    dll
}

/// 只读输入根里所有文件的字节。按**内容**清点，不看名字——名字就是内容哈希，名字对了
/// 只说明宿主会算哈希，字节对了才说明摆进去的真是那三样东西。
fn staged_inputs(sandbox: &Sandbox) -> Vec<Vec<u8>> {
    fn walk(dir: &Path, out: &mut Vec<Vec<u8>>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if let Ok(bytes) = std::fs::read(&path) {
                out.push(bytes);
            }
        }
    }
    let mut out = Vec::new();
    walk(&inputs_root_for(&sandbox.staging), &mut out);
    out
}

fn dlssnr_job<'a>(
    feature: &'a Path,
    settings: &'a DlssnrSettings,
    page: &'a [u8],
) -> DlssnrJob<'a> {
    DlssnrJob {
        input_id: "scope-a:archive-a:0",
        settings_id: "dlssnr-out:v3:test",
        source_revision: "reader-page",
        priority: Priority::Foreground,
        stage_id: proxy::DLSSNR_STAGE_ID,
        feature,
        settings,
        page,
    }
}

/// 宿主那条 DLSSNR 产品路径的字节桥：一页、一套参数、一份片段三样都按内容摆进只读输入根，
/// 由 worker 算（NGX 只在那边初始化）。
///
/// 回声引擎在这里正好当判官：它不认参数也不载片段，但它会把「引擎手边那份输入是谁」写进
/// 产物。所以这一条不需要真 DLL 与真显卡，就能证明三样东西确实从宿主摆到了 worker 手边。
#[test]
fn the_dlssnr_stage_carries_the_page_the_settings_and_the_feature_to_the_worker() {
    let sandbox = Sandbox::new("dlssnr");
    let feature = fake_feature(&sandbox);
    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起计算编排");

    let page = page_png();
    let settings = DlssnrSettings::default();
    let outcome = proxy::dlssnr(
        &manager,
        dlssnr_job(&feature, &settings, &page),
        &|| false,
    )
    .expect("回声引擎这一轮不该失败");
    let jobs = manager.all_jobs();
    manager.shutdown();

    let staged = staged_inputs(&sandbox);
    assert_eq!(
        staged.len(),
        3,
        "只读输入根里该正好是这三样（一页、一套参数、一份片段）：{} 份",
        staged.len()
    );
    assert!(
        staged.contains(&page),
        "这一页没被摆进只读输入根：{:?}",
        staged.iter().map(|bytes| bytes.len()).collect::<Vec<_>>()
    );
    assert!(
        staged.contains(&std::fs::read(&feature).expect("读回假片段")),
        "那一份片段没被摆进只读输入根"
    );
    assert!(
        staged.contains(&settings.to_json().into_bytes()),
        "那一套参数没被摆进只读输入根"
    );

    let line = String::from_utf8(outcome.bytes).expect("回声产物是一行 UTF-8 文本");
    assert!(
        line.starts_with("echo stage=dlssnr "),
        "这一页没走到 DLSSNR 那一档：{line}"
    );
    assert_eq!(
        echo_field(&line, "input="),
        "scope-a:archive-a:0",
        "引擎手边那一件不是这次提交的：{line}"
    );
    assert_eq!(
        echo_field(&line, "granted="),
        format!(
            "{}/{}.png",
            &blake3::hash(&page).to_hex().to_string()[..2],
            blake3::hash(&page).to_hex()
        ),
        "引擎手边的不是这一页：{line}"
    );
    assert!(outcome.computed, "回声引擎算过了，宿主不该当它没算：{line}");
    assert_eq!(jobs.len(), 1, "该只有一件任务：{jobs:?}");
    assert_eq!(jobs[0].state, JobState::Completed, "任务没算完就算出了结果");
}

/// 「这一页没算过」这件事全凭 worker 的交代：它自报 `passthrough` 时，宿主必须把字节按
/// 「没算过」处理。
///
/// 为什么值得一条端到端的用例：DLSSNR 会在「两次评估都与输入逐像素相同」时原图交回，而
/// 按「DLSSNR 的输出」把它写进产物缓存，等于把「没处理过」固化下来——那一页会一直停在
/// 未处理的样子。判据一旦接不上（比如拿 `engine_id` 时取错了栏），这条链上没有任何别的
/// 地方会发现。
#[test]
fn a_page_the_worker_handed_back_is_not_counted_as_computed() {
    let sandbox = Sandbox::new("dlssnr-passthrough");
    let feature = fake_feature(&sandbox);
    let mut config = config(&sandbox);
    // 只在这个用例里开：让回声引擎的报告自称 `passthrough`（真实引擎只在那一种局面下这么报，
    // 而那种局面不是测试能稳定造出来的）。
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_PASSTHROUGH".to_string(),
        "1".to_string(),
    )];
    let manager = ComputeManager::start(config, no_events()).expect("起计算编排");

    let page = page_png();
    let settings = DlssnrSettings::default();
    let outcome = proxy::dlssnr(&manager, dlssnr_job(&feature, &settings, &page), &|| false)
        .expect("原样交回不是失败");
    manager.shutdown();

    let line = String::from_utf8(outcome.bytes).expect("回声产物是一行 UTF-8 文本");
    assert!(
        line.starts_with("echo stage=dlssnr "),
        "这一页没走到 DLSSNR 那一档：{line}"
    );
    assert!(
        !outcome.computed,
        "worker 说这一页没算过，宿主却当它算过了（会被写进产物缓存）：{line}"
    );
}

/// 随包那一份片段在哪（与 `worker/src/dlssnr.rs` 的 `shipped_dll()` 同一套候选）。
fn shipped_feature() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("YOMIKA_DLSSNR_DLL") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut at = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while at.pop() {
        let base = at.join("docs").join("DLSSNR-DLL-Options-310.8.0.0");
        if base.is_dir() {
            for variant in ["NVIDIA-Original", "Community-RTX40-RTX50", "SF-v2"] {
                let candidate = base.join(variant).join("nvngx_dlssnr.dll");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            return None;
        }
    }
    None
}

/// 一张确定性的高频噪声 PNG（LCG，不依赖随机源）。
///
/// 为什么不用棋盘格：NGX 在平坦或强规律的图上会把原图原样交回（`filter::PASSTHROUGH`），
/// 那时 `DlssnrOutput::computed` 是假，用例就测不到「NGX 真跑过」这件事。
fn noise_page(width: u32, height: u32) -> Vec<u8> {
    use image::ImageEncoder;
    let mut rgba = Vec::with_capacity((width as usize) * (height as usize) * 4);
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    for _ in 0..(width as usize) * (height as usize) {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let byte = (state >> 33) as u8;
        rgba.extend_from_slice(&[byte, byte.wrapping_add(85), byte.wrapping_add(170), 255]);
    }
    let mut page = Vec::new();
    image::codecs::png::PngEncoder::new(&mut page)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .expect("编一张噪声 PNG");
    page
}

/// 真显卡这一条：从**宿主 spawn 出去的 worker** 里初始化 NGX，再让 NGX 算一页。
///
/// 为什么非得走宿主这一条路：2026-10-08 用户报「DLSSNR 依然错误」，日志原文是
/// `NGX 核心初始化失败：平台错误（驱动、系统库或 NvAPI）（0xBAD00002）`。查下来既不是
/// 片段变体（用户那份与仓库 `NVIDIA-Original` 逐字节相同），也不是显卡跑不动（进程内那条
/// 真片段用例一直绿），而是**宿主给 worker 的环境白名单**：NVIDIA 的运行库会拿
/// `SystemDrive` 拼路径，白名单里只给 `SystemRoot` + `TEMP` 就必然是 0xBAD00002
/// （清空环境只补这一个变量就过，四档实测见 `docs/136`）。进程内的用例带着完整环境，
/// 这一条它永远看不见——所以判据必须落在「宿主自己 spawn 出来的那个进程」上。
///
/// 机器上没有片段时跳过：与 `worker/src/dlssnr.rs` 那条真片段用例同一口径。
#[test]
fn the_worker_this_host_spawns_can_initialise_ngx_and_compute_a_page() {
    let Some(source) = shipped_feature() else {
        eprintln!("跳过：读不到 nvngx_dlssnr.dll（YOMIKA_DLSSNR_DLL 或 docs/DLSSNR-DLL-Options-310.8.0.0）");
        return;
    };
    let sandbox = Sandbox::new("dlssnr-gpu");
    let feature = sandbox.root.join("dlssnr").join("nvngx_dlssnr.dll");
    std::fs::create_dir_all(feature.parent().expect("片段目录")).expect("建片段目录");
    std::fs::copy(&source, &feature).expect("拷一份真片段");
    let mut config = config(&sandbox);
    // 真引擎：DLSSNR 只在 worker 那边初始化 NGX（宿主产品码里没有一条进重引擎的路）。
    config.worker_engine = WorkerEngine::Onnx;
    let manager = ComputeManager::start(config, no_events()).expect("起计算编排");

    let page = noise_page(256, 256);
    let settings = DlssnrSettings::default();
    let outcome = proxy::dlssnr(&manager, dlssnr_job(&feature, &settings, &page), &|| false);
    let jobs = manager.all_jobs();
    let status = manager.worker_status();
    let note = jobs.first().and_then(|job| manager.failure_note(&job.job_id));
    manager.shutdown();

    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => panic!("这一页没算成：{error:?}\n计算进程状态：{status:?}\nworker 原话：{note:?}\n任务：{jobs:?}"),
    };
    assert_eq!(jobs.len(), 1, "该只有一件任务：{jobs:?}");
    assert_eq!(jobs[0].state, JobState::Completed, "任务没算完就算出了结果");
    assert!(
        outcome.computed,
        "NGX 把原图原样交回了 —— 那说明这一页根本没进 NGX"
    );
    let decoded = image::load_from_memory(&outcome.bytes).expect("产物该是一张图");
    assert_eq!(
        (decoded.width(), decoded.height()),
        (256, 256),
        "产物尺寸变了"
    );
}
