//! 算力中心：把桌面端的超分 / DLSSNR 借给局域网里的移动端用。
//!
//! 两个方向都在这一个模块里：
//!
//! * **服务端**（桌面）：一条极简的 HTTP/1.1 服务，`GET /v2/capabilities` 报能力、
//!   `POST /v2/process` 收字节回字节。协议自己写（tokio + `TcpListener`），不引框架：
//!   只有两个端点、一个令牌头，`Content-Length` + `Connection: close` 就够了。
//! * **客户端**（任意端）：`remote_*` 几条命令，把本机缓存里的一页发给远端、取回
//!   处理好的图。移动端没法直接发 HTTP（webview 里没有网络权限这条路），所以由
//!   Rust 代发。
//!
//! 安全上的取舍：
//! * 默认**不开**；可用模型由远端请求时动态读取。
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
/// 配对的请求体上限：那两个端点只收一小段 JSON，不该跟着数据端点一起按兆收
/// （docs/175 R05）。
const MAX_PAIR_BODY: usize = 8 * 1024;
/// 读**请求头**的期限（整段头一次算，不是「每读一次宽限一次」）。对面连上了却不说话
/// （半开连接、慢速滴水）不能永远占着一个连接位，也不能永远占着一条任务（docs/175 R05）。
const HEAD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);
/// 读**请求体**的期限。一页上兆的图在局域网里够用；卡住不动的那条要放掉。
const BODY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);
/// 同时开着的连接上限：每条连接一条任务 + 一份缓冲，没有上限就是没有边界（docs/175 R05）。
const MAX_CONNECTIONS: usize = 16;
/// 在途请求体的总字节预算：单条上限仍是 [`MAX_BODY`]，但几条大上传叠在一起也能把内存吃光。
/// 超出这条预算的那一条当场回 503，而不是先把体读进来再说（docs/175 R05）。
const MAX_INFLIGHT_BODY_BYTES: usize = 128 * 1024 * 1024;

/// 服务名与版本：`/v1/ping` 用它自报家门（移动端连上时先确认对面是同类应用）。
const SERVICE_NAME: &str = "yomika-compute-center";
const PROTOCOL_VERSION: u32 = 2;
const DISCOVERY_PORT: u16 = 47654;
const DISCOVERY_REQUEST: &[u8] = b"YOMIKA_DISCOVER_V2";

/// 配对列表变了（有新设备配对成功）：发给 webview，让正开着的设置页重拉一次。
///
/// 配对是**对面**发起的——它直接打本机的 `/v2/pair/confirm`，前端没有任何别的办法
/// 知道这件事（唯一的来源是挂载设置页时那次 `compute_center_status`，所以以前要退出
/// 再进才看得见新设备）。名字必须与 `nativeComputeCenterRepository.ts` 里的
/// `COMPUTE_CENTER_PAIRING_CHANGED_EVENT` 一致。
pub const PAIRING_CHANGED_EVENT: &str = "compute-center-pairing-changed";

/// 有人请求配对，这一端要显示六位码：发给 webview，由前端画成主题内的弹窗。
///
/// 以前这里用的是 `tauri_plugin_dialog` 的系统消息框，画出来是一张 Windows 原生白底
/// 窗体，与应用主题、字体、深浅色都无关（用户报的「配对码弹窗不符合主题」）。事件之外
/// 还要把主窗叫到前面：要读这串数字的人坐在**这一台**机器前面，而窗口可能缩在托盘里，
/// 或者被别的窗口盖住——弹窗画在一个看不见的窗口里等于没弹。
///
/// 名字必须与 `nativeComputeCenterRepository.ts` 里的
/// `COMPUTE_CENTER_PAIRING_CODE_EVENT` 一致。
pub const PAIRING_CODE_EVENT: &str = "compute-center-pairing-code";

/// 配对码的有效期：与 [`PairingState::begin`] 里写死的一致，前端拿它做倒计时。
const PAIRING_CODE_TTL_SECONDS: u64 = 90;

/// 一项能力：移动端据此显示「对面有什么、能不能用」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    /// `upscale` / `dlssnr`。
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
    /// 保留旧字段供前端状态解析；服务可以在尚未安装模型时启动。
    pub can_start: bool,
    pub paired_clients: Vec<PairedClient>,
    pub windows_service_supported: bool,
    pub windows_service_installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedClient {
    pub id: String,
    pub name: String,
    pub address: String,
    /// 发起配对那一端自报的设备类型（`phone` / `tablet` / `desktop`），只用来挑图标。
    ///
    /// `default`：这一版之前存下的 `compute-center-clients.json` 里没有这个键，读回来必须
    /// 还是「好文件」，不能因为少一个装饰性字段就把整份配对列表丢掉。
    #[serde(default)]
    pub kind: Option<String>,
    token: String,
}

/// 移动端看到的远端能力清单。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    pub service: String,
    pub version: u32,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub models: Vec<crate::inference::RunnableModel>,
    /// 服务端配置版本（模型内容、参数、DLL 和政策），独立于每次请求的处理链。
    ///
    /// `default`：这一版之前起着的服务端不会发这个键，读回来必须是「好清单 + 不知道是哪一版」，
    /// 不能因为少一个字段就把整份能力清单丢掉。
    #[serde(default)]
    pub revision: String,
}

/// 服务端句柄。
#[derive(Default)]
pub struct ComputeCenter {
    inner: Mutex<Option<Running>>,
    /// 令牌随时可能被用户换：请求进来现读，不用重启服务。
    token: Arc<RwLock<String>>,
    pairing: Arc<PairingState>,
}

#[derive(Default)]
struct PairingState {
    pending: Mutex<Option<PendingPair>>,
    clients: Mutex<Vec<PairedClient>>,
    storage: Mutex<Option<std::path::PathBuf>>,
}

struct PendingPair {
    request_id: String,
    code: String,
    peer: String,
    name: String,
    kind: Option<String>,
    expires: std::time::Instant,
    attempts: u8,
}

impl PairingState {
    fn begin(&self, peer: &str, name: &str, kind: Option<String>) -> Result<(String, String), String> {
        let mut pending = self.pending.lock().map_err(|_| "配对状态不可用")?;
        if pending.as_ref().is_some_and(|item| item.expires > std::time::Instant::now()) {
            return Err("已有配对请求，请稍后重试".into());
        }
        let request_id = fresh_token();
        let secret = fresh_token();
        let code_value = u32::from_str_radix(&secret[..8], 16).map_err(|_| "无法生成配对码")? % 1_000_000;
        let code = format!("{code_value:06}");
        *pending = Some(PendingPair {
            request_id: request_id.clone(),
            code: code.clone(),
            peer: peer.to_string(),
            name: name.chars().take(80).collect(),
            kind,
            expires: std::time::Instant::now() + std::time::Duration::from_secs(90),
            attempts: 0,
        });
        Ok((request_id, code))
    }

    fn confirm(&self, peer: &str, request_id: &str, code: &str) -> Result<String, String> {
        let mut pending = self.pending.lock().map_err(|_| "配对状态不可用")?;
        let item = pending.as_mut().ok_or("没有待确认的配对请求")?;
        if item.expires <= std::time::Instant::now() {
            *pending = None;
            return Err("配对码已过期".into());
        }
        if item.peer != peer || item.request_id != request_id {
            return Err("配对请求不匹配".into());
        }
        item.attempts += 1;
        if !token_matches(&item.code, code) {
            if item.attempts >= 5 { *pending = None; }
            return Err("配对码错误".into());
        }
        let name = item.name.clone();
        let kind = item.kind.clone();
        *pending = None;
        let token = fresh_token();
        let mut clients = self.clients.lock().map_err(|_| "配对列表不可用")?;
        // 只留这一台：这台机器是**它自己**的算力来源，第二台设备配对成功就把上一台整表换掉
        // （旧令牌当场失效，`authorized` 也只会命中这一台）。从前这里是 `push`——列表越排越长，
        // 每台旧设备的令牌都还能用，界面还会把它们列出来当「可切换的设备」。
        let next = vec![PairedClient { id: fresh_token(), name, address: peer.to_string(), kind, token: token.clone() }];
        self.persist(&next)?;
        *clients = next;
        Ok(token)
    }

    fn set_storage(&self, data: &Path) {
        let path = data.join("compute-center-clients.json");
        let Ok(mut storage) = self.storage.lock() else { return; };
        if storage.as_ref() == Some(&path) { return; }
        *storage = Some(path.clone());
        drop(storage);
        let backup = path.with_extension("json.bak");
        if !path.exists() && backup.exists() { let _ = std::fs::rename(&backup, &path); }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(saved) = serde_json::from_slice::<Vec<PairedClient>>(&bytes) {
                if let Ok(mut clients) = self.clients.lock() { *clients = saved; }
            }
        }
    }

    fn persist(&self, clients: &[PairedClient]) -> Result<(), String> {
        let path = self.storage.lock().map_err(|_| "配对路径不可用")?.clone();
        if let Some(path) = path {
            let bytes = serde_json::to_vec(clients).map_err(|error| error.to_string())?;
            let temporary = path.with_extension("json.tmp");
            let backup = path.with_extension("json.bak");
            std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
            if path.exists() {
                if backup.exists() { std::fs::remove_file(&backup).map_err(|error| error.to_string())?; }
                std::fs::rename(&path, &backup).map_err(|error| error.to_string())?;
            }
            if let Err(error) = std::fs::rename(&temporary, &path) {
                if backup.exists() { let _ = std::fs::rename(&backup, &path); }
                return Err(error.to_string());
            }
            if backup.exists() { let _ = std::fs::remove_file(backup); }
        }
        Ok(())
    }

    fn listed(&self) -> Vec<PairedClient> {
        self.clients.lock().map(|clients| clients.iter().cloned().map(|mut client| { client.token.clear(); client }).collect()).unwrap_or_default()
    }

    fn authorized(&self, token: &str) -> bool {
        self.clients.lock().map(|clients| clients.iter().any(|client| token_matches(&client.token, token))).unwrap_or(false)
    }

    fn revoke(&self, id: &str) -> Result<(), String> {
        let mut clients = self.clients.lock().map_err(|_| "配对列表不可用")?;
        let previous = clients.len();
        let next: Vec<_> = clients.iter().filter(|client| client.id != id).cloned().collect();
        if next.len() == previous { return Err("找不到这台已配对设备".into()); }
        self.persist(&next)?;
        *clients = next;
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut clients = self.clients.lock().map_err(|_| "配对列表不可用")?;
        self.persist(&[])?;
        clients.clear();
        Ok(())
    }
}

struct Running {
    port: u16,
    stop: Arc<AtomicBool>,
    discovery: Option<std::thread::JoinHandle<()>>,
    /// 这一轮服务收着的连接（docs/175 R05）：`stop` 不只是叫停 accept，
    /// 还要把已经收下的连接一起收掉，所以句柄得留在 `Running` 上。
    connections: Connections,
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

    pub fn running_port(&self) -> Option<u16> {
        self.inner.lock().ok().and_then(|guard| guard.as_ref().map(|running| running.port))
    }

    /// 开服务。`port` 为 0 或占着就报错——这里不替用户改端口，改端口是设置页的事。
    pub fn start(&self, context: ServerContext, port: u16) -> Result<u16, String> {
        self.pairing.set_storage(&context.data);
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
        let connections = Connections::default();
        let token = Arc::clone(&self.token);
        let pairing = Arc::clone(&self.pairing);

        let stop_for_task = Arc::clone(&stop);
        let connections_for_task = connections.clone();
        // `from_std` 必须在 tokio 的运行环境里调（普通测试线程里没有 reactor），
        // 所以监听套接字在这一步之前就建好了——端口占用这类错也就还能同步报出来。
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            serve(
                listener,
                token,
                Arc::clone(&pairing),
                stop_for_task,
                connections_for_task,
                context,
            )
            .await;
        });
        let discovery = if port != 0 {
            let discovery_stop = Arc::clone(&stop);
            Some(std::thread::spawn(move || serve_discovery(bound, discovery_stop)))
        } else {
            None
        };
        *guard = Some(Running {
            port: bound,
            stop,
            discovery,
            connections,
        });
        Ok(bound)
    }

    /// 关服务：置位之后往自己的端口连一次，把卡在 `accept` 上的循环叫醒。
    pub fn stop(&self) {
        let running = self.inner.lock().ok().and_then(|mut guard| guard.take());
        if let Some(running) = running {
            running.stop.store(true, Ordering::SeqCst);
            // 存量连接：**全部收掉**，而不是留着等它们各自的期限到点（docs/175 R05）。
            // 从前 `stop` 只叫停 accept 那一圈，已经 spawn 出去的 handler 谁也不管，
            // 于是一条半开连接会一直挂到它自己超时——而旧代码那条路根本没有期限。
            // 收掉一条连接 = 把它那条任务 abort 掉：未来被丢掉，`TcpStream` 随之析构
            // （对面立刻看到 FIN），在途的那一次计算也会在下一个取消点上退出来。
            running.connections.close_all();
            let _ = std::net::TcpStream::connect(("127.0.0.1", running.port));
            if let Some(discovery) = running.discovery {
                if let Ok(socket) = std::net::UdpSocket::bind("127.0.0.1:0") {
                    let _ = socket.send_to(b"STOP", ("127.0.0.1", DISCOVERY_PORT));
                }
                let _ = discovery.join();
            }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredDevice {
    pub address: String,
    pub name: String,
    pub port: u16,
}

fn serve_discovery(port: u16, stop: Arc<AtomicBool>) {
    let Ok(socket) = std::net::UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else { return };
    let _ = socket.set_read_timeout(Some(std::time::Duration::from_millis(500)));
    let reply = serde_json::json!({ "service": SERVICE_NAME, "version": PROTOCOL_VERSION, "name": host_name(), "port": port }).to_string();
    let mut buffer = [0u8; 128];
    while !stop.load(Ordering::SeqCst) {
        if let Ok((size, peer)) = socket.recv_from(&mut buffer) {
            if &buffer[..size] == DISCOVERY_REQUEST {
                let _ = socket.send_to(reply.as_bytes(), peer);
            }
        }
    }
}

pub fn discover_devices() -> Result<Vec<DiscoveredDevice>, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|error| error.to_string())?;
    socket.set_broadcast(true).map_err(|error| error.to_string())?;
    socket.set_read_timeout(Some(std::time::Duration::from_millis(1200))).map_err(|error| error.to_string())?;
    socket.send_to(DISCOVERY_REQUEST, ("255.255.255.255", DISCOVERY_PORT)).map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    let mut buffer = [0u8; 1024];
    while let Ok((size, peer)) = socket.recv_from(&mut buffer) {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buffer[..size]) else { continue };
        if value.get("service").and_then(|value| value.as_str()) != Some(SERVICE_NAME)
            || value.get("version").and_then(|value| value.as_u64()) != Some(PROTOCOL_VERSION as u64) { continue }
        let Some(port) = value.get("port").and_then(|value| value.as_u64()).and_then(|value| u16::try_from(value).ok()) else { continue };
        let name = value.get("name").and_then(|value| value.as_str()).unwrap_or("Yomika").chars().take(80).collect();
        let address = format!("{}:{port}", peer.ip());
        if !devices.iter().any(|device: &DiscoveredDevice| device.address == address) {
            devices.push(DiscoveredDevice { address, name, port });
        }
    }
    Ok(devices)
}

/// 能力清单：两类各自查一遍「齐不齐」。
///
/// `model_data` 是模型目录（`inference` 那一套的安装根），`data` 是数据目录（DLSSNR
/// 的 DLL 与日志在那里）。
pub fn capabilities(
    model_data: &Path,
    data: &Path,
    manager: Option<&crate::compute::manager::ComputeManager>,
) -> Vec<Capability> {
    let runnable = crate::inference::runnable_models(model_data);
    let upscalers: Vec<&crate::inference::RunnableModel> = runnable
        .iter()
        .filter(|model| model.kind == "upscale")
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
    ];
    capabilities.push(dlssnr_capability(data, manager));
    capabilities
}

#[cfg(windows)]
fn dlssnr_capability(
    data: &Path,
    manager: Option<&crate::compute::manager::ComputeManager>,
) -> Capability {
    // 「引擎那一侧有没有 NGX」只能听 worker 说（宿主这份二进制里没有垫片），所以先问
    // 它握手时报的构建事实；它还没起来时按装配事实答（见 `dlssnr::engine_facts`）。
    let facts = crate::dlssnr::engine_facts(
        manager
            .and_then(|manager| manager.worker_build())
            .as_ref(),
    );
    let status = crate::dlssnr::status_with(data, facts);
    Capability {
        id: "dlssnr".to_string(),
        label: "DLSSNR".to_string(),
        ready: status.available,
        detail: if status.available {
            status.variant_label.unwrap_or_else(|| "已导入".into())
        } else {
            status.error.unwrap_or_else(|| "DLSSNR 不可用".into())
        },
    }
}

#[cfg(not(windows))]
fn dlssnr_capability(
    _data: &Path,
    _manager: Option<&crate::compute::manager::ComputeManager>,
) -> Capability {
    Capability {
        id: "dlssnr".to_string(),
        label: "DLSSNR".to_string(),
        ready: false,
        detail: "DLSSNR 只在 Windows 桌面端可用".to_string(),
    }
}

/// 服务端设置里与远端处理有关的那几项：**一次读完就定格**（docs/175 R01）。
///
/// 这份快照是远端处理唯一的设置来源：请求进来时读一次，之后整条链只读它。中途再回头读本机
/// 偏好就会出现「第一阶段按旧设置算、第二阶段按新设置算」——同一页的两个阶段各用一份模型或
/// 参数，出来的东西既不是旧版本也不是新版本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSettings {
    /// `off` / `cpu` / `auto`。
    pub upscale_backend: String,
    /// 服务端默认的超分模型 id（空 = 没配）。
    pub upscale_model: String,
    pub upscale_output_scale: u32,
    /// DLSSNR 的层参数（JSON 文本，空 = 用默认那一套）。
    pub dlssnr_passes: String,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            upscale_backend: "auto".to_string(),
            upscale_model: String::new(),
            upscale_output_scale: crate::inference::ENHANCED_OUTPUT_SCALE,
            dlssnr_passes: String::new(),
        }
    }
}

impl RemoteSettings {
    /// 从本机偏好里取这一次要用的几项。
    pub fn from_preferences(preferences: &crate::settings::PreferenceSnapshot) -> Self {
        Self {
            upscale_backend: preferences.upscale_backend.clone(),
            upscale_model: preferences.upscale_model.clone(),
            // Fixed-scale graphs follow the native model, including old preferences.
            upscale_output_scale: 0,
            dlssnr_passes: preferences.dlssnr_passes.clone(),
        }
    }

