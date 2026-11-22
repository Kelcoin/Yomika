//! 宿主侧的产物租借表（`docs/71` §7.4、§7.5）。
//!
//! 前端拿到的不是文件路径，而是一个**不透明的租借号**，配成
//! `yomika-image://asset/{leaseId}`。于是 URL 里没有数据目录、没有档案 id、也没有页号：
//! 一个泄漏出去的 URL 只泄漏「某个已经算好的产物存在过」，而且它跟着租借一起过期。
//!
//! 为什么不直接把路径给前端：路径就是权限。前端是 WebView 里的页面，它的输入（远端档案
//! 的名字、别人机器上的文件名）不可信。把「能读哪一份文件」变成宿主这边一次查表的结论，
//! 就不会出现「拼一个路径出来试试看」这种攻击面。
//!
//! 这个模块**不碰数据库**：谁把内容钉住（`crate::cache::pin_cache_path`）由命令层决定，
//! 这里只回答「这个租借号是不是有效、它指向哪一份内容」。时间也是**传进来的**
//! （`now: Instant`），所以过期逻辑可以在测试里一步跨过去，不必睡十分钟。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) type ReaderFile = Arc<Mutex<std::fs::File>>;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 一份租借最多活这么久。前端在离开阅读器时会主动放掉，这个上限是给「它没来得及放」
/// 准备的：崩掉的 WebView、被强杀的窗口、写错的调用点。
pub const LEASE_TTL: Duration = Duration::from_secs(600);

/// 同时活着的租借上限。租借代表一份**编译后**的图片，几十 MB 起步，所以上限是防漏的
/// 闸门而不是性能旋钮；正常阅读（可见页 + 邻页）离它很远。
pub const MAX_LIVE_LEASES: usize = 64;

pub const LEASE_UNKNOWN_CODE: &str = "COMPUTE_LEASE_UNKNOWN";
pub const LEASE_EXPIRED_CODE: &str = "COMPUTE_LEASE_EXPIRED";
pub const LEASE_WRONG_WINDOW_CODE: &str = "COMPUTE_LEASE_WRONG_WINDOW";
pub const ARTIFACT_INVALID_CODE: &str = "COMPUTE_ARTIFACT_INVALID";
pub const RESOURCE_LIMIT_CODE: &str = "COMPUTE_RESOURCE_LIMIT";

/// 允许通过 `yomika-image` 交给渲染器的类型（§7.5 的白名单）。
///
/// 只有位图。SVG 与 HTML 也在「图片」的语义里，但它们是**可执行的文档**：SVG 能带脚本、
/// 能发外部请求，交给一个共享 WebView 的 scheme 就等于把同源策略绕开一半。
pub fn is_allowed_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

/// 租借失败的原因。每一种都对应前端要认的一个稳定错误码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    Unknown { lease_id: String },
    Expired { lease_id: String },
    WrongWindow { lease_id: String },
    /// 产物还在 staging 里、没发到正式目录（宿主没配发布根，或者核验没过）。
    NotPublished { artifact_id: String },
    UnsupportedMime { artifact_id: String, mime: String },
    BudgetFull { limit: usize },
}

impl LeaseError {
    pub fn code(&self) -> &'static str {
        match self {
            LeaseError::Unknown { .. } => LEASE_UNKNOWN_CODE,
            LeaseError::Expired { .. } => LEASE_EXPIRED_CODE,
            LeaseError::WrongWindow { .. } => LEASE_WRONG_WINDOW_CODE,
            LeaseError::NotPublished { .. } => ARTIFACT_INVALID_CODE,
            LeaseError::UnsupportedMime { .. } => ARTIFACT_INVALID_CODE,
            LeaseError::BudgetFull { .. } => RESOURCE_LIMIT_CODE,
        }
    }

    /// 只有「等一会儿再来」值得重试。租借号不认识就是不认识，重试一万次也一样。
    pub fn retryable(&self) -> bool {
        matches!(self, LeaseError::BudgetFull { .. })
    }

    pub fn message(&self) -> String {
        match self {
            LeaseError::Unknown { lease_id } => {
                format!("这张图的使用凭据不认识（可能已经被回收）：{lease_id}")
            }
            LeaseError::Expired { lease_id } => {
                format!("这张图的使用凭据已经过期：{lease_id}")
            }
            LeaseError::WrongWindow { lease_id } => {
                format!("这张图的使用凭据不是发给这个窗口的：{lease_id}")
            }
            LeaseError::NotPublished { artifact_id } => {
                format!("产物还没落到正式目录，不能交给界面：{artifact_id}")
            }
            LeaseError::UnsupportedMime { mime, artifact_id } => {
                format!("产物 {artifact_id} 的类型 {mime} 不在可交给渲染器的白名单里")
            }
            LeaseError::BudgetFull { limit } => {
                format!("同时显示的计算产物已经到上限（{limit} 份），先放掉一些再取")
            }
        }
    }
}

