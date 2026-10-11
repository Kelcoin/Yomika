//! 算力中心：把桌面端的超分 / 去码 / DLSSNR 借给局域网里的移动端用。
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
    /// 保留旧字段供前端状态解析；服务可以在尚未安装模型时启动。
    pub can_start: bool,
    pub paired_clients: Vec<PairedClient>,
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
        let token = Arc::clone(&self.token);
        let pairing = Arc::clone(&self.pairing);

        let stop_for_task = Arc::clone(&stop);
        // `from_std` 必须在 tokio 的运行环境里调（普通测试线程里没有 reactor），
        // 所以监听套接字在这一步之前就建好了——端口占用这类错也就还能同步报出来。
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = TcpListener::from_std(listener) else {
                return;
            };
            serve(listener, token, Arc::clone(&pairing), stop_for_task, context).await;
        });
        let discovery = if port != 0 {
            let discovery_stop = Arc::clone(&stop);
            Some(std::thread::spawn(move || serve_discovery(bound, discovery_stop)))
        } else {
            None
        };
        *guard = Some(Running { port: bound, stop, discovery });
        Ok(bound)
    }

    /// 关服务：置位之后往自己的端口连一次，把卡在 `accept` 上的循环叫醒。
    pub fn stop(&self) {
        let running = self.inner.lock().ok().and_then(|mut guard| guard.take());
        if let Some(running) = running {
            running.stop.store(true, Ordering::SeqCst);
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

/// 能力清单：三类各自查一遍「齐不齐」。
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

/// 请求要干的事。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessParams {
    /// `upscale` / `decensor` / `dlssnr`。
    pub op: String,
    /// 这一页要做的**几档**，按顺序做（`["decensor","upscale"]` 就是先去码再超分）。
    ///
    /// 空的就按 `op` 单做一档（老客户端与直接调用的来路照旧）。客户端只说「做什么」，
    /// **模型与参数一律不传**：那两样跟随这台服务端自己的设置（`model_id` 为空时
    /// `resolve_upscaler` / `resolve_installed_bundle` 取的就是本机默认那一份，DLSSNR
    /// 取 `DlssnrSettings::default()`）——这正是「远端处理固定跟随远端服务的设置」。
    #[serde(default)]
    pub chain: Vec<String>,
    /// 模型 id（超分 / 去码用）。
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
/// 去码那一档、DLSSNR 那一档都必须经由它交给 worker。这不是可选的分流——Task 8 的出口就是
/// 「宿主进程里没有 ONNX Runtime，也没有 NGX 资源」，所以这里不能再留一条「引擎在宿主就地
/// 跑」的兜底来路。宿主自己还能算的只剩两样：内置的 shader 链（Anime4K）与没有模型的最近邻，
/// 它们本来也不用 ONNX Runtime。
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
    if bytes.is_empty() {
        return Err("请求体是空的（要发图片字节）".to_string());
    }
    // 要做哪几档：`chain` 说了算，没给就按 `op` 单做一档。改写上限是三道——三档都做一遍
    // 就是全部；重复的那一档没有第二次的意义（同样的模型吃同样的字节出来还是一样）。
    let steps: Vec<&str> = if params.chain.is_empty() {
        vec![params.op.as_str()]
    } else {
        let mut seen: Vec<&str> = Vec::new();
        for step in &params.chain {
            let step = step.as_str();
            if !matches!(step, "upscale" | "decensor" | "dlssnr") {
                return Err(format!("不认识的处理方式：{step}"));
            }
            if !seen.contains(&step) {
                seen.push(step);
            }
        }
        seen
    };
    // 动图原样交回这一条规则只写一处：改像素的两种处理方式一旦动手，出来的就只有第一
    // 帧，回一个「看着成功、其实丢帧」的结果比报错更坏。DLSSNR 不在此列——worker 那边
    // 自己会逐帧走一遍再编回 APNG（见 `worker/src/dlssnr.rs`）；一串里有它，整串都不走
    // 这条短路（它前面几档也改像素）。
    if !steps.contains(&"dlssnr") && crate::cache::is_animated_image(bytes) {
        return Ok(bytes.to_vec());
    }
    let mut current = bytes.to_vec();
    for step in steps {
        if cancelled() {
            return Err("对面把这条连接丢了".to_string());
        }
        current = match step {
            "upscale" => upscale_bytes(manager, model_data, params, &current, cancelled)?,
            "decensor" => decensor_bytes(manager, model_data, params, &current, cancelled)?,
            "dlssnr" => dlssnr_bytes(manager, data, params, &current, cancelled)?,
            other => return Err(format!("不认识的处理方式：{other}")),
        };
    }
    Ok(current)
}

/// 超分：装了 ONNX 模型的那一档交给计算进程，其余两档（内置 shader 链、没有模型的
/// 最近邻）留在宿主——`run_host_upscale_bytes` 自己会把 ONNX 那一档顶回来。
fn upscale_bytes(
    manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path,
    params: &ProcessParams,
    source: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let model_id = params.model_id.as_deref().unwrap_or_default();
    let resolved = crate::inference::resolve_upscaler(model_data, model_id);
    match &resolved {
        Some(crate::inference::ResolvedUpscaler::Onnx(_, manifest)) => {
            let manager = manager.ok_or_else(no_orchestration)?;
            let settings_id = crate::inference::enhanced_revision(&resolved, None);
            let input_id = format!("remote:{}", blake3::hash(source).to_hex());
            crate::compute::proxy::upscale(
                manager,
                crate::compute::proxy::UpscaleJob {
                    input_id: &input_id,
                    settings_id: &settings_id,
                    // 这一页是从网络那头来的字节，没有本机归档与页码可讲；四元身份里的
                    // 这一栏就照实说「远端字节」，而不是借一个像模像样的页码。
                    source_revision: "remote-bytes",
                    // 远端请求永远排在本机阅读之后：用户正看着的那一页先算。
                    priority: crate::compute::scheduler::Priority::Background,
                    // 倍数由模型说了算（`scale` 是模型自己的属性），这里不再让请求体
                    // 覆盖它——覆盖会让同一份输入因参数不同落进两个任务身份。
                    output_scale: None,
                    stage: crate::compute::proxy::StageSpec {
                        stage_id: crate::compute::reader::UPSCALE_STAGE_ID,
                        model_spec_id: model_id,
                        scale: manifest.scale.clamp(1, 4),
                        page: source,
                    },
                },
                cancelled,
            )
            .map_err(proxy_failure)
        }
        _ => crate::inference::run_host_upscale_bytes(model_data, model_id, source, params.scale),
    }
}

/// 去码：装没装三件套由宿主查（那是磁盘上的事），检测与补像素在 worker。
fn decensor_bytes(
    manager: Option<&crate::compute::manager::ComputeManager>,
    model_data: &Path,
    params: &ProcessParams,
    source: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let model_id = params.model_id.as_deref().unwrap_or_default();
    let Some((bundle, manifest)) = crate::inference::resolve_installed_bundle(model_data, model_id)
    else {
        return Err("No complete de-censoring bundle is installed under that id".to_string());
    };
    let manager = manager.ok_or_else(no_orchestration)?;
    let settings_id = crate::inference::decensored_revision(&manifest.sha256);
    let input_id = format!("remote:{}", blake3::hash(source).to_hex());
    crate::compute::proxy::decensor(
        manager,
        crate::compute::proxy::DecensorJob {
            input_id: &input_id,
            settings_id: &settings_id,
            source_revision: "remote-bytes",
            priority: crate::compute::scheduler::Priority::Background,
            model_spec_id: model_id,
            inpaint: crate::compute::decensor::InpaintPreparation {
                detector: bundle.detector,
                bar: bundle.bar,
                mosaic: bundle.mosaic,
            },
            page: source,
        },
        cancelled,
    )
    .map_err(proxy_failure)
}

/// 编排没起来时的说法：这条来路现在**只能**走 worker，宿主手里已经没有引擎了，
/// 所以这是一句诚实的「没法算」，不是「过会儿再来」。
fn no_orchestration() -> String {
    "计算编排还没起来，这一页没法交给计算进程（宿主这边已经没有它的引擎了）".to_string()
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
    params: &ProcessParams,
    source: &[u8],
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u8>, String> {
    use crate::dlssnr::DlssnrSettings;

    let settings: DlssnrSettings = match &params.dlssnr {
        Some(value) => serde_json::from_value::<DlssnrSettings>(value.clone())
            .map_err(|error| format!("DLSSNR 参数不对：{error}"))?
            .normalized(),
        None => DlssnrSettings::default(),
    };
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
    let settings_id = crate::dlssnr::output_revision(data, None, &settings);
    let input_id = format!("remote:{}", blake3::hash(source).to_hex());
    let outcome = crate::compute::proxy::dlssnr(
        manager,
        crate::compute::proxy::DlssnrJob {
            input_id: &input_id,
            settings_id: &settings_id,
            source_revision: "remote-bytes",
            // 远端请求永远排在本机阅读之后：用户正看着的那一页先算。
            priority: crate::compute::scheduler::Priority::Background,
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
    _params: &ProcessParams,
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

/// 回包。写成泛型是因为「算了很久」那条路会把连接拆成读写两半（读端要单独一条任务盯着对面
/// 还在不在），回包只能从 `WriteHalf` 那一半写出去。
async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    stream: &mut W,
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

async fn serve(
    listener: TcpListener,
    token: Arc<RwLock<String>>,
    pairing: Arc<PairingState>,
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
                let pairing = Arc::clone(&pairing);
                let context = context.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle_connection(stream, token, pairing, context).await;
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
    pairing: Arc<PairingState>,
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

    // 数据端点仍要求凭配对码取得的令牌。
    if request.path == "/v2/ping" && request.method == "GET" {
        let body = serde_json::json!({ "service": SERVICE_NAME, "version": PROTOCOL_VERSION });
        return write_json(&mut stream, 200, "OK", &body.to_string()).await;
    }

    let expected = token.read().map(|guard| guard.clone()).unwrap_or_default();
    let presented = request
        .headers
        .get("x-yomika-token")
        .cloned()
        .unwrap_or_default();
    if !token_matches(&expected, &presented) && !pairing.authorized(&presented) {
        let body = error_body("UNAUTHORIZED", "令牌不对（在桌面端设置页复制一份）");
        return write_json(&mut stream, 401, "Unauthorized", &body).await;
    }

    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v2/capabilities") => {
            // 能力清单里的 DLSSNR 那一档要问 worker 的构建事实（引擎在它那一侧），
            // 取法与 `/v2/process` 同一条：取不到就是 None，那一档按装配事实答。
            let manager = context.manager();
            let name = host_name();
            let payload = RemoteCapabilities {
                service: SERVICE_NAME.to_string(),
                version: PROTOCOL_VERSION,
                name,
                capabilities: capabilities(&context.model_data, &context.data, manager.as_deref()),
                models: crate::inference::runnable_models(&context.model_data),
            };
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
            // 出错时回给人看的那一档：一串就写成 `decensor+upscale`，日志里能看出是哪一串。
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
            let cancelled = {
                let gone = Arc::clone(&gone);
                move || gone.load(Ordering::SeqCst)
            };
            let processed = tauri::async_runtime::spawn_blocking(move || {
                process(manager.as_deref(), &model_data, &data, &params, &body, &cancelled)
            })
            .await
            .map_err(|error| format!("等待计算进程的线程没能回来：{error}"))
            .and_then(|inner| inner);
            // 算完了就没必要再盯着对面；对面已经走了的话，下面那次回包会写失败——那不是错误，
            // 是「它自己不要了」。
            watcher.abort();
            match processed {
                // 跳过动图时回的是 GIF/WebP 的原始字节，标签跟着 sniff 走才不会撒谎；
                // 正常路径产出 PNG，sniff 出来的仍然是 image/png，行为不变。
                Ok(bytes) => {
                    let content_type = crate::cache::sniff_image_mime(
                        "application/octet-stream",
                        &bytes,
                    )
                    .unwrap_or_else(|| "application/octet-stream".to_string());
                    write_response(&mut writer, 200, "OK", &content_type, &bytes).await
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
        .get(format!("{base}/v2/capabilities"))
        .header("x-yomika-token", token)
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .map_err(|error| format!("连不上 {base}：{error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(describe_error(status.as_u16(), &body));
    }
    let capabilities: RemoteCapabilities = serde_json::from_str(&body).map_err(|error| format!("对面回的不是能力清单：{error}"))?;
    if capabilities.service != SERVICE_NAME || capabilities.version != PROTOCOL_VERSION {
        return Err("远端配对协议版本不匹配".into());
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
pub fn request_pairing(url: &str, name: Option<String>, kind: Option<String>) -> Result<PairRequest, String> {
    let base = normalize_base(url)?;
    let response = blocking_client()?
        .post(format!("{base}/v2/pair/request"))
        .json(&serde_json::json!({
            "name": name.filter(|value| !value.trim().is_empty()).unwrap_or_else(host_name),
            "kind": kind,
        }))
        .timeout(std::time::Duration::from_secs(8))
        .send().map_err(|error| format!("连不上 {base}：{error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() { return Err(describe_error(status.as_u16(), &body)); }
    serde_json::from_str(&body).map_err(|error| format!("配对响应无效：{error}"))
}

pub fn confirm_pairing(url: &str, request_id: &str, code: &str) -> Result<PairResult, String> {
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("请输入六位数字配对码".into());
    }
    let base = normalize_base(url)?;
    let response = blocking_client()?
        .post(format!("{base}/v2/pair/confirm"))
        .json(&serde_json::json!({ "requestId": request_id, "code": code }))
        .timeout(std::time::Duration::from_secs(8))
        .send().map_err(|error| format!("连不上 {base}：{error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() { return Err(describe_error(status.as_u16(), &body)); }
    serde_json::from_str(&body).map_err(|error| format!("配对响应无效：{error}"))
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
    // 动图只有 DLSSNR 那条路认它（对面逐帧跑完编回 APNG）；超分 / 去码没有逐帧实现，
    // 发过去只会被压成第一帧，所以照旧原样交回（前端把失败当可重试）。判定必须在下面
    // 那次「归一成 PNG」之前——归一化本身就已经把动图压成第一帧了。
    let animated = crate::cache::is_animated_image(&bytes);
    if animated && params.op != "dlssnr" {
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
        let normalized = image::load_from_memory(&bytes)
            .map_err(|error| RemoteFailure::protocol(format!("待处理图像无法解码：{error}")))?
            .to_rgba8();
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(normalized.as_raw(), normalized.width(), normalized.height(), image::ExtendedColorType::Rgba8)
            .map_err(|error| RemoteFailure::protocol(format!("待处理图像无法转换为 PNG：{error}")))?;
        png
    };
    let response = blocking_client()
        .map_err(RemoteFailure::transport)?
        .post(format!("{base}/v2/process"))
        .header("x-yomika-token", token)
        .header("x-yomika-params", encoded)
        .header("content-type", "application/octet-stream")
        .timeout(PROCESS_TIMEOUT)
        .body(payload)
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

pub fn restore_on_launch(app: &tauri::AppHandle) -> Result<(), String> {
    let mut snapshot = preferences(app)?;
    if !snapshot.compute_center_enabled { return Ok(()); }
    if snapshot.compute_center_token.is_empty() {
        snapshot.compute_center_token = fresh_token();
        snapshot = store_preferences(app, snapshot)?;
    }
    let (model_data, data) = paths(app)?;
    let center = center_of(app)?;
    center.set_token(&snapshot.compute_center_token);
    center.start(ServerContext { model_data, data, app: Some(app.clone()), manager: None }, snapshot.compute_center_port)?;
    Ok(())
}

/// 算力中心的现状：开没开、端口、地址、令牌。
#[tauri::command(async)]
pub fn compute_center_status(app: tauri::AppHandle) -> CommandResult<ComputeCenterStatus> {
    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    let (model_data, data) = match paths(&app) {
        Ok(paths) => paths,
        Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error, false),
    };
    center.pairing.set_storage(&data);
    let token = preferences(&app)
        .map(|snapshot| snapshot.compute_center_token)
        .unwrap_or_default();
    // 这一台**能提供什么**（超分 / 去码 / DLSSNR）：本机那一档的设置页要照着它说
    // 「这台设备能对外做什么」，从前这里是空的，于是设置页那三个字一个都显示不出来。
    let local_capabilities = capabilities(
        &model_data,
        &data,
        crate::compute::manager_from_app(&app).as_deref(),
    );
    CommandResult::success(ComputeCenterStatus {
        running: center.is_running(),
        port: center.running_port().unwrap_or_else(|| current_port(&app)),
        addresses: local_addresses(),
        token,
        capabilities: local_capabilities,
        can_start: true,
        paired_clients: center.pairing.listed(),
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
        };
        if let Err(error) = center.start(context, snapshot.compute_center_port) {
            if let Some(old_port) = previous_port {
                if changing_port {
                    let fallback = ServerContext { model_data, data, app: Some(app.clone()), manager: None };
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
    })
}

#[tauri::command(async)]
pub fn compute_center_revoke_pairing(app: tauri::AppHandle, id: String) -> CommandResult<ComputeCenterStatus> {
    let center = match center_of(&app) {
        Ok(center) => center,
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    if let Err(error) = center.pairing.revoke(&id) {
        return CommandResult::failure("UNKNOWN", error, false);
    }
    compute_center_status(app)
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
        Ok(Err(error)) => CommandResult::failure("REMOTE_UNAVAILABLE", error, true),
        Err(error) => CommandResult::failure("UNKNOWN", error.to_string(), true),
    }
}

#[tauri::command]
pub async fn compute_pair_confirm(url: String, request_id: String, code: String) -> CommandResult<PairResult> {
    match tauri::async_runtime::spawn_blocking(move || confirm_pairing(&url, &request_id, &code)).await {
        Ok(Ok(result)) => CommandResult::success(result),
        Ok(Err(error)) => CommandResult::failure("UNAUTHORIZED", error, false),
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
    /// 起点那一版是哪两个模型产出的（与 DLSSNR 那条路同一个规矩：起点按产出它的
    /// 模型存，要算出同一个 revision 才读得到）。
    #[serde(default)]
    pub decensor_model: Option<String>,
    #[serde(default)]
    pub upscale_model: Option<String>,
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
    let result = crate::inference::run_remote(priority, task_id, move || {
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
    use crate::cache::CacheImageIdentity;

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
    // 锁外读盘：一页可能上兆，读文件与算摘要都不该占着全局 DB 锁。
    let page = match crate::cache::read_cached_image(database, data_dir, &identity) {
        Ok(Some(image)) => image,
        Ok(None) => return CommandResult::failure("LRR_NOT_FOUND", "Page is not cached yet", true),
        Err(error) => return CommandResult::failure("UNKNOWN", error, true),
    };
    // 两道检查：发出**之前**取消就不再发（省掉对面一次推理），发出**之后**取消则按
    // 取消处理结果（见下面的 match）。真正的中断要靠异步 HTTP，那是以后的事。
    if guard.cancelled() {
        return CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false);
    }

    match remote_process(&input.url, &input.token, &input.params, page.bytes) {
        // 已经发出去的那一次没法从这一侧掐断（阻塞式 HTTP），但结果回来时要是已经没人
        // 要了，就把它按取消处理：不把一页已经翻过去的图当成「成功」交上去，也让它早
        // 一点从那条队列上退下来（审计 P2-2 的「响应后丢弃」落到原生这一侧）。
        Ok(_) if guard.cancelled() => {
            CommandResult::failure("INFERENCE_CANCELLED", "这一页的处理已取消", false)
        }
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

    /// 去码那条路也把动图原样交回，而且**早于**找模型包：这一页要不要动手与装没装三件套
    /// 无关。这条判据原本在 `run_decensor_bytes` 里，现在上提到 `process`，于是三种处理
    /// 方式里只剩 DLSSNR 自己去逐帧。这里连模型包都没有，仍然要原样回来。
    #[test]
    fn an_animated_page_is_handed_back_by_the_decensor_too() {
        let dir = tempfile::tempdir().expect("临时目录");
        let gif = animated_gif();
        let params = ProcessParams {
            chain: Vec::new(),
            op: "decensor".into(),
            model_id: Some("no-such-bundle".into()),
            scale: None,
            dlssnr: None,
        };
        let bytes = process(None, dir.path(), dir.path(), &params, &gif, &cancelled_never).expect("动图要当成功处理");
        assert_eq!(bytes, gif, "原样回来，不是第一帧的 PNG");
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
            chain: Vec::new(),
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
        let capabilities = capabilities(dir.path(), dir.path(), None);
        let ids: Vec<&str> = capabilities.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["upscale", "decensor", "dlssnr"]);
        assert!(!capabilities[0].ready, "没有模型时超分不该是 ready");
        assert!(!capabilities[1].ready);
        assert!(capabilities[0].detail.contains("超分模型"));
    }

    /// 单测里那几条来路不测取消：交一张「永远不取消」的牌。**不写成内联的 `|| false`**——
    /// 判据（`tests/contracts/native-config.test.ts`）钉的就是「这个文件里没有一条把取消
    /// 写死的来路」，那样写会连测试一起钉进去。
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

    fn server_for(dir: &std::path::Path) -> (ComputeCenter, u16) {
        let context = ServerContext {
            model_data: dir.to_path_buf(),
            data: dir.to_path_buf(),
            app: None,
            manager: None,
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
        // 超分 / 去码没有逐帧实现：发过去之前那次「归一成 PNG」就已经把动图压成第一帧
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
        assert_eq!(refused.code, "REMOTE_UNAVAILABLE", "{}", refused.message);

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
        assert_eq!(refused.code, "REMOTE_UNAVAILABLE", "{}", refused.message);
        assert!(refused.retryable, "编排没起来是暂态，对面回的是 5xx：{}", refused.message);
        assert!(
            refused.message.contains("dlssnr：计算编排"),
            "对面没走到 DLSSNR 那一档：{}",
            refused.message
        );
        center.stop();
    }
}
