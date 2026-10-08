//! 去码那条路的真进程闭环（docs/71 §11 Task 8-b、8-f）。
//!
//! `compute_manager.rs` 证明的是协议闭环（回声引擎）、`compute_model_chain.rs` 证明的是
//! 超分那条产品路径。这里证明的是**去码**：宿主把「这一页」交给 worker，worker 自己拿这一页
//! 的像素跑检测器算出要补哪些框，再用真的 DeepCreamPy 修补图跑出一张尺寸不变、框外一个字节
//! 都没动过的 PNG。8-f 之后还多一条：指名了超分模型时这是**一条链**（去码 → 超分），
//! 一次提交交回**两件产物**。
//!
//! 三件事让这条测试必须有：
//! ① 掩膜是几百 KB（`width×height` 的 0/1），而协议一帧只收 64 KiB ⇒ 它**从来不过协议**：
//!    worker 手里有这一页的像素，也有一份恒跑 CPU 的检测器（`docs/94`），于是它自己算。
//! ② 修补的几何在核心（Task 8-a 搬的），执行在 worker。两边一旦分叉，症状是「某些页面的
//!    窗口偏了」——最像模型问题、最该早就发现的那一类。
//! ③ 链上第二阶段的输入是第一阶段那份被逐件核验过的产物（`StageInput::Previous`）：两阶段
//!    必须在同一件任务里，因为 compute 的产物只有内容寻址的落点、没有缓存行。
//!
//! 检测器在夹具里默认是**占位文件**，要跑起来的用例得自己换：`install_stub_detector`
//! （`scripts/compute/make_stub_detector.py` 造的桩，钉接线）或 `install_real_detector`
//! （本机那份 254 MB 的真 Mask R-CNN，证明它真的能在 worker 里跑起来）。真模型素材不进仓库，
//! 所以本机没有就**明说**跳过，不假装测过。

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use yomika_lib::compute::decensor::{into_request, plan_decensor_page, DecensorPageRequest};
use yomika_lib::compute::manager::{
    no_events, ComputeManager, SourceFile, SubmitRequest, SupervisorConfig, WorkerEngine,
};
use yomika_lib::compute::models::ModelCatalog;
use yomika_lib::compute::reader::{plan_reader_page, ReaderPageRequest};
use yomika_lib::compute::scheduler::{JobState, Priority};

/// 真 ONNX 会话 + 一页 256×256 的修补：第一次开模型要几秒，给足。
const HANDOFF: Duration = Duration::from_secs(180);

/// 页面 320×240：长边 320 ≥ 修补窗口下限 256，所以两个框都能拿到完整窗口。
const PAGE_WIDTH: u32 = 320;
const PAGE_HEIGHT: u32 = 240;

/// 横条框与马赛克框：一个阶段里混着两种，正是「两份模型都必须给」的理由。
const BAR_BOX: (u32, u32, u32, u32) = (40, 40, 64, 24);
const MOSAIC_BOX: (u32, u32, u32, u32) = (200, 120, 48, 48);

const BUNDLE_ID: &str = "aletheia-lens";

/// 真模型素材在哪：产品里那是用户装上的数据目录，这里指向本机那份 Aletheia-Lens 安装。
fn bundle_source() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/Aletheia-Lens/_internal/models");
    let bar = root.join("deepcreampy/bar.onnx");
    let mosaic = root.join("deepcreampy/mosaic.onnx");
    match (bar.is_file(), mosaic.is_file()) {
        (true, true) => Some(root),
        _ => {
            eprintln!(
                "跳过：本机没有去码模型包（{} 或 {} 不在）",
                bar.display(),
                mosaic.display()
            );
            None
        }
    }
}

/// 真超分模型素材在哪（与 `compute_model_chain.rs` 同一份来路）：本机没有就**明说**跳过。
fn local_upscaler(name: &str) -> Option<Vec<u8>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../docs/models")
        .join(format!("{name}.onnx"));
    match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            eprintln!("跳过链式那一条：本机没有 {}（{error}）", path.display());
            None
        }
    }
}