/// 前端要的那些字段（§9.2 的 `ComputedImageLease`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedImageLease {
    pub lease_id: String,
    pub artifact_id: String,
    pub job_id: String,
    /// `yomika-image://asset/{leaseId}`。
    pub url: String,
    pub mime: String,
    pub byte_length: u64,
    /// worker **自报**的尺寸，只作界面排版的估计（宿主这一轮不解码图像）。
    pub width: u32,
    pub height: u32,
    /// 解码后的估计字节数（宽 × 高 × 4）。内存预算按这个算，不按压缩后的字节数——
    /// 真正吃内存的是解码后的位图（§7.4）。
    pub estimated_decoded_bytes: u64,
    pub pipeline_revision: String,
    pub expires_in_ms: u64,
}

/// 表里记着的那份内容。协议层靠它决定读哪个文件、回什么头。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseView {
    pub artifact_id: String,
    pub job_id: String,
    pub path: PathBuf,
    pub mime: String,
    pub byte_length: u64,
    /// 内容寻址的相对路径：命令层用它把文件钉住，别让配额回收把它删了。
    pub cache_relative: String,
    pub pipeline_revision: String,
}

struct LeaseEntry {
    view: LeaseView,
    file: Option<ReaderFile>,
    reader_page: Option<(u32, i64)>,
    webview_label: String,
    expires_at: Instant,
}

/// 开一张租借要交的材料。
#[derive(Debug, Clone)]
pub struct LeaseSpec {
    pub artifact_id: String,
    pub job_id: String,
    pub path: PathBuf,
    pub cache_relative: Option<String>,
    pub mime: String,
    pub byte_length: u64,
    pub width: u32,
    pub height: u32,
    pub pipeline_revision: String,
    /// 发起这次取用的窗口。来自宿主的 context，**不是**前端传上来的（§6.6）。
    pub webview_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcquiredLease {
    pub lease: ComputedImageLease,
    /// 顺手清掉的过期租借。调用方要把它们的内容**放开**（解 pin），
    /// 否则过期只是「读不到了」，配额却还被占着。
    pub expired: Vec<LeaseView>,
}

pub struct LeaseStore {
    entries: Mutex<HashMap<String, LeaseEntry>>,
    serial: AtomicU64,
    ttl: Duration,
    capacity: usize,
}

impl Default for LeaseStore {
    fn default() -> Self {
        Self::new()
    }
}

impl LeaseStore {
    pub fn new() -> Self {
        Self::with_limits(LEASE_TTL, MAX_LIVE_LEASES)
    }

    pub fn with_limits(ttl: Duration, capacity: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            serial: AtomicU64::new(0),
            ttl,
            capacity,
        }
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn live_count(&self) -> usize {
        self.lock().len()
    }

    /// 锁中毒不当回事：这里的数据是「谁在看哪张图」，最坏的情况是白送一张租借，
    /// 而没有理由为了它让整个进程崩掉。
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, LeaseEntry>> {
        self.entries.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn collect_expired(
        entries: &mut HashMap<String, LeaseEntry>,
        now: Instant,
    ) -> Vec<LeaseView> {
        let dead: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| entry.expires_at <= now)
            .map(|(id, _)| id.clone())
            .collect();
        dead.into_iter()
            .filter_map(|id| entries.remove(&id))
            .map(|entry| entry.view)
            .collect()
    }

    pub fn acquire(&self, spec: LeaseSpec, now: Instant) -> Result<AcquiredLease, LeaseError> {
        self.acquire_inner(spec, None, None, now)
    }

    pub(crate) fn acquire_file(
        &self,
        spec: LeaseSpec,
        file: std::fs::File,
        reader_page: Option<(u32, i64)>,
        now: Instant,
    ) -> Result<AcquiredLease, LeaseError> {
        self.acquire_inner(spec, Some(Arc::new(Mutex::new(file))), reader_page, now)
    }

