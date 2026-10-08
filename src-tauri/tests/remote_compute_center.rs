//! 算力中心**服务端**的真进程闭环（`docs/71` §11 Task 8 第 ④ 条）。
//!
//! 远端发来的那一页在服务端只该有**一条**出路：交给同一份 `ComputeManager`（于是走同一条
//! 调度、同一套产物发布），并且这一条出路要能被打断——对面走了就不该继续算。三件事在这里
//! 变成可测的事实：
//!
//! ① 远端请求走的是本机同一条调度/产物路：回声产物里那句 `input=remote:<这一页的哈希>` 是
//!    证据（只有经过 `proxy` → worker 才会产出它），产物还落在同一条内容寻址发布路里；
//! ② 认证与 `/v2/ping` 不等 GPU：慢任务在飞的时候它们照样立刻答完；
//! ③ 客户端走了 ⇒ 取消**它自己那一次订阅**（`manager.cancel(job_id, subscription_id)`），
//!    而不是白算完，也不是把同一条任务上别人那一次订阅一起带走。
//!
//! HTTP 走真 TCP，计算走真 `yomika-compute-worker.exe` 的回声引擎（`YOMIKA_WORKER_TEST_DELAY_MS`
//! 让它「算」得够久，取消才测得出来；那个变量生产路径永远不设）。
//!
//! 服务端那一边不半关连接（`shutdown(Write)`）——**半关就是「我走了」**：`/v2/process` 的
//! 客户端在这一版里只发一件请求、然后只读结果，所以「读端看到 EOF」这件事本身就等于它不等
//! 这份结果了。用半关当「我说完了」的写法在这条协议上不存在（本机客户端是 reqwest 发的，
//! 它不会半关）。

#![cfg(windows)]

use std::io::{Read, Write};
use std::net::TcpStream as StdTcpStream;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use yomika_lib::compute::manager::{no_events, ComputeManager, SupervisorConfig, WorkerEngine};
use yomika_lib::compute::models::ModelCatalog;
use yomika_lib::compute::scheduler::JobState;
use yomika_lib::compute_center::{ComputeCenter, ProcessParams, ServerContext};

const TOKEN: &str = "token-remote";
const REMOTE_MODEL: &str = "remote-model";

/// 等一件任务跑起来 / 跑到终态的预算。
const HANDOFF: Duration = Duration::from_secs(20);
/// 断开之后，多久该看到 `Cancelled`。给得比假算长一点：这一条要能区分「取消生效了」与
/// 「只是还没算完」——取消该在几百毫秒内落地，而假算还在跑。
const CANCEL_BUDGET: Duration = Duration::from_secs(8);

const PAGE_WIDTH: u32 = 24;
const PAGE_HEIGHT: u32 = 16;

/// worker 可执行文件：测试自己的路径是 `target/<profile>/deps/xxx.exe`，反推得到
/// `target/<profile>`（与 `CARGO_TARGET_DIR` 无关）。**每次都先编一遍**，否则会拿上一轮
/// 的旧 worker 跑，测试钩子改了也不生效。
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
            "yomika-center-it-{name}-{}-{stamp}",
            std::process::id()
        ));
        let staging = root.join("staging");
        std::fs::create_dir_all(&staging).expect("建 staging");
        Self { root, staging }
    }

    /// 造一份「已安装的模型」：回声引擎不会去解它，所以字节内容是假的也无妨——宿主侧只算
    /// 哈希、只按内容摆文件。清单里的 sha256 与真字节一致，这条链路才是真的。
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

/// 一份「数据根 + 编排」的配置。`delay` 是回声引擎的假算时长（0 就是尽快）。
fn config(sandbox: &Sandbox, delay: Duration) -> SupervisorConfig {
    let mut config = SupervisorConfig::new(worker_exe(), &sandbox.staging);
    config.handshake_timeout = Duration::from_secs(10);
    // 测试里不让闲置回收插手：那会让「谁算的、算完了没有」变得说不清。
    config.idle_shutdown = Duration::from_secs(600);
    config.publish_root = Some(sandbox.root.clone());
    config.models = Some(ModelCatalog::new(&sandbox.root));
    config.worker_engine = WorkerEngine::Echo;
    config.extra_env = vec![(
        "YOMIKA_WORKER_TEST_DELAY_MS".to_string(),
        delay.as_millis().to_string(),
    )];
    config
}

