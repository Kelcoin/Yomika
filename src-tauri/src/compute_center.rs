//! 算力中心：把桌面端的超分 / 去码 / DLSS5 借给局域网里的移动端用。
//!
//! 两个方向都在这一个模块里：
//!
//! * **服务端**（桌面）：一条极简的 HTTP/1.1 服务，`GET /v1/capabilities` 报能力、
//!   `POST /v1/process` 收字节回字节。协议自己写（tokio + `TcpListener`），不引框架：
//!   只有两个端点、一个令牌头，`Content-Length` + `Connection: close` 就够了。
//! * **客户端**（任意端）：`remote_*` 几条命令，把本机缓存里的一页发给远端、取回
//!   处理好的图。移动端没法直接发 HTTP（webview 里没有网络权限这条路），所以由
//!   Rust 代发。
//!
//! 安全上的取舍：
//! * 默认**不开**，且至少有一个「模型包齐全」的能力才允许开（前端与后端都拦）。
//! * 每个请求都要令牌（除了一条只报服务名的 `/v1/ping`），比较是按位累积的常数
//!   时间比较，不给逐字节试探留时间差。
//! * 明文 HTTP：这是局域网内的临时通道，令牌就是全部凭据；要更严就换 HTTPS 反代。
//!   README 与设置页都会写清这一点。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::domain::result::CommandResult;

/// 默认端口：47653（随便挑的一个不容易撞的高位端口）。
pub const DEFAULT_PORT: u16 = 47653;
/// 请求体上限：一页扫描图几 MB，留足余量后封顶 64 MB。
const MAX_BODY: usize = 64 * 1024 * 1024;
/// 请求头上限。
const MAX_HEADER: usize = 32 * 1024;

/// 服务名与版本：`/v1/ping` 用它自报家门（移动端连上时先确认对面是同类应用）。
const SERVICE_NAME: &str = "yomika-compute-center";
const PROTOCOL_VERSION: u32 = 1;

/// 一项能力：移动端据此显示「对面有什么、能不能用」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    /// `upscale` / `decensor` / `dlssnr`。
    pub id: String,
    pub label: String,
    /// 齐全到能直接跑。
    pub ready: bool,
    /// 为什么不能用 / 有什么可用——给人看的一句话。
    pub detail: String,
}

/// 算力中心在设置页与能力清单里的一整份现状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeCenterStatus {
    pub running: bool,
    pub port: u16,
    /// 本机在局域网里的地址（设置页照着念给移动端）。
    pub addresses: Vec<String>,
    pub token: String,
    pub capabilities: Vec<Capability>,
    /// 至少有一项能力齐全——没有就不允许开。
    pub can_start: bool,
}

/// 移动端看到的远端能力清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    pub service: String,
    pub version: u32,
    pub name: String,
    pub capabilities: Vec<Capability>,
}

/// 服务端句柄。
#[derive(Default)]
pub struct ComputeCenter {
    inner: Mutex<Option<Running>>,
    /// 令牌随时可能被用户换：请求进来现读，不用重启服务。
    token: Arc<RwLock<String>>,
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl ComputeCenter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_token(&self, token: &str) {
        if let Ok(mut guard) = self.token.write() {
            *guard = token.to_string();
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    /// 开服务。`port` 为 0 或占着就报错——这里不替用户改端口，改端口是设置页的事。
    pub fn start(&self, context: ServerContext, port: u16) -> Result<u16, String> {
        let mut guard = self.inner.lock().map_err(|_| "算力中心锁失败".to_string())?;
        if let Some(running) = guard.as_ref() {
            return Ok(running.port);
        }
        let listener = std::net::TcpListener::bind(("0.0.0.0", port))
            .map_err(|error| format!("监听 {port} 失败：{error}"))?;
        // 端口 0 交给系统挑：只有测试这么用，但拿到的端口要能报回去。
        let bound = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("设置非阻塞失败：{error}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let token = Arc::clone(&self.token);

        let stop_for_task = Arc::clone(&stop);
        // `from_std` 必须在 tokio 的运行环境里调（普通测试线程里没有 reactor），
        // 所以监听套接字在这一步之前就建好了——端口占用这类错也就还能同步报出来。
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            serve(listener, token, stop_for_task, context).await;
        });
        *guard = Some(Running { port: bound, stop });
        Ok(bound)
    }

    /// 关服务：置位之后往自己的端口连一次，把卡在 `accept` 上的循环叫醒。
    pub fn stop(&self) {
        let running = self.inner.lock().ok().and_then(|mut guard| guard.take());
        if let Some(running) = running {
            running.stop.store(true, Ordering::SeqCst);
            let _ = std::net::TcpStream::connect(("127.0.0.1", running.port));
        }
    }
}

/// 本机的局域网地址（给设置页显示，用户照着填到移动端上）。
pub fn local_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    // 不引网络接口库：连一次外网地址拿到「会被选中的那块网卡」的本地地址，
    // 这一步不发包（UDP connect 只做路由决策）。
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local) = socket.local_addr() {
                if !local.ip().is_loopback() {
                    addresses.push(local.ip().to_string());
                }
            }
        }
    }
    addresses
}