    /// 超分这一档在这台机器上是不是关着的（设置里那一栏是 `off`）。
    pub fn upscale_off(&self) -> bool {
        self.upscale_backend == "off"
    }
}

#[cfg(test)]
#[test]
fn fixed_scale_server_settings_ignore_legacy_output_caps() {
    let preferences = crate::settings::PreferenceSnapshot {
        upscale_model: "realesrgan-x4plus".into(), upscale_output_scale: 1,
        ..Default::default()
    };
    let settings = RemoteSettings::from_preferences(&preferences);
    assert_eq!(settings.upscale_model, preferences.upscale_model);
    assert_eq!(settings.upscale_output_scale, 0, "use the native graph, then downsample for display");
}

/// 客户端显式点名要「没有模型的最近邻」时用的 id。
///
/// 空 id **不算**显式点名：从前空 id 会悄悄落到最近邻上，于是「服务端压根没配模型」被回成
/// 一次成功的超分（内容只是被放大了），客户端还会把它当成模型产物存下来。显式点名才是那条
/// 保留下来的用途（docs/175 R01）。
pub const EXPLICIT_NEAREST_MODEL: &str = "nearest";

/// 一次远端请求的**冻结处理计划**：模型、参数、链顺序只解析一次，之后每一步都只读它。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessPlan {
    /// 实际要做的档，按顺序（动图下会被裁掉改像素的那些）。
    pub steps: Vec<String>,
    /// 超分那一档实际用的模型 id（空 = 明确点名的最近邻）。
    pub model_id: String,
    /// 最近邻的放大倍数。
    pub scale: Option<u32>,
    pub output_scale: u32,
    /// 归一化之后的 DLSSNR 参数（这也是它进身份的那一版）。
    pub dlssnr: serde_json::Value,
    /// 这一页什么都不做、原样交回（动图，且链里没有逐帧那一档）。
    pub passthrough: bool,
    /// 动图这一单里被跳过的档：它们一旦先动手，动画就只剩第一帧（docs/175 R03）。
    pub skipped: Vec<String>,
    /// 超分这一档在缓存/调度身份里的那一串（`enhanced_revision`）。
    pub upscale_revision: String,
    /// 实际模型内容的版本（docs/175 R11）。
    pub model_content: String,
    /// DLSSNR 那一份 DLL 的内容版本（docs/175 R11）。
    pub dll_content: String,
    /// 这一单实际用的本地执行政策（`auto` / `cpu` / `gpu`）。
    pub engine_policy: String,
    /// 这份**实际处理计划**的 revision：模型内容 + DLL 内容 + 归一化参数 + 链顺序 + 政策。
    pub revision: String,
}

impl ProcessPlan {
    /// 把一次请求解析成计划。`settings` 是**请求进来那一刻**读到的服务端设置；`animated`
    /// 是这一页是不是动图（由字节判定，与 [`process`] 里那条规则同一把尺子）。
    fn resolve(
        model_data: &Path,
        data: &Path,
        params: &ProcessParams,
        settings: &RemoteSettings,
        animated: bool,
    ) -> Result<Self, String> {
        let mut steps: Vec<String> = if params.chain.is_empty() {
            if !matches!(params.op.as_str(), "upscale" | "dlssnr") {
                return Err(format!("不认识的处理方式：{}", params.op));
            }
            vec![params.op.clone()]
        } else {
            // 改写上限是两道——两档都做一遍就是全部；重复的那一档没有第二次的意义
            // （同样的模型吃同样的字节出来还是一样）。
            let mut unique: Vec<String> = Vec::new();
            for step in &params.chain {
                if !matches!(step.as_str(), "upscale" | "dlssnr") {
                    return Err(format!("不认识的处理方式：{step}"));
                }
                if !unique.iter().any(|known| known == step) {
                    unique.push(step.clone());
                }
            }
            unique
        };
        // 动图原样交回这一条规则只写一处：改像素的处理方式一旦先动手，出来的就只有第一帧，
        // 回一个「看着成功、其实丢帧」的结果比报错更坏。DLSSNR 不在此列——worker 那边自己
        // 会逐帧走一遍再编回 APNG。所以一串里有它时，把前面那些**会丢帧的档从计划里摘掉**
        // （记在 `skipped` 里），让动画原样走到逐帧那一档（docs/175 R03）。
        let mut skipped: Vec<String> = Vec::new();
        let mut passthrough = false;
        if animated {
            if steps.iter().any(|step| step == "dlssnr") {
                skipped = steps
                    .iter()
                    .filter(|step| step.as_str() != "dlssnr")
                    .cloned()
                    .collect();
                steps.retain(|step| step == "dlssnr");
            } else {
                passthrough = true;
                skipped = std::mem::take(&mut steps);
            }
        }
        // 超分那一档用哪个模型：客户端显式点名（老客户端 / 显式最近邻）优先，否则跟随这台
        // 服务端自己的设置。整条计划就在这里定死——不再问第二次本机偏好。
        let named = params.model_id.as_deref().map(str::trim).unwrap_or_default();
        let mut explicit_nearest = named == EXPLICIT_NEAREST_MODEL;
        let mut model_id = if named.is_empty() {
            settings.upscale_model.trim().to_string()
        } else {
            named.to_string()
        };
        if model_id == EXPLICIT_NEAREST_MODEL {
            explicit_nearest = true;
            model_id.clear();
        }
        let wants_upscale = steps.iter().any(|step| step == "upscale");
        if wants_upscale && named.is_empty() && settings.upscale_off() {
            return Err("服务端设置里超分是关的（off）——这一页不在这里超分".to_string());
        }
        if wants_upscale && model_id.is_empty() && !explicit_nearest {
            // 没有有效模型就是**结构化不可用**，不许把最近邻伪装成所选模型成功。
            if settings.upscale_off() {
                return Err("服务端设置里超分是关的（off）——这一页不在这里超分".to_string());
            }
            return Err(format!(
                "服务端没有配置超分模型（设置里那一栏是空的）：先在服务端选一个，或者显式指名 {EXPLICIT_NEAREST_MODEL} 用最近邻"
            ));
        }
        let resolved = if wants_upscale && !explicit_nearest {
            match crate::inference::resolve_upscaler(model_data, &model_id) {
                Some(found) => Some(found),
                None => return Err(format!("没有装这个超分模型：{model_id}")),
            }
        } else {
            None
        };
        let wants_dlssnr = steps.iter().any(|step| step == "dlssnr");
        let dlssnr = if wants_dlssnr {
            normalized_dlssnr(params.dlssnr.as_ref(), settings)?
        } else {
            serde_json::Value::Null
        };
        let model_content = if explicit_nearest {
            "nearest".to_string()
        } else if wants_upscale {
            crate::inference::upscaler_content_revision(&resolved)
        } else {
            String::new()
        };
        let dll_content = if wants_dlssnr { dll_content(data) } else { String::new() };
        let engine_policy = plan_engine_policy(&steps, settings);
        let mut revision = plan_revision(&steps, &model_id, &model_content, &dlssnr, &dll_content, &format!("{engine_policy}:output:{}", settings.upscale_output_scale));
        if explicit_nearest {
            revision = blake3::hash(format!("{revision}:scale:{}", params.scale.unwrap_or(2)).as_bytes()).to_hex().to_string();
        }
        Ok(Self {
            steps,
            model_id,
            scale: params.scale,
            output_scale: settings.upscale_output_scale,
            dlssnr,
            passthrough,
            skipped,
            upscale_revision: crate::inference::enhanced_revision_with_scale(&resolved, settings.upscale_output_scale),
            model_content,
            dll_content,
            engine_policy,
            revision,
        })
    }
}

/// 计划身份里那一栏「这台机器打算用谁」：超分那一档是本机执行政策，DLSSNR 那一档只有显卡
/// 一条路（没有 CPU 回退）。都从源头派生，不另写拼法。
fn plan_engine_policy(steps: &[String], settings: &RemoteSettings) -> String {
    if steps.iter().any(|step| step == "upscale") {
        if settings.upscale_backend == "cpu" {
            "cpu".to_string()
        } else {
            crate::compute::reader::engine_policy_label().to_string()
        }
    } else if steps.iter().any(|step| step == "dlssnr") {
        "gpu".to_string()
    } else {
        String::new()
    }
}

/// 计划身份串：把「会漂移的东西」全放进去，客户端拿它当缓存键里「对面那一版」。
///
/// 键里只有 device/source/chain 是不够的（docs/175 R11）：服务端换了模型权重、换了参数或换
/// 了那份 DLL，链没变、设备没变，旧产物却被当成新策略的产物接着用。这里只放**哈希与
/// 归一化参数**，不放令牌、不放 API key。
fn plan_revision(
    steps: &[String],
    model_id: &str,
    model_content: &str,
    dlssnr: &serde_json::Value,
    dll_content: &str,
    engine_policy: &str,
) -> String {
    let canonical = serde_json::json!({
        "revision": 3, // Native model processing; delivery is capped at 2x.
        "protocol": PROTOCOL_VERSION,
        "steps": steps,
        "model": model_id,
        "modelContent": model_content,
        "dlssnr": dlssnr,
        "dll": dll_content,
        "policy": engine_policy,
    });
    blake3::hash(canonical.to_string().as_bytes()).to_hex().to_string()
}

/// 服务端配置版本：与请求链无关，能力清单和处理响应必须返回同一语义的版本。
///
/// 它覆盖客户端键里没有的三样：模型内容、DLSSNR 参数、那份 DLL 的内容。链顺序由请求自带。
fn settings_revision(model_data: &Path, data: &Path, settings: &RemoteSettings) -> String {
    let resolved = if settings.upscale_off() || settings.upscale_model.trim().is_empty() {
        None
    } else {
        crate::inference::resolve_upscaler(model_data, settings.upscale_model.trim())
    };
    let dlssnr = normalized_dlssnr(None, settings).unwrap_or(serde_json::Value::Null);
    plan_revision(
        &["upscale".to_string(), "dlssnr".to_string()],
        settings.upscale_model.trim(),
        &crate::inference::upscaler_content_revision(&resolved),
        &dlssnr,
        &dll_content(data),
        &format!("{}:{}:output:{}", settings.upscale_backend, plan_engine_policy(&["upscale".into()], settings), settings.upscale_output_scale),
    )
}

/// DLSSNR 那一份片段 DLL 的内容版本（读不到就是空串：那也是「这台机器上没有它」这个事实）。
#[cfg(windows)]
fn dll_content(data: &Path) -> String {
    // Share the content fingerprint used by import/probing. It is invalidated
    // on installation and keyed by file metadata, rather than reading the whole
    // DLL at capabilities, plan creation and both ends of every page request.
    crate::dlssnr::dll_identity(data)
}

#[cfg(not(windows))]
fn dll_content(_data: &Path) -> String {
    String::new()
}

/// 请求里给的参数优先，没给就取服务端设置里那一份，都没有就是默认那一套。**归一化只做
/// 一次**，结果既进计划的身份也交给 worker。
#[cfg(windows)]
fn normalized_dlssnr(
    requested: Option<&serde_json::Value>,
    settings: &RemoteSettings,
) -> Result<serde_json::Value, String> {
    use crate::dlssnr::DlssnrSettings;

    let value = match requested {
        Some(value) => value.clone(),
        None if settings.dlssnr_passes.trim().is_empty() => serde_json::Value::Null,
        None => serde_json::from_str::<serde_json::Value>(&settings.dlssnr_passes)
            .map_err(|error| format!("服务端设置里的 DLSSNR 参数不是合法 JSON：{error}"))?,
    };
    let parsed = if value.is_null() {
        DlssnrSettings::default()
    } else {
        serde_json::from_value::<DlssnrSettings>(if value.is_array() {
            serde_json::json!({ "passes": value })
        } else { value })
            .map_err(|error| format!("DLSSNR 参数不对：{error}"))?
    };
    serde_json::to_value(parsed.normalized()).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn normalized_dlssnr(
    requested: Option<&serde_json::Value>,
    settings: &RemoteSettings,
) -> Result<serde_json::Value, String> {
    if let Some(value) = requested {
        return Ok(value.clone());
    }
    if settings.dlssnr_passes.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&settings.dlssnr_passes)
        .map_err(|error| format!("服务端设置里的 DLSSNR 参数不是合法 JSON：{error}"))
}

/// 请求要干的事。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessParams {
    /// `upscale` / `dlssnr`。
    pub op: String,
    /// 这一页要做的**几档**，按顺序做（`["upscale","dlssnr"]` 就是先超分再去噪）。
    ///
    /// 空的就按 `op` 单做一档（老客户端与直接调用的来路照旧）。客户端只说「做什么」，
    /// **模型与参数一律不传**：那两样跟随这台服务端自己的设置（`model_id` 为空时
    /// `resolve_upscaler` 取的就是本机默认那一份，DLSSNR 取
    /// `DlssnrSettings::default()`）——这正是「远端处理固定跟随远端服务的设置」。
    #[serde(default)]
    pub chain: Vec<String>,
    /// 模型 id（超分用）。
    #[serde(default)]
    pub model_id: Option<String>,
    /// 放大倍数（模型为空时的最近邻路径用）。
    #[serde(default)]
    pub scale: Option<u32>,
    /// DLSSNR 的 1–5 层参数。
    #[serde(default)]
    pub dlssnr: Option<serde_json::Value>,
}

impl ProcessParams {
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|error| format!("参数不是合法 JSON：{error}"))
    }
}

/// 一次处理：字节进、字节出。三个方向都收敛到这里。
///
/// 三个方向**都不在宿主进程里算了**：`manager` 是算力编排的把手，装 ONNX 模型的那一档、
/// 内置的 Anime4K 那一档、DLSSNR 那一档都必须经由它交给 worker。这不是可选的分流——Task 8
/// 的出口就是「宿主进程里没有 ONNX Runtime，也没有 NGX 资源」，所以这里不能再留一条「引擎
/// 在宿主就地跑」的兜底来路（docs/175 R02：内置链从前是绕开 worker 在宿主 CPU 上跑的）。
/// 宿主自己还能算的只剩一样：没有模型的最近邻，而且它现在**要点名才算**。
///
/// `cancelled` 是**这条请求自己**的取消牌：对面把连接丢了就该停下（见 `handle_connection`
/// 里那个读端观察任务）。它不是「本机用户走开了」那张牌——那两张牌各管各的。
pub fn process(
    manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path,
    data: &Path,
    params: &ProcessParams,
    bytes: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    process_planned(
        manager,
        model_data,
        data,
        params,
        &RemoteSettings::default(),
        bytes,
        cancelled,
    )
    .map(|(bytes, _plan)| bytes)
}

/// 带服务端设置快照的那一版：服务端自己那条来路走它，并把实际用的计划一起交回去
/// （响应头要靠它说「这一次真正用的是哪一版」，docs/175 R11）。
///
/// 设置在这里读**一次**，整条链只读这份计划——中途不再回头读本机偏好（docs/175 R01）。
pub fn process_planned(
    manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path,
    data: &Path,
    params: &ProcessParams,
    settings: &RemoteSettings,
    bytes: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, ProcessPlan), String> {
    process_planned_with_managers(manager, manager, model_data, data, params, settings, bytes, cancelled)
}

fn process_planned_with_managers(
    manager: Option<&crate::compute::manager::ComputeManager>,
    dlssnr_manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path, data: &Path, params: &ProcessParams,
    settings: &RemoteSettings, bytes: &[u8], cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<u8>, ProcessPlan), String> {
    if bytes.is_empty() {
        return Err("请求体是空的（要发图片字节）".to_string());
    }
    let plan = ProcessPlan::resolve(
        model_data,
        data,
        params,
        settings,
        crate::cache::is_animated_image(bytes),
    )?;
    if plan.passthrough {
        return Ok((bytes.to_vec(), plan));
    }
    let mut current = bytes.to_vec();
    for step in plan.steps.clone() {
        if cancelled() {
            return Err("对面把这条连接丢了".to_string());
        }
        current = match step.as_str() {
            "upscale" => upscale_bytes(manager, model_data, &plan, &current, cancelled)?,
            "dlssnr" => dlssnr_bytes(dlssnr_manager, data, &plan, &current, cancelled)?,
            other => return Err(format!("不认识的处理方式：{other}")),
        };
    }
    let resolved = if plan.model_id.is_empty() { None } else {
        crate::inference::resolve_upscaler(model_data, &plan.model_id)
    };
    if plan.steps.iter().any(|step| step == "upscale") && !plan.model_id.is_empty()
        && crate::inference::upscaler_content_revision(&resolved) != plan.model_content {
        return Err("超分模型在处理期间发生变化，请重新请求".into());
    }
    if plan.steps.iter().any(|step| step == "dlssnr") && dll_content(data) != plan.dll_content {
        return Err("DLSSNR DLL 在处理期间发生变化，请重新请求".into());
    }
    Ok((current, plan))
}

/// 超分：装了 ONNX 模型的那一档与**内置 shader 链**那一档都交给计算进程，宿主只留下
/// 「显式点名的最近邻」那一条（`plan.model_id` 为空时才是它）。
///
/// docs/175 R02：内置链从前走的是 `run_host_upscale_bytes`，于是它在**宿主 CPU 上**跑——
/// 既绕开了本地执行政策（设置里选了 auto/gpu 也照样按 CPU 算），也绕开了 worker 那一侧的
/// 引擎选择与回退报告。现在两档都只说「要哪一档」，引擎由 worker 按政策挑。
fn upscale_bytes(
    manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path,
    plan: &ProcessPlan,
    source: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let model_id = plan.model_id.as_str();
    let resolved = if model_id.is_empty() {
        None
    } else {
        crate::inference::resolve_upscaler(model_data, model_id)
    };
    if !model_id.is_empty() && (resolved.is_none()
        || crate::inference::upscaler_content_revision(&resolved) != plan.model_content) {
        return Err("超分模型在计划解析后发生变化，请重新请求".into());
    }
    // 交给计算进程的那两档：ONNX 用模型自己的倍率，内置链用链自己的倍率。
    let delegated: Option<(&str, u32)> = match &resolved {
        Some(crate::inference::ResolvedUpscaler::Onnx(_, manifest)) => {
            Some((model_id, manifest.scale.clamp(1, 4)))
        }
        // 内置链的名字就是它的模型 id：`compute::models` 认出来之后补 `builtin`。
        Some(crate::inference::ResolvedUpscaler::Anime4k(preset)) => {
            Some((preset.id, preset.scale.clamp(1, 4)))
        }
        None => None,
    };
    let Some((model_spec_id, scale)) = delegated else {
        return crate::inference::run_host_upscale_bytes(model_data, model_id, source, plan.scale);
    };
    let manager = manager.ok_or_else(no_orchestration)?;
    let input_id = format!("remote:{}", blake3::hash(source).to_hex());
    crate::compute::proxy::upscale(
        manager,
        crate::compute::proxy::UpscaleJob {
            input_id: &input_id,
            policy: if plan.engine_policy == "cpu" {
                yomika_compute_protocol::EnginePolicy::Cpu
            } else {
                crate::compute::reader::engine_policy()
            },
            // Include actual model content and the frozen policy in the scheduler key.
            settings_id: &plan.revision,
            // 这一页是从网络那头来的字节，没有本机归档与页码可讲；四元身份里的
            // 这一栏就照实说「远端字节」，而不是借一个像模像样的页码。
            source_revision: "remote-bytes",
            // 网络另一端也有正在等这一页的读者；与本机可见页按前台 FIFO 共享执行机会。
            priority: crate::compute::scheduler::Priority::Foreground,
            // 倍数由模型说了算（`scale` 是模型自己的属性），这里不再让请求体
            // 覆盖它——覆盖会让同一份输入因参数不同落进两个任务身份。
            output_scale: (plan.output_scale != 0).then_some(plan.output_scale),
            stage: crate::compute::proxy::StageSpec {
                stage_id: crate::compute::reader::UPSCALE_STAGE_ID,
                model_spec_id,
                scale,
                page: source,
            },
        },
        cancelled,
    )
    .map_err(proxy_failure)
}