/// worker 可执行文件：测试自己的路径是 `target/<profile>/deps/xxx.exe`，反推得到
/// `target/<profile>`。**每次都先编一遍**，否则会拿上一轮的旧 worker 跑。
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
    // `--target-dir` 必须**显式**给，而且给的就是测试二进制所在的那个 target 目录。
    //
    // 不给会踩一个很安静的坑：cargo 跑集成测试时把子进程的工作目录设成**包目录**
    // （`src-tauri/`），于是 `CARGO_TARGET_DIR` 这种相对路径会被解析到另一棵树
    // （`src-tauri/debug_outputs/cargo-target/`）——worker 编在那里，而上面那句
    // `profile_dir.join("yomika-compute-worker.exe")` 找的是**测试二进制旁边**那个。
    // 两边错开之后，这一轮新编出来的 worker 一次也不会被跑到，测试跑的是上一次谁在这棵
    // 树里留下的旧 worker（第 19 轮实测：一整轮 4 条用例全红成 `COMPUTE_WORKER_LOST`，
    // 因为旧 worker 不认 `decensor` 授权；另跑一次 `cargo test -p yomika-compute-worker`
    // 把旧 worker 换掉之后又全绿——正是「编的地方和跑的地方不是一个」的症状）。
    let target_dir = profile_dir
        .parent()
        .expect("target 目录是 <target>/<profile> 的父目录");
    let mut command = ProcessCommand::new(env!("CARGO"));
    command
        .arg("build")
        .arg("--target-dir")
        .arg(target_dir)
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
            "yomika-decensor-chain-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }

    /// 造一份「已安装的去码包」：`models/<id>/` 下四份文件齐活——`installed_models_in` 认的
    /// 就是这个形状（它不看清单）。
    ///
    /// 检测器与 ESRGAN 是占位文件，等用例自己换：**检测器现在真的会被打开**（检测搬进 worker
    /// 了，docs/94），所以每条要跑起来的用例都得先 `install_stub_detector` 或
    /// `install_real_detector`，否则 worker 第一步就倒在一段打不开的字节上。两份修补模型是真的
    /// （硬链接优先，跨盘就复制）——它们才是这一轮要跑的东西。
    fn install_bundle(&self, source: &Path) {
        let install = self.root.join("models").join(BUNDLE_ID);
        let files: [(&str, Option<PathBuf>); 4] = [
            ("mrcnn/weights.onnx", None),
            ("deepcreampy/bar.onnx", Some(source.join("deepcreampy/bar.onnx"))),
            (
                "deepcreampy/mosaic.onnx",
                Some(source.join("deepcreampy/mosaic.onnx")),
            ),
            ("esrgan/4x-Fatal-Pixels.onnx", None),
        ];
        for (relative, real) in files {
            let target = install.join(relative);
            std::fs::create_dir_all(target.parent().expect("有父目录")).expect("建包目录");
            match real {
                Some(path) => {
                    if std::fs::hard_link(&path, &target).is_err() {
                        std::fs::copy(&path, &target).expect("复制真模型");
                    }
                }
                None => std::fs::write(&target, b"placeholder-never-opened").expect("写占位文件"),
            }
        }
    }

    /// 把包里的检测器换成一份**桩**（`scripts/compute/make_stub_detector.py` 造的）。
    ///
    /// 为什么要桩而不是用真 Mask R-CNN：真模型在一张合成页上找得到什么，是**模型的性质**；
    /// 而这些用例要证的是**接线**——「一个框都没有」是一个成功的终局，「两个框」会把两份修补
    /// 模型都拉起来。桩把这两句话变成确定的前提（恒空 / 恰好一个横条框 / 恰好一横条一马赛克）。
    fn install_stub_detector(&self, stub: &str) {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(stub);
        assert!(
            source.is_file(),
            "桩检测器不在 {}：先跑 scripts/compute/make_stub_detector.py",
            source.display()
        );
        let target = self.detector();
        std::fs::remove_file(&target).expect("去掉占位文件");
        std::fs::copy(&source, &target).expect("装桩检测器");
    }

    /// 把真的 Mask R-CNN 装进沙箱（覆盖那份占位文件）。
    ///
    /// 254 MB：同盘就硬链接，跨盘只能复制。硬链接**之后**要小心：往这个路径里写字节会改到
    /// `docs/` 里那份夹具（同一个 inode），所以只有「换掉整份文件」才用得上 `remove_file`。
    fn install_real_detector(&self, source: &Path) {
        let real = source.join("mrcnn/weights.onnx");
        assert!(
            real.is_file(),
            "真检测器不在 {}：这条测试要它",
            real.display()
        );
        let target = self.root.join("models").join(BUNDLE_ID).join("mrcnn/weights.onnx");
        std::fs::remove_file(&target).expect("去掉占位文件");
        if std::fs::hard_link(&real, &target).is_err() {
            std::fs::copy(&real, &target).expect("复制真检测器");
        }
    }

    /// 把装好的马赛克模型换成一段打不开的字节。
    ///
    /// 先 `remove_file` 再写：装的时候是**硬链接**，直接写进去会把 `docs/Aletheia-Lens/`
    /// 里那份真夹具一起改掉（同一个 inode）。删掉链接只少一个名字，源头不动。
    fn break_mosaic(&self) {
        let path = self.mosaic();
        std::fs::remove_file(&path).expect("去掉链接");
        std::fs::write(&path, b"not-an-onnx-model").expect("写坏的马赛克模型");
    }

    fn bar(&self) -> PathBuf {
        self.root
            .join("models")
            .join(BUNDLE_ID)
            .join("deepcreampy/bar.onnx")
    }

    /// 造一份「已安装的超分模型」：`models/<id>/1/` 里一份清单 + 一份 ONNX。
    ///
    /// 与 `compute_model_chain.rs` 里那份同一形状（也是产品下载/解压最后留下的形状），
    /// 模型字节是真材实料——链的第二个阶段要在 worker 里把它开起来。
    fn install_upscaler(&self, id: &str, bytes: &[u8], min_input_edge: u32) {
        let install = self.root.join("models").join(id).join("1");
        std::fs::create_dir_all(&install).expect("建模型安装目录");
        std::fs::write(install.join("model.onnx"), bytes).expect("写超分模型");
        let manifest = serde_json::json!({
            "id": id,
            "version": "1",
            "format": "onnx",
            "scale": 2,
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

    fn mosaic(&self) -> PathBuf {
        self.root
            .join("models")
            .join(BUNDLE_ID)
            .join("deepcreampy/mosaic.onnx")
    }

    /// 装好的检测器。它现在是**worker** 要打开的第一份文件（检测搬进 worker 了，docs/94）。
    fn detector(&self) -> PathBuf {
        self.root
            .join("models")
            .join(BUNDLE_ID)
            .join("mrcnn/weights.onnx")
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
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    config.models = Some(ModelCatalog::new(&sandbox.root));
    config.worker_engine = WorkerEngine::Onnx;
    config
}

/// 一张「已经被遮过的」页：底色是斜渐变（模型有东西可借），横条框涂成纯黑（产品里横条
/// 就是这么打码的），马赛克框里是 8×8 高对比块。
fn make_page(path: &Path) {
    let mut image = gradient();
    let (bx, by, bw, bh) = BAR_BOX;
    for y in by..by + bh {
        for x in bx..bx + bw {
            image.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
        }
    }
    let (mx, my, mw, mh) = MOSAIC_BOX;
    for y in my..my + mh {
        for x in mx..mx + mw {
            let block = ((x - mx) / 8 + (y - my) / 8) % 2 == 0;
            let value = if block { 24 } else { 232 };
            image.put_pixel(x, y, image::Rgba([value, value, value, 255]));
        }
    }
    image.save(path).expect("存源图 PNG");
}

/// 同一张底色、**不带任何遮挡**：用来量「检测器在干净页上会不会凭空找出框」。
///
/// 这个问题不是学术性的：`prepare_decensor_page` 把「一个框都没有」当成一个**成功的终局**
/// （原页就是答案）。如果检测器在干净页上会瞎找，那这个终局就会被一张假框的修补结果顶掉——
/// 用户看到的是原页被改花了。
fn make_clean_page(path: &Path) {
    gradient().save(path).expect("存干净页 PNG");
}

fn gradient() -> image::RgbaImage {
    let mut image = image::RgbaImage::new(PAGE_WIDTH, PAGE_HEIGHT);
    for y in 0..PAGE_HEIGHT {
        for x in 0..PAGE_WIDTH {
            let r = (x * 255 / (PAGE_WIDTH - 1)) as u8;
            let g = (y * 255 / (PAGE_HEIGHT - 1)) as u8;
            let b = ((x + y) % 256) as u8;
            image.put_pixel(x, y, image::Rgba([r, g, b, 255]));
        }
    }
    image
}

/// 一条产品入口：身份由 `plan_decensor_page` 铸，输入位置与哈希由这一侧量。
///
/// **检测集不在这里**：worker 拿到这一页之后自己算（docs/94），所以这条产线路上再没有
/// 「框从哪儿来」这一栏。
fn request(model_id: &str, page: &Path) -> SubmitRequest {
    submit_of(plan_request(model_id, None), page)
}

/// 一条**链**（去码 → 超分）的产品入口：两阶段在同一件任务里，`settings_id` 也换成链的答案
/// （`enhanced` 那一版）。
fn chained_request(decensor_id: &str, upscale_id: &str, page: &Path) -> SubmitRequest {
    submit_of(plan_request(decensor_id, Some(upscale_id)), page)
}

/// 阅读器那条路的产品入口：前端只说得出「哪一页 + 哪个模型」，身份由宿主铸（`plan_reader_page`）。
///
/// 只含**超分**一个阶段——阅读器不提交去码，那是另一条来路。
fn reader_request(model_id: &str, page: &Path) -> SubmitRequest {
    let job = plan_reader_page(
        page.parent().expect("页面有父目录"),
        &ReaderPageRequest {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 7,
            model_id: model_id.to_string(),
            generation: 1,
            priority: Priority::Foreground,
            deadline_ms: 0,
        },
    )
    .expect("超分包装好了，身份铸得出来");
    let (byte_length, content_hash) =
        yomika_lib::compute::artifacts::hash_file(page).expect("源图读得出来");
    yomika_lib::compute::reader::into_request(
        job,
        SourceFile {
            path: page.to_path_buf(),
            content_hash,
            byte_length,
        },
    )
}

fn plan_request(decensor_id: &str, upscale_id: Option<&str>) -> DecensorPageRequest {
    DecensorPageRequest {
        scope_id: "scope-a".to_string(),
        archive_id: "archive-a".to_string(),
        page_index: 7,
        model_id: decensor_id.to_string(),
        upscale_model_id: upscale_id.map(str::to_string),
        generation: 1,
        priority: Priority::Foreground,
        deadline_ms: 0,
    }
}

fn submit_of(request: DecensorPageRequest, page: &Path) -> SubmitRequest {
    // 数据根就是这个沙箱：模型装在它下面的 `models/`，与产品路径同一套布局。
    let job = plan_decensor_page(&page.parent().expect("页面有父目录").to_path_buf(), &request)
        .expect("去码包装好了，身份铸得出来");
    let (byte_length, content_hash) =
        yomika_lib::compute::artifacts::hash_file(page).expect("源图读得出来");
    into_request(
        job,
        SourceFile {
            path: page.to_path_buf(),
            content_hash,
            byte_length,
        },
    )
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

/// 框里有多少个像素真的被改过。`inpaint_detections` 的判据是「只贴被遮像素」，
/// 所以框外必须是 0（下面的断言就是这么用的）。
fn differing_inside(
    produced: &image::RgbaImage,
    source: &image::RgbaImage,
    box_: (u32, u32, u32, u32),
) -> usize {
    let (x0, y0, w, h) = box_;
    let mut count = 0;
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let left = produced.get_pixel(x, y).0;
            let right = source.get_pixel(x, y).0;
            if left.iter().zip(right.iter()).any(|(a, b)| a != b) {
                count += 1;
            }
        }
    }
    count
}

/// 框外有多少个像素被动过——**必须是 0**。
fn differing_outside(
    produced: &image::RgbaImage,
    source: &image::RgbaImage,
    boxes: [(u32, u32, u32, u32); 2],
) -> usize {
    let mut count = 0;
    for y in 0..produced.height() {
        for x in 0..produced.width() {
            let inside = boxes.iter().any(|(x0, y0, w, h)| {
                x >= *x0 && x < x0 + w && y >= *y0 && y < y0 + h
            });
            if inside {
                continue;
            }
            let left = produced.get_pixel(x, y).0;
            let right = source.get_pixel(x, y).0;
            if left.iter().zip(right.iter()).any(|(a, b)| a != b) {
                count += 1;
            }
        }
    }
    count
}

/// 主闭环：真页面 + **真 worker 自己检测** + 真 bar/mosaic → 尺寸不变、框外逐字节不动、
/// 框内真的被补过。
///
/// 检测器换成了桩 `detector-both.onnx`：它恰好报出这一页上那两处遮挡（横条 (40,40) 64×24、
/// 马赛克 (200,120) 48×48），于是「两份修补模型都被真的用到」这句话由桩指定，不由模型的性质
/// 决定。检测本身在这一轮是**真跑**的：模型在 worker 进程里被 ORT 打开、推理、解码。
#[test]
fn the_worker_de_censors_a_real_page_with_both_models() {
    let Some(source) = bundle_source() else {
        return;
    };
    let sandbox = Sandbox::new("chain");
    sandbox.install_bundle(&source);
    sandbox.install_stub_detector("detector-both.onnx");
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request(BUNDLE_ID, &page))
        .expect("应该收下这件任务");
    let state = wait_until("真修补跑完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "应该是补完了，而不是回声或失败");

    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "一个阶段一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "onnx", "真要跑模型，不是回声");
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH, PAGE_HEIGHT),
        "修补不改尺寸：进多少像素出多少像素"
    );
    assert!(
        artifact.pipeline_revision.starts_with("worker-v1:"),
        "revision 由这一份 run 派生：{}",
        artifact.pipeline_revision
    );

    // 四份东西走**同一条**输入根：这一页 + 检测器 + 两份修补模型。掩膜不在里面了——
    // 它是 worker 自己算的（docs/94），输入根里再没有 `.bin`。
    let inputs = yomika_lib::compute::inputs::inputs_root_for(&sandbox.staging);
    let blobs = input_blobs(&inputs);
    let lengths: Vec<u64> = blobs.iter().map(|(_, length)| *length).collect();
    let bar_bytes = std::fs::metadata(sandbox.bar()).expect("bar 在").len();
    let mosaic_bytes = std::fs::metadata(sandbox.mosaic()).expect("mosaic 在").len();
    let detector_bytes = std::fs::metadata(sandbox.detector()).expect("检测器在").len();
    for (what, length) in [
        ("检测器", detector_bytes),
        ("横条模型", bar_bytes),
        ("马赛克模型", mosaic_bytes),
        ("这一页", std::fs::metadata(&page).expect("源图").len()),
    ] {
        assert!(
            lengths.contains(&length),
            "{what}该在输入根里（{length} 字节）：{lengths:?}"
        );
    }
    assert_eq!(
        blobs
            .iter()
            .filter(|(path, _)| path.extension().is_some_and(|ext| ext == "bin"))
            .count(),
        0,
        "输入根里不该再有掩膜：检测搬进 worker 之后没有任何人把它交给别人：{blobs:?}"
    );

    // 像素级证据：框外一个字节都没动，框内真的被补过。
    let produced_bytes = std::fs::read(&artifact.path).expect("读产物");
    assert!(
        produced_bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "产物该是真 PNG"
    );
    let produced = image::load_from_memory(&produced_bytes)
        .expect("按内容解码产物")
        .to_rgba8();
    let original = image::open(&page).expect("读源图").to_rgba8();
    let outside = differing_outside(&produced, &original, [BAR_BOX, MOSAIC_BOX]);
    let inside_bar = differing_inside(&produced, &original, BAR_BOX);
    let inside_mosaic = differing_inside(&produced, &original, MOSAIC_BOX);
    assert_eq!(
        outside, 0,
        "框外的像素必须原样回来：模型只许写被遮的那一块（动了 {outside} 个）"
    );
    assert!(
        inside_bar > 0,
        "横条框里一个像素都没变：模型没跑，或者补出来的正好是原样"
    );
    assert!(
        inside_mosaic > 0,
        "马赛克框里一个像素都没变：马赛克模型没被真的开起来"
    );

    eprintln!(
        "去码链条：检测器 {} 字节（worker 自己跑）+ bar {} 字节 + mosaic {} 字节 → 产物 {} 字节，{}×{} 不变；框外被动过 {outside} 个像素，框内改过 {}（横条）/ {}（马赛克）个；engine={} 精度={} 政策={:?} 回退={:?} revision={}；输入根 {} 个 blob",
        detector_bytes,
        bar_bytes,
        mosaic_bytes,
        produced_bytes.len(),
        produced.width(),
        produced.height(),
        inside_bar,
        inside_mosaic,
        artifact.engine_id,
        artifact.engine_precision,
        artifact.engine_policy,
        artifact.engine_fallback,
        artifact.pipeline_revision,
        blobs.len(),
    );

    manager.shutdown();
}