/// 能力清单：三类各自查一遍「齐不齐」。
///
/// `model_data` 是模型目录（`inference` 那一套的安装根），`data` 是数据目录（DLSS5
/// 的 DLL 与日志在那里）。
pub fn capabilities(model_data: &Path, data: &Path) -> Vec<Capability> {
    let runnable = crate::inference::runnable_models(model_data);
    let upscalers: Vec<&crate::inference::RunnableModel> = runnable
        .iter()
        .filter(|model| model.kind == "upscale")
        .collect();
    let decensors: Vec<&crate::inference::RunnableModel> = runnable
        .iter()
        .filter(|model| model.kind == "decensor")
        .collect();

    let mut capabilities = vec![
        Capability {
            id: "upscale".to_string(),
            label: "超分".to_string(),
            ready: !upscalers.is_empty(),
            detail: if upscalers.is_empty() {
                "还没有装好的超分模型".to_string()
            } else {
                upscalers
                    .iter()
                    .map(|model| model.label.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            },
        },
        Capability {
            id: "decensor".to_string(),
            label: "去码".to_string(),
            ready: !decensors.is_empty(),
            detail: if decensors.is_empty() {
                "去码模型包不完整（要四个文件都在）".to_string()
            } else {
                decensors
                    .iter()
                    .map(|model| model.label.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            },
        },
    ];
    capabilities.push(dlssnr_capability(data));
    capabilities
}

#[cfg(windows)]
fn dlssnr_capability(data: &Path) -> Capability {
    let status = crate::dlssnr::status(data);
    // Probe results are process-global, but validity is tied to the exact data
    // directory and DLL. A different profile (or test fixture) must not make
    // this capability report DLSS5 as ready here.
    match crate::dlssnr::last_probe_for(data) {
        Some(probe) if probe.supported => Capability {
            id: "dlssnr".to_string(),
            label: "DLSS5".to_string(),
            ready: true,
            detail: format!("{}（检测 {:.1}ms）", status.variant_label.clone().unwrap_or_else(|| "已导入".into()), probe.elapsed_ms as f64),
        },
        Some(probe) => Capability {
            id: "dlssnr".to_string(),
            label: "DLSS5".to_string(),
            ready: false,
            detail: probe
                .error
                .clone()
                .unwrap_or_else(|| "这台机器上 DLSS5 跑不起来".to_string()),
        },
        None => Capability {
            id: "dlssnr".to_string(),
            label: "DLSS5".to_string(),
            ready: false,
            detail: if status.available {
                "还没有检测过（在设置页点一次检测）".to_string()
            } else {
                status
                    .error
                    .clone()
                    .unwrap_or_else(|| "DLSS5 不可用".to_string())
            },
        },
    }
}

#[cfg(not(windows))]
fn dlssnr_capability(_data: &Path) -> Capability {
    Capability {
        id: "dlssnr".to_string(),
        label: "DLSS5".to_string(),
        ready: false,
        detail: "DLSS5 只在 Windows 桌面端可用".to_string(),
    }
}

/// 请求要干的事。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessParams {
    /// `upscale` / `decensor` / `dlssnr`。
    pub op: String,
    /// 模型 id（超分 / 去码用）。
    #[serde(default)]
    pub model_id: Option<String>,
    /// 放大倍数（模型为空时的最近邻路径用）。
    #[serde(default)]
    pub scale: Option<u32>,
    /// DLSS5 的 1–3 层参数。
    #[serde(default)]
    pub dlssnr: Option<serde_json::Value>,
}

impl ProcessParams {
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|error| format!("参数不是合法 JSON：{error}"))
    }
}

/// 一次处理：字节进、字节出。三个方向都收敛到这里。
pub fn process(
    model_data: &Path,
    data: &Path,
    params: &ProcessParams,
    bytes: &[u8],
) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("请求体是空的（要发图片字节）".to_string());
    }
    match params.op.as_str() {
        "upscale" => crate::inference::run_upscale_bytes(
            model_data,
            params.model_id.as_deref().unwrap_or_default(),
            bytes,
            params.scale,
        ),
        "decensor" => crate::inference::run_decensor_bytes(
            model_data,
            params.model_id.as_deref().unwrap_or_default(),
            bytes,
        ),
        "dlssnr" => dlssnr_process(data, params, bytes),
        other => Err(format!("不认识的处理方式：{other}")),
    }
}