    fn acquire_inner(
        &self,
        spec: LeaseSpec,
        file: Option<ReaderFile>,
        reader_page: Option<(u32, i64)>,
        now: Instant,
    ) -> Result<AcquiredLease, LeaseError> {
        if !is_allowed_image_mime(&spec.mime) {
            return Err(LeaseError::UnsupportedMime {
                artifact_id: spec.artifact_id,
                mime: spec.mime,
            });
        }
        // 没有落到正式目录的产物不给 URL：staging 是 worker 能随便写的地方，
        // 还没核验过的东西不该出现在渲染器面前。
        let Some(cache_relative) = spec.cache_relative.clone().or_else(|| file.as_ref().map(|_| String::new())) else {
            return Err(LeaseError::NotPublished {
                artifact_id: spec.artifact_id,
            });
        };
        // Validate before changing ownership. Failed requests cannot return the
        // expired list, so removing it early loses the caller's database pins.
        let mut entries = self.lock();
        let expired = Self::collect_expired(&mut entries, now);
        if entries.len() >= self.capacity {
            return Err(LeaseError::BudgetFull { limit: self.capacity });
        }
        let lease_id = self.new_id(&spec);
        let url = lease_url(&lease_id);
        let view = LeaseView {
            artifact_id: spec.artifact_id.clone(),
            job_id: spec.job_id.clone(),
            path: spec.path,
            mime: spec.mime.clone(),
            byte_length: spec.byte_length,
            cache_relative,
            pipeline_revision: spec.pipeline_revision.clone(),
        };
        let expires_at = now + self.ttl;
        entries.insert(
            lease_id.clone(),
            LeaseEntry {
                view: view.clone(),
                file,
                reader_page,
                webview_label: spec.webview_label,
                expires_at,
            },
        );
        Ok(AcquiredLease {
            lease: ComputedImageLease {
                lease_id,
                artifact_id: view.artifact_id,
                job_id: view.job_id,
                url,
                mime: view.mime,
                byte_length: view.byte_length,
                width: spec.width,
                height: spec.height,
                estimated_decoded_bytes: decoded_bytes(spec.width, spec.height),
                pipeline_revision: view.pipeline_revision,
                expires_in_ms: self.ttl.as_millis() as u64,
            },
            expired,
        })
    }

    /// 查一张租借。窗口不对也算失败——租借号只在拿到它的那个窗口里有效。
    #[cfg(test)]
    pub fn view(
        &self,
        lease_id: &str,
        webview_label: &str,
        now: Instant,
    ) -> Result<LeaseView, LeaseError> {
        self.view_with_file(lease_id, webview_label, now).map(|(view, _)| view)
    }

    pub(crate) fn view_with_file(
        &self,
        lease_id: &str,
        webview_label: &str,
        now: Instant,
    ) -> Result<(LeaseView, Option<ReaderFile>), LeaseError> {
        let entries = self.lock();
        let Some(entry) = entries.get(lease_id) else {
            return Err(LeaseError::Unknown {
                lease_id: lease_id.to_string(),
            });
        };
        if entry.expires_at <= now {
            return Err(LeaseError::Expired {
                lease_id: lease_id.to_string(),
            });
        }
        if entry.webview_label != webview_label {
            return Err(LeaseError::WrongWindow {
                lease_id: lease_id.to_string(),
            });
        }
        Ok((entry.view.clone(), entry.file.clone()))
    }

    /// Take a single snapshot for both sides of a spread. Once acquired, the
    /// renderer owns these references even if either front-end lease is retired.
    #[cfg(any(windows, target_os = "android", target_os = "ios", test))]
    pub(crate) fn reader_files(
        &self,
        left: &str,
        right: Option<&str>,
        webview_label: &str,
        session: u32,
        page: i32,
        now: Instant,
    ) -> Option<(ReaderFile, Option<ReaderFile>)> {
        let entries = self.lock();
        let first_index = i64::from(page) - 1;
        let entry_for = |id: &str| {
            let entry = entries.get(id)?;
            let (lease_session, page_index) = entry.reader_page?;
            if entry.webview_label != webview_label || lease_session != session || entry.expires_at <= now {
                return None;
            }
            Some((page_index, entry.file.as_ref()?))
        };
        let (left_index, left) = entry_for(left)?;
        let Some(right) = right else {
            return (left_index == first_index).then(|| (left.clone(), None));
        };
        let (right_index, right) = entry_for(right)?;
        // Images arrive in visual order, while page identifies the first logical page.
        let pages = (left_index.min(right_index), left_index.max(right_index));
        (pages == (first_index, first_index + 1)).then(|| (left.clone(), Some(right.clone())))
    }