/// 链：**一件任务两个阶段**（去码 → 超分），一次交回两件产物。
///
/// 这是 8-f 的核心闭环。它在真进程里证明三件事：
/// ① 第二阶段的输入是第一阶段那份产物（尺寸从 320×240 变成 640×480，第二件的哈希与第一件
///    不同——它读的是一张已经被补过的图，不是原页）；
/// ② 两件产物都被宿主逐件核验过、都落在内容寻址的缓存位置（`publish_root` 那一侧）；
/// ③ 两件产物各带自己的 `stage_id`，所以前端能「先显示去码那一版，再换成放大那一版」。
///
/// 检测器用桩（`detector-both.onnx`）：这一条要证的是**链**，不是「模型在一张合成页上找得到
/// 什么」——那是模型的性质，另有真检测器那条用例盯着。
#[test]
fn the_chain_de_censors_and_then_upscales_into_two_artifacts() {
    let Some(source) = bundle_source() else {
        return;
    };
    let Some(model_bytes) = local_upscaler("realcugan-2x-conservative") else {
        return;
    };
    let sandbox = Sandbox::new("chain-upscale");
    sandbox.install_bundle(&source);
    sandbox.install_stub_detector("detector-both.onnx");
    sandbox.install_upscaler("realcugan-2x-conservative", &model_bytes, 20);
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(chained_request(
            BUNDLE_ID,
            "realcugan-2x-conservative",
            &page,
        ))
        .expect("应该收下这条链");
    let state = wait_until("链的两个阶段都跑完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(state, JobState::Completed, "两阶段都该跑完，而不是回声或失败");

    let artifacts = manager.job_artifacts(&submitted.job_id);
    let stages: Vec<String> = artifacts
        .iter()
        .map(|artifact| artifact.stage_id.clone())
        .collect();
    assert_eq!(
        artifacts.len(),
        2,
        "两个阶段两件产物（每件都有自己的 stage_id）：{stages:?}"
    );
    let decensor = artifacts
        .iter()
        .find(|artifact| artifact.stage_id == "decensor")
        .unwrap_or_else(|| panic!("缺第一步的产物：{stages:?}"));
    let upscale = artifacts
        .iter()
        .find(|artifact| artifact.stage_id == "upscale")
        .unwrap_or_else(|| panic!("缺第二步的产物：{stages:?}"));
    for artifact in [decensor, upscale] {
        assert!(artifact.verified, "宿主必须自己核过每一件：{artifact:?}");
        assert_eq!(artifact.engine_id, "onnx", "真要跑模型，不是回声");
        assert!(
            artifact.cache_relative.is_some(),
            "配了发布根的产物该落在内容寻址的缓存位置：{artifact:?}"
        );
    }
    assert_eq!(
        (decensor.width, decensor.height),
        (PAGE_WIDTH, PAGE_HEIGHT),
        "修补不改尺寸：进多少像素出多少像素"
    );
    assert_eq!(
        (upscale.width, upscale.height),
        (PAGE_WIDTH * 2, PAGE_HEIGHT * 2),
        "第二步吃的是第一步那份产物，2× 放大"
    );
    assert_ne!(
        upscale.content_hash, decensor.content_hash,
        "第二步读的必须是第一步那份产物（一张已经被补过的图），不是原页"
    );
    assert_ne!(
        upscale.content_hash,
        yomika_lib::compute::artifacts::hash_file(&page)
            .expect("源图读得回来")
            .1,
        "第二件产物要是原页 2×，那这条链就没接上——它是把原页又放大了一遍"
    );

    // 产物落在**内容寻址**的位置（`cache/images/xx/<hash>.bin`），扩展名说明不了格式：
    // 按内容解码，不按文件名。
    let upscale_bytes = std::fs::read(&upscale.path).expect("读第二件产物");
    assert!(
        upscale_bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "链的答案该是真 PNG"
    );
    let produced = image::load_from_memory(&upscale_bytes)
        .expect("按内容解码第二件产物")
        .to_rgba8();
    assert_eq!(
        (produced.width(), produced.height()),
        (PAGE_WIDTH * 2, PAGE_HEIGHT * 2),
        "链的答案是放大那一张"
    );

    eprintln!(
        "链式两阶段：第一步 {}×{}（{} 字节）revision={}；第二步 {}×{}（{} 字节）revision={}；两件都被核验过、都在缓存位置（{} / {}）；engine={} 政策={:?} 回退={:?}",
        decensor.width,
        decensor.height,
        std::fs::metadata(&decensor.path).map(|meta| meta.len()).unwrap_or(0),
        decensor.pipeline_revision,
        upscale.width,
        upscale.height,
        upscale_bytes.len(),
        upscale.pipeline_revision,
        decensor.cache_relative.as_deref().unwrap_or("<无>"),
        upscale.cache_relative.as_deref().unwrap_or("<无>"),
        upscale.engine_id,
        upscale.engine_policy,
        upscale.engine_fallback,
    );

    manager.shutdown();
}

/// 去码阶段没带三份模型：宿主在派发前就该拒。
///
/// 8-e 之前这里拒的是「没有检测集」；检测搬进 worker 之后，掩膜不再过协议，宿主手上只剩
/// 「这一页 + 检测器 + 两份修补模型」这一手。漏传的后果与从前一样糟：worker 拿着一条不知
/// 道用哪份模型的阶段，能干的事只有交回一张**仍然被遮**的图。
#[test]
fn a_decensor_stage_without_the_three_models_is_refused_before_dispatch() {
    let sandbox = Sandbox::new("no-detections");
    let page = sandbox.root.join("page.png");
    make_page(&page);

    // 手搭一条去码阶段（不经过 `plan_decensor_page`），故意把三份模型那一手留空：
    // 这正是「命令层漏传」会在产品里长出来的样子。
    let Some(source) = bundle_source() else {
        return;
    };
    sandbox.install_bundle(&source);
    let mut request = request(BUNDLE_ID, &page);
    request.inpaint = None;

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager.submit(request).expect("宿主收下这件任务");
    let state = wait_until("任务收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    match state {
        JobState::Failed { code } => {
            assert_eq!(code, "COMPUTE_INPUT_INVALID", "没有三份模型就是输入不对")
        }
        other => panic!("三份模型没给全必须失败，实际 {other:?}"),
    }
    assert!(manager.job_artifacts(&submitted.job_id).is_empty());
    manager.shutdown();
}

/// 只有横条框的一页**不需要**能打开的马赛克模型：worker 只开真的会用到的会话。
///
/// 判据是行为性的，不是「少开一份会话更快」那种成本性质——成本性质没有观测点，写成断言
/// 只是自欺。这里把装好的马赛克模型换成一段打不开的字节：谁无脑把两份模型都打开，这一页
/// 就会连横条都补不了；只有按框选模型，才会照样补完。
///
/// 桩 `detector-bar.onnx` 让「这一页只有横条框」成为确定前提（真模型在一张合成页上找到什么
/// 是模型的性质，不是这段接线要证的东西）。
#[test]
fn a_bar_only_page_does_not_need_a_readable_mosaic_model() {
    let Some(source) = bundle_source() else {
        return;
    };
    let sandbox = Sandbox::new("bar-only");
    sandbox.install_bundle(&source);
    sandbox.install_stub_detector("detector-bar.onnx");
    sandbox.break_mosaic();
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request(BUNDLE_ID, &page))
        .expect("应该收下这件任务");
    let state = wait_until("只补横条的一页跑完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "一页只有横条框，马赛克模型打不开也不该挡路（无脑开两份模型就会倒在这里）"
    );

    let artifacts = manager.job_artifacts(&submitted.job_id);
    let artifact = artifacts.first().expect("有一件产物");
    let produced = image::load_from_memory(&std::fs::read(&artifact.path).expect("读产物"))
        .expect("按内容解码产物")
        .to_rgba8();
    let original = image::open(&page).expect("读源图").to_rgba8();
    let inside_bar = differing_inside(&produced, &original, BAR_BOX);
    assert!(
        inside_bar > 0,
        "横条框里一个像素都没变：横条模型没被真的开起来"
    );

    eprintln!(
        "只补横条的一页：马赛克模型是一段打不开的字节（{} 字节），照样补完，框内改过 {inside_bar} 个像素；回退={:?}",
        std::fs::metadata(sandbox.mosaic()).expect("坏模型在").len(),
        artifact.engine_fallback,
    );

    manager.shutdown();
}