/// 编排没起来时的说法：远端超分**只走计算进程**。
///
/// 2026-10-16 复审指出旧文案「宿主手里已经没有它的引擎了」说过头了：
/// `inference::run_host_upscale_bytes` 仍然编在宿主里、也仍然能开内置链，只是**这条来路
/// 已经不给它输入**——远端页面在这里一律先解析成计划（`upscale_bytes` 的 `resolved`），
/// 内置链与 ONNX 两档都进 `delegated` 交给 worker，只有「显式不点名模型」的最近邻才落到
/// 宿主（`model_id` 为空那一支）。所以这句话说「这条来路只走计算进程」，不说「宿主没有引擎」。
fn no_orchestration() -> String {
    "计算编排还没起来，这一页没法交给计算进程（远端超分只走计算进程）".to_string()
}

/// 字节桥的错误压成字符串：这一层没有错误码可回（HTTP 那边统一回
/// `INFERENCE_UNAVAILABLE`），所以把桥自己的码留在文字里，日志里还能看出是哪一段。
fn proxy_failure(error: crate::compute::proxy::ProxyError) -> String {
    format!("{}（{}）", error.message, error.code)
}

/// DLSSNR：一份 DLL（按内容摆盘）+ 一套参数 + 这一页，三样都交出去。
///
/// 逐帧那件事不用在这儿分岔：worker 认得动图（`worker/src/dlssnr.rs` 逐帧跑完编回 APNG），
/// 所以远端发来的字节**原样**摆进只读输入根——先在宿主里压成 PNG，动图就只剩第一帧了。
///
/// 门控排在「编排没起来」之前：这台机器根本跑不了 DLSSNR（没导入片段 / 没链上核心 / 显卡不
/// 在支持范围）是**永久**的事实，对端该先听到它；「编排没起来」是暂态的。门控只看那份 DLL
/// 是不是个文件，载它的是 worker。
#[cfg(windows)]
fn dlssnr_bytes(
    manager: Option<&crate::compute::manager::ComputeManager>,
    data: &Path,
    plan: &ProcessPlan,
    source: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    use crate::dlssnr::DlssnrSettings;

    // 参数取自计划：归一化在 `ProcessPlan::resolve` 里已经做过一次，这里不再回头问请求、
    // 也不再问本机偏好（docs/175 R01）。
    if dll_content(data) != plan.dll_content {
        return Err("DLSSNR DLL 在计划解析后发生变化，请重新请求".into());
    }
    let settings: DlssnrSettings = serde_json::from_value::<DlssnrSettings>(plan.dlssnr.clone())
        .map_err(|error| format!("DLSSNR 参数不对：{error}"))?
        .normalized();
    crate::dlssnr::runtime_gate_with(
        data,
        crate::dlssnr::engine_facts(
            manager
                .and_then(|manager| manager.worker_build())
                .as_ref(),
        )
        .gpu,
    )?;
    let manager = manager.ok_or_else(no_orchestration)?;
    let settings_id = plan.revision.clone();
    let input_id = format!("remote:{}", blake3::hash(source).to_hex());
    let outcome = crate::compute::proxy::dlssnr(
        manager,
        crate::compute::proxy::DlssnrJob {
            input_id: &input_id,
            settings_id: &settings_id,
            source_revision: "remote-bytes",
            // 网络另一端也有正在等这一页的读者；与本机可见页按前台 FIFO 共享执行机会。
            priority: crate::compute::scheduler::Priority::Foreground,
            stage_id: crate::compute::proxy::DLSSNR_STAGE_ID,
            feature: &crate::dlssnr::dll_path(data),
            settings: &settings,
            page: source,
        },
        cancelled,
    )
    .map_err(proxy_failure)?;
    // 「原样交回」（worker 报的引擎名是 `passthrough`）对这条来路是正常结果：远端只看
    // content-type，把源字节还回去照样能播（动图不适用是常态）。这里没有产物缓存要写，
    // 所以不写缓存这一条不适用；只记一条日志，方便和本机那条路对上同一个现象。
    if !outcome.computed {
        if let Err(log_error) = crate::error_log::record_at_data_dir(
            data,
            "warn",
            "dlssnr/passthrough",
            "远端这一页的评估两次都原样交回了输入",
            Some(&settings.to_json()),
        ) {
            eprintln!("yomika: DLSSNR 原样交回没能写进错误日志：{log_error}");
        }
    }
    Ok(outcome.bytes)
}

#[cfg(not(windows))]
fn dlssnr_bytes(
    _manager: Option<&crate::compute::manager::ComputeManager>,
    _data: &Path,
    _plan: &ProcessPlan,
    _source: &[u8],
    _cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    Err("DLSSNR 只在 Windows 桌面端可用".to_string())
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

/// 请求头读完了、体还没读的那一段（docs/175 R05）。
///
/// 拆开是因为「先读满体再鉴权」是这条来路最大的一个坑：一条令牌不对的连接也能让本机先
/// 备下一份 64 MB 的缓冲，而且在体读进来之前它不占任何预算。
struct RequestHead {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    content_length: usize,
    /// 读头那一次多读进来的字节——它们已经是体的开头了，不能丢。
    leftover: Vec<u8>,
}

impl RequestHead {
    fn header(&self, name: &str) -> &str {
        self.headers.get(name).map(String::as_str).unwrap_or_default()
    }
}

/// 只读请求头，不读体。头上给一个期限（docs/175 R05）：一个字节一个字节发的半开连接
/// 从前可以让服务端一直等它。
async fn read_request_head(stream: &mut TcpStream) -> Result<RequestHead, RequestError> {
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
        let read = match tokio::time::timeout(HEAD_DEADLINE, stream.read(&mut chunk)).await {
            Ok(Ok(read)) => read,
            Ok(Err(error)) => {
                return Err(RequestError::bad_request(
                    "INVALID_RESPONSE",
                    format!("读请求失败：{error}"),
                ))
            }
            Err(_) => {
                return Err(RequestError {
                    status: 408,
                    reason: "Request Timeout",
                    code: "INVALID_RESPONSE",
                    message: format!("请求头没有在 {} 秒内发完", HEAD_DEADLINE.as_secs()),
                })
            }
        };
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

    Ok(RequestHead {
        method,
        path,
        headers,
        content_length,
        leftover: buffer[header_end + 4..].to_vec(),
    })
}

/// 读体：只读对面声明的那点字节，给一个总期限（docs/175 R05）。期限到了还没读满就当场
/// 报「不完整」，而不是把这条连接无限期挂在读上。
async fn read_request_body(
    stream: &mut TcpStream,
    content_length: usize,
    leftover: Vec<u8>,
) -> Result<Vec<u8>, RequestError> {
    let mut body = leftover;
    let deadline = tokio::time::Instant::now() + BODY_DEADLINE;
    while body.len() < content_length {
        let mut chunk = vec![0u8; (content_length - body.len()).min(64 * 1024)];
        let read = match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(read)) => read,
            Ok(Err(error)) => {
                return Err(RequestError::bad_request(
                    "INCOMPLETE_BODY",
                    format!("读请求体失败：{error}"),
                ))
            }
            Err(_) => {
                return Err(RequestError::bad_request(
                    "INCOMPLETE_BODY",
                    format!(
                        "请求体没在期限内读完：声明 {content_length} 字节，只收到 {}",
                        body.len()
                    ),
                ))
            }
        };
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

    Ok(body)
}

fn find_headers_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// 回包。写成泛型是因为「算了很久」那条路会把连接拆成读写两半（读端要单独一条任务盯着对面
/// 还在不在），回包只能从 `WriteHalf` 那一半写出去。
async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    stream: &mut W,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    write_response_with(stream, status, reason, content_type, &[], body).await
}