    /// 放掉一张租借。`None` = 本来就没有（重复释放、过期后清过）——重复释放不是错误，
    /// 前端的卸载路径和错误路径会重叠，把它们都变成报错只会让人不敢放。
    pub fn release(&self, lease_id: &str) -> Option<LeaseView> {
        self.lock().remove(lease_id).map(|entry| entry.view)
    }

    /// 清掉过期的，返回清掉的（调用方要解 pin）。协议处理器每次开工前都会叫一次它，
    /// 所以没人放的租借不会永远占着上限。
    pub fn purge_expired(&self, now: Instant) -> Vec<LeaseView> {
        let mut entries = self.lock();
        Self::collect_expired(&mut entries, now)
    }

    fn new_id(&self, spec: &LeaseSpec) -> String {
        let serial = self.serial.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let mut hasher = blake3::Hasher::new();
        hasher.update(spec.job_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(spec.artifact_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(&serial.to_le_bytes());
        hasher.update(&nanos.to_le_bytes());
        let hex = hasher.finalize().to_hex();
        hex[..LEASE_ID_HEX_BYTES].to_string()
    }
}

/// 租借号的长度（十六进制字符）。够短到能塞进 URL，够长到猜不出来。
pub const LEASE_ID_HEX_BYTES: usize = 32;

pub const SCHEME: &str = "yomika-image";
pub const HOST: &str = "asset";

/// 一张租借交给渲染器时用的取图地址。
///
/// **Windows 与 Android 上不能写 `yomika-image://asset/{id}`**：那两边的 WebView 只把
/// 「HTTP 请求」交给自定义 scheme 的处理器。wry 的做法是注册一张 `http://yomika-image.*`
/// 的资源拦截表，等真的来了 `http://yomika-image.localhost/...` 再把前缀换回
/// `yomika-image://localhost/...` 转给处理器（见 wry 的 `custom_protocol_workaround.rs`，
/// Tauri 自己的 `convertFileSrc` 也是这么分的：Windows/Android 用
/// `http://<scheme>.localhost/<path>`）。直接写 scheme 形状的 `<img>` 在 WebView2 里
/// 根本不会被拦到，也就没人回它——解码只是一直不完成，页面上留下一张破图。
/// macOS/Linux/iOS 走原生 scheme handler，原样写 scheme 就够。
pub fn lease_url(lease_id: &str) -> String {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        format!("http://{SCHEME}.localhost/{HOST}/{lease_id}")
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        format!("{SCHEME}://{HOST}/{lease_id}")
    }
}

/// 解码后的估计字节数。宽高都是 worker 自报的，0 就当 0——估算是为了预算，
/// 不是为了拒绝，所以要倾向保守而不是精确。
fn decoded_bytes(width: u32, height: u32) -> u64 {
    u64::from(width) * u64::from(height) * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(artifact: &str) -> LeaseSpec {
        LeaseSpec {
            artifact_id: artifact.to_string(),
            job_id: "job-1".to_string(),
            path: PathBuf::from("C:\\data\\cache\\images\\ab\\ab.bin"),
            cache_relative: Some("cache/images/ab/ab.bin".to_string()),
            mime: "image/png".to_string(),
            byte_length: 4096,
            width: 64,
            height: 32,
            pipeline_revision: "worker-v1:abcdef".to_string(),
            webview_label: "main".to_string(),
        }
    }

    #[test]
    fn reader_file_survives_path_replacement_and_release_during_read() {
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("page.bin");
        std::fs::write(&path, b"first version").unwrap();
        let mut spec = spec("page");
        spec.path = path.clone();
        let original = std::fs::File::open(&path).unwrap();
        let window = spec.webview_label.clone();
        let now = Instant::now();
        let store = LeaseStore::new();
        let lease = store.acquire_file(spec, original, None, now).unwrap().lease;
        std::fs::rename(&path, dir.path().join("evicted.bin")).unwrap();
        std::fs::write(&path, b"second version").unwrap();
        assert!(store.view_with_file(&lease.lease_id, "other", now).is_err());
        let (_, file) = store.view_with_file(&lease.lease_id, &window, now).unwrap();
        store.release(&lease.lease_id);
        assert!(store.view_with_file(&lease.lease_id, &window, now).is_err());
        let mut result = Vec::new();
        file.unwrap().lock().unwrap().read_to_end(&mut result).unwrap();
        assert_eq!(result, b"first version");
    }

    #[test]
    fn native_spread_acquires_both_exact_versions_for_the_requesting_window() {
        use std::io::Read;

        let now = Instant::now();
        let store = LeaseStore::new();
        let dir = tempfile::tempdir().unwrap();
        let make = |name: &str, contents: &[u8], window: &str, session: u32, page_index: i64| {
            let mut spec = spec(name);
            spec.path = dir.path().join(name);
            spec.webview_label = window.to_owned();
            std::fs::write(&spec.path, contents).unwrap();
            let file = std::fs::File::open(&spec.path).unwrap();
            store.acquire_file(spec, file, Some((session, page_index)), now).unwrap().lease.lease_id
        };
        let first = make("first", b"original", "main", 5, 10);
        let second = make("second", b"processed", "main", 5, 11);
        let foreign = make("foreign", b"other reader", "other", 5, 11);
        let stale = make("stale", b"previous session", "main", 4, 11);
        assert!(store.reader_files(&first, Some(&foreign), "main", 5, 11, now).is_none());
        assert!(store.reader_files(&first, Some(&stale), "main", 5, 11, now).is_none());
        assert!(store.reader_files(&stale, None, "main", 5, 11, now).is_none());
        let newer_first = make("newer-first", b"processed first", "main", 5, 10);
        assert!(store.reader_files(&first, Some(&newer_first), "main", 5, 11, now).is_none());
        assert!(store.reader_files(&second, None, "main", 5, 11, now).is_none());
        assert!(store.reader_files(&second, Some(&first), "main", 5, 11, now).is_some());
        let (left, right) = store.reader_files(&first, Some(&second), "main", 5, 11, now).unwrap();
        store.release(&first);
        store.release(&second);
        assert!(store.reader_files(&first, Some(&second), "main", 5, 11, now).is_none());
        for (file, expected) in [(left, b"original".as_slice()), (right.unwrap(), b"processed".as_slice())] {
            let mut bytes = Vec::new();
            file.lock().unwrap().read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, expected);
        }
    }