/// 一个框都没有的一页：**照样是一件任务**，而且原样回来。
///
/// 8-c 里「没有框」是宿主给出的一个终局（`NothingToRepair`，前端拿 `null`）。8-e 把检测搬进
/// worker 之后这句话就不成立了：宿主不再有资格看这一页的像素，也就没有资格说「不用补」。
/// 它只能把这一页交出去，由 worker 检测；worker 发现 0 个框是**成功的结论**，处置是「原样
/// 编码这一页交出去」——尺寸不变、像素逐点相同，仍然有一件产物、一份 CPU 报告。
///
/// 桩 `detector-none.onnx` 恒报背景行（`decode_detections` 见到 class 0 就停），于是这一条
/// 测的是那条分支本身，而不是模型在合成素材上碰巧找到几个框。
#[test]
fn a_page_the_detector_finds_nothing_in_comes_back_as_it_was() {
    let Some(source) = bundle_source() else {
        return;
    };
    let sandbox = Sandbox::new("nothing-to-repair");
    sandbox.install_bundle(&source);
    sandbox.install_stub_detector("detector-none.onnx");
    let page = sandbox.root.join("page.png");
    make_clean_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(request(BUNDLE_ID, &page))
        .expect("没有框的一页也是任务：宿主不再替 worker 下结论");
    let state = wait_until("原样交回", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "0 个框是结论，不是失败：{state:?}"
    );

    let artifacts = manager.job_artifacts(&submitted.job_id);
    assert_eq!(artifacts.len(), 1, "0 个框也交出一件产物");
    let artifact = artifacts.first().expect("有一件");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "onnx", "走的仍是真模型的编码路径");
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH, PAGE_HEIGHT),
        "原样交回也不许改尺寸"
    );
    assert!(
        artifact.engine_fallback.is_none(),
        "CPU 上的检测不需要回退：{:?}",
        artifact.engine_fallback
    );

    let produced = image::load_from_memory(&std::fs::read(&artifact.path).expect("读产物"))
        .expect("按内容解码产物")
        .to_rgba8();
    let original = image::open(&page).expect("读源图").to_rgba8();
    assert_eq!(produced.dimensions(), original.dimensions());
    let moved = produced
        .pixels()
        .zip(original.pixels())
        .filter(|(left, right)| left != right)
        .count();
    assert_eq!(
        moved, 0,
        "一个框都没有的时候，这一页必须逐点原样回来（动了 {moved} 个像素）"
    );

    eprintln!(
        "0 个框的一页：桩恒报背景 ⇒ 产物 {} 字节、{}×{}、逐点未动 {} 个像素；engine={} 政策={:?} 回退={:?}",
        std::fs::metadata(&artifact.path).expect("产物在").len(),
        produced.width(),
        produced.height(),
        moved,
        artifact.engine_id,
        artifact.engine_policy,
        artifact.engine_fallback,
    );

    manager.shutdown();
}