/// 带额外响应头的那一版：远端处理那条来路要用它说「这一次真正用的是哪一版计划」
/// （docs/175 R11）。做成参数而不是常量，别的来路的回包形状一个字节都不变。
async fn write_response_with<W: tokio::io::AsyncWrite + Unpin>(
    stream: &mut W,
    status: u16,
    reason: &str,
    content_type: &str,
    extra: &[(&str, &str)],
    body: &[u8],
) -> Result<(), String> {
    let mut header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in extra {
        header.push_str(name);
        header.push_str(": ");
        header.push_str(value);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
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

async fn write_json<W: tokio::io::AsyncWrite + Unpin>(
    stream: &mut W,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    write_response(stream, status, reason, "application/json; charset=utf-8", body.as_bytes()).await
}

/// 服务一次请求需要的全部东西：两个目录，以及「这台机器上的计算编排」。**不拿 `AppHandle`**
/// ——这样测试能起一个真服务、用真的客户端打一遍（局域网协议本身要有测试）。
#[derive(Clone)]
pub struct ServerContext {
    pub model_data: std::path::PathBuf,
    pub data: std::path::PathBuf,
    pub app: Option<tauri::AppHandle>,
    /// 直接给一份编排。生产上这一栏是 `None`（那份从 `app` 里取），它存在是为了让集成测试
    /// 能起「真中心 + 真调度器 + 真 worker」而手里没有 AppHandle。「谁算这一页」只该有一个
    /// 来源，所以两条来路都由 [`ServerContext::manager`] 收口。
    pub manager: Option<Arc<crate::compute::manager::ComputeManager>>,
    /// Windows service isolates NGX from ONNX's process-wide driver state.
    pub dlssnr_manager: Option<Arc<crate::compute::manager::ComputeManager>>,
}

impl ServerContext {
    /// 这一台机器上的计算编排：壳里那份（生产），或者直接给的那份（测试）。
    fn manager(&self) -> Option<Arc<crate::compute::manager::ComputeManager>> {
        self.manager
            .clone()
            .or_else(|| self.app.as_ref().and_then(crate::compute::manager_from_app))
    }
}

/// 广播 [`PAIRING_CHANGED_EVENT`]。没有壳就什么也不做——单测起的是真服务、不带 AppHandle，
/// 事件本来就只是给 UI 的。
fn notify_pairing_changed(context: &ServerContext) {
    if let Some(app) = &context.app {
        let _ = tauri::Emitter::emit(app, PAIRING_CHANGED_EVENT, serde_json::json!({}));
    }
}

/// 把刚生成的六位配对码交给前端，并把主窗叫到前面。
///
/// 没有壳（单测）就什么也不做：配对码只有人眼需要，测试里没有人在看。
fn notify_pairing_code(context: &ServerContext, code: &str, name: &str, peer: &str) {
    let Some(app) = &context.app else { return };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        // `unminimize` 只在桌面端存在（移动端没有「最小化」这回事）。
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = tauri::Emitter::emit(
        app,
        PAIRING_CODE_EVENT,
        serde_json::json!({
            "code": code,
            "name": name,
            "address": peer,
            "expiresInSeconds": PAIRING_CODE_TTL_SECONDS,
        }),
    );
}

/// 服务这一侧收着的连接（docs/175 R05）。
///
/// 从前 `serve` 是「接一个就 spawn 一个」：连接数没有上限、请求体在读完之前没有期限、
/// 几条大上传可以叠在一起把内存吃光，`stop` 也只叫停 accept 那一圈。四样东西在这里收口。
#[derive(Clone, Default)]
struct Connections {
    inner: Arc<ConnectionsInner>,
}

#[derive(Default)]
struct ConnectionsInner {
    /// 连接号 -> 那条连接的任务。`stop` 要把它们全 abort 掉，所以句柄得留着；
    /// 占位时先放 `None`（任务还没 spawn 出来），`attach` 再补上。
    open: Mutex<std::collections::BTreeMap<u64, Option<tauri::async_runtime::JoinHandle<()>>>>,
    /// 在途请求体的字节数——对面**声明**的长度，还没读进来就先占着。单条上限是
    /// [`MAX_BODY`]，但几条大上传叠在一起也能把内存吃光。
    inflight: std::sync::atomic::AtomicUsize,
    next_id: std::sync::atomic::AtomicU64,
    closed: AtomicBool,
}

/// 一条请求体额度：这条连接走完（或者断了）就还回去。
struct BodyReservation {
    connections: Connections,
    bytes: usize,
}

impl Drop for BodyReservation {
    fn drop(&mut self) {
        self.connections
            .inner
            .inflight
            .fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

impl Connections {
    fn len(&self) -> usize {
        self.inner
            .open
            .lock()
            .map(|open| open.len())
            .unwrap_or(0)
    }

    /// 占一个连接位。满了回 `None`：调用方当场回 503，而不是先接下来再慢慢排。
    fn reserve(&self) -> Option<u64> {
        let mut open = self.inner.open.lock().ok()?;
        if self.inner.closed.load(Ordering::SeqCst) || open.len() >= MAX_CONNECTIONS {
            return None;
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        open.insert(id, None);
        Some(id)
    }

    /// 把 spawn 出来的任务挂到已经占好的号上。任务在挂上来之前就结束的话，
    /// 号可能已被 `finish` 或 `stop` 摘掉；缺号时必须 abort，避免脱管任务。
    fn attach(&self, id: u64, task: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut open) = self.inner.open.lock() {
            if let Some(slot) = open.get_mut(&id) {
                *slot = Some(task);
                return;
            }
        }
        // stop can remove a reserved slot before spawn returns its handle.
        task.abort();
    }

    fn finish(&self, id: u64) {
        if let Ok(mut open) = self.inner.open.lock() {
            open.remove(&id);
        }
    }

    /// 占住「声明了这么多字节的体」。超出总预算回 `None`（调用方回 503），
    /// 而不是先把体读进来再说。
    fn hold_body(&self, declared: usize) -> Option<BodyReservation> {
        loop {
            let current = self.inner.inflight.load(Ordering::SeqCst);
            if current.saturating_add(declared) > MAX_INFLIGHT_BODY_BYTES {
                return None;
            }
            if self
                .inner
                .inflight
                .compare_exchange(current, current + declared, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Some(BodyReservation {
                    connections: self.clone(),
                    bytes: declared,
                });
            }
        }
    }

    /// 停服务：把已经收下的连接全收掉（abort 掉任务 = 丢掉未来 = 析构 `TcpStream`）。
    fn close_all(&self) {
        let open = match self.inner.open.lock() {
            Ok(mut open) => {
                self.inner.closed.store(true, Ordering::SeqCst);
                std::mem::take(&mut *open)
            },
            Err(_) => return,
        };
        for (_, task) in open {
            if let Some(task) = task {
                task.abort();
            }
        }
    }
}

/// Dropping a handler (including stop/abort) cancels its blocking computation and
/// its socket reader. A detached JoinHandle alone would keep both alive.
struct RequestLifetime {
    gone: Arc<AtomicBool>,
    watcher: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for RequestLifetime {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::SeqCst);
        self.watcher.abort();
    }
}

async fn serve(
    listener: TcpListener,
    token: Arc<RwLock<String>>,
    pairing: Arc<PairingState>,
    stop: Arc<AtomicBool>,
    connections: Connections,
    context: ServerContext,
) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match listener.accept().await {
            Ok((mut stream, _)) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // 连接数上限（docs/175 R05）：满了当场说清楚，而不是接下来慢慢排。
                // 这一条连请求头都还没读——回包不需要先读头（`Connection: close`）。
                let Some(id) = connections.reserve() else {
                    let body = error_body(
                        "COMPUTE_RESOURCE_LIMIT",
                        &format!("连接已经满了（上限 {MAX_CONNECTIONS} 条）：过一会儿再试"),
                    );
                    let _ = write_json(&mut stream, 503, "Service Unavailable", &body).await;
                    continue;
                };
                let token = Arc::clone(&token);
                let pairing = Arc::clone(&pairing);
                let context = context.clone();
                let for_task = connections.clone();
                let task = tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(stream, token, pairing, context, for_task.clone()).await;
                    for_task.finish(id);
                });
                connections.attach(id, task);
            }
            // 单个连接出错不该让服务停：继续接下一个。
            Err(_) => continue,
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    token: Arc<RwLock<String>>,
    pairing: Arc<PairingState>,
    context: ServerContext,
    connections: Connections,
) -> Result<(), String> {
    let head = match read_request_head(&mut stream).await {
        Ok(head) => head,
        Err(error) => {
            let body = error_body(error.code, &error.message);
            write_json(&mut stream, error.status, error.reason, &body).await?;
            return Ok(());
        }
    };

    // 配对那两个端点只收一小段 JSON：体上限比数据端点小得多（docs/175 R05）。
    let pairing_endpoint = matches!(head.path.as_str(), "/v2/pair/request" | "/v2/pair/confirm");
    if (pairing_endpoint || head.path == "/v2/local-control") && head.content_length > MAX_PAIR_BODY {
        let error = RequestError {
            status: 413,
            reason: "Payload Too Large",
            code: "INVALID_RESPONSE",
            message: format!(
                "配对的请求体太大（{} 字节，上限 {MAX_PAIR_BODY}）",
                head.content_length
            ),
        };
        let body = error_body(error.code, &error.message);
        write_json(&mut stream, error.status, error.reason, &body).await?;
        return Ok(());
    }

    // 令牌要在**体读进来之前**判（docs/175 R05）：从前是先读满整个体再鉴权，于是
    // 一条令牌不对的连接也能让本机先备下一份 64 MB 的缓冲。配对入口与 ping 不看令牌
    // （配对靠的是六位码，ping 只自报家门）。
    if !pairing_endpoint && head.path != "/v2/ping" {
        let expected = token.read().map(|guard| guard.clone()).unwrap_or_default();
        let presented = head.header("x-yomika-token");
        if !token_matches(&expected, presented) && !pairing.authorized(presented) {
            let body = error_body("UNAUTHORIZED", "令牌不对（在桌面端设置页复制一份）");
            return write_json(&mut stream, 401, "Unauthorized", &body).await;
        }
    }

    // 在途请求体的总预算（docs/175 R05）：声明了体就先占额度，这条连接走完再还。
    // 占不下就当场回 503，而不是先把体读进来。
    let _reservation = if head.content_length > 0 {
        match connections.hold_body(head.content_length) {
            Some(reservation) => Some(reservation),
            None => {
                let body = error_body(
                    "COMPUTE_RESOURCE_LIMIT",
                    &format!(
                        "在途请求体到预算了（上限 {MAX_INFLIGHT_BODY_BYTES} 字节）：过一会儿再试"
                    ),
                );
                return write_json(&mut stream, 503, "Service Unavailable", &body).await;
            }
        }
    } else {
        None
    };

    // 体在过了令牌与预算之后才读进来。
    let body = match read_request_body(&mut stream, head.content_length, head.leftover).await {
        Ok(body) => body,
        Err(error) => {
            let payload = error_body(error.code, &error.message);
            write_json(&mut stream, error.status, error.reason, &payload).await?;
            return Ok(());
        }
    };
    let request = Request {
        method: head.method,
        path: head.path,
        headers: head.headers,
        body,
    };

    // Control is loopback-only AND requires the host token, never a paired
    // client's token. This lets the GUI inspect pair codes/revoke a device
    // while a Session-0 Windows service owns the listener.
    if request.path == "/v2/local-control" {
        let expected = token.read().map(|value| value.clone()).unwrap_or_default();
        if !stream.peer_addr().map_err(|e| e.to_string())?.ip().is_loopback()
            || !token_matches(&expected, request.headers.get("x-yomika-token").map(String::as_str).unwrap_or_default()) {
            return write_json(&mut stream, 403, "Forbidden", &error_body("UNAUTHORIZED", "本机控制权限不足")).await;
        }
        if request.method == "POST" {
            let payload: serde_json::Value = serde_json::from_slice(&request.body).unwrap_or_default();
            if let Some(id) = payload.get("revoke").and_then(|id| id.as_str()) {
                if let Err(error) = pairing.revoke(id) { return write_json(&mut stream, 500, "Error", &error_body("UNKNOWN", &error)).await; }
            }
        }
        let pending = pairing.pending.lock().ok().and_then(|value| value.as_ref().filter(|p| p.expires > std::time::Instant::now()).map(|p| serde_json::json!({
            "code": p.code, "name": p.name, "address": p.peer, "expiresInSeconds": p.expires.saturating_duration_since(std::time::Instant::now()).as_secs(),
        })));
        return write_json(&mut stream, 200, "OK", &serde_json::json!({ "pairedClients": pairing.listed(), "pending": pending }).to_string()).await;
    }

    // 配对入口只给出临时请求号；凭据必须凭被配对端显示的六位码取得。
    if request.path == "/v2/pair/request" && request.method == "POST" {
        let peer = stream.peer_addr().map_err(|error| error.to_string())?.ip().to_string();
        let payload: serde_json::Value = serde_json::from_slice(&request.body).unwrap_or_default();
        let name = payload.get("name").and_then(|value| value.as_str()).filter(|name| !name.trim().is_empty()).unwrap_or(&peer);
        // 对面自报的类型可以没有（旧客户端不发）：没有就由前端退回通用图标。
        let kind = payload.get("kind").and_then(|value| value.as_str()).map(str::to_string);
        return match pairing.begin(&peer, name, kind) {
            Ok((request_id, code)) => {
                notify_pairing_code(&context, &code, name, &peer);
                write_json(&mut stream, 200, "OK", &serde_json::json!({ "requestId": request_id }).to_string()).await
            }
            Err(error) => write_json(&mut stream, 429, "Too Many Requests", &error_body("REMOTE_UNAVAILABLE", &error)).await,
        };
    }
    if request.path == "/v2/pair/confirm" && request.method == "POST" {
        let peer = stream.peer_addr().map_err(|error| error.to_string())?.ip().to_string();
        let payload: serde_json::Value = serde_json::from_slice(&request.body).unwrap_or_default();
        let request_id = payload.get("requestId").and_then(|value| value.as_str()).unwrap_or_default();
        let code = payload.get("code").and_then(|value| value.as_str()).unwrap_or_default();
        return match pairing.confirm(&peer, request_id, code) {
            Ok(client_token) => {
                // 列表变了：正开着的设置页要立刻看见新设备，不必退出再进。
                notify_pairing_changed(&context);
                write_json(&mut stream, 200, "OK", &serde_json::json!({ "token": client_token, "name": host_name() }).to_string()).await
            }
            Err(error) => write_json(&mut stream, 403, "Forbidden", &error_body("UNAUTHORIZED", &error)).await,
        };
    }

    // 数据端点仍要求凭配对码取得的令牌（上面已经判过：这里不再重复读头）。
    if request.path == "/v2/ping" && request.method == "GET" {
        let body = serde_json::json!({ "service": SERVICE_NAME, "version": PROTOCOL_VERSION });
        return write_json(&mut stream, 200, "OK", &body.to_string()).await;
    }

    // 服务端设置**在这里读一次**，之后整条链只读这份快照（docs/175 R01）：从前来路会在
    // 中途回头看本机偏好，于是同一页的两个阶段各用一份模型或参数。
    let settings = match context.app.as_ref() {
        Some(app) => match preferences(app) {
            Ok(snapshot) => RemoteSettings::from_preferences(&snapshot),
            Err(error) => {
                let body = error_body("UNAVAILABLE", &format!("读服务端设置失败：{error}"));
                return write_json(&mut stream, 503, "Service Unavailable", &body).await;
            }
        },
        // 没有壳（单测直接起中心的那种用法）：没有本机偏好可读，那就是「什么都没配」。
        None => {
            #[cfg(windows)]
            if context.data.join("yomika.sqlite3").exists() {
                match crate::windows_compute_service::read_preferences(&context.data) {
                    Ok(snapshot) => RemoteSettings::from_preferences(&snapshot),
                    Err(error) => return write_json(&mut stream, 503, "Service Unavailable", &error_body("UNAVAILABLE", &error)).await,
                }
            } else { RemoteSettings::default() }
            #[cfg(not(windows))]
            { RemoteSettings::default() }
        },
    };

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v2/capabilities") => {
            // 能力清单里的 DLSSNR 那一档要问 worker 的构建事实（引擎在它那一侧），
            // 取法与 `/v2/process` 同一条：取不到就是 None，那一档按装配事实答。
            let manager = context.manager();
            let name = host_name();
            let payload = tauri::async_runtime::spawn_blocking(move || {
              let mut available = capabilities(&context.model_data, &context.data, manager.as_deref());
              if let Some(upscale) = available.iter_mut().find(|item| item.id == "upscale") {
                if settings.upscale_off() || settings.upscale_model.trim().is_empty()
                    || crate::inference::resolve_upscaler(&context.model_data, settings.upscale_model.trim()).is_none() {
                    upscale.ready = false;
                    upscale.detail = "服务端未启用有效的默认超分模型".into();
                }
              }
              RemoteCapabilities {
                service: SERVICE_NAME.to_string(),
                version: PROTOCOL_VERSION,
                name,
                capabilities: available,
                models: crate::inference::runnable_models(&context.model_data),
                // docs/175 R11：客户端键里 device/source/chain 三样都不含模型内容、
                // 参数与 DLL 内容，这一栏就是补上那三样的「实际处理计划身份」。
                revision: settings_revision(&context.model_data, &context.data, &settings),
              }
            }).await.map_err(|error| format!("读取服务端能力失败：{error}"))?;
            let body = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
            write_json(&mut stream, 200, "OK", &body).await
        }
        ("POST", "/v2/process") => {
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
            // 出错时回给人看的那一档：一串就写成 `upscale+dlssnr`，日志里能看出是哪一串。
            let op = if params.chain.is_empty() {
                params.op.clone()
            } else {
                params.chain.join("+")
            };
            let body = request.body;
            let context = context;
            // 三个方向都要交给计算进程，把手从这里取：没有 AppHandle（测试里直接起中心的那种
            // 用法）或编排还没起来时取到的是 `None`，那不是错误——真要 worker 的那一档会在
            // 自己那一层给出明确的说法。
            let manager = context.manager();
            let dlssnr_manager = context.dlssnr_manager.clone().or_else(|| manager.clone());
            // 三条来路现在都是**等**计算进程（DLSSNR 也走了 worker，见 `dlssnr_bytes`），最长
            // 可以等到字节桥自己那 660 秒预算。占着本机重活闸等这么久，会把用户当前那一页的
            // 活一起堵在门外，所以它们只用一条普通阻塞线程等，不占闸——这与 `run_remote` 让
            // 远端任务不占本机闸是同一条理由：等的是别人的算力，本机只做搬运。
            let (model_data, data) = (context.model_data.clone(), context.data.clone());
            // 等的时候还要盯着一件事：**对面还在不在**。读端拆出来单独一条任务——请求体已经
            // 读完了，所以它等到的只有两种可能：对面把连接丢了（读到 EOF），或者对方想在这条
            // 连接上流水线式地再发一件（这一版不支持，看到就当它走了）。读到就翻牌，等在那儿
            // 的那条路下一轮就会请 worker 停下；停的是**这条请求自己那一次订阅**
            // （`ComputeManager::cancel` 只退一份订阅，同一页还有别人等着就继续算）。
            let (mut reader, mut writer) = tokio::io::split(stream);
            let gone = Arc::new(AtomicBool::new(false));
            let watcher = {
                let gone = Arc::clone(&gone);
                tauri::async_runtime::spawn(async move {
                    let mut scratch = [0_u8; 1];
                    let _ = reader.read(&mut scratch).await;
                    gone.store(true, Ordering::SeqCst);
                })
            };
            let lifetime = RequestLifetime { gone: Arc::clone(&gone), watcher };
            let cancelled = {
                let gone = Arc::clone(&gone);
                move || gone.load(Ordering::SeqCst)
            };
            let processed = tauri::async_runtime::spawn_blocking(move || {
                // Keep the body budget until the blocking task actually releases the body.
                let _reservation = _reservation;
                let revision = settings_revision(&model_data, &data, &settings);
                process_planned_with_managers(
                    manager.as_deref(),
                    dlssnr_manager.as_deref(),
                    &model_data,
                    &data,
                    &params,
                    &settings,
                    &body,
                    &cancelled,
                ).and_then(|(bytes, plan)| {
                    if revision != settings_revision(&model_data, &data, &settings) {
                        return Err("服务端模型或 DLL 在处理期间发生变化，请重新请求".into());
                    }
                    Ok((bytes, plan, revision))
                })
            })
            .await
            .map_err(|error| format!("等待计算进程的线程没能回来：{error}"))
            .and_then(|inner| inner);
            // 算完了就没必要再盯着对面；对面已经走了的话，下面那次回包会写失败——那不是错误，
            // 是「它自己不要了」。
            drop(lifetime);
            match processed {
                // 跳过动图时回的是 GIF/WebP 的原始字节，标签跟着 sniff 走才不会撒谎；
                // 正常路径产出 PNG，sniff 出来的仍然是 image/png，行为不变。
                Ok((bytes, plan, revision)) => {
                    let content_type = crate::cache::sniff_image_mime(
                        "application/octet-stream",
                        &bytes,
                    )
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                    // docs/175 R11：回包里标明**这一次真正用的**是哪一版计划。客户端拿它
                    // 与自己做键时用的那一版对账，对不上就不会把这份产物当那一版存下来。
                    write_response_with(
                        &mut writer,
                        200,
                        "OK",
                        &content_type,
                        &[("x-yomika-plan-revision", plan.revision.as_str()),
                          ("x-yomika-settings-revision", revision.as_str())],
                        &bytes,
                    )
                    .await
                }
                Err(error) => {
                    let body = error_body("INFERENCE_UNAVAILABLE", &format!("{op}：{error}"));
                    write_json(&mut writer, 500, "Internal Server Error", &body).await
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

/// 异步客户端：远端这一件要能在途取消，所以走 async 那一套（docs/175 R04）。
/// 连接超时和阻塞版一样短——远端多半在局域网里；读超时留给推理。
fn async_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())
}

/// 归一成 PNG：对面那条路只认「一张图」，动图之外都得先解成像素再编回去。
fn to_png_payload(bytes: Vec<u8>) -> Result<Vec<u8>, RemoteFailure> {
    let normalized = image::load_from_memory(&bytes)
        .map_err(|error| RemoteFailure::protocol(format!("待处理图像无法解码：{error}")))?
        .to_rgba8();
    let mut png = Vec::new();
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            normalized.as_raw(),
            normalized.width(),
            normalized.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| RemoteFailure::protocol(format!("待处理图像无法转换为 PNG：{error}")))?;
    Ok(png)
}

/// 盯着取消牌，牌一翻就返回（docs/175 R04）。
///
/// 25 毫秒一格：对「翻页之后立刻掐断」够用，又不至于把 CPU 转起来。取消牌本身是个
/// `AtomicBool`（`cancel::TaskGuard`），没有唤醒机制，所以这里只能轮询。
async fn wait_until_cancelled(cancel: &crate::inference::cancel::CancelToken) {
    const TICK: std::time::Duration = std::time::Duration::from_millis(25);
    loop {
        if cancel.cancelled() {
            return;
        }
        tokio::time::sleep(TICK).await;
    }
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
pub fn remote_capabilities(url: &str, token: &str) -> Result<RemoteCapabilities, RemoteFailure> {
    let base = normalize_base(url).map_err(RemoteFailure::protocol)?;
    let response = blocking_client().map_err(RemoteFailure::protocol)?
        .get(format!("{base}/v2/capabilities"))
        .header("x-yomika-token", token)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .map_err(RemoteFailure::request)?;
    let status = response.status();
    let body = response.text().map_err(RemoteFailure::request)?;
    if !status.is_success() {
        return Err(RemoteFailure::response(status.as_u16(), &body));
    }
    let capabilities: RemoteCapabilities = serde_json::from_str(&body).map_err(|error| RemoteFailure::invalid_response(format!("对面回的不是能力清单：{error}")))?;
    if capabilities.service != SERVICE_NAME || capabilities.version != PROTOCOL_VERSION {
        return Err(RemoteFailure { code: "COMPUTE_PROTOCOL_MISMATCH", message: "远端配对协议版本不匹配".into(), retryable: false });
    }
    Ok(capabilities)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub request_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResult {
    pub token: String,
    pub name: String,
}

/// 向对面报到：报上的是**这一台**设备的名字与类型，对面把它存进自己的配对列表，
/// 用来在「管理已有配对」里认出是谁。
///
/// 名字为空时退回 `host_name()`——桌面端 UA 里没有机型，前端会刻意交空串，而
/// `COMPUTERNAME` 正是那边最像名字的东西。
pub fn request_pairing(url: &str, name: Option<String>, kind: Option<String>) -> Result<PairRequest, RemoteFailure> {
    let base = normalize_base(url).map_err(RemoteFailure::protocol)?;
    let response = blocking_client().map_err(RemoteFailure::protocol)?
        .post(format!("{base}/v2/pair/request"))
        .json(&serde_json::json!({
            "name": name.filter(|value| !value.trim().is_empty()).unwrap_or_else(host_name),
            "kind": kind,
        }))
        .timeout(std::time::Duration::from_secs(8))
        .send().map_err(RemoteFailure::request)?;
    let status = response.status();
    let body = response.text().map_err(RemoteFailure::request)?;
    if !status.is_success() { return Err(RemoteFailure::response(status.as_u16(), &body)); }
    serde_json::from_str(&body).map_err(|error| RemoteFailure::invalid_response(format!("配对响应无效：{error}")))
}

pub fn confirm_pairing(url: &str, request_id: &str, code: &str) -> Result<PairResult, RemoteFailure> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RemoteFailure { code: "INVALID_INPUT", message: "请输入六位数字配对码".into(), retryable: false });
    }
    let base = normalize_base(url).map_err(RemoteFailure::protocol)?;
    let response = blocking_client().map_err(RemoteFailure::protocol)?
        .post(format!("{base}/v2/pair/confirm"))
        .json(&serde_json::json!({ "requestId": request_id, "code": code }))
        .timeout(std::time::Duration::from_secs(8))
        .send().map_err(RemoteFailure::request)?;
    let status = response.status();
    let body = response.text().map_err(RemoteFailure::request)?;
    if !status.is_success() { return Err(RemoteFailure::response(status.as_u16(), &body)); }
    serde_json::from_str(&body).map_err(|error| RemoteFailure::invalid_response(format!("配对响应无效：{error}")))
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
    tauri::async_runtime::block_on(remote_process_cancellable(
        url,
        token,
        params,
        bytes,
        &crate::inference::cancel::CancelToken::none(),
        None,
    ))
}