    #[test]
    fn a_lease_is_bound_to_the_window_that_acquired_it() {
        let store = LeaseStore::new();
        let now = Instant::now();
        let acquired = store.acquire(spec("art-1"), now).expect("开一张租借");
        // 取图地址必须是这个 WebView 真能拦到的形状：Windows/Android 只拦
        // `http://yomika-image.*`，把 scheme 形状写回 `<img>` 就是一个没人回的死链。
        #[cfg(any(target_os = "windows", target_os = "android"))]
        assert_eq!(
            acquired.lease.url,
            format!(
                "http://yomika-image.localhost/asset/{}",
                acquired.lease.lease_id
            )
        );
        #[cfg(not(any(target_os = "windows", target_os = "android")))]
        assert_eq!(
            acquired.lease.url,
            format!("yomika-image://asset/{}", acquired.lease.lease_id)
        );
        assert_eq!(acquired.lease.estimated_decoded_bytes, 64 * 32 * 4);
        assert_eq!(acquired.expired.len(), 0);
        assert!(store.view(&acquired.lease.lease_id, "main", now).is_ok());
        assert_eq!(
            store.view(&acquired.lease.lease_id, "second-window", now),
            Err(LeaseError::WrongWindow {
                lease_id: acquired.lease.lease_id.clone()
            })
        );
    }