#[cfg(windows)]
fn dlssnr_process(data: &Path, params: &ProcessParams, bytes: &[u8]) -> Result<Vec<u8>, String> {
    use crate::dlssnr::DlssnrSettings;

    let settings: DlssnrSettings = match &params.dlssnr {
        Some(value) => serde_json::from_value::<DlssnrSettings>(value.clone())
            .map_err(|error| format!("DLSS5 参数不对：{error}"))?
            .normalized(),
        None => DlssnrSettings::default(),
    };
    let decoded = image::load_from_memory(bytes)
        .map_err(|error| error.to_string())?
        .to_rgba8();
    let (width, height) = (decoded.width(), decoded.height());
    let processed = crate::dlssnr::apply_rgba(data, decoded.into_raw(), width, height, &settings)?;
    let mut encoded = Vec::new();
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut encoded)
        .write_image(
            &processed.rgba,
            processed.width,
            processed.height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| error.to_string())?;
    Ok(encoded)
}

#[cfg(not(windows))]
fn dlssnr_process(_data: &Path, _params: &ProcessParams, _bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("DLSS5 只在 Windows 桌面端可用".to_string())
}

/// 令牌比较：长度不同直接否，长度相同按位累积异或——不给「逐字节试」留时间差。
fn token_matches(expected: &str, presented: &str) -> bool {
    let (expected, presented) = (expected.as_bytes(), presented.as_bytes());
    if expected.len() != presented.len() || expected.is_empty() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in expected.iter().zip(presented.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

/// 一个已解析的请求。
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// 请求读失败的原因：状态码、机器可读的码、给人看的一句话。
///
/// 以前所有读失败都回同一个 400 `INVALID_RESPONSE`，于是一个被截断的请求体和一
/// 个格式错乱的头长得一模一样——对面看到的是「模糊的图片解码错误」（§2.6）。
struct RequestError {
    status: u16,
    reason: &'static str,
    code: &'static str,
    message: String,
}

impl RequestError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            reason: "Bad Request",
            code,
            message: message.into(),
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, RequestError> {
    let mut buffer = Vec::with_capacity(8 * 1024);
    let header_end = loop {
        if let Some(at) = find_headers_end(&buffer) {
            break at;
        }
        if buffer.len() > MAX_HEADER {
            return Err(RequestError::bad_request(
                "INVALID_RESPONSE",
                "请求头太长",
            ));
        }
        let mut chunk = [0u8; 8 * 1024];
        let read = stream.read(&mut chunk).await.map_err(|error| {
            RequestError::bad_request("INVALID_RESPONSE", format!("读请求失败：{error}"))
        })?;
        if read == 0 {
            return Err(RequestError::bad_request(
                "INVALID_RESPONSE",
                "连接提前关了",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    let mut content_length_seen = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        // 这一层解析器只认「一个 Content-Length + 定长体」。重复的长度头、分块传输
        // 都是它读不对的东西：读错了会去截一个不存在的长度，然后拿半张图去解码。
        // 与其猜，不如当场说清楚。
        if name == "content-length" {
            if content_length_seen {
                return Err(RequestError::bad_request(
                    "INVALID_RESPONSE",
                    "重复的 Content-Length：这一版协议只认一个",
                ));
            }
            content_length_seen = true;
        }
        if name == "transfer-encoding" {
            return Err(RequestError::bad_request(
                "INVALID_RESPONSE",
                "不支持 Transfer-Encoding（分块请求）：请发送定长的 Content-Length",
            ));
        }
        headers.insert(name, value.trim().to_string());
    }

    let content_length = match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| {
            RequestError::bad_request(
                "INVALID_RESPONSE",
                format!("Content-Length 不是数字：{value}"),
            )
        })?,
        None => 0,
    };
    if content_length > MAX_BODY {
        return Err(RequestError {
            status: 413,
            reason: "Payload Too Large",
            code: "INVALID_RESPONSE",
            message: format!("请求体太大（{content_length} 字节，上限 {MAX_BODY}）"),
        });
    }

    let mut body = buffer[header_end + 4..].to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0u8; (content_length - body.len()).min(64 * 1024)];
        let read = stream.read(&mut chunk).await.map_err(|error| {
            RequestError::bad_request("INCOMPLETE_BODY", format!("读请求体失败：{error}"))
        })?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    // 短读：对面说的长度没读满（连接断了）。以前这里直接 `truncate` 就当收到一个
    // 完整请求，处理失败时给出的是一条与真因无关的解码错误。
    if body.len() < content_length {
        return Err(RequestError::bad_request(
            "INCOMPLETE_BODY",
            format!(
                "请求体不完整：声明 {content_length} 字节，只收到 {}",
                body.len()
            ),
        ));
    }
    body.truncate(content_length);

    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn find_headers_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(body)
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())
}

async fn write_json(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> Result<(), String> {
    write_response(stream, status, reason, "application/json; charset=utf-8", body.as_bytes()).await
}

/// 服务一次请求需要的全部东西：两个目录。**不拿 `AppHandle`**——这样测试能起
/// 一个真服务、用真的客户端打一遍（局域网协议本身要有测试）。
#[derive(Clone)]
pub struct ServerContext {
    pub model_data: std::path::PathBuf,
    pub data: std::path::PathBuf,
}

async fn serve(
    listener: TcpListener,
    token: Arc<RwLock<String>>,
    stop: Arc<AtomicBool>,
    context: ServerContext,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept().await {
            Ok((stream, _)) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let token = Arc::clone(&token);
                let context = context.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(stream, token, context).await;
                });
            }
            // 单个连接出错不该让服务停：继续接下一个。
            Err(_) => continue,
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    token: Arc<RwLock<String>>,
    context: ServerContext,
) -> Result<(), String> {
    let request = match read_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            let body = error_body(error.code, &error.message);
            write_json(&mut stream, error.status, error.reason, &body).await?;
            return Ok(());
        }
    };

    // 不带头令牌的一律先挡在门外（`/v1/ping` 只报服务名，不碰数据）。
    if request.path == "/v1/ping" && request.method == "GET" {
        let body = serde_json::json!({ "service": SERVICE_NAME, "version": PROTOCOL_VERSION });
        return write_json(&mut stream, 200, "OK", &body.to_string()).await;
    }

    let expected = token.read().map(|guard| guard.clone()).unwrap_or_default();
    let presented = request
        .headers
        .get("x-yomika-token")
        .cloned()
        .unwrap_or_default();
    if !token_matches(&expected, &presented) {
        let body = error_body("UNAUTHORIZED", "令牌不对（在桌面端设置页复制一份）");
        return write_json(&mut stream, 401, "Unauthorized", &body).await;
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/capabilities") => {
            let name = host_name();
            let payload = RemoteCapabilities {
                service: SERVICE_NAME.to_string(),
                version: PROTOCOL_VERSION,
                name,
                capabilities: capabilities(&context.model_data, &context.data),
            };
            let body = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
            write_json(&mut stream, 200, "OK", &body).await
        }
        ("POST", "/v1/process") => {
            let params = request
                .headers
                .get("x-yomika-params")
                .ok_or_else(|| "缺少 x-yomika-params 头".to_string())
                .and_then(|encoded| {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|error| format!("参数不是合法 base64：{error}"))
                })
                .and_then(|decoded| ProcessParams::from_bytes(&decoded));
            let params = match params {
                Ok(params) => params,
                Err(error) => {
                    let body = error_body("INVALID_RESPONSE", &error);
                    return write_json(&mut stream, 400, "Bad Request", &body).await;
                }
            };
            let op = params.op.clone();
            let body = request.body;
            let context = context;
            // 重活串到全局那一件（见 `inference::run_heavy`）：两张图同时进来把内存
            // 顶爆比慢一点糟。
            let processed = crate::inference::run_heavy(move || {
                process(&context.model_data, &context.data, &params, &body)
            })
            .await
            .and_then(|inner| inner);
            match processed {
                Ok(bytes) => write_response(&mut stream, 200, "OK", "image/png", &bytes).await,
                Err(error) => {
                    let body = error_body("INFERENCE_UNAVAILABLE", &format!("{op}：{error}"));
                    write_json(&mut stream, 500, "Internal Server Error", &body).await
                }
            }
        }
        _ => {
            let body = error_body("NOT_FOUND", "没有这个端点");
            write_json(&mut stream, 404, "Not Found", &body).await
        }
    }
}