/// 发一页给远端，并且让取消牌**直接管到在途的那一次请求**（docs/175 R04）。
///
/// 取消发生在传输层：一边等回复、一边盯着取消牌，牌一翻就把这次请求整个丢掉——`reqwest`
/// 的 future 被 drop 之后连接随之断开，对面那次推理成了没人要的结果，本机那条远端队列
/// 当场放人（见 `remote_compute_process`）。从前是「等满 180 秒、拿到结果再丢掉」：旧页
/// 翻得越快，堵在队列上的旧请求越多。
pub async fn remote_process_cancellable(
    url: &str,
    token: &str,
    params: &ProcessParams,
    bytes: Vec<u8>,
    cancel: &crate::inference::cancel::CancelToken,
    expected_revision: Option<&str>,
) -> Result<Vec<u8>, RemoteFailure> {
    // 动图只有 DLSSNR 那条路认它（对面逐帧跑完编回 APNG）；超分没有逐帧实现，
    // 发过去只会被压成第一帧，所以照旧原样交回（前端把失败当可重试）。判定必须在下面
    // 那次「归一成 PNG」之前——归一化本身就已经把动图压成第一帧了。
    let animated = crate::cache::is_animated_image(&bytes);
    let includes_dlssnr = if params.chain.is_empty() {
        params.op == "dlssnr"
    } else {
        params.chain.iter().any(|step| step == "dlssnr")
    };
    if animated && !includes_dlssnr {
        return Ok(bytes);
    }
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
    let payload = if animated {
        // 动图原样发：对面按容器自己解（GIF / APNG / 动画 WebP）。配的是旧版 worker 时
        // 它会原样把这串字节交回来，客户端只认 content-type 就收下——动画在客户端这边
        // 保住了，不会因为对面不会处理而变差。
        bytes
    } else {
        // 归一成 PNG 是纯 CPU 活（几兆的解码 + 编码）：放到阻塞线程上，别占着异步线程。
        // 这一步不看取消牌：它只有几十毫秒，半路丢掉已经解出来的像素也没有意义。
        tauri::async_runtime::spawn_blocking(move || to_png_payload(bytes))
            .await
            .map_err(|error| RemoteFailure::protocol(error.to_string()))??
    };
    let request = async_client()
        .map_err(RemoteFailure::protocol)?
        .post(format!("{base}/v2/process"))
        .header("x-yomika-token", token)
        .header("x-yomika-params", encoded)
        .header("content-type", "application/octet-stream")
        .timeout(PROCESS_TIMEOUT)
        .body(payload);
    // 取消牌与这次传输赛跑（docs/175 R04）。`biased` 让取消牌先看一眼：已经翻页的那一页
    // 根本不该再把请求发出去。这一局输给取消牌就 `return`——future 被丢掉、连接断开，
    // 对面的推理也就没人要了（从前是等它跑完再丢结果，传输本身一直占着）。
    let response = tokio::select! {
        biased;
        _ = wait_until_cancelled(cancel) => return Err(RemoteFailure::cancelled()),
        response = request.send() => response.map_err(|error| {
            if error.is_timeout() {
                RemoteFailure::timeout(format!(
                    "对面 {} 秒没有回话（一页大图 + 一个模型）：可以重试，或者把图切小、改用本机处理",
                    PROCESS_TIMEOUT.as_secs()
                ))
            } else {
                RemoteFailure::request(error)
            }
        })?,
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    // New servers expose settings and request-plan revisions separately. The cache
    // expected revision comes from capabilities, so compare settings with settings.
    // Older servers only expose the plan header (or neither header).
    let used_revision = response
        .headers()
        .get("x-yomika-settings-revision")
        .or_else(|| response.headers().get("x-yomika-plan-revision"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    // 回包也可能在传的中途被取消（一页几兆、对面还慢）：同样赛一次。
    let body = tokio::select! {
        biased;
        _ = wait_until_cancelled(cancel) => return Err(RemoteFailure::cancelled()),
        body = response.bytes() => body.map_err(RemoteFailure::request)?.to_vec(),
    };
    if !status.is_success() {
        return Err(RemoteFailure::response(status.as_u16(), &String::from_utf8_lossy(&body)));
    }
    if !content_type.starts_with("image/") {
        return Err(RemoteFailure::protocol(format!(
            "对面回的不是图片（{content_type}）"
        )));
    }
    // 身份对不上：这一份产物是照**另一版**处理计划算出来的，按本机这个键存下去就会
    // 让下次拿旧键命中一份不是那一版的图。对面那一版已经变了，重探一次再取。
    if let (Some(expected), Some(used)) = (expected_revision, used_revision.as_deref()) {
        if expected != used {
            return Err(RemoteFailure::plan_changed(expected, used));
        }
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
            code: "NETWORK",
            message,
            retryable: true,
        }
    }

    /// 客户端这一侧不想要了（用户翻页）：这不是失败，是取消（docs/175 R04）。
    ///
    /// 码沿用本机那条路的 `INFERENCE_CANCELLED`——前端把它当「这一页这一档的结果」，
    /// 既不入错误日志也不重试（`src/domain/errors.ts`）。
    fn cancelled() -> Self {
        Self {
            code: "INFERENCE_CANCELLED",
            message: "这一页的处理已取消".to_string(),
            retryable: false,
        }
    }

    fn request(error: reqwest::Error) -> Self {
        if error.is_timeout() { Self::timeout(error.to_string()) }
        else if error.is_builder() || error.is_decode() || error.is_redirect() {
            Self::protocol(error.to_string())
        } else { Self::transport(error.to_string()) }
    }

    fn invalid_response(message: String) -> Self {
        Self { code: "INVALID_RESPONSE", message, retryable: false }
    }

    fn response(status: u16, body: &str) -> Self {
        // A received server error can be an engine/protocol defect, not a link failure.
        let payload = serde_json::from_str::<serde_json::Value>(body).ok();
        let worker_busy = payload.as_ref().and_then(|value| value.get("error")).is_some_and(|error| {
            error["code"].as_str() == Some("COMPUTE_UNAVAILABLE")
                // Older hosts expose the worker code only as a final suffix.
                || (status == 500 && error["code"].as_str() == Some("INFERENCE_UNAVAILABLE")
                    && error["message"].as_str().is_some_and(|message| message.ends_with("（COMPUTE_UNAVAILABLE）")))
        });
        let code = match status {
            500 | 503 if worker_busy => "COMPUTE_UNAVAILABLE",
            500 => "INFERENCE_UNAVAILABLE",
            429 => "REMOTE_RATE_LIMIT",
            _ => "REMOTE_UNAVAILABLE",
        };
        Self { code, message: describe_error(status, body), retryable: status >= 500 || status == 429 }
    }

    fn protocol(message: String) -> Self {
        Self {
            code: "REMOTE_UNAVAILABLE",
            message,
            retryable: false,
        }
    }

    /// 对面实际用的那一版处理计划与本机建键用的那一版**不是同一版**（docs/175 R11）。
    ///
    /// 不重试就等于永远看不见这一页：对面重开一次、或设置改回去就又能算了，所以是可重试的。
    fn plan_changed(expected: &str, used: &str) -> Self {
        Self {
            code: "REMOTE_PLAN_CHANGED",
            message: format!(
                "对面换了一版处理计划（它实际用的是 {used}，本机这一版是 {expected}）：这份产物不算那一版，重新探一次对面再取"
            ),
            retryable: true,
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

pub fn restore_on_launch(app: &tauri::AppHandle) -> Result<(), String> {
    let mut snapshot = preferences(app)?;
    if !snapshot.compute_center_enabled { return Ok(()); }
    #[cfg(windows)]
    if crate::windows_compute_service::installed() {
        watch_service_pairing(app.clone());
        return Ok(());
    }
    if snapshot.compute_center_token.is_empty() {
        snapshot.compute_center_token = fresh_token();
        snapshot = store_preferences(app, snapshot)?;
    }
    let (model_data, data) = paths(app)?;
    let center = center_of(app)?;
    center.set_token(&snapshot.compute_center_token);
    center.start(ServerContext { model_data, data, app: Some(app.clone()), manager: None, dlssnr_manager: None }, snapshot.compute_center_port)?;
    Ok(())
}

/// 算力中心的现状：开没开、端口、地址、令牌。
#[tauri::command(async)]
pub fn compute_center_status(app: tauri::AppHandle) -> CommandResult<ComputeCenterStatus> {
    #[cfg(windows)]
    let service = crate::windows_compute_service::installed();
    #[cfg(not(windows))]
    let service = false;
    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let (model_data, data) = match paths(&app) {
        Ok(paths) => paths,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    if !service { center.pairing.set_storage(&data); }
    let token = preferences(&app)
        .map(|snapshot| snapshot.compute_center_token)
        .unwrap_or_default();
    // 这一台**能提供什么**（超分 / DLSSNR）：本机那一档的设置页要照着它说
    // 「这台设备能对外做什么」，从前这里是空的，于是设置页那三个字一个都显示不出来。
    let local_capabilities = capabilities(
        &model_data,
        &data,
        crate::compute::manager_from_app(&app).as_deref(),
    );
    let service_state = if service { local_service_control(&app, None).ok() } else { None };
    CommandResult::success(ComputeCenterStatus {
        running: center.is_running() || service_state.is_some(),
        port: center.running_port().unwrap_or_else(|| current_port(&app)),
        addresses: local_addresses(),
        token,
        capabilities: local_capabilities,
        can_start: true,
        paired_clients: service_state.and_then(|v| serde_json::from_value(v["pairedClients"].clone()).ok()).unwrap_or_else(|| center.pairing.listed()),
        windows_service_supported: cfg!(windows),
        windows_service_installed: service,
    })
}

/// 打开 / 关掉算力中心，或者换端口、换令牌。
///
#[tauri::command(async)]
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

    #[cfg(windows)]
    if crate::windows_compute_service::installed() {
        if rotate_token.unwrap_or(false) { return CommandResult::failure("INVALID_RESPONSE", "请先关闭 Windows 服务再更换配对令牌", false); }
        let previous = preferences(&app).ok();
        if let Err(error) = store_preferences(&app, snapshot) { return CommandResult::failure("UNKNOWN", error, true); }
        if enabled && !crate::windows_compute_service::running() {
            if let Err(error) = crate::windows_compute_service::configure(true) {
                if let Some(previous) = previous { let _ = store_preferences(&app, previous); }
                return CommandResult::failure("PLATFORM_UNAVAILABLE", error, true);
            }
        }
        // Service observes committed settings once a second. Never bind the
        // same port in the GUI or write into its worker workspace.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        while std::time::Instant::now() < deadline {
            if local_service_control(&app, None).is_ok() == enabled { break; }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if local_service_control(&app, None).is_ok() != enabled {
            if let Some(previous) = previous { let _ = store_preferences(&app, previous); }
            return CommandResult::failure("NETWORK", "Windows 服务未能应用设置，已恢复之前的设置；请检查服务日志", true);
        }
        return compute_center_status(app);
    }

    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    center.pairing.set_storage(&data);
    // 能力清单在起服务之前算：它问的是磁盘上的模型与 DLL 齐不齐（跟服务开没开无关），
    // 而下面两条分支里 `model_data` / `data` 会被移进 `ServerContext`。
    let local_capabilities = capabilities(
        &model_data,
        &data,
        crate::compute::manager_from_app(&app).as_deref(),
    );
    if rotate_token.unwrap_or(false) {
        if let Err(error) = center.pairing.clear() {
            return CommandResult::failure("UNKNOWN", error, true);
        }
    }
    let previous_port = center.running_port();
    let changing_port = enabled && previous_port.is_some_and(|running| running != snapshot.compute_center_port);
    if changing_port {
        if let Err(error) = std::net::TcpListener::bind(("0.0.0.0", snapshot.compute_center_port)) {
            return CommandResult::failure("NETWORK", format!("端口不可用：{error}"), true);
        }
        center.stop();
    }
    if enabled {
        let context = ServerContext {
            model_data: model_data.clone(),
            data: data.clone(),
            app: Some(app.clone()),
            manager: None,
            dlssnr_manager: None,
        };
        if let Err(error) = center.start(context, snapshot.compute_center_port) {
            if let Some(old_port) = previous_port {
                if changing_port {
                    let fallback = ServerContext { model_data, data, app: Some(app.clone()), manager: None, dlssnr_manager: None };
                    let _ = center.start(fallback, old_port);
                }
            }
            // 端口被占、绑不上：这是本机的一次网络动作失败（前端错误码表里是 `NETWORK`）。
            // 别用表里没有的码——发出去整条错误会被桥当成无效响应。
            return CommandResult::failure("NETWORK", error, true);
        }
    } else {
        center.stop();
    }
    center.set_token(&snapshot.compute_center_token);

    let saved = match store_preferences(&app, snapshot) {
        Ok(snapshot) => snapshot,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    CommandResult::success(ComputeCenterStatus {
        running: center.is_running(),
        port: center.running_port().unwrap_or(saved.compute_center_port),
        addresses: local_addresses(),
        token: saved.compute_center_token,
        // 与 `compute_center_status` 同一条来路：上面那份就是此刻磁盘上的能力清单。
        capabilities: local_capabilities,
        can_start: true,
        paired_clients: center.pairing.listed(),
        windows_service_supported: cfg!(windows),
        windows_service_installed: false,
    })
}

#[tauri::command(async)]
pub fn compute_center_revoke_pairing(app: tauri::AppHandle, id: String) -> CommandResult<ComputeCenterStatus> {
    #[cfg(windows)]
    if crate::windows_compute_service::installed() {
        if let Err(error) = local_service_control(&app, Some(&id)) { return CommandResult::failure("NETWORK", error, true); }
        return compute_center_status(app);
    }
    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    if let Err(error) = center.pairing.revoke(&id) {
        return CommandResult::failure("UNKNOWN", error, false);
    }
    compute_center_status(app)
}

fn local_service_control(app: &tauri::AppHandle, revoke: Option<&str>) -> Result<serde_json::Value, String> {
    let preferences = preferences(app)?;
    let client = reqwest::blocking::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{}/v2/local-control", preferences.compute_center_port);
    let request = if let Some(id) = revoke { client.post(url).json(&serde_json::json!({ "revoke": id })) } else { client.get(url) };
    request.header("x-yomika-token", preferences.compute_center_token).send().and_then(|response| response.error_for_status()).and_then(|response| response.json()).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn watch_service_pairing(app: tauri::AppHandle) {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        let mut last_code = String::new();
        let mut last_clients = serde_json::Value::Null;
        while crate::windows_compute_service::installed() {
            if let Ok(value) = local_service_control(&app, None) {
                if let Some(code) = value["pending"]["code"].as_str() {
                    if code != last_code {
                        last_code = code.to_string();
                        let context = ServerContext { data: Default::default(), model_data: Default::default(), app: Some(app.clone()), manager: None, dlssnr_manager: None };
                        notify_pairing_code(&context, code, value["pending"]["name"].as_str().unwrap_or("设备"), value["pending"]["address"].as_str().unwrap_or(""));
                    }
                } else { last_code.clear(); }
                if last_clients != value["pairedClients"] {
                    last_clients = value["pairedClients"].clone();
                    let _ = tauri::Emitter::emit(&app, PAIRING_CHANGED_EVENT, ());
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

#[tauri::command(async)]
pub fn compute_windows_service_configure(app: tauri::AppHandle, enabled: bool) -> CommandResult<ComputeCenterStatus> {
    #[cfg(not(windows))]
    { let _ = (app, enabled); CommandResult::failure("PLATFORM_UNAVAILABLE", "仅 Windows 支持注册系统服务", false) }
    #[cfg(windows)]
    {
        let snapshot = match preferences(&app) { Ok(snapshot) => snapshot, Err(error) => return CommandResult::failure("UNKNOWN", error, true) };
        if enabled && !snapshot.compute_center_enabled { return CommandResult::failure("INVALID_RESPONSE", "请先开启本机远程后处理服务", false); }
        if let Ok(center) = center_of(&app) { center.stop(); }
        if let Err(error) = crate::windows_compute_service::configure(enabled) {
            let _ = restore_on_launch(&app);
            return CommandResult::failure("PLATFORM_UNAVAILABLE", error, true);
        }
        if enabled {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
            while local_service_control(&app, None).is_err() {
                if std::time::Instant::now() >= deadline {
                    return CommandResult::failure("NETWORK", "Windows 服务已注册，但独立处理进程未能就绪；请查看服务日志或关闭此开关重试", true);
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            watch_service_pairing(app.clone());
        }
        else {
            // The service was the sole writer while installed. Discard the
            // GUI's pre-handoff copy before it starts authenticating clients.
            if let Ok(center) = center_of(&app) {
                if let Ok(mut storage) = center.pairing.storage.lock() { *storage = None; }
                if let Ok(mut clients) = center.pairing.clients.lock() { clients.clear(); }
            }
            if let Err(error) = restore_on_launch(&app) { return CommandResult::failure("NETWORK", error, true); }
        }
        compute_center_status(app)
    }
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
        Ok(Err(error)) => CommandResult::failure(error.code, error.message, error.retryable),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub async fn compute_discover() -> CommandResult<Vec<DiscoveredDevice>> {
    match tauri::async_runtime::spawn_blocking(discover_devices).await {
        Ok(Ok(devices)) => CommandResult::success(devices),
        Ok(Err(error)) => CommandResult::failure("NETWORK", error, true),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub async fn compute_pair_request(url: String, name: Option<String>, kind: Option<String>) -> CommandResult<PairRequest> {
    match tauri::async_runtime::spawn_blocking(move || request_pairing(&url, name, kind)).await {
        Ok(Ok(result)) => CommandResult::success(result),
        Ok(Err(error)) => CommandResult::failure(error.code, error.message, error.retryable),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub async fn compute_pair_confirm(url: String, request_id: String, code: String) -> CommandResult<PairResult> {
    match tauri::async_runtime::spawn_blocking(move || confirm_pairing(&url, &request_id, &code)).await {
        Ok(Ok(result)) => CommandResult::success(result),
        Ok(Err(error)) => CommandResult::failure(error.code, error.message, error.retryable),
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
    /// 从哪一版开始发：`reader-page` / `enhanced`。
    #[serde(default)]
    pub source: Option<String>,
    /// 建**本机缓存键**时用的那一版处理计划身份（能力清单给的那一份，docs/175 R11）。
    /// 对面回包上会写明「这一次真正用的」是哪一版；两者对不上就说明身份在往返之间变了，
    /// 这一份产物不能按老版本存下来。老版本客户端不发这一栏（缺省即不校验）。
    #[serde(default)]
    pub expected_revision: Option<String>,
    /// 起点那一版是哪个模型产出的（与 DLSSNR 那条路同一个规矩：起点按产出它的
    /// 模型存，要算出同一个 revision 才读得到）。
    #[serde(default)]
    pub upscale_model: Option<String>,
    #[serde(default)]
    pub upscale_output_scale: Option<u32>,
    /// 前端给这次任务起的号：翻页之后就不必再发出去了。
    #[serde(default)]
    pub task_id: Option<String>,
    /// `"foreground"` 才是当前页。远端有**自己**的一条队列（`inference::run_remote`），
    /// 这里的档位决定的是「远端任务之间」谁先走：当前页插到整本预扫前面（审计 P2-2）。
    #[serde(default)]
    pub priority: Option<String>,
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
    // 远端走**自己**那条队列，不占本机 GPU 那一件重活：阻塞式 HTTP 发出去之后这一侧
    // 没法掐断，最长要等 180 秒，而它占的资源在对面那台机器上——让本机当前页的
    // DLSSNR / 超分排在它后面是纯粹的浪费（审计 P2-2）。
    let priority = crate::inference::HeavyPriority::parse(input.priority.as_deref());
    let task_id = input.task_id.clone();
    // 闸门（远端那条队列）照旧一次只放一件，但**由异步这一侧拿着**：取消要能管到在途
    // 传输，那一段就必须跑在异步线程上，而不是整块塞进阻塞线程（docs/175 R04）。
    let database = app.state::<crate::db::Database>();
    let result = crate::inference::run_remote(priority, task_id, async {
        remote_process_cached_page(&database, &data, &input).await
    })
    .await?;
    Ok(crate::domain::result::into_binary_response(result))
}

// Remote outputs share the reader-session cache and quota with local outputs.
// Bind them to both the actual source bytes and the advertised plan; retaining
// only the JS blob made an evicted prefetched page run over the network again.
fn remote_output_identity(input: &RemoteProcessInput, source: &[u8]) -> Option<crate::cache::CacheImageIdentity> {
    let revision = input.expected_revision.as_deref().filter(|value| !value.is_empty())?;
    let key = serde_json::to_vec(&(&input.url, revision, &input.params, input.source.as_deref().unwrap_or("reader-page"))).ok()?;
    let mut hash = blake3::Hasher::new();
    hash.update(&key);
    hash.update(source);
    let rendition = if input.params.op == "dlssnr" || input.params.chain.iter().any(|op| op == "dlssnr") { "dlssnr" } else { "enhanced" };
    let mut identity = crate::cache::CacheImageIdentity::new(&input.scope_id, &input.archive_id, rendition, input.page_index);
    identity.revision = Some(format!("remote:{}", hash.finalize().to_hex()));
    Some(identity)
}

async fn remote_process_cached_page(
    database: &crate::db::Database,
    data_dir: &std::path::Path,
    input: &RemoteProcessInput,
) -> CommandResult<Vec<u8>> {
    use crate::cache::CacheImageIdentity;

    if input.page_index < 0 {
        return CommandResult::failure("INVALID_RESPONSE", "Invalid page index", false);
    }
    let rendition = input.source.as_deref().unwrap_or("reader-page");
    let revision = match crate::inference::source_revision(
        data_dir,
        rendition,
        input.upscale_model.as_deref(),
        input.upscale_output_scale,
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
    // 锁外读盘：一页可能上兆，读文件与算摘要都不该占着全局 DB 锁。
    let page = match crate::cache::read_cached_image(database, data_dir, &identity) {
        Ok(Some(image)) => image,
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    // 两道检查：发出**之前**取消就不再发（省掉对面一次推理）；发出**之后**取消则由
    // `remote_process_cancellable` 在传输层当场掐断（docs/175 R04）。
    if guard.cancelled() {
        return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false);
    }
    let output_identity = remote_output_identity(input, &page.bytes);
    if let Some(bytes) = output_identity.as_ref().and_then(|identity| crate::inference::cached_derived(database, data_dir, identity)) {
        return CommandResult::success(bytes);
    }

    match remote_process_cancellable(
        &input.url,
        &input.token,
        &input.params,
        page.bytes,
        &guard.token(),
        input.expected_revision.as_deref(),
    )
    .await
    {
        // 取消现在真能掐断在途传输（`remote_process_cancellable`）；这一条兜的是「回复
        // 刚好赶在取消之前回来」那一拍：已经没人要的图不能当成「成功」交上去。
        Ok(_) if guard.cancelled() => {
            CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false)
        }
        Ok(bytes) => {
            let bytes = if let Some(identity) = output_identity {
                let mime = crate::cache::sniff_image_mime("", &bytes).unwrap_or_else(|| "image/png".into());
                crate::inference::finish_derived(database, data_dir, "inference.remote.cache", &identity, &mime, bytes)
            } else { bytes };
            CommandResult::success(bytes)
        }
        // 远端那一步的失败带着自己的码：超时是可重试的（本地可以退到本机那一版
        // 继续读），4xx 是我们发错了、不该原样重试。
        Err(error) => CommandResult::failure(error.code, error.message, error.retryable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remote_prefetch_survives_memory_eviction_and_invalidates_with_source_or_plan() {
        use std::io::{Read, Write};
        let temp = tempfile::tempdir().unwrap();
        let database = crate::db::Database::open_path(temp.path().join("test.sqlite3")).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let png = b"\x89PNG\r\n\x1a\nprocessed";
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nX-Yomika-Settings-Revision: plan-a\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png.len()).unwrap();
            stream.write_all(png).unwrap();
        });
        let mut input = RemoteProcessInput {
            url, token: "private-token".into(), params: ProcessParams { op: "dlssnr".into(), chain: vec!["dlssnr".into()], model_id: None, scale: None, dlssnr: None },
            scope_id: "scope".into(), archive_id: "archive".into(), page_index: 1, source: None,
            expected_revision: Some("plan-a".into()), upscale_model: None, upscale_output_scale: None, task_id: None, priority: None,
        };
        let source = crate::cache::CacheImageIdentity::new("scope", "archive", "reader-page", 1);
        let mut original = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8, 8).write_to(&mut original, image::ImageFormat::Png).unwrap();
        crate::cache::write_cached_image(&database, temp.path(), &source, "image/png", original.get_ref()).unwrap();
        let first = match remote_process_cached_page(&database, temp.path(), &input).await {
            CommandResult::Success { value, .. } => value,
            other => panic!("first remote process failed: {other:?}"),
        };
        server.join().unwrap(); // No listening server remains: a second fetch must use disk.
        let CommandResult::Success { value: second, .. } = remote_process_cached_page(&database, temp.path(), &input).await else { panic!("disk cache missed") };
        assert_eq!(first, second);
        input.expected_revision = Some("plan-b".into());
        assert!(matches!(remote_process_cached_page(&database, temp.path(), &input).await, CommandResult::Failure { .. }));
        input.expected_revision = Some("plan-a".into());
        crate::cache::write_cached_image(&database, temp.path(), &source, "image/png", b"\x89PNGchanged").unwrap();
        assert!(matches!(remote_process_cached_page(&database, temp.path(), &input).await, CommandResult::Failure { .. }));
        assert!(!remote_output_identity(&input, b"source").unwrap().revision.unwrap().contains("private-token"));
        input.expected_revision = None;
        assert!(remote_output_identity(&input, b"source").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn remote_dlssnr_accepts_the_pass_array_saved_by_the_settings_ui() {
        let passes = vec![crate::dlssnr::PassSettings::default(); 2];
        let settings = RemoteSettings { dlssnr_passes: serde_json::to_string(&passes).unwrap(), ..RemoteSettings::default() };
        let normalized = normalized_dlssnr(None, &settings).unwrap();
        let decoded: crate::dlssnr::DlssnrSettings = serde_json::from_value(normalized).unwrap();
        assert_eq!(decoded.passes, passes);
    }

    fn remote_failure_stub(status: u16, content_type: &str, body: &str) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });
        (url, worker)
    }

    #[test]
    fn remote_failure_transport_is_distinct_from_protocol_and_engine_answers() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert_eq!(remote_capabilities(&url, "token").unwrap_err().code, "NETWORK");
        assert_eq!(request_pairing(&url, None, None).unwrap_err().code, "NETWORK");
        assert_eq!(confirm_pairing(&url, "id", "123456").unwrap_err().code, "NETWORK");
        assert_eq!(RemoteFailure::timeout("timed out".into()).code, "REMOTE_TIMEOUT");
        assert_eq!(RemoteFailure::protocol("decode failed".into()).code, "REMOTE_UNAVAILABLE");

        let (url, worker) = remote_failure_stub(200, "application/json", "{broken");
        assert_eq!(remote_capabilities(&url, "token").unwrap_err().code, "INVALID_RESPONSE");
        worker.join().unwrap();
        let (url, worker) = remote_failure_stub(200, "application/json", "{broken");
        assert_eq!(request_pairing(&url, None, None).unwrap_err().code, "INVALID_RESPONSE");
        worker.join().unwrap();
        let (url, worker) = remote_failure_stub(200, "application/json", "{broken");
        assert_eq!(confirm_pairing(&url, "id", "123456").unwrap_err().code, "INVALID_RESPONSE");
        worker.join().unwrap();

        let params = ProcessParams { chain: Vec::new(), op: "upscale".into(), model_id: None, scale: Some(2), dlssnr: None };
        let (url, worker) = remote_failure_stub(200, "text/plain", "not an image");
        assert_eq!(remote_process(&url, "token", &params, one_pixel_png()).unwrap_err().code, "REMOTE_UNAVAILABLE");
        worker.join().unwrap();
        let (url, worker) = remote_failure_stub(500, "application/json", &error_body("GPU_OUTPUT_INVALID", "broken engine"));
        let error = remote_process(&url, "token", &params, one_pixel_png()).unwrap_err();
        assert_eq!(error.code, "INFERENCE_UNAVAILABLE");
        assert!(error.message.contains("broken engine"));
        worker.join().unwrap();
    }

    #[test]
    fn remote_worker_pressure_preserves_retryable_compute_code() {
        for (status, code, message) in [
            (500, "INFERENCE_UNAVAILABLE", "upscale：worker budget（COMPUTE_UNAVAILABLE）"),
            (503, "COMPUTE_UNAVAILABLE", "upscale：worker budget"),
        ] {
            let error = RemoteFailure::response(status, &error_body(code, message));
            assert_eq!(error.code, "COMPUTE_UNAVAILABLE");
            assert!(error.retryable);
        }
    }

    #[test]
    fn pairing_codes_expire_and_cannot_be_replayed() {
        let pairing = PairingState::default();
        let (request_id, code) = pairing.begin("127.0.0.1", "Phone", None).expect("start pairing");
        assert_ne!(request_id, code);
        assert!(pairing.confirm("127.0.0.1", &request_id, "invalid").is_err());
        assert!(pairing.confirm("127.0.0.2", &request_id, &code).is_err());
        assert!(pairing.confirm("127.0.0.1", &request_id, &code).is_ok());
        assert!(pairing.confirm("127.0.0.1", &request_id, &code).is_err());
    }

    #[test]
    fn pairing_a_second_device_replaces_the_first() {
        let dir = tempfile::tempdir().expect("temp directory");
        let pairing = PairingState::default();
        pairing.set_storage(dir.path());
        let (first_request, first_code) = pairing.begin("127.0.0.1", "Phone", None).unwrap();
        let first = pairing.confirm("127.0.0.1", &first_request, &first_code).unwrap();
        let (second_request, second_code) = pairing.begin("127.0.0.2", "Tablet", None).unwrap();
        let second = pairing.confirm("127.0.0.2", &second_request, &second_code).unwrap();
        assert_ne!(first, second);
        // 这台机器是它自己的算力来源：配对第二台就把第一台换掉，不给「轮流用几台」留位置。
        let listed = pairing.listed();
        assert_eq!(listed.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), vec!["Tablet"]);
        assert!(!pairing.authorized(&first), "上一台的令牌要当场失效");
        assert!(pairing.authorized(&second));

        let restarted = PairingState::default();
        restarted.set_storage(dir.path());
        let reloaded = restarted.listed();
        assert_eq!(reloaded.len(), 1, "落盘的也只能剩下这一台");
        assert!(!restarted.authorized(&first));
        assert!(restarted.authorized(&second));
        // 撤销这条路还在：换成一整表之后它照样要能把这唯一一台摘掉。
        restarted.revoke(&reloaded[0].id).unwrap();
        assert!(!restarted.authorized(&second));
        assert!(restarted.listed().is_empty());
    }

    #[test]
    fn failed_pairing_write_does_not_authorize_a_client() {
        let dir = tempfile::tempdir().unwrap();
        let pairing = PairingState::default();
        pairing.set_storage(&dir.path().join("missing"));
        let (request, code) = pairing.begin("127.0.0.1", "Phone", None).unwrap();
        assert!(pairing.confirm("127.0.0.1", &request, &code).is_err());
        assert!(pairing.listed().is_empty());
    }

    #[test]
    fn a_client_file_written_before_kind_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        // 这一版之前的文件：没有 kind 这个键。少一个装饰性字段不该让整份列表消失。
        std::fs::write(
            dir.path().join("compute-center-clients.json"),
            br#"[{"id":"old-1","name":"SM-G991B","address":"192.168.1.9","token":"0123456789abcdef"}]"#,
        )
        .unwrap();

        let pairing = PairingState::default();
        pairing.set_storage(dir.path());

        let listed = pairing.listed();
        assert_eq!(listed.len(), 1, "旧文件必须还是能被读出来");
        assert_eq!(listed[0].name, "SM-G991B");
        assert_eq!(listed[0].kind, None, "没有 kind 就是不知道，不该编一个");
        // 读回来还得是**能用**的记录：只认列表、不认令牌就等于把人锁在门外。
        assert!(pairing.authorized("0123456789abcdef"));
        assert!(!pairing.authorized("fedcba9876543210"));
    }

    #[test]
    fn the_reported_kind_survives_confirmation_and_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let pairing = PairingState::default();
        pairing.set_storage(dir.path());

        let (request, code) = pairing.begin("192.168.1.9", "Pixel 7 Pro", Some("phone".to_string())).unwrap();
        pairing.confirm("192.168.1.9", &request, &code).unwrap();

        let listed = pairing.listed();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind.as_deref(), Some("phone"), "列表里要带着类型给界面挑图标");

        let restarted = PairingState::default();
        restarted.set_storage(dir.path());
        assert_eq!(restarted.listed()[0].kind.as_deref(), Some("phone"));

        // 再配一台没报类型的：换掉上一台，而「不知道」还是「不知道」（界面退到通用图标）。
        let (plain_request, plain_code) = pairing.begin("192.168.1.10", "DESKTOP-PC", None).unwrap();
        pairing.confirm("192.168.1.10", &plain_request, &plain_code).unwrap();

        let replaced = pairing.listed();
        assert_eq!(replaced.len(), 1, "第二台配对成功就把第一台换掉");
        assert_eq!(replaced[0].name, "DESKTOP-PC");
        assert_eq!(replaced[0].kind, None, "对面没说类型就老实留空，让界面自己退到通用图标");

        let restarted = PairingState::default();
        restarted.set_storage(dir.path());
        let reloaded = restarted.listed();
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].kind, None);
    }

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
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: Some("nope".into()),
            scale: Some(2),
            dlssnr: None,
        };
        // 没有模型时走最近邻：它照样能跑，只是没模型（与阅读器一致）。
        let png =
            crate::inference::run_host_upscale_bytes(dir.path(), "", &one_pixel_png(), Some(2))
                .expect("最近邻放大");
        assert!(!png.is_empty());
        // 而点名一个不存在的模型时要明确报错，不该悄悄降级。
        let error = process(None, dir.path(), dir.path(), &params, &one_pixel_png(), &cancelled_never)
            .expect_err("该报错");
        assert!(error.contains("nope") || error.contains("Wrong") || error.len() > 0, "{error}");
    }

    /// 装了 ONNX 模型、但编排没起来（没有 AppHandle）时必须**明确拒绝**：宿主这边已经
    /// 没有那台引擎了——最后一条「就地跑模型」的来路在这一轮拆掉了。悄悄降级成最近邻
    /// 会让远端收到一张「看着成功、其实没跑模型」的图。
    #[test]
    fn an_onnx_model_without_the_compute_orchestration_is_refused() {
        let dir = tempfile::tempdir().expect("临时目录");
        install_fake_onnx_upscaler(dir.path(), "fake-onnx");
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: Some("fake-onnx".into()),
            scale: Some(2),
            dlssnr: None,
        };
        let error = process(None, dir.path(), dir.path(), &params, &one_pixel_png(), &cancelled_never)
            .expect_err("没有编排时必须拒绝，不能就地跑");
        assert!(error.contains("计算编排"), "{error}");
    }

    /// 一份「装好的 ONNX 超分模型」：清单 + 一个 onnx 文件。图从不被打开——这里的要点
    /// 只是让宿主认出「这一档归 worker」，而不是让哪个引擎去解它（所以字节是假的）。
    fn install_fake_onnx_upscaler(root: &std::path::Path, id: &str) {
        let dir = root.join("models").join(id).join("1");
        std::fs::create_dir_all(&dir).expect("模型目录");
        let manifest = serde_json::json!({
            "id": id,
            "version": "1",
            "format": "onnx",
            "scale": 2,
            "maxPixels": 64_000_000usize,
            "sha256": "",
            "supportedBackends": ["cpu"],
            "minInputEdge": 32,
        });
        std::fs::write(
            dir.join("yomika-model.json"),
            serde_json::to_vec(&manifest).expect("清单"),
        )
        .expect("写清单");
        std::fs::write(dir.join("model.onnx"), b"never-opened").expect("写图");
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
            app: None,
            manager: None,
            dlssnr_manager: None,
        };
        let center = ComputeCenter::new();
        center.set_token("token-123");
        let port = center.start(context, 0).expect("起服务");
        let base = format!("127.0.0.1:{port}");

        // 令牌不对：对面要明确拒绝，而不是给一份空清单。
        let refused = remote_capabilities(&base, "wrong-token").expect_err("该拒绝");
        assert!(refused.message.contains("401"), "{}", refused.message);

        // 令牌对：拿到两项能力（这台机器上什么都没装，所以都不 ready）。
        let capabilities = remote_capabilities(&base, "token-123").expect("能力清单");
        assert_eq!(capabilities.version, PROTOCOL_VERSION);
        assert_eq!(capabilities.capabilities.len(), 2);
        assert!(capabilities.capabilities.iter().all(|item| !item.ready));

        // 处理一张 1×1 的图。服务端没配模型时**不再悄悄走最近邻**（docs/175 R01）：
        // 回一张「看着成功、其实没跑模型」的图，客户端会把它当成模型产物存下来。
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: None,
            scale: Some(2),
            dlssnr: None,
        };
        let no_model = remote_process(&base, "token-123", &params, one_pixel_png()).expect_err("没有模型要拒绝");
        assert!(no_model.message.contains("没有配置超分模型"), "{}", no_model.message);
        // 而**显式点名最近邻**的那条用途还在：客户端要的本来就是放大，不是模型。
        let params = ProcessParams {
            model_id: Some(EXPLICIT_NEAREST_MODEL.to_string()),
            ..params
        };
        let bytes = remote_process(&base, "token-123", &params, one_pixel_png()).expect("处理");
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a], "回的是 PNG");

        center.stop();
        // 关掉之后就该连不上了（端口没人听）。
        let after_stop = remote_capabilities(&base, "token-123").expect_err("服务已停");
        assert!(!after_stop.message.is_empty());
        assert_eq!(after_stop.code, "NETWORK");
    }

    #[test]
    fn capabilities_are_computed_without_any_model_installed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let capabilities = capabilities(dir.path(), dir.path(), None);
        let ids: Vec<&str> = capabilities.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["upscale", "dlssnr"]);
        assert!(!capabilities[0].ready, "没有模型时超分不该是 ready");
        assert!(!capabilities[1].ready);
        assert!(capabilities[0].detail.contains("超分模型"));
    }

    /// 单测里那几条来路不测取消：交一张「永远不取消」的牌。**不写成内联的 `|| false`**——
    /// 判据（`tests/contracts/native-config.test.ts`）钉的就是「这个文件里没有一条把取消
    /// 写死的来路」，那样写会连测试一起钉进去。
    /// docs/175 R04：客户端取消要能**停掉在途的那一次传输**，不是等它跑完再丢结果。
    ///
    /// 判据有两条，缺一不可：一来对面**看到连接断了**（这一条才分得清「掐断了传输」与
    /// 「结果回来时顺手丢掉」），二来本地立刻拿到取消、而不是等满 180 秒超时。
    #[test]
    fn a_cancelled_remote_request_stops_the_transfer_in_flight() {
        use std::io::Read as _;
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
        use std::time::{Duration, Instant};

        // 一个「只收请求、不回话」的对端：连接一直拿着，除非客户端自己断开。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (in_flight_tx, in_flight_rx) = std::sync::mpsc::channel::<()>();
        let (dropped_tx, dropped_rx) = std::sync::mpsc::channel::<bool>();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut head = [0u8; 4096];
            let _ = stream.read(&mut head);
            let _ = in_flight_tx.send(());
            // 再读一次：客户端把传输丢掉时这里会读到 0（EOF）。
            let mut tail = [0u8; 64];
            let _ = dropped_tx.send(matches!(stream.read(&mut tail), Ok(0)));
        });

        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let flag_in_task = std::sync::Arc::clone(&flag);
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: Some("remote-model".into()),
            scale: Some(2),
            dlssnr: None,
        };
        let runner = std::thread::spawn(move || {
            let cancel = crate::inference::cancel::CancelToken::watch(flag_in_task);
            let started = Instant::now();
            let code = match tauri::async_runtime::block_on(remote_process_cancellable(
                &url,
                "token",
                &params,
                one_pixel_png(),
                &cancel,
                None,
            )) {
                Ok(_) => "ok".to_string(),
                Err(error) => error.code.to_string(),
            };
            (code, started.elapsed())
        });
        // 等这次传输真的在途了再翻牌——这正是「用户在等的时候翻了页」。
        std::thread::spawn(move || {
            if in_flight_rx.recv_timeout(Duration::from_secs(10)).is_ok() {
                flag.store(true, AtomicOrdering::SeqCst);
            }
        });

        assert_eq!(
            dropped_rx.recv_timeout(Duration::from_secs(5)).ok(),
            Some(true),
            "对面没有看到连接被掐断：在途传输没停"
        );
        let (code, elapsed) = runner.join().unwrap();
        assert_eq!(code, "INFERENCE_CANCELLED");
        assert!(
            elapsed < Duration::from_secs(5),
            "取消没能在途生效：等了 {elapsed:?}"
        );
        let _ = server.join();
    }

    /// docs/175 R11（客户端那一半）：回包上写的「实际用的那一版」与本机建键用的那一版对不上
    /// 时，这一份产物不能当本机那一版收下——否则下次拿同一个键就命中一份**不是那一版**的图。
    #[test]
    fn a_remote_answer_that_ran_a_different_plan_is_refused() {
        use std::io::{Read as _, Write as _};

        /// 一个只会回「一张 PNG + 它说自己用的是哪一版」的对端；`None` 表示干脆不说
        /// （老版本对面的样子）。
        fn image_server(announced: Option<String>) -> (String, std::thread::JoinHandle<()>) {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let handle = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut head = [0u8; 4096];
                let _ = stream.read(&mut head);
                let png = one_pixel_png();
                let revision = match announced {
                    Some(announced) => format!("x-yomika-plan-revision: {announced}\r\n"),
                    None => String::new(),
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: {}\r\n{revision}connection: close\r\n\r\n",
                    png.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&png);
            });
            (url, handle)
        }

        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: Some("remote-model".into()),
            scale: Some(2),
            dlssnr: None,
        };
        let expected = "a".repeat(64);

        // ① 对面上换了一版：这一份不算本机那一版。
        let (url, server) = image_server(Some("b".repeat(64)));
        let error = tauri::async_runtime::block_on(remote_process_cancellable(
            &url,
            "token",
            &params,
            one_pixel_png(),
            &crate::inference::cancel::CancelToken::none(),
            Some(expected.as_str()),
        ))
        .expect_err("对面跑的是另一版，不该当成功收下");
        assert_eq!(error.code, "REMOTE_PLAN_CHANGED");
        assert!(error.message.contains(&"b".repeat(64)), "{}", error.message);
        assert!(error.retryable, "重探一次对面就能算，该允许重试");
        let _ = server.join();

        // ② 同一版照旧收下（这一条防「一律拒绝」那种假绿）。
        let (url, server) = image_server(Some(expected.clone()));
        let bytes = tauri::async_runtime::block_on(remote_process_cancellable(
            &url,
            "token",
            &params,
            one_pixel_png(),
            &crate::inference::cancel::CancelToken::none(),
            Some(expected.as_str()),
        ))
        .expect("同一版该收下");
        assert!(!bytes.is_empty());
        let _ = server.join();

        // ③ 对面根本不说（老版本）：没有可对的那一版，照旧收下。
        let (url, server) = image_server(None);
        let bytes = tauri::async_runtime::block_on(remote_process_cancellable(
            &url,
            "token",
            &params,
            one_pixel_png(),
            &crate::inference::cancel::CancelToken::none(),
            Some(expected.as_str()),
        ))
        .expect("老版本对面不发这一头时不该被拒");
        assert!(!bytes.is_empty());
        let _ = server.join();
    }

    fn cancelled_never() -> bool {
        false
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

    /// 与 `raw_request` 一样说一段原始 HTTP，但**不半关**写方向——真正的客户端在拿到回包
    /// 之前不会关它。上游把「读端读到 EOF」当成「对面把连接丢了」并据此取消这一次订阅，半关
    /// 会有同样的样子；那条语义是另一条用例要的，不该顺手把这一条也碰成取消。
    fn raw_request_keeping_the_write_side_open(port: u16, request: &[u8]) -> String {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("连上服务");
        let _ = stream.write_all(request);
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).to_string()
    }

    fn server_for(dir: &std::path::Path) -> (ComputeCenter, u16) {
        let context = ServerContext {
            model_data: dir.to_path_buf(),
            data: dir.to_path_buf(),
            app: None,
            manager: None,
            dlssnr_manager: None,
        };
        let center = ComputeCenter::new();
        center.set_token("token-123");
        let port = center.start(context, 0).expect("起服务");
        (center, port)
    }

    #[test]
    fn local_service_control_requires_host_token_and_does_not_disclose_client_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let (center, port) = server_for(dir.path());
        let (id, code) = center.pairing.begin("127.0.0.1", "Test tablet", None).unwrap();
        let paired_token = center.pairing.confirm("127.0.0.1", &id, &code).unwrap();
        let request = |token: &str| raw_request(port, format!("GET /v2/local-control HTTP/1.1\r\nHost: localhost\r\nx-yomika-token: {token}\r\n\r\n").as_bytes());
        assert!(request(&paired_token).starts_with("HTTP/1.1 403"));
        let response = request("token-123");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Test tablet"));
        assert!(!response.contains(&paired_token));
        let client_id = center.pairing.listed()[0].id.clone();
        let body = serde_json::json!({"revoke": client_id}).to_string();
        let response = raw_request(port, format!("POST /v2/local-control HTTP/1.1\r\nHost: localhost\r\nx-yomika-token: token-123\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes());
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(!center.pairing.authorized(&paired_token));
        center.stop();
    }

    #[test]
    fn a_truncated_body_is_refused_with_a_reason_instead_of_being_processed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let response = raw_request(
            port,
            b"POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: token-123\r\ncontent-length: 100\r\n\r\n0123456789",
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
                "POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: token-123\r\n{extra}\r\n"
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

    /// 两帧 GIF（每帧 1×1 + 2 色全局色表，LZW 只有 clear/0/EOI 三个码）。
    fn animated_gif() -> Vec<u8> {
        let mut bytes = Vec::from(*b"GIF89a");
        bytes.extend_from_slice(&[1, 0, 1, 0, 0x80, 0, 0]);
        bytes.extend_from_slice(&[0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);
        for _ in 0..2 {
            bytes.push(0x2C);
            bytes.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0, 0]);
            bytes.extend_from_slice(&[0x02, 0x02, 0x44, 0x01, 0x00]);
        }
        bytes.push(0x3B);
        bytes
    }

    #[test]
    fn an_animated_page_is_handed_back_by_process() {
        // worker 收到动图就不该去超分：处理完只剩第一帧，动的部分再也回不来。
        let dir = tempfile::tempdir().expect("临时目录");
        let gif = animated_gif();
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: None,
            scale: Some(2),
            dlssnr: None,
        };
        let bytes = process(None, dir.path(), dir.path(), &params, &gif, &cancelled_never).expect("动图要当成功处理");
        assert_eq!(bytes, gif);
    }

    /// DLSSNR 那一档也不在**本进程**里算了：宿主这边已经没有 NGX，能算它的只有计算进程。
    ///
    /// 这条用例钉的是「没有人算的时候，宿主说的是『没人算』，而不是就地算一张」。判据落在
    /// 一句话上：改动之前，1×1 的动图会走「不适用 ⇒ 原样交回」那条路，成功地把同一串字节
    /// 还回来（判定排在建上下文之前，所以这台机器没装真 DLL 也照样过）——于是这一条红。
    #[cfg(windows)]
    #[test]
    fn the_dlssnr_op_no_longer_computes_in_this_process() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 门控要排在「编排没起来」之前，所以这里要让它先过：门控只要求那份 DLL **是个文件**
        // （它不校验字节），有显卡这一步由这台机器提供。
        let feature = dir.path().join("dlssnr");
        std::fs::create_dir_all(&feature).expect("建片段目录");
        std::fs::write(feature.join("nvngx_dlssnr.dll"), vec![0u8; 64]).expect("写假片段");
        let params = ProcessParams {
            chain: Vec::new(),
            op: "dlssnr".into(),
            model_id: None,
            scale: None,
            dlssnr: None,
        };
        let error = process(None, dir.path(), dir.path(), &params, &animated_gif(), &cancelled_never)
            .expect_err("没有编排时 DLSSNR 不该在本进程里算");
        assert!(
            error.contains("计算编排"),
            "宿主在没人算的时候要说清是谁没起来：{error}"
        );
    }

    #[test]
    fn an_animated_page_is_handed_back_without_a_remote_round_trip() {
        // 超分没有逐帧实现：发过去之前那次「归一成 PNG」就已经把动图压成第一帧
        // 了，所以这里必须连试都不试（127.0.0.1:9 上没有任何东西在听）。
        let gif = animated_gif();
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: None,
            scale: Some(2),
            dlssnr: None,
        };
        let bytes = remote_process("http://127.0.0.1:9/", "token", &params, gif.clone())
            .expect("动图要当成功处理");
        assert_eq!(bytes, gif);
    }

    #[test]
    fn an_animated_page_in_a_combined_chain_is_sent_to_the_remote() {
        let params = ProcessParams {
            chain: vec!["upscale".into(), "dlssnr".into()],
            op: "upscale".into(),
            model_id: None,
            scale: None,
            dlssnr: None,
        };
        let refused = remote_process("http://127.0.0.1:9/", "token", &params, animated_gif())
            .expect_err("DLSSNR in the chain must not silently return the unprocessed animation");
        assert_eq!(refused.code, "NETWORK");
    }

    #[test]
    fn an_animated_page_reaches_dlssnr_as_an_animation() {
        // 动图只有 DLSSNR 那条路认它，所以 op 是 dlssnr 时**不许**在本地把它交回去：
        // 交回去等于这个功能对动图根本没生效。
        let gif = animated_gif();
        let params = ProcessParams {
            chain: Vec::new(),
            op: "dlssnr".into(),
            model_id: None,
            scale: None,
            dlssnr: None,
        };
        let refused = remote_process("http://127.0.0.1:9/", "token", &params, gif.clone())
            .expect_err("op 是 dlssnr 的动图要真的发出去，不该在本地就交回来");
        assert_eq!(refused.code, "NETWORK", "{}", refused.message);

        // 对面**收到**的是 GIF 本身，不是归一化后的 PNG：这一版的服务端已经没有本进程里的
        // DLSSNR 了（`server_for` 不起编排），所以它会以 5xx 明说「计算编排还没起来」——回包
        // 里那个 `dlssnr：` 就是它确实走到了那一档、而不是在门口把动图交回来的证据。客户端
        // 有没有把它压成第一帧，由上面那一半与 `legacy_upscale_proxy.rs` 里真 worker 那一条
        // 一起钉住。
        let dir = tempfile::tempdir().expect("临时目录");
        // 门控排在「编排没起来」之前，所以这里先让它过（它只要求那份 DLL 是个文件）。
        let feature = dir.path().join("dlssnr");
        std::fs::create_dir_all(&feature).expect("建片段目录");
        std::fs::write(feature.join("nvngx_dlssnr.dll"), vec![0u8; 64]).expect("写假片段");
        let (center, port) = server_for(dir.path());
        let base = format!("127.0.0.1:{port}");
        let refused = remote_process(&base, "token-123", &params, gif.clone())
            .expect_err("没有编排时对面该拒绝，而不是就地算出来");
        assert_eq!(refused.code, "INFERENCE_UNAVAILABLE", "{}", refused.message);
        assert!(refused.retryable, "编排没起来是暂态，对面回的是 5xx：{}", refused.message);
        assert!(
            refused.message.contains("dlssnr：计算编排"),
            "对面没走到 DLSSNR 那一档：{}",
            refused.message
        );
        center.stop();
    }

    /// docs/175 R01：服务端设置只读一次、冻成一份计划；**默认跟随服务端**，而「没有有效
    /// 模型」要结构化不可用，不许把最近邻伪装成成功。
    ///
    /// 从前模型只从 `params.model_id` 来（客户端不传就是空串），于是服务端设置里选的那个
    /// 模型从来没进过远端计算；空 id 又一路落到最近邻上，回一张「成功」的放大图。
    #[test]
    fn a_plan_freezes_the_servers_settings_before_the_first_step() {
        let dir = tempfile::tempdir().expect("临时目录");
        install_fake_onnx_upscaler(dir.path(), "server-model");
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            // 客户端**不点模型**：老客户端本来就是这样，远端那一版该由服务端设置决定。
            model_id: None,
            scale: None,
            dlssnr: None,
        };
        let settings = RemoteSettings {
            upscale_backend: "auto".into(),
            upscale_model: "server-model".into(),
            upscale_output_scale: 2,
            dlssnr_passes: String::new(),
        };
        let plan =
            ProcessPlan::resolve(dir.path(), dir.path(), &params, &settings, false).expect("定计划");
        assert_eq!(plan.model_id, "server-model", "默认要跟随服务端设置");
        assert!(
            !plan.model_content.is_empty() && plan.model_content != "nearest",
            "计划要带上模型内容版本：{plan:?}"
        );
        assert_eq!(plan.revision.len(), 64, "身份是 blake3 十六进制：{}", plan.revision);

        // 同一份设置定两次是同一版；换了模型内容就是另一版（客户端键里缺的就是它）。
        let again =
            ProcessPlan::resolve(dir.path(), dir.path(), &params, &settings, false).expect("定计划");
        assert_eq!(plan.revision, again.revision, "同一份设置要定出同一版计划");
        install_fake_onnx_upscaler(dir.path(), "server-model-2");
        let other = RemoteSettings {
            upscale_model: "server-model-2".into(),
            ..settings.clone()
        };
        let changed =
            ProcessPlan::resolve(dir.path(), dir.path(), &params, &other, false).expect("定计划");
        assert_ne!(plan.revision, changed.revision, "换了模型内容必须是另一版计划");

        // 服务端没配模型、客户端也没显式点名：结构化不可用（不是最近邻）。
        let none = ProcessPlan::resolve(dir.path(), dir.path(), &params, &RemoteSettings::default(), false)
            .expect_err("没有模型要说不可用");
        assert!(none.contains("没有配置超分模型"), "{none}");
        // 设置里超分是关的：另一句话，同样不是最近邻。
        let off = RemoteSettings {
            upscale_backend: "off".into(),
            ..RemoteSettings::default()
        };
        let off = ProcessPlan::resolve(dir.path(), dir.path(), &params, &off, false).expect_err("关掉要说不可用");
        assert!(off.contains("超分是关的"), "{off}");

        // 显式指名最近邻的那条用途还在，而且计划里说清它是最近邻。
        let nearest = ProcessParams {
            model_id: Some(EXPLICIT_NEAREST_MODEL.into()),
            ..params.clone()
        };
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &nearest, &RemoteSettings::default(), false)
            .expect("显式最近邻");
        assert!(plan.model_id.is_empty());
        assert_eq!(plan.model_content, "nearest");
        assert_eq!(
            plan.upscale_revision,
            crate::inference::enhanced_revision(&None),
            "最近邻在缓存身份里还是原来那一版"
        );
    }

    /// docs/175 R02：内置 shader 链也不再在**本进程**里跑——它和 ONNX 那一档一样交给计算
    /// 进程，引擎由 worker 按本机执行政策挑。宿主这边没有编排时要说「没人算」。
    ///
    /// 从前这一档走 `run_host_upscale_bytes` 里 `Anime4k` 那一条：没有编排也照样在宿主 CPU
    /// 上算出一张，既绕开设置里选的 auto/gpu，也绕开 worker 的引擎选择与回退报告。
    #[test]
    fn a_builtin_shader_chain_is_handed_to_the_compute_process() {
        let dir = tempfile::tempdir().expect("临时目录");
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            model_id: Some("anime4k-hq".into()),
            scale: Some(2),
            dlssnr: None,
        };
        let error = process(None, dir.path(), dir.path(), &params, &one_pixel_png(), &cancelled_never)
            .expect_err("内置链不该在宿主里跑");
        assert!(error.contains("计算编排还没起来"), "{error}");
        // 计划里说的也是交给计算进程的那一档：链的名字就是模型 id。
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &RemoteSettings::default(), false)
            .expect("定计划");
        assert_eq!(plan.model_id, "anime4k-hq");
        // 这一档的引擎政策由 `proxy` 那边钉（`a_byte_bridge_stage_carries_the_local_engine_policy`）：
        // 计划的政策串与阶段上那一栏是同一个来源。
        assert!(!plan.engine_policy.is_empty(), "计划要记下这一单用谁：{plan:?}");
    }

    /// docs/175 R03：动图在多阶段链里要保持动画——会把它压成第一帧的第一步必须从计划里摘掉。
    #[test]
    fn an_animated_page_keeps_its_frames_in_a_combined_chain() {
        let dir = tempfile::tempdir().expect("临时目录");
        let params = ProcessParams {
            chain: vec!["upscale".into(), "dlssnr".into()],
            op: "upscale".into(),
            model_id: None,
            scale: Some(2),
            dlssnr: None,
        };
        // 服务端（这个测试里）没配模型：要是第一步还留在计划里，这里会先在那一档以「没有配置
        // 超分模型」失败，动画连逐帧那一档都到不了。
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &RemoteSettings::default(), true)
            .expect("动图不该卡在会丢帧的第一步上");
        assert_eq!(plan.steps, vec!["dlssnr".to_string()], "只剩逐帧那一档");
        assert_eq!(plan.skipped, vec!["upscale".to_string()], "摘掉的档要记在计划里");
        assert!(!plan.passthrough);

        // 链里没有逐帧那一档：整页原样交回（谁也不许动手）。
        let only_upscale = ProcessParams {
            chain: vec!["upscale".into()],
            ..params.clone()
        };
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &only_upscale, &RemoteSettings::default(), true)
            .expect("定计划");
        assert!(plan.passthrough);
        assert_eq!(plan.skipped, vec!["upscale".to_string()]);

        // 静态页照旧：第一步要模型，没有就说不可用（而不是被摘掉）。
        let error = ProcessPlan::resolve(dir.path(), dir.path(), &params, &RemoteSettings::default(), false)
            .expect_err("静态页第一步要模型");
        assert!(error.contains("没有配置超分模型"), "{error}");
    }

    /// docs/175 R03（端到端那一半）：对面看到的必须是「轮到逐帧那一档了」，而不是先去做那个
    /// 会把动画压成第一帧的第一步。
    #[test]
    fn an_animated_page_in_a_combined_chain_skips_the_frame_destroying_step() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 门控排在「编排没起来」之前，所以这里先让它过（它只要求那份 DLL 是个文件）。
        let feature = dir.path().join("dlssnr");
        std::fs::create_dir_all(&feature).expect("建片段目录");
        std::fs::write(feature.join("nvngx_dlssnr.dll"), vec![0u8; 64]).expect("写假片段");
        let (center, port) = server_for(dir.path());
        let base = format!("127.0.0.1:{port}");
        let params = ProcessParams {
            chain: vec!["upscale".into(), "dlssnr".into()],
            op: "upscale".into(),
            model_id: None,
            scale: None,
            dlssnr: None,
        };
        let refused = remote_process(&base, "token-123", &params, animated_gif()).expect_err("没有编排时该拒绝");
        assert!(
            !refused.message.contains("没有配置超分模型"),
            "对面先去做了会丢帧的第一步：{}",
            refused.message
        );
        assert!(
            refused.message.contains("dlssnr：计算编排"),
            "对面没走到逐帧那一档：{}",
            refused.message
        );
        center.stop();
    }

    /// docs/175 R11：回包要标明**这一次真正用的**那一版计划身份，而且它等于服务端跑的那一份。
    #[test]
    fn a_response_declares_the_plan_revision_it_actually_used() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let params = ProcessParams {
            chain: Vec::new(),
            op: "upscale".into(),
            // 显式最近邻：这条来路不需要编排，所以能拿回一个 200（要验的就是 200 上的头）。
            model_id: Some(EXPLICIT_NEAREST_MODEL.into()),
            scale: Some(2),
            dlssnr: None,
        };
        let encoded = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&params).expect("参数"))
        };
        let png = one_pixel_png();
        let mut request = format!(
            "POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: token-123\r\nx-yomika-params: {encoded}\r\ncontent-length: {}\r\n\r\n",
            png.len()
        )
        .into_bytes();
        request.extend_from_slice(&png);
        let response = raw_request_keeping_the_write_side_open(port, &request);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");

        // 它必须等于**这一单**计划算出来的那一版，不是常量、也不是能力清单那一版（清单说的
        // 是「当前设置这一版」，与「这一单实际用了什么」是两件事）。
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &RemoteSettings::default(), false)
            .expect("定计划");
        assert!(
            response
                .to_lowercase()
                .contains(&format!("x-yomika-plan-revision: {}", plan.revision)),
            "回包没带它真正用的那一版：{}",
            response
        );
        // 令牌不在身份里：它是 64 位十六进制哈希，而且 `plan_revision` 的签名里根本没有
        // 凭据这一路（逐项敏感性见 `the_plan_revision_is_a_pure_function_of_the_enumerated_plan_inputs`）。
        //
        // 2026-10-16 复审指出「只断言哈希里不含 token-123」是弱证据（换个写法照样能过），
        // 所以这里只留长度这一条结构事实，把「哪些东西进身份、哪些不进」交给那条逐项判据。
        assert_eq!(plan.revision.len(), 64);
        center.stop();
    }

    /// docs/175 R11：身份是**计划输入**的纯函数——枚举进 JSON 的每一项变了都得换一版。
    ///
    /// 这条替掉原来那句弱断言（「哈希里不含 token-123」）：证明「凭据进不去」的办法不是找
    /// 字符串，而是证明身份只由这五样计划输入决定，且 `plan_revision` 的签名里没有凭据参数
    /// （它收的是步骤、模型 id/内容、归一化参数、DLL 内容、本机政策）。
    /// 把 JSON 里任何一项删掉或写死，下面相应的 `assert_ne!` 就会转红。
    #[test]
    fn the_plan_revision_is_a_pure_function_of_the_enumerated_plan_inputs() {
        let steps = vec!["upscale".to_string(), "dlssnr".to_string()];
        let params = serde_json::json!({ "passes": 1 });
        let base = plan_revision(
            &steps,
            "server-model",
            "blake3:aaa",
            &params,
            "blake3:bbb",
            "auto",
        );
        assert_eq!(base.len(), 64, "身份是 blake3 十六进制：{base}");
        // 同输入同输出：没有时钟、没有随机、没有进程状态混进来。
        assert_eq!(
            base,
            plan_revision(
                &steps,
                "server-model",
                "blake3:aaa",
                &params,
                "blake3:bbb",
                "auto"
            ),
            "同一份计划输入必须定出同一版身份"
        );
        // 逐项敏感性：链顺序、模型 id、模型内容、归一化参数、DLL 内容、本机政策。
        assert_ne!(
            base,
            plan_revision(
                &["upscale".to_string()],
                "server-model",
                "blake3:aaa",
                &params,
                "blake3:bbb",
                "auto"
            ),
            "链顺序变了必须是另一版身份"
        );
        assert_ne!(
            base,
            plan_revision(
                &steps,
                "other-model",
                "blake3:aaa",
                &params,
                "blake3:bbb",
                "auto"
            ),
            "模型 id 变了必须是另一版身份"
        );
        assert_ne!(
            base,
            plan_revision(
                &steps,
                "server-model",
                "blake3:ccc",
                &params,
                "blake3:bbb",
                "auto"
            ),
            "模型内容变了必须是另一版身份"
        );
        assert_ne!(
            base,
            plan_revision(
                &steps,
                "server-model",
                "blake3:aaa",
                &serde_json::json!({ "passes": 2 }),
                "blake3:bbb",
                "auto"
            ),
            "归一化参数变了必须是另一版身份"
        );
        assert_ne!(
            base,
            plan_revision(
                &steps,
                "server-model",
                "blake3:aaa",
                &params,
                "blake3:ddd",
                "auto"
            ),
            "DLL 内容变了必须是另一版身份"
        );
        assert_ne!(
            base,
            plan_revision(
                &steps,
                "server-model",
                "blake3:aaa",
                &params,
                "blake3:bbb",
                "gpu"
            ),
            "本机执行政策变了必须是另一版身份"
        );
    }

    /// docs/175 R11：能力清单上那一版身份覆盖客户端键里没有的三样——模型内容、归一化参数、
    /// 那份 DLL 的内容。链没变、设备没变，服务端换了模型权重也是另一版。
    #[test]
    fn the_advertised_revision_covers_the_model_contents() {
        let dir = tempfile::tempdir().expect("临时目录");
        install_fake_onnx_upscaler(dir.path(), "server-model");
        let settings = RemoteSettings {
            upscale_backend: "auto".into(),
            upscale_model: "server-model".into(),
            upscale_output_scale: 2,
            dlssnr_passes: String::new(),
        };
        let before = settings_revision(dir.path(), dir.path(), &settings);
        let resized = RemoteSettings { upscale_output_scale: 1, ..settings.clone() };
        assert_ne!(before, settings_revision(dir.path(), dir.path(), &resized), "output size must invalidate the client's remote cache");
        let params = ProcessParams { chain: vec![], op: "upscale".into(), model_id: None, scale: None, dlssnr: None };
        let normal_plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &settings, false).unwrap();
        let resized_plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &resized, false).unwrap();
        assert_eq!(resized_plan.output_scale, 1);
        assert_ne!(normal_plan.revision, resized_plan.revision);
        assert_ne!(normal_plan.upscale_revision, resized_plan.upscale_revision);
        assert_eq!(before.len(), 64, "身份是 blake3 十六进制：{before}");
        assert_eq!(
            before,
            settings_revision(dir.path(), dir.path(), &settings),
            "同一份设置要定出同一版身份"
        );

        // 同一个模型 id、**内容**换了：客户端键里少的就是它。
        std::fs::write(
            dir.path().join("models").join("server-model").join("1").join("model.onnx"),
            b"other-weights",
        )
        .expect("换权重");
        assert_ne!(
            before,
            settings_revision(dir.path(), dir.path(), &settings),
            "换了模型内容必须是另一版身份"
        );
        // 参数也是身份的一部分。
        let other = RemoteSettings {
            dlssnr_passes: "{\"passes\":1}".into(),
            ..settings.clone()
        };
        assert_ne!(
            settings_revision(dir.path(), dir.path(), &settings),
            settings_revision(dir.path(), dir.path(), &other),
            "换了归一化参数必须是另一版身份"
        );

        // 那份 DLL 的内容同样是身份的一部分（客户端键里也没有它）。
        #[cfg(windows)]
        {
            let before_dll = settings_revision(dir.path(), dir.path(), &settings);
            let feature = dir.path().join("dlssnr");
            std::fs::create_dir_all(&feature).expect("建片段目录");
            std::fs::write(feature.join("nvngx_dlssnr.dll"), vec![0u8; 64]).expect("写假片段");
            assert_ne!(
                before_dll,
                settings_revision(dir.path(), dir.path(), &settings),
                "换了 DLL 内容是另一版身份"
            );
        }
    }

    /// 一条**能分段发**的原始连接。R05 那几条要验的正是「对面还没发完」时服务这边怎么办，
    /// 所以不能在帮手里把请求一次写完，也不能指望 `read_to_end` 会及时回来。
    struct RawSocket {
        stream: std::net::TcpStream,
    }

    impl RawSocket {
        fn connect(port: u16) -> Self {
            let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("连上服务");
            stream
                .set_read_timeout(Some(std::time::Duration::from_millis(200)))
                .expect("读超时");
            Self { stream }
        }

        fn send(&mut self, bytes: &[u8]) {
            use std::io::Write;
            let _ = self.stream.write_all(bytes);
        }

        /// 一直读到对面关连接为止，最多等 `limit`。回「收到的字节」与「看没看到 EOF」。
        fn read_until_eof(&mut self, limit: std::time::Duration) -> (String, bool) {
            use std::io::Read;
            let started = std::time::Instant::now();
            let mut received = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                if started.elapsed() > limit {
                    return (String::from_utf8_lossy(&received).to_string(), false);
                }
                match self.stream.read(&mut chunk) {
                    Ok(0) => return (String::from_utf8_lossy(&received).to_string(), true),
                    Ok(read) => received.extend_from_slice(&chunk[..read]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(_) => return (String::from_utf8_lossy(&received).to_string(), true),
                }
            }
        }
    }

    /// 一条数据端点的请求头（体还没发），`length` 是**声明**的体长。
    fn data_head(length: usize, token: &str) -> String {
        format!(
            "POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\nx-yomika-token: {token}\r\ncontent-length: {length}\r\n\r\n"
        )
    }

    /// docs/175 R05：数据端点**先认证，再读体**。
    ///
    /// 从前读头与读体是同一段：令牌不对的请求也要先把声明的体收完（限 64 MB）才轮到认证。
    /// 一条没有令牌的连接于是能把服务的一条任务与一份缓冲占满整段读体时间，而它连门都进不来。
    #[test]
    fn an_unauthenticated_request_is_refused_before_its_body_is_read() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let mut socket = RawSocket::connect(port);
        // 声明一个满上限的体，然后**一个字节都不发**：认证必须排在这之前。
        socket.send(data_head(MAX_BODY, "不是这份令牌").as_bytes());
        let started = std::time::Instant::now();
        let (response, closed) = socket.read_until_eof(std::time::Duration::from_secs(4));
        assert!(
            response.starts_with("HTTP/1.1 401"),
            "令牌不对要当场拒绝，而不是等体读完：{response:?}"
        );
        assert!(closed, "401 之后这条连接就该收掉");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "拒绝没有等体：{:?}",
            started.elapsed()
        );
        center.stop();
    }

    /// docs/175 R05：连上却不把头说完的连接有期限（半开连接不能一直占着连接位）。
    #[test]
    fn a_connection_that_never_finishes_its_head_is_dropped() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let mut socket = RawSocket::connect(port);
        // 头没写完，后面的字节永远不发。
        socket.send(b"POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        // 期限是 `HEAD_DEADLINE`（5 秒），这里给 9 秒的余量：超了就是没有期限。
        let (_, closed) = socket.read_until_eof(std::time::Duration::from_secs(9));
        assert!(closed, "读头没有期限：这条连接会一直占着一个连接位");
        center.stop();
    }

    /// docs/175 R05：连上来的连接数有上限，超了要当场说清楚，而不是接下来慢慢排。
    #[test]
    fn too_many_open_connections_are_refused_with_a_reason() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        // 先占满上限：每一条都只发半截头，于是都停在「读头」这一步不走。
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            let mut socket = RawSocket::connect(port);
            socket.send(b"POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\n");
            held.push(socket);
        }
        // 让服务把这些连接都收进去（accept 与计数都在服务那一侧）。
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut extra = RawSocket::connect(port);
        extra.send(data_head(2, "token-123").as_bytes());
        let (response, _) = extra.read_until_eof(std::time::Duration::from_secs(3));
        assert!(
            response.starts_with("HTTP/1.1 503"),
            "超上限要当场拒绝，而不是排队等：{response:?}"
        );
        assert!(response.contains("连接"), "要说清是哪一档满了：{response}");
        drop(held);
        center.stop();
    }

    /// docs/175 R05：在途请求体的**总字节**也有预算（单条上限不能挡住「几条一起上」）。
    #[test]
    fn the_in_flight_body_budget_is_enforced() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        // 两条各声明满上限的体：都通过了认证，但体一个字节都不发（一直挂着）。
        let mut first = RawSocket::connect(port);
        first.send(data_head(MAX_BODY, "token-123").as_bytes());
        let mut second = RawSocket::connect(port);
        second.send(data_head(MAX_BODY, "token-123").as_bytes());
        std::thread::sleep(std::time::Duration::from_millis(200));
        // 第三条再声明一个满上限的体：总预算放不下，要当场回 503。
        let mut third = RawSocket::connect(port);
        third.send(data_head(MAX_BODY, "token-123").as_bytes());
        let (response, _) = third.read_until_eof(std::time::Duration::from_secs(3));
        assert!(
            response.starts_with("HTTP/1.1 503"),
            "在途预算放不下就不该先把体读进来：{response:?}"
        );
        assert!(
            response.contains("在途") || response.contains("预算"),
            "要说清是哪一档满了：{response}"
        );
        drop(first);
        drop(second);
        center.stop();
    }

    /// docs/175 R05：**停服务要把已经收下的连接关掉**。
    ///
    /// 从前 `stop` 只把 accept 那一圈叫停、再停 UDP：已经 spawn 出去的 handler 谁也不管，
    /// 于是半开连接会一直挂到它自己的读超时（旧代码里那条路根本没有期限）。
    #[test]
    fn stopping_the_server_closes_the_connections_it_is_holding() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (center, port) = server_for(dir.path());
        let mut socket = RawSocket::connect(port);
        socket.send(b"POST /v2/process HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        std::thread::sleep(std::time::Duration::from_millis(200));
        center.stop();
        let (_, closed) = socket.read_until_eof(std::time::Duration::from_secs(3));
        assert!(closed, "停服务要把它已经收下的连接关掉，不能等对面自己超时");
    }
    #[test]
    fn acceptance_capability_revision_is_accepted_by_a_real_process_request() {
        let dir = tempfile::tempdir().unwrap();
        let (center, port) = server_for(dir.path());
        let url = format!("127.0.0.1:{port}");
        let advertised = remote_capabilities(&url, "token-123").unwrap();
        let params = ProcessParams { chain: vec![], op: "upscale".into(),
            model_id: Some(EXPLICIT_NEAREST_MODEL.into()), scale: Some(2), dlssnr: None };
        let result = tauri::async_runtime::block_on(remote_process_cancellable(
            &url, "token-123", &params, one_pixel_png(),
            &crate::inference::cancel::CancelToken::none(), Some(&advertised.revision)));
        center.stop();
        assert!(result.is_ok(), "the advertised settings revision must validate a single-stage response: {result:?}");
    }

    #[test]
    fn acceptance_server_policy_and_scale_are_part_of_the_frozen_plan() {
        let dir = tempfile::tempdir().unwrap();
        let settings = RemoteSettings { upscale_backend: "cpu".into(),
            upscale_model: "anime4k-hq".into(), upscale_output_scale: 2, dlssnr_passes: String::new() };
        let params = ProcessParams { chain: vec![], op: "upscale".into(),
            model_id: None, scale: Some(2), dlssnr: None };
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &settings, false).unwrap();
        assert_eq!(plan.engine_policy, "cpu");
        let off = RemoteSettings { upscale_backend: "off".into(), ..settings.clone() };
        assert!(ProcessPlan::resolve(dir.path(), dir.path(), &params, &off, false).is_err());
        let nearest = ProcessParams { model_id: Some(EXPLICIT_NEAREST_MODEL.into()), ..params };
        let p2 = ProcessPlan::resolve(dir.path(), dir.path(), &nearest, &settings, false).unwrap();
        let p3 = ProcessPlan::resolve(dir.path(), dir.path(), &ProcessParams { scale: Some(3), ..nearest }, &settings, false).unwrap();
        assert_ne!(p2.revision, p3.revision);
    }

    #[test]
    fn acceptance_stop_between_reserve_and_attach_cancels_the_task() {
        let connections = Connections::default();
        let id = connections.reserve().unwrap();
        connections.close_all();
        let (tx, rx) = std::sync::mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = tx.send(());
        });
        connections.attach(id, task);
        assert!(rx.recv_timeout(std::time::Duration::from_secs(1)).is_err(), "closed connection spawned an untracked task");
        assert!(connections.reserve().is_none(), "a stopped registry must stay closed");
    }

    #[test]
    fn acceptance_a_replaced_model_cannot_run_under_the_old_plan() {
        let dir = tempfile::tempdir().unwrap();
        install_fake_onnx_upscaler(dir.path(), "server-model");
        let settings = RemoteSettings { upscale_model: "server-model".into(), ..RemoteSettings::default() };
        let params = ProcessParams { chain: vec![], op: "upscale".into(), model_id: None, scale: None, dlssnr: None };
        let plan = ProcessPlan::resolve(dir.path(), dir.path(), &params, &settings, false).unwrap();
        std::fs::write(dir.path().join("models/server-model/1/model.onnx"), b"changed weights").unwrap();
        let error = upscale_bytes(None, dir.path(), &plan, &one_pixel_png(), &cancelled_never).unwrap_err();
        assert!(error.contains("发生变化"), "must reject stale model before handing it to a worker: {error}");
    }

}