/// 真服务 + 真编排，两者由 `ServerContext` 的 `manager` 那一栏接起来。测试里没有
/// AppHandle，而生产上那一栏是 `None`（从 `app` 里取）。
fn center_with(sandbox: &Sandbox, manager: &Arc<ComputeManager>) -> (ComputeCenter, u16) {
    let context = ServerContext {
        model_data: sandbox.root.clone(),
        data: sandbox.root.clone(),
        app: None,
        manager: Some(Arc::clone(manager)),
    };
    let center = ComputeCenter::new();
    center.set_token(TOKEN);
    let port = center.start(context, 0).expect("起服务");
    (center, port)
}

/// 一张真的 24×16 PNG（不是 1×1：让输入哈希有内容可算）。
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
        .expect("编码 PNG");
    page
}

/// 一条 `/v2/process` 请求（和 `remote_process` 发的一模一样：参数走 base64 头）。
fn process_request(page: &[u8]) -> Vec<u8> {
    let params = ProcessParams {
        op: "upscale".to_string(),
        model_id: Some(REMOTE_MODEL.to_string()),
        scale: Some(2),
        dlssnr: None,
    };
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&params).expect("参数能序列化"))
    };
    let head = format!(
        "POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: {TOKEN}\r\n\
         x-yomika-params: {encoded}\r\ncontent-type: application/octet-stream\r\n\
         content-length: {}\r\n\r\n",
        page.len()
    );
    let mut request = head.into_bytes();
    request.extend_from_slice(page);
    request
}

fn connect(port: u16) -> StdTcpStream {
    StdTcpStream::connect(("127.0.0.1", port)).expect("连上服务")
}

/// 读到底：服务端每次都 `Connection: close`，所以读完就是一份完整回包。
fn read_response(stream: &mut StdTcpStream) -> String {
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    String::from_utf8_lossy(&response).to_string()
}

/// 发一条请求并等回包。**不半关连接**：半关在这条服务里等于「我走了」（见文件头）。
fn raw_request(port: u16, request: &[u8]) -> String {
    let mut stream = connect(port);
    stream.write_all(request).expect("发请求");
    read_response(&mut stream)
}

fn raw_get(port: u16, path: &str, token: Option<&str>) -> String {
    let head = match token {
        Some(token) => format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: {token}\r\n\r\n"
        ),
        None => format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
    };
    raw_request(port, head.as_bytes())
}

/// 回包里的体（头与体之间那一个空行之后）。
fn body_of(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default()
}

fn page_hash(page: &[u8]) -> String {
    blake3::hash(page).to_hex().to_string()
}

/// 这一页在计算进程里的**任务身份**：算力中心给的 `input_id`（见 `upscale_bytes`）。
fn input_id(page: &[u8]) -> String {
    format!("remote:{}", page_hash(page))
}

/// 那一件任务正在算吗？
fn is_computing(manager: &ComputeManager, wanted: &str) -> bool {
    manager.all_jobs().iter().any(|snapshot| {
        snapshot.key.input_id == wanted && matches!(snapshot.state, JobState::Running { .. })
    })
}

/// 那一件任务的在飞编号（等到它真的开始算为止）。
fn running_job(manager: &ComputeManager, wanted: &str) -> Option<String> {
    manager
        .all_jobs()
        .iter()
        .find(|snapshot| {
            snapshot.key.input_id == wanted && matches!(snapshot.state, JobState::Running { .. })
        })
        .map(|snapshot| snapshot.job_id.clone())
}

/// 这个任务身份此刻那件**还没了结**的任务（无论它排着队还是已经在算）。
///
/// 「合并」这件事发生在提交那一刻，与「有没有开始算」无关，所以合并那一步要的是这一条，
/// 不是 [`running_job`]。
fn live_job(manager: &ComputeManager, wanted: &str) -> Option<String> {
    manager
        .all_jobs()
        .iter()
        .find(|snapshot| snapshot.key.input_id == wanted && !snapshot.state.is_terminal())
        .map(|snapshot| snapshot.job_id.clone())
}

fn subscribers_of(manager: &ComputeManager, job_id: &str) -> usize {
    manager
        .job(job_id)
        .map(|snapshot| snapshot.subscribers)
        .unwrap_or(0)
}

fn state_of(manager: &ComputeManager, job_id: &str) -> Option<JobState> {
    manager.job(job_id).map(|snapshot| snapshot.state)
}

fn terminal_of(manager: &ComputeManager, job_id: &str) -> Option<JobState> {
    state_of(manager, job_id).filter(|state| state.is_terminal())
}