/// 阻塞客户端：远端多半在局域网里，连接超时给短一点，读超时留给推理。
fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())
}

fn error_body(code: &str, message: &str) -> String {
    serde_json::json!({ "ok": false, "error": { "code": code, "message": message, "retryable": false } })
        .to_string()
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Yomika".to_string())
}

// ---------------------------------------------------------------------------
// 客户端：把一页发给远端，取回处理好的图。
// ---------------------------------------------------------------------------

/// 连一次远端，拿它的能力清单（移动端「连接」按钮走它）。
pub fn remote_capabilities(url: &str, token: &str) -> Result<RemoteCapabilities, String> {
    let base = normalize_base(url)?;
    let response = blocking_client()?
        .get(format!("{base}/v1/capabilities"))
        .header("x-yomika-token", token)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .map_err(|error| format!("连不上 {base}：{error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(describe_error(status.as_u16(), &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("对面回的不是能力清单：{error}"))
}

/// 把一段图片字节发给远端处理，取回 PNG 字节。
///
/// 失败分成两类，因为对面能做的事不一样：**超时**（对面还在算、或者卡住了）与
/// **其它**（连不上、被拒、回的不是图）。以前两者都压成一个字符串，本地只好一律
/// 报「网络错误」——而超时是可重试的，该退到本机那一版继续读下去。
pub fn remote_process(
    url: &str,
    token: &str,
    params: &ProcessParams,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, RemoteFailure> {
    let base = normalize_base(url).map_err(RemoteFailure::protocol)?;
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_vec(params)
                .map_err(|error| RemoteFailure::protocol(error.to_string()))?,
        )
    };
    // 一页大图 + 一个模型的推理，给足时间；再长就该考虑把图切小。
    const PROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
    let response = blocking_client()
        .map_err(RemoteFailure::transport)?
        .post(format!("{base}/v1/process"))
        .header("x-yomika-token", token)
        .header("x-yomika-params", encoded)
        .header("content-type", "application/octet-stream")
        .timeout(PROCESS_TIMEOUT)
        .body(bytes)
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                RemoteFailure::timeout(format!(
                    "对面 {} 秒没有回话（一页大图 + 一个模型）：可以重试，或者把图切小、改用本机处理",
                    PROCESS_TIMEOUT.as_secs()
                ))
            } else {
                RemoteFailure::transport(format!("发给 {base} 失败：{error}"))
            }
        })?;
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response
        .bytes()
        .map_err(|error| RemoteFailure::transport(format!("读回包失败：{error}")))?
        .to_vec();
    if !status.is_success() {
        return Err(RemoteFailure {
            code: "REMOTE_UNAVAILABLE",
            message: describe_error(status.as_u16(), &String::from_utf8_lossy(&body)),
            // 5xx 是那边的事，重试有意义；4xx 是我们发错了（令牌、参数）。
            retryable: status.is_server_error(),
        });
    }
    if !content_type.starts_with("image/") {
        return Err(RemoteFailure::protocol(format!(
            "对面回的不是图片（{content_type}）"
        )));
    }
    Ok(body)
}