/// **真的 254 MB Mask R-CNN 在 worker 里被打开、推理、解码**，然后才轮到修补。
///
/// 这是 8-e 的出口条件在测试里的样子：检测器不再住在宿主进程里。这里**不**断言找到几个框
/// ——合成素材上真模型找到什么，是模型的性质，不是这段接线的性质（把它写成「必须找到 N 个」
/// 就是拿素材当被测对象）。要钉的是：一份 254 MB 的图被交进输入根、worker 打开它、跑完这条
/// 阶段、产物尺寸不变、报告说这是 CPU 上的一次 ONNX 阶段。
#[test]
fn the_worker_really_runs_the_real_detector_before_it_repairs() {
    let Some(source) = bundle_source() else {
        return;
    };
    let sandbox = Sandbox::new("real-detector");
    sandbox.install_bundle(&source);
    sandbox.install_real_detector(&source);
    let page = sandbox.root.join("page.png");
    make_page(&page);

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let started = Instant::now();
    let submitted = manager
        .submit(request(BUNDLE_ID, &page))
        .expect("应该收下这件任务");
    let state = wait_until("真检测器跑完", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    let elapsed = started.elapsed();
    assert_eq!(
        state,
        JobState::Completed,
        "真检测器 + 真修补整条链要跑通：{state:?}"
    );

    let artifacts = manager.job_artifacts(&submitted.job_id);
    let artifact = artifacts.first().expect("有一件产物");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    assert_eq!(artifact.engine_id, "onnx");
    assert_eq!(
        (artifact.width, artifact.height),
        (PAGE_WIDTH, PAGE_HEIGHT),
        "修补不改尺寸"
    );

    let produced = image::load_from_memory(&std::fs::read(&artifact.path).expect("读产物"))
        .expect("按内容解码产物")
        .to_rgba8();
    let original = image::open(&page).expect("读源图").to_rgba8();
    let moved = produced
        .pixels()
        .zip(original.pixels())
        .filter(|(left, right)| left != right)
        .count();

    eprintln!(
        "真检测器在 worker 里：{} 字节的 Mask R-CNN 走完一条阶段用了 {:.2?}；产物 {} 字节、{}×{}、被动过 {moved} 个像素（找到几个框由模型决定，这里不作断言）；政策={:?} 回退={:?} revision={}",
        std::fs::metadata(sandbox.detector()).expect("检测器在").len(),
        elapsed,
        std::fs::metadata(&artifact.path).expect("产物在").len(),
        produced.width(),
        produced.height(),
        artifact.engine_policy,
        artifact.engine_fallback,
        artifact.pipeline_revision,
    );

    manager.shutdown();
}

/// 动图那一页必须是**原字节交回**，不许被压成静态首帧（docs/71 §7.6）。
///
/// 8-g② 把阅读器整个翻到 compute 链上之后，链上每一环都只认得「一张图」：`probe_dimensions`
/// 拿解码器问尺寸，`encode_png` 恒出 PNG，而解码器在动图上只给第一帧。规格要的是「去码 /
/// 超分不适用动图时**原样保留动画**，不能变静态第一帧」——这条判定必须发生在任何解码与
/// 模型解析之前，所以它落在 worker 唯一的分派口上。
///
/// 两个容器各跑一遍（都由这一条助手跑完）：修之前它们红的样子不一样，说的却是同一件事——
/// - **GIF**：worker 的 `image` 根本没开 gif 解码器（§5.3 只给 worker 留 jpeg/png/webp），
///   那一页连尺寸都读不出来，整件任务 `COMPUTE_INPUT_INVALID` 当场倒下：这一页打不开；
/// - **APNG**：解得开，于是第一帧被真的放大成一张静态 PNG——用户看到的是动图没了。
///
/// 超分那一路（阅读器只提交超分），并且装的是真模型：APNG 那条修之前会真的算出一张
/// 128×96 的 PNG，所以「字节与源图一个不差」是真断言，不是少了个分支的形状之红。真模型
/// 素材不进仓库，本机没有就明说跳过。
fn assert_animated_page_passes_through(name: &str, file_name: &str, animated: &[u8]) {
    let Some(model_bytes) = local_upscaler("realcugan-2x-conservative") else {
        return;
    };
    let sandbox = Sandbox::new(&format!("animated-{name}"));
    sandbox.install_upscaler("realcugan-2x-conservative", &model_bytes, 1);
    let page = sandbox.root.join(file_name);
    std::fs::write(&page, animated).expect("写动图那一页");

    let manager = ComputeManager::start(config(&sandbox), no_events()).expect("起 supervisor");
    let submitted = manager
        .submit(reader_request("realcugan-2x-conservative", &page))
        .expect("应该收下这一页");
    let state = wait_until("动图那一页收尾", HANDOFF, || {
        terminal_of(&manager, &submitted.job_id)
    });
    assert_eq!(
        state,
        JobState::Completed,
        "{name} 那一页该原样交回，而不是失败、也不是算成别的东西：{state:?}"
    );

    let artifacts = manager.job_artifacts(&submitted.job_id);
    let artifact = artifacts.first().expect("有一件产物");
    assert!(artifact.verified, "宿主必须自己核过：{artifact:?}");
    let produced = std::fs::read(&artifact.path).expect("读产物");
    assert_eq!(
        produced, animated,
        "{name} 必须原样交回：超分与去码都不适用动图，交回来的不是一个字节不差的动图，\
         就说明这一页已经在链上被解成了静态首帧"
    );
    assert_eq!(
        &produced[..4],
        &animated[..4],
        "交回来的还得是同一个容器，不是一张同名同尺寸的 PNG"
    );
    assert_eq!(
        artifact.engine_id, "passthrough",
        "没有任何引擎跑过这一页，报告不该冒充 onnx"
    );
    assert_eq!(
        (artifact.width, artifact.height),
        (64, 48),
        "尺寸按容器声明的画布报（64×48），不是解码第一帧量出来的"
    );

    eprintln!(
        "动图那一页（{name}）：源 {} 字节 / 产物 {} 字节、{}×{}、engine={} 政策={:?}",
        animated.len(),
        produced.len(),
        artifact.width,
        artifact.height,
        artifact.engine_id,
        artifact.engine_policy,
    );

    manager.shutdown();
}

#[test]
fn a_gif_page_comes_back_frame_for_frame() {
    assert_animated_page_passes_through(
        "gif",
        "page.gif",
        include_bytes!("../src/dlssnr/testdata/animated.gif"),
    );
}

#[test]
fn an_apng_page_comes_back_frame_for_frame() {
    assert_animated_page_passes_through(
        "apng",
        "page.png",
        include_bytes!("../src/dlssnr/testdata/animated.png"),
    );
}