    #[test]
    fn an_expired_lease_is_refused_and_can_be_collected() {
        let store = LeaseStore::with_limits(Duration::from_secs(5), 4);
        let start = Instant::now();
        let acquired = store.acquire(spec("art-1"), start).expect("开一张租借");
        let later = start + Duration::from_secs(6);
        assert_eq!(
            store.view(&acquired.lease.lease_id, "main", later),
            Err(LeaseError::Expired {
                lease_id: acquired.lease.lease_id.clone()
            })
        );
        let collected = store.purge_expired(later);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].artifact_id, "art-1");
        assert_eq!(
            store.view(&acquired.lease.lease_id, "main", later),
            Err(LeaseError::Unknown {
                lease_id: acquired.lease.lease_id.clone()
            })
        );
    }

    #[test]
    fn an_artifact_that_was_never_published_gets_no_url() {
        let store = LeaseStore::new();
        let mut unpublished = spec("art-1");
        unpublished.cache_relative = None;
        assert_eq!(
            store.acquire(unpublished, Instant::now()),
            Err(LeaseError::NotPublished {
                artifact_id: "art-1".to_string()
            })
        );
    }

    #[test]
    fn a_type_the_renderer_should_not_render_is_refused() {
        let store = LeaseStore::new();
        for mime in ["image/svg+xml", "text/html", "application/octet-stream"] {
            let mut wrong = spec("art-1");
            wrong.mime = mime.to_string();
            assert_eq!(
                store.acquire(wrong, Instant::now()),
                Err(LeaseError::UnsupportedMime {
                    artifact_id: "art-1".to_string(),
                    mime: mime.to_string()
                }),
                "{mime} 不该被放过去"
            );
        }
        for mime in ["image/png", "image/jpeg", "image/webp", "image/gif"] {
            assert!(is_allowed_image_mime(mime), "{mime} 是白名单里的");
        }
    }

    #[test]
    fn the_lease_table_refuses_to_grow_past_its_budget() {
        let store = LeaseStore::with_limits(Duration::from_secs(60), 2);
        let now = Instant::now();
        let first = store.acquire(spec("art-1"), now).expect("第一张");
        let second = store.acquire(spec("art-2"), now).expect("第二张");
        assert_eq!(
            store.acquire(spec("art-3"), now),
            Err(LeaseError::BudgetFull { limit: 2 })
        );
        assert!(LeaseError::BudgetFull { limit: 2 }.retryable());
        store.release(&first.lease.lease_id);
        assert!(store.acquire(spec("art-3"), now).is_ok());
        assert_eq!(store.live_count(), 2);
        store.release(&second.lease.lease_id);
        assert_eq!(store.live_count(), 1);
    }

    #[test]
    fn acquiring_hands_back_the_ones_that_expired_and_nothing_else() {
        let store = LeaseStore::with_limits(Duration::from_secs(10), 4);
        let start = Instant::now();
        let stale = store.acquire(spec("art-1"), start).expect("第一张");
        let live = store.acquire(spec("art-2"), start + Duration::from_secs(5)).expect("第二张");
        let again = store
            .acquire(spec("art-3"), start + Duration::from_secs(11))
            .expect("第三张");
        // 第一张过期（10 秒），第二张还没（第 5 秒开的，到第 15 秒才过期）。
        assert_eq!(again.expired.len(), 1);
        assert_eq!(again.expired[0].artifact_id, "art-1");
        assert_eq!(again.expired[0].cache_relative, "cache/images/ab/ab.bin");
        assert!(store
            .view(&stale.lease.lease_id, "main", start + Duration::from_secs(11))
            .is_err());
        assert!(store
            .view(&live.lease.lease_id, "main", start + Duration::from_secs(11))
            .is_ok());
    }

    #[test]
    fn releasing_an_unknown_lease_is_not_an_error() {
        let store = LeaseStore::new();
        let acquired = store.acquire(spec("art-1"), Instant::now()).expect("开一张");
        assert!(store.release(&acquired.lease.lease_id).is_some());
        assert!(store.release(&acquired.lease.lease_id).is_none());
        assert!(store.release("nope").is_none());
    }

    #[test]
    fn lease_ids_are_opaque_and_unique() {
        let store = LeaseStore::new();
        let now = Instant::now();
        let mut seen = std::collections::HashSet::new();
        for _ in 0..8 {
            let acquired = store.acquire(spec("art-1"), now).expect("开一张");
            let id = acquired.lease.lease_id;
            assert_eq!(id.len(), LEASE_ID_HEX_BYTES);
            assert!(
                id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{id} 必须是 32 位小写十六进制"
            );
            assert!(!id.contains("job-1") && !id.contains("art-1"));
            assert!(seen.insert(id), "租借号撞了");
        }
    }

    #[test]
    fn an_invalid_acquisition_does_not_lose_expired_pins_before_the_caller_can_unpin_them() {
        let store = LeaseStore::with_limits(Duration::from_secs(1), 2);
        let now = Instant::now();
        let old = store.acquire(spec("old"), now).unwrap().lease;
        let later = now + Duration::from_secs(2);
        let mut invalid = spec("invalid");
        invalid.mime = "text/html".into();
        assert!(store.acquire(invalid, later).is_err());
        let next = store.acquire(spec("new"), later).unwrap();
        assert_eq!(next.expired.len(), 1, "failed acquire must not silently delete the old host pin record");
        assert_eq!(next.expired[0].artifact_id, old.artifact_id);
    }

}