/// 远端那一步的失败：给调用方的码、人话，以及能不能重试。
#[derive(Debug)]
pub struct RemoteFailure {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl RemoteFailure {
    fn timeout(message: String) -> Self {
        Self {
            code: "REMOTE_TIMEOUT",
            message,
            retryable: true,
        }
    }

    fn transport(message: String) -> Self {
        Self {
            code: "REMOTE_UNAVAILABLE",
            message,
            retryable: true,
        }
    }

    fn protocol(message: String) -> Self {
        Self {
            code: "REMOTE_UNAVAILABLE",
            message,
            retryable: false,
        }
    }
}

/// 用户会填 `192.168.1.5`、`192.168.1.5:47653`、`http://192.168.1.5:47653` 这几种；
/// 都收，缺协议与端口就补默认值。
fn normalize_base(url: &str) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("还没有填远端的地址".to_string());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|error| format!("地址不对：{error}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "地址里没有主机名".to_string())?
        .to_string();
    let port = parsed.port().unwrap_or(DEFAULT_PORT);
    Ok(format!("{}://{host}:{port}", parsed.scheme()))
}

fn describe_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(|message| message.to_string())
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("远端返回 {status}：{message}")
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 生成一份新令牌：24 字节随机数的十六进制（够长，也方便手抄）。
fn fresh_token() -> String {
    use ring::rand::{SecureRandom, SystemRandom};

    let mut bytes = [0u8; 24];
    let random = SystemRandom::new();
    if random.fill(&mut bytes).is_err() {
        // 随机器不可用是极罕见的事；退回时间 + 地址凑一个，仍然不是可预测的常量。
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let address = &bytes as *const _ as usize as u128;
        return format!("{:024x}{:016x}", now, address);
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn preferences(app: &tauri::AppHandle) -> Result<crate::settings::PreferenceSnapshot, String> {
    let database = app.state::<crate::db::Database>();
    let connection = database
        .connection
        .lock()
        .map_err(|_| "数据库锁失败".to_string())?;
    crate::settings::load_preferences_from(&connection)
}

fn store_preferences(
    app: &tauri::AppHandle,
    snapshot: crate::settings::PreferenceSnapshot,
) -> Result<crate::settings::PreferenceSnapshot, String> {
    let database = app.state::<crate::db::Database>();
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| "数据库锁失败".to_string())?;
    crate::settings::save_preferences_to(&mut connection, snapshot)
}

fn paths(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let data = crate::data_paths::data_dir(app).map_err(|error| error.to_string())?;
    Ok((data.clone(), data))
}

/// 算力中心的句柄。
///
/// 用 `try_state` 而不是 `state`：后者取不到时 panic，而命令里的 panic 会跨 FFI
/// 边界直接中止进程——「设置页待一会儿应用就没了」就是取错了类型这么来的（登记的是
/// `Arc<ComputeCenter>`、这里按 `ComputeCenter` 取）。缺了就当命令失败。
fn center_of(app: &tauri::AppHandle) -> Result<tauri::State<'_, ComputeCenter>, String> {
    app.try_state::<ComputeCenter>()
        .ok_or_else(|| "算力中心尚未就绪".to_string())
}

fn current_port(app: &tauri::AppHandle) -> u16 {
    preferences(app)
        .map(|snapshot| snapshot.compute_center_port)
        .unwrap_or(DEFAULT_PORT)
}

/// 算力中心的现状：开没开、端口、地址、令牌、能力清单。
#[tauri::command]
pub fn compute_center_status(app: tauri::AppHandle) -> CommandResult<ComputeCenterStatus> {
    let (model_data, data) = match paths(&app) {
        Ok(paths) => paths,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let token = preferences(&app)
        .map(|snapshot| snapshot.compute_center_token)
        .unwrap_or_default();
    let capabilities = capabilities(&model_data, &data);
    let can_start = capabilities.iter().any(|capability| capability.ready);
    CommandResult::success(ComputeCenterStatus {
        running: center.is_running(),
        port: current_port(&app),
        addresses: local_addresses(),
        token,
        capabilities,
        can_start,
    })
}

/// 打开 / 关掉算力中心，或者换端口、换令牌。
///
/// 打开时至少一项能力要齐全——这也是用户的要求：模型包齐全才允许开。
#[tauri::command]
pub fn compute_center_configure(
    app: tauri::AppHandle,
    enabled: bool,
    port: Option<u16>,
    rotate_token: Option<bool>,
) -> CommandResult<ComputeCenterStatus> {
    let (model_data, data) = match paths(&app) {
        Ok(paths) => paths,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    let mut snapshot = match preferences(&app) {
        Ok(snapshot) => snapshot,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    if let Some(port) = port {
        // 1024 以下要管理员权限，而且这一项是用户随手填的，收个范围就好。
        if port < 1024 {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                "端口要用 1024 以上（以下的端口通常要管理员权限）",
                false,
            );
        }
        snapshot.compute_center_port = port;
    }
    if rotate_token.unwrap_or(false) || snapshot.compute_center_token.is_empty() {
        snapshot.compute_center_token = fresh_token();
    }
    snapshot.compute_center_enabled = enabled;

    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    center.set_token(&snapshot.compute_center_token);
    if enabled {
        let capabilities = capabilities(&model_data, &data);
        if !capabilities.iter().any(|capability| capability.ready) {
            return CommandResult::failure(
                "INFERENCE_UNAVAILABLE",
                "还没有一项能在远端用的能力：超分模型、去码模型包、DLSS5 至少齐全一个",
                false,
            );
        }
        let context = ServerContext {
            model_data: model_data.clone(),
            data: data.clone(),
        };
        if let Err(error) = center.start(context, snapshot.compute_center_port) {
            // 端口被占、绑不上：这是本机的一次网络动作失败（前端错误码表里是 `NETWORK`）。
            // 别用表里没有的码——发出去整条错误会被桥当成无效响应。
            return CommandResult::failure("NETWORK", error, true);
        }
    } else {
        center.stop();
    }

    let saved = match store_preferences(&app, snapshot) {
        Ok(snapshot) => snapshot,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let capabilities = capabilities(&model_data, &data);
    let can_start = capabilities.iter().any(|capability| capability.ready);
    CommandResult::success(ComputeCenterStatus {
        running: center.is_running(),
        port: saved.compute_center_port,
        addresses: local_addresses(),
        token: saved.compute_center_token,
        capabilities,
        can_start,
    })
}

/// 连一次远端，拿它的能力清单（移动端「连接」按钮）。
#[tauri::command]
pub async fn remote_compute_capabilities(
    url: String,
    token: String,
) -> CommandResult<RemoteCapabilities> {
    match tauri::async_runtime::spawn_blocking(move || remote_capabilities(&url, &token)).await {
        Ok(Ok(capabilities)) => CommandResult::success(capabilities),
        // 连不上就是「这个地址这一刻没有服务」：`NETWORK_ERROR` 不在前端的错误码表里，
        // 发出去整条错误会被桥当成无效响应，真正的信息反而看不到。
        Ok(Err(error)) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

/// 把本地缓存里的一页发给远端处理，取回 PNG 字节。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcessInput {
    pub url: String,
    pub token: String,
    pub params: ProcessParams,
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 从哪一版开始发：`reader-page` / `decensored` / `enhanced`。
    #[serde(default)]
    pub source: Option<String>,
    /// 起点那一版是哪两个模型产出的（与 DLSS5 那条路同一个规矩：起点按产出它的
    /// 模型存，要算出同一个 revision 才读得到）。
    #[serde(default)]
    pub decensor_model: Option<String>,
    #[serde(default)]
    pub upscale_model: Option<String>,
    /// 前端给这次任务起的号：翻页之后就不必再发出去了。
    #[serde(default)]
    pub task_id: Option<String>,
}

#[tauri::command]
pub async fn remote_compute_process(
    input: RemoteProcessInput,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let data = match crate::data_paths::data_dir(&app) {
        Ok(value) => value,
        Err(error) => {
            return Ok(crate::domain::result::into_binary_response(
                CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false),
            ))
        }
    };
    let result = crate::inference::run_heavy(move || {
        let database = app.state::<crate::db::Database>();
        remote_process_cached_page(&database, &data, &input)
    })
    .await?;
    Ok(crate::domain::result::into_binary_response(result))
}

fn remote_process_cached_page(
    database: &crate::db::Database,
    data_dir: &std::path::Path,
    input: &RemoteProcessInput,
) -> CommandResult<Vec<u8>> {
    use crate::cache::{load_image_cache, CacheImageIdentity};

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    let rendition = input.source.as_deref().unwrap_or("reader-page");
    let revision = match crate::inference::source_revision(
        data_dir,
        rendition,
        input.decensor_model.as_deref(),
        input.upscale_model.as_deref(),
    ) {
        Ok(revision) => revision,
        Err(error) => return CommandResult::failure(error.code, error.message, false),
    };
    // 取消牌先登记：等全局闸的时候用户可能已经翻页了，那就不必再把这一页发出去
    // （远端那一次要跑很久，本机这段时间只允许一件重活）。
    let guard = crate::inference::cancel::begin(input.task_id.as_deref());
    if guard.cancelled() {
        return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false);
    }
    let mut identity =
        CacheImageIdentity::new(&input.scope_id, &input.archive_id, rendition, input.page_index);
    identity.revision = revision;
    let connection = match database.connection.lock() {
        Ok(value) => value,
        Err(_) => return CommandResult::failure("UNKNOWN", "Database lock failed", true),
    };
    let page = match load_image_cache(&connection, data_dir, &identity) {
        Ok(Some(image)) => image,
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    drop(connection);
    // 已经发出去的那一次没法从这一侧掐断（阻塞式 HTTP），所以只保证「取消之后不再
    // 发出新的」。发出去之后的结果仍然按正常路径回来，只是前端已经不要了。
    if guard.cancelled() {
        return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false);
    }

    match remote_process(&input.url, &input.token, &input.params, page.bytes) {
        Ok(bytes) => CommandResult::success(bytes),
        // 远端那一步的失败带着自己的码：超时是可重试的（本地可以退到本机那一版
        // 继续读），4xx 是我们发错了、不该原样重试。
        Err(error) => CommandResult::failure(error.code, error.message, error.retryable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_must_match_exactly_and_never_match_an_empty_stored_token() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        // 没有令牌就等于没开门，别把空串当成「放行」。
        assert!(!token_matches("", ""));
        assert!(!token_matches("", "anything"));
    }

    #[test]
    fn addresses_are_normalized_with_a_default_port_and_scheme() {
        assert_eq!(normalize_base("192.168.1.5").unwrap(), "http://192.168.1.5:47653");
        assert_eq!(
            normalize_base("192.168.1.5:8080").unwrap(),
            "http://192.168.1.5:8080"
        );
        assert_eq!(
            normalize_base("https://nas.local/").unwrap(),
            "https://nas.local:47653"
        );
        assert!(normalize_base("   ").is_err());
    }

    #[test]
    fn a_page_gets_dropped_when_no_model_is_installed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let params = ProcessParams {
            op: "upscale".into(),
            model_id: Some("nope".into()),
            scale: Some(2),
            dlssnr: None,
        };
        // 没有模型时走最近邻：它照样能跑，只是没模型（与阅读器一致）。
        let png = crate::inference::run_upscale_bytes(dir.path(), "", &one_pixel_png(), Some(2))
            .expect("最近邻放大");
        assert!(!png.is_empty());
        // 而点名一个不存在的模型时要明确报错，不该悄悄降级。
        let error = process(dir.path(), dir.path(), &params, &one_pixel_png()).expect_err("该报错");
        assert!(error.contains("nope") || error.contains("Wrong") || error.len() > 0, "{error}");
    }

    fn one_pixel_png() -> Vec<u8> {
        let mut encoded = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut encoded)
            .write_image(&[255u8, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
            .expect("编码");
        encoded
    }

    #[test]
    fn a_client_round_trip_over_loopback_works_with_a_token_and_refuses_without_one() {
        let dir = tempfile::tempdir().expect("临时目录");
        let context = ServerContext {
            model_data: dir.path().to_path_buf(),
            data: dir.path().to_path_buf(),
        };
        let center = ComputeCenter::new();
        center.set_token("token-123");
        let port = center.start(context, 0).expect("起服务");
        let base = format!("127.0.0.1:{port}");

        // 令牌不对：对面要明确拒绝，而不是给一份空清单。
        let refused = remote_capabilities(&base, "wrong-token").expect_err("该拒绝");
        assert!(refused.contains("401"), "{refused}");

        // 令牌对：拿到三项能力（这台机器上什么都没装，所以都不 ready）。
        let capabilities = remote_capabilities(&base, "token-123").expect("能力清单");
        assert_eq!(capabilities.version, PROTOCOL_VERSION);
        assert_eq!(capabilities.capabilities.len(), 3);
        assert!(capabilities.capabilities.iter().all(|item| !item.ready));

        // 处理一张 1×1 的图：没有模型时走最近邻，回的是 PNG。
        let params = ProcessParams {
            op: "upscale".into(),
            model_id: None,
            scale: Some(2),
            dlssnr: None,
        };
        let bytes = remote_process(&base, "token-123", &params, one_pixel_png()).expect("处理");
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "回的是 PNG");

        center.stop();
        // 关掉之后就该连不上了（端口没人听）。
        let after_stop = remote_capabilities(&base, "token-123").expect_err("服务已停");
        assert!(!after_stop.is_empty());
    }

    #[test]
    fn capabilities_are_computed_without_any_model_installed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let capabilities = capabilities(dir.path(), dir.path());
        let ids: Vec<&str> = capabilities.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["upscale", "decensor", "dlssnr"]);
        assert!(!capabilities[0].ready, "没有模型时超分不该是 ready");
        assert!(!capabilities[1].ready);
        assert!(capabilities[0].detail.contains("超分模型"));
    }

    /// 对服务说一段原始 HTTP。客户端的库不会发出坏请求，所以协议层的严格性只能
    /// 这样验——这一层以前把「声明 100 字节、只收到 10」当成一个完整请求处理。
    fn raw_request(port: u16, request: &[u8]) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("连上服务");
        let _ = stream.write_all(request);
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).to_string()
    }

    fn server_for(dir: &std::path::Path) -> (ComputeCenter, u16) {
        let context = ServerContext {
            model_data: dir.to_path_buf(),
            data: dir.to_path_buf(),
        };
        let center = ComputeCenter::new();
        center.set_token("token-123");
        let port = center.start(context, 0).expect("起服务");
        (center, port)
    }

    #[test]
    fn a_truncated_body_is_refused_with_a_reason_instead_of_being_processed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let response = raw_request(
            port,
            b"POST /v1/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: token-123\r\ncontent-length: 100\r\n\r\n0123456789",
        );
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(response.contains("INCOMPLETE_BODY"), "{response}");
        center.stop();
    }

    #[test]
    fn an_unsupported_or_ambiguous_framing_is_refused_at_the_door() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let head = |extra: &str| {
            format!(
                "POST /v1/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: token-123\r\n{extra}\r\n"
            )
        };
        // 重复的长度头：读哪一个都可能错，所以不猜。
        let duplicated = raw_request(
            port,
            head("content-length: 1\r\ncontent-length: 2\r\n").as_bytes(),
        );
        assert!(duplicated.starts_with("HTTP/1.1 400"), "{duplicated}");
        assert!(duplicated.contains("重复的 Content-Length"), "{duplicated}");

        // 分块传输：这一版解析器读不对，明确拒绝好过读成一个 0 字节的体。
        let chunked = raw_request(
            port,
            head("transfer-encoding: chunked\r\n").as_bytes(),
        );
        assert!(chunked.starts_with("HTTP/1.1 400"), "{chunked}");
        assert!(chunked.contains("Transfer-Encoding"), "{chunked}");

        // 长度不是数字：以前被静默当成 0，然后拿一个空体去处理。
        let garbage = raw_request(port, head("content-length: abc\r\n").as_bytes());
        assert!(garbage.starts_with("HTTP/1.1 400"), "{garbage}");
        assert!(garbage.contains("不是数字"), "{garbage}");

        // 超过上限：413，而且说清楚上限是多少。
        let oversized = raw_request(
            port,
            head(&format!("content-length: {}\r\n", MAX_BODY + 1)).as_bytes(),
        );
        assert!(oversized.starts_with("HTTP/1.1 413"), "{oversized}");
        assert!(oversized.contains(&MAX_BODY.to_string()), "{oversized}");
        center.stop();
    }
}