/// 这个任务身份此刻在调度器里的**每一件**任务：编号、状态、订阅者数。
///
/// 8-h④ 那一轮这条判据红过一次，红在「等了 20 秒还没等到：两条请求合并成一件任务」——
/// 而那句话分不清两种完全不同的现场：是两条请求各建了一件任务（没合并，产品错），
/// 还是合并成了一件但 worker 迟迟没起来（`Queued`，不是合并的错）。同一句话对应两种
/// 修法，等于没有说出现场。现在超时的时候把这几行一起打出来。
fn jobs_dump(manager: &ComputeManager, wanted: &str) -> String {
    let mut lines: Vec<String> = manager
        .all_jobs()
        .iter()
        .filter(|snapshot| snapshot.key.input_id == wanted)
        .map(|snapshot| {
            format!(
                "{} 状态 {:?} 订阅 {}",
                snapshot.job_id, snapshot.state, snapshot.subscribers
            )
        })
        .collect();
    if lines.is_empty() {
        lines.push("一件都没有".to_string());
    }
    lines.join("；")
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

/// 和 [`wait_until`] 一样，只是超时的时候连现场一起说出来（见 [`jobs_dump`]）。
fn wait_until_showing<T>(
    what: &str,
    budget: Duration,
    mut probe: impl FnMut() -> Option<T>,
    show: impl Fn() -> String,
) -> T {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(value) = probe() {
            return value;
        }
        if Instant::now() >= deadline {
            panic!(
                "等了 {} 秒还没等到：{what}\n那一刻调度器里的样子：{}",
                budget.as_secs(),
                show()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// ① 远端那一页走的是本机同一条调度路：回声产物里有任务身份与手边那份输入。
#[test]
fn a_remote_page_is_computed_by_the_worker_of_this_machine() {
    let sandbox = Sandbox::new("scheduler");
    sandbox.install_model(REMOTE_MODEL, "1", b"not an onnx file", 1, 2);
    let manager =
        ComputeManager::start(config(&sandbox, Duration::ZERO), no_events()).expect("起计算编排");
    let (center, port) = center_with(&sandbox, &manager);

    let page = page_png();
    let response = raw_request(port, &process_request(&page));
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let body = body_of(&response);
    assert!(
        body.starts_with("echo stage=upscale "),
        "远端那一页不是计算进程的回声引擎算的：{body}"
    );
    // 引擎报的任务身份正是算力中心给这一页的那一个：同一条调度，不是另一条私路。
    assert!(
        body.contains(&format!("input={} ", input_id(&page))),
        "任务身份没走到引擎手边：{body}"
    );
    // 产物走的是**同一条**内容寻址发布路：它的落点就是它自己字节的哈希。
    let artifact_hash = blake3::hash(body.as_bytes()).to_hex().to_string();
    let published = sandbox.published(&artifact_hash);
    assert!(
        published.exists(),
        "产物该落在内容寻址存储里：{}",
        published.display()
    );
    assert_eq!(std::fs::read(&published).expect("读产物"), body.as_bytes());

    center.stop();
    manager.shutdown();
}

/// ② 认证与 `/v2/ping` 不等 GPU：那一页还在算的时候它们照样立刻答完。
#[test]
fn a_ping_answers_while_the_worker_is_busy_with_a_remote_page() {
    const DELAY: Duration = Duration::from_millis(3000);
    let sandbox = Sandbox::new("ping");
    sandbox.install_model(REMOTE_MODEL, "1", b"not an onnx file", 1, 2);
    let manager =
        ComputeManager::start(config(&sandbox, DELAY), no_events()).expect("起计算编排");
    let (center, port) = center_with(&sandbox, &manager);

    let page = page_png();
    let wanted = input_id(&page);
    let request = process_request(&page);
    let sender = std::thread::spawn(move || raw_request(port, &request));
    wait_until("远端那一页开始算", HANDOFF, || {
        running_job(&manager, &wanted)
    });

    let started = Instant::now();
    let ping = raw_get(port, "/v2/ping", None);
    let elapsed = started.elapsed();
    assert!(ping.starts_with("HTTP/1.1 200"), "{ping}");
    assert!(
        ping.contains("yomika-compute-center"),
        "ping 该自报家门：{ping}"
    );
    // 两条都要成立才算「不等 GPU」：答得够快，**而且**答完之后那一页还在算。
    assert!(
        elapsed < DELAY,
        "ping 等了 {elapsed:?}，比那一页的假算（{DELAY:?}）还久"
    );
    assert!(
        is_computing(&manager, &wanted),
        "ping 答完时那一页已经不在了：这不是「不等」，只是碰巧错开了"
    );

    // 认证这一层同理：带令牌的清单请求也不该排在 GPU 后面（不带令牌则照旧 401）。
    let capabilities = raw_get(port, "/v2/capabilities", Some(TOKEN));
    assert!(capabilities.starts_with("HTTP/1.1 200"), "{capabilities}");
    assert!(
        is_computing(&manager, &wanted),
        "清单答完时那一页已经不在了"
    );
    let refused = raw_get(port, "/v2/capabilities", Some("wrong-token"));
    assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");

    let response = sender.join().expect("发请求的线程");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    center.stop();
    manager.shutdown();
}

/// ③ **客户端走了：算的可不只是白算**——那一次订阅该被取消，而不是等它算完。
#[test]
fn a_client_that_hangs_up_stops_its_own_page() {
    const DELAY: Duration = Duration::from_millis(3000);
    let sandbox = Sandbox::new("hangup");
    sandbox.install_model(REMOTE_MODEL, "1", b"not an onnx file", 1, 2);
    let manager =
        ComputeManager::start(config(&sandbox, DELAY), no_events()).expect("起计算编排");
    let (center, port) = center_with(&sandbox, &manager);

    let page = page_png();
    let wanted = input_id(&page);
    let mut stream = connect(port);
    stream.write_all(&process_request(&page)).expect("发请求");
    let job_id = wait_until("远端那一页开始算", HANDOFF, || {
        running_job(&manager, &wanted)
    });

    // 对面走了：连接关掉（FIN 到手），服务端该把这一次订阅取消掉。
    drop(stream);

    let terminal = wait_until("断开之后这一页该停下来", CANCEL_BUDGET, || {
        terminal_of(&manager, &job_id)
    });
    assert_eq!(
        terminal,
        JobState::Cancelled,
        "客户端走了，这一页不该继续算（也不该白算完）"
    );
    // 取消掉的那一页不留下产物：内容寻址存储里不该有它。
    let images = sandbox.root.join("cache/images");
    let leftovers: Vec<PathBuf> = std::fs::read_dir(&images)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .flat_map(|entry| {
                    std::fs::read_dir(entry.path())
                        .map(|inner| inner.filter_map(Result::ok).map(|file| file.path()))
                        .into_iter()
                        .flatten()
                })
                .collect()
        })
        .unwrap_or_default();
    assert!(
        leftovers.is_empty(),
        "取消掉的那一页留下了产物：{leftovers:?}"
    );

    center.stop();
    manager.shutdown();
}

/// ③ 的另一半：掉的只是**它自己那一次订阅**。同一页的两条请求会合并成一件任务，
/// 其中一条走了不该把另一条要的结果一起带走。
#[test]
fn one_client_leaving_does_not_take_the_other_ones_page_down() {
    const DELAY: Duration = Duration::from_millis(4000);
    let sandbox = Sandbox::new("subscribers");
    sandbox.install_model(REMOTE_MODEL, "1", b"not an onnx file", 1, 2);
    let manager =
        ComputeManager::start(config(&sandbox, DELAY), no_events()).expect("起计算编排");
    let (center, port) = center_with(&sandbox, &manager);

    let page = page_png();
    let wanted = input_id(&page);
    let request = process_request(&page);
    let mut first = connect(port);
    first.write_all(&request).expect("第一条请求");
    let mut second = connect(port);
    second.write_all(&request).expect("第二条请求");

    // 两条同样的请求落在同一个任务身份上，于是合并成**一件**任务、两个订阅者。
    //
    // 这一步要的是「合并」本身，不是「它已经开始算了」：合并发生在提交那一刻，能不能开算
    // 要看 worker 起没起来。原先等的是 `Running`——worker 起得慢一点（任务还排在 `Queued`）
    // 就会红成「两条请求没合并」，把一件与合并无关的事说成合并错了。任务真没算成的话，
    // 下面 `read_response` 那一步照样会红，那才是该红的地方。
    let job_id = wait_until_showing(
        "两条请求合并成一件任务",
        HANDOFF,
        || {
            live_job(&manager, &wanted).filter(|job_id| subscribers_of(&manager, job_id) == 2)
        },
        || jobs_dump(&manager, &wanted),
    );

    // 第一条走了：它那一次订阅被丢掉，剩下的那一条继续等结果。
    drop(first);
    wait_until("掉一条订阅之后任务要继续", HANDOFF, || {
        (subscribers_of(&manager, &job_id) == 1).then_some(())
    });
    assert!(
        state_of(&manager, &job_id).is_some_and(|state| !state.is_terminal()),
        "掉一条订阅不该把整件任务带走：{:?}",
        state_of(&manager, &job_id)
    );

    let response = read_response(&mut second);
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        body_of(&response).starts_with("echo stage=upscale "),
        "剩下那一条没拿到结果：{response}"
    );

    center.stop();
    manager.shutdown();
}
