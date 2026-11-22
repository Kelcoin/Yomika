//! `yomika-image://asset/{leaseId}` 的窄异步协议（`docs/71` §7.5）。
//!
//! 阅读器不该通过 IPC 把几十 MB 的衍生图搬进 JS：那样每一页都要在 WebView 的主线程上
//! 走一次「字节数组 → Blob → objectURL」，长任务全落在这上面。这里改成让渲染器**直接按
//! URL 取**，宿主按租借号查表、把文件流出去。
//!
//! 半边是纯逻辑（[`plan`]：把一次请求翻译成状态码和取字节的计划），半边是 Tauri 的接线
//! （[`serve`]：读文件、回响应）。纯的那半在 `cargo test` 里全测得到，接线那半只能在真
//! WebView 里跑，所以它被压到最短——只做「查状态、读文件、拼响应」。
//!
//! 三条边界，写死在代码里而不是配置里：
//! * 只认 GET/HEAD，只认单段 Range；
//! * 只回白名单位图类型，且永远带 `X-Content-Type-Options: nosniff`；
//! * 请求里的 leaseId 是**唯一**的输入——没有路径、没有查询串、没有页号。

use std::path::PathBuf;
use std::time::Instant;

use super::leases::{is_allowed_image_mime, LeaseError, LeaseStore, ReaderFile};
/// 协议名与主机名都在租借表那边定义（URL 是租借拼出来的），这里转手给外面用。
pub use super::leases::{HOST, SCHEME};

pub const STATUS_OK: u16 = 200;
pub const STATUS_PARTIAL: u16 = 206;
pub const STATUS_BAD_REQUEST: u16 = 400;
pub const STATUS_FORBIDDEN: u16 = 403;
pub const STATUS_NOT_FOUND: u16 = 404;
pub const STATUS_METHOD_NOT_ALLOWED: u16 = 405;
pub const STATUS_GONE: u16 = 410;
pub const STATUS_RANGE_NOT_SATISFIABLE: u16 = 416;
pub const STATUS_INTERNAL: u16 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetMethod {
    Get,
    Head,
}

/// 要读的东西。`Empty` = 这次不回字节（HEAD，或者错误响应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetBody {
    Empty,
    Full(PathBuf),
    Range {
        path: PathBuf,
        start: u64,
        length: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetReply {
    pub status: u16,
    pub mime: String,
    /// 这次真正要回多少字节。
    pub content_length: u64,
    /// 206 与 416 才有。
    pub content_range: Option<String>,
    pub body: AssetBody,
}

/// 请求里我们真正用得到的三样东西。
#[derive(Debug, Clone)]
pub struct AssetRequest {
    pub method: AssetMethod,
    pub uri: String,
    /// 来自宿主 context（`UriSchemeContext::webview_label()`），不是前端传的。
    pub webview_label: String,
    pub range: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetError {
    BadRequest { why: String },
    MethodNotAllowed,
    Unknown { lease_id: String },
    Expired { lease_id: String },
    WrongWindow { lease_id: String },
    Unsatisfiable { total: u64, requested: String },
    Io { path: String, detail: String },
}

impl AssetError {
    pub fn status(&self) -> u16 {
        match self {
            AssetError::BadRequest { .. } => STATUS_BAD_REQUEST,
            AssetError::MethodNotAllowed => STATUS_METHOD_NOT_ALLOWED,
            AssetError::Unknown { .. } => STATUS_NOT_FOUND,
            AssetError::Expired { .. } => STATUS_GONE,
            AssetError::WrongWindow { .. } => STATUS_FORBIDDEN,
            AssetError::Unsatisfiable { .. } => STATUS_RANGE_NOT_SATISFIABLE,
            AssetError::Io { .. } => STATUS_INTERNAL,
        }
    }

    pub fn message(&self) -> String {
        match self {
            AssetError::BadRequest { why } => format!("这个取图请求不合法：{why}"),
            AssetError::MethodNotAllowed => "取图只支持 GET 与 HEAD".to_string(),
            AssetError::Unknown { lease_id } => format!("这张图的使用凭据不认识：{lease_id}"),
            AssetError::Expired { lease_id } => format!("这张图的使用凭据已经过期：{lease_id}"),
            AssetError::WrongWindow { lease_id } => {
                format!("这张图的使用凭据不是发给这个窗口的：{lease_id}")
            }
            AssetError::Unsatisfiable { total, requested } => {
                format!("只支持单段且在文件范围内的 Range（文件 {total} 字节，请求 {requested}）")
            }
            AssetError::Io { path, detail } => format!("读产物 {path} 失败：{detail}"),
        }
    }
}

impl From<LeaseError> for AssetError {
    fn from(error: LeaseError) -> Self {
        match error {
            LeaseError::Unknown { lease_id } => AssetError::Unknown { lease_id },
            LeaseError::Expired { lease_id } => AssetError::Expired { lease_id },
            LeaseError::WrongWindow { lease_id } => AssetError::WrongWindow { lease_id },
            // 租借表里不可能装着一个「没发布」或者「不能渲染」的产物：开租借时就挡了。
            // 真出现了就是宿主自己的不一致，按不认识处理，别把细节漏给渲染器。
            LeaseError::NotPublished { artifact_id } => AssetError::BadRequest {
                why: format!("产物 {artifact_id} 没有可读的落点"),
            },
            LeaseError::UnsupportedMime { artifact_id, mime } => AssetError::BadRequest {
                why: format!("产物 {artifact_id} 的类型 {mime} 不该由渲染器取"),
            },
            LeaseError::BudgetFull { limit } => AssetError::BadRequest {
                why: format!("租借表已满（{limit}）"),
            },
        }
    }
}

/// 从 URI 里取出唯一那个 leaseId。
///
/// 形状卡死成 `yomika-image://asset/{32 位小写十六进制}`：多一段、带查询串、带片段、
/// 大小写混用、百分号编码，一律不收。宽松解析在这里没有任何好处——我们自己拼 URL，
/// 严格只会让「有人往这个 scheme 上塞东西」变成一条明确的 400。
///
/// 唯一被允许的「多一段」是 Windows/Android 上的 `localhost/`：那边 `lease_url` 发出去的是
/// `http://yomika-image.localhost/asset/{id}`，wry 把前缀换回来之后处理器看到的是
/// `yomika-image://localhost/asset/{id}`（`localhost` 落在 host 位上）。这一段要么没有
/// （macOS/Linux/iOS 的原生 scheme 处理器原样送 `yomika-image://asset/{id}`），要么正好是
/// `localhost`——`localhostfoo` 之类一样不收。
pub fn parse_lease_id(uri: &str) -> Result<String, AssetError> {
    let Some(rest) = uri.strip_prefix(&format!("{SCHEME}://")) else {
        return Err(AssetError::BadRequest {
            why: format!("不是 {SCHEME} 协议：{uri}"),
        });
    };
    let rest = rest.strip_prefix("localhost/").unwrap_or(rest);
    let Some(rest) = rest.strip_prefix(&format!("{HOST}/")) else {
        return Err(AssetError::BadRequest {
            why: format!("只认 {HOST}/ 下的东西：{uri}"),
        });
    };
    if rest.contains(['?', '#', '/', '%']) {
        return Err(AssetError::BadRequest {
            why: "取图地址里不该有查询串、片段或者更深的路径".to_string(),
        });
    }
    let is_hex = rest.len() == super::leases::LEASE_ID_HEX_BYTES
        && rest
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if !is_hex {
        return Err(AssetError::BadRequest {
            why: "使用凭据必须是 32 位小写十六进制".to_string(),
        });
    }
    Ok(rest.to_string())
}

/// 把 Range 头解析成**单段**且落在文件里的字节区间（闭区间）。
///
/// 三种合法写法：`bytes=a-b`、`bytes=a-`、`bytes=-n`。多段（带逗号）不收：多段要回
/// `multipart/byteranges`，而我们唯一的使用者是自己的阅读器，它只做从某个偏移开始读的
/// 单段请求。宁可明确 416，也不要回一个我们自己都没测过的多段响应。
pub fn parse_range(header: &str, total: u64) -> Result<(u64, u64), AssetError> {
    let unsatisfiable = |requested: &str| AssetError::Unsatisfiable {
        total,
        requested: requested.to_string(),
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        // 别的单位按 RFC 应该忽略，但我们没有别的单位，直接说不支持。
        return Err(unsatisfiable(header.trim()));
    };
    if spec.contains(',') {
        return Err(unsatisfiable(spec));
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Err(unsatisfiable(spec));
    };
    let (start, end) = if first.is_empty() {
        // `bytes=-n`：最后 n 个字节。
        let Ok(suffix) = last.trim().parse::<u64>() else {
            return Err(unsatisfiable(spec));
        };
        if suffix == 0 {
            return Err(unsatisfiable(spec));
        }
        (total.saturating_sub(suffix), total.saturating_sub(1))
    } else {
        let Ok(start) = first.trim().parse::<u64>() else {
            return Err(unsatisfiable(spec));
        };
        let end = if last.trim().is_empty() {
            total.saturating_sub(1)
        } else {
            let Ok(end) = last.trim().parse::<u64>() else {
                return Err(unsatisfiable(spec));
            };
            end
        };
        (start, end)
    };
    if total == 0 || start >= total || start > end {
        return Err(unsatisfiable(spec));
    }
    Ok((start, end.min(total - 1)))
}

/// 把一次请求翻译成「回什么状态、读哪一段字节」。
///
/// 传进去的 `now` 让过期判断不依赖真实时钟，测试里一步就能跨过 TTL。
#[cfg(test)]
pub fn plan(
    request: &AssetRequest,
    store: &LeaseStore,
    now: Instant,
) -> Result<AssetReply, AssetError> {
    plan_file(request, store, now).map(|(reply, _)| reply)
}

fn plan_file(
    request: &AssetRequest,
    store: &LeaseStore,
    now: Instant,
) -> Result<(AssetReply, Option<ReaderFile>), AssetError> {
    let lease_id = parse_lease_id(&request.uri)?;
    let (view, file) = store.view_with_file(&lease_id, &request.webview_label, now)?;
    // 租借表里的类型在开租借时已经过白名单，这里再查一次：这一层是渲染器的门口，
    // 门口的规则应该自己站得住，而不是「上面那层查过了」。
    if !is_allowed_image_mime(&view.mime) {
        return Err(AssetError::BadRequest {
            why: format!("类型 {} 不在白名单里", view.mime),
        });
    }
    let total = view.byte_length;
    if request.method == AssetMethod::Head {
        return Ok((AssetReply {
            status: STATUS_OK,
            mime: view.mime,
            content_length: total,
            content_range: None,
            body: AssetBody::Empty,
        }, file));
    }
    let Some(header) = request.range.as_deref() else {
        return Ok((AssetReply {
            status: STATUS_OK,
            mime: view.mime,
            content_length: total,
            content_range: None,
            body: AssetBody::Full(view.path),
        }, file));
    };
    let (start, end) = parse_range(header, total)?;
    Ok((AssetReply {
        status: STATUS_PARTIAL,
        mime: view.mime,
        content_length: end - start + 1,
        content_range: Some(format!("bytes {start}-{end}/{total}")),
        body: AssetBody::Range {
            path: view.path,
            start,
            length: end - start + 1,
        },
    }, file))
}

// ---------------------------------------------------------------------------
// Tauri 接线
//
// 这一段是唯一碰 WebView 的地方，也是唯一测不到的地方（要真窗口才能发请求）。所以它
// 被压到最短：把请求的三样东西取出来 → 交给上面的纯逻辑 → 按计划读文件拼响应。
// 所有判断都在 `plan` 里，这里没有一个 `if` 是安全相关的。
// ---------------------------------------------------------------------------

/// `yomika-image` 的处理器。
///
/// 它跑在 WebView 的消息线程上，所以**立刻**把活交给一个新线程：读一份几十 MB 的图
/// 不能让窗口停住，这正是整条 URL 通道存在的理由。
pub fn serve<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let webview_label = ctx.webview_label().to_string();
    let app = ctx.app_handle().clone();
    let method = request.method().as_str().to_ascii_uppercase();
    let uri = request.uri().to_string();
    let range = request
        .headers()
        .get(tauri::http::header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    std::thread::spawn(move || {
        let reply = build_response(&app, &webview_label, &method, &uri, range.as_deref());
        responder.respond(reply);
    });
}

fn build_response<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    webview_label: &str,
    method: &str,
    uri: &str,
    range: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;

    let method = match method {
        "GET" => AssetMethod::Get,
        "HEAD" => AssetMethod::Head,
        _ => {
            return error_response(
                STATUS_METHOD_NOT_ALLOWED,
                "取图只支持 GET 与 HEAD",
                None,
            )
        }
    };
    let Some(handle) = app.try_state::<crate::compute::ComputeHandle>() else {
        return error_response(STATUS_INTERNAL, "计算编排没起来", None);
    };
    let request = AssetRequest {
        method,
        uri: uri.to_string(),
        webview_label: webview_label.to_string(),
        range: range.map(str::to_string),
    };
    match plan_file(&request, handle.leases(), Instant::now()) {
        Ok((reply, file)) => materialize(reply, method, file),
        Err(error) => {
            let content_range = match &error {
                // 416 要告诉客户端文件到底多大，否则它没法重试。
                AssetError::Unsatisfiable { total, .. } => Some(format!("bytes */{total}")),
                _ => None,
            };
            error_response(error.status(), &error.message(), content_range)
        }
    }
}

/// 按计划把字节读出来。读失败是 500：文件可能刚好被清缓存删掉，那不是请求的错。
fn materialize(reply: AssetReply, method: AssetMethod, file: Option<ReaderFile>) -> tauri::http::Response<Vec<u8>> {
    let bytes = match (&reply.body, method) {
        (_, AssetMethod::Head) => Vec::new(),
        (AssetBody::Empty, _) => Vec::new(),
        (AssetBody::Full(path), _) => match read_range(path, file.as_ref(), 0, reply.content_length) {
            Ok(bytes) => bytes,
            Err(error) => {
                return error_response(STATUS_INTERNAL, &format!("读产物失败：{error}"), None)
            }
        },
        (AssetBody::Range { path, start, length }, _) => match read_range(path, file.as_ref(), *start, *length) {
            Ok(bytes) => bytes,
            Err(error) => {
                return error_response(STATUS_INTERNAL, &format!("读产物失败：{error}"), None)
            }
        },
    };
    let mut builder = tauri::http::Response::builder()
        .status(reply.status)
        .header(tauri::http::header::CONTENT_TYPE, &reply.mime)
        .header(tauri::http::header::CONTENT_LENGTH, reply.content_length)
        .header("X-Content-Type-Options", "nosniff")
        .header("Accept-Ranges", "bytes");
    if let Some(content_range) = &reply.content_range {
        builder = builder.header(tauri::http::header::CONTENT_RANGE, content_range);
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| error_response(STATUS_INTERNAL, "响应拼不出来", None))
}

fn read_range(path: &std::path::Path, file: Option<&ReaderFile>, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    if let Some(file) = file {
        let mut file = file.lock().map_err(|_| std::io::Error::other("Reader file unavailable"))?;
        return read_file_range(&mut file, start, length);
    }
    read_file_range(&mut std::fs::File::open(path)?, start, length)
}

fn read_file_range(file: &mut std::fs::File, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(start))?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn error_response(
    status: u16,
    message: &str,
    content_range: Option<String>,
) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(content_range) = content_range {
        builder = builder.header(tauri::http::header::CONTENT_RANGE, content_range);
    }
    builder
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::leases::{LeaseSpec, LeaseStore};
    use std::path::PathBuf;
    use std::time::Duration;

    const TOTAL: u64 = 4096;

    fn store_with_lease() -> (LeaseStore, String) {
        let store = LeaseStore::new();
        let acquired = store
            .acquire(
                LeaseSpec {
                    artifact_id: "art-1".to_string(),
                    job_id: "job-1".to_string(),
                    path: PathBuf::from("C:\\data\\cache\\images\\ab\\ab.bin"),
                    cache_relative: Some("cache/images/ab/ab.bin".to_string()),
                    mime: "image/png".to_string(),
                    byte_length: TOTAL,
                    width: 64,
                    height: 32,
                    pipeline_revision: "worker-v1:abc".to_string(),
                    webview_label: "main".to_string(),
                },
                Instant::now(),
            )
            .expect("开一张租借");
        (store, acquired.lease.lease_id)
    }

    fn request(lease_id: &str) -> AssetRequest {
        AssetRequest {
            method: AssetMethod::Get,
            uri: format!("{SCHEME}://{HOST}/{lease_id}"),
            webview_label: "main".to_string(),
            range: None,
        }
    }

    #[test]
    fn a_plain_request_gets_the_whole_file() {
        let (store, lease_id) = store_with_lease();
        let reply = plan(&request(&lease_id), &store, Instant::now()).expect("应该给整份");
        assert_eq!(reply.status, STATUS_OK);
        assert_eq!(reply.mime, "image/png");
        assert_eq!(reply.content_length, TOTAL);
        assert_eq!(reply.content_range, None);
        assert_eq!(
            reply.body,
            AssetBody::Full(PathBuf::from("C:\\data\\cache\\images\\ab\\ab.bin"))
        );
    }

    #[test]
    fn a_head_answers_the_size_without_bytes() {
        let (store, lease_id) = store_with_lease();
        let mut head = request(&lease_id);
        head.method = AssetMethod::Head;
        let reply = plan(&head, &store, Instant::now()).expect("HEAD 也要能答");
        assert_eq!(reply.status, STATUS_OK);
        assert_eq!(reply.content_length, TOTAL);
        assert_eq!(reply.body, AssetBody::Empty);
    }

    #[test]
    fn a_single_range_asks_for_exactly_those_bytes() {
        let (store, lease_id) = store_with_lease();
        let mut ranged = request(&lease_id);
        ranged.range = Some("bytes=100-199".to_string());
        let reply = plan(&ranged, &store, Instant::now()).expect("单段 Range 应该给 206");
        assert_eq!(reply.status, STATUS_PARTIAL);
        assert_eq!(reply.content_length, 100);
        assert_eq!(reply.content_range.as_deref(), Some("bytes 100-199/4096"));
        assert_eq!(
            reply.body,
            AssetBody::Range {
                path: PathBuf::from("C:\\data\\cache\\images\\ab\\ab.bin"),
                start: 100,
                length: 100
            }
        );
    }

    #[test]
    fn an_open_ended_range_runs_to_the_end_of_the_file() {
        let (store, lease_id) = store_with_lease();
        let mut ranged = request(&lease_id);
        ranged.range = Some("bytes=4000-".to_string());
        let reply = plan(&ranged, &store, Instant::now()).expect("到文件尾");
        assert_eq!(reply.status, STATUS_PARTIAL);
        assert_eq!(reply.content_length, 96);
        assert_eq!(reply.content_range.as_deref(), Some("bytes 4000-4095/4096"));
    }

    #[test]
    fn a_suffix_range_names_the_last_bytes() {
        let (store, lease_id) = store_with_lease();
        let mut ranged = request(&lease_id);
        ranged.range = Some("bytes=-100".to_string());
        let reply = plan(&ranged, &store, Instant::now()).expect("最后 100 字节");
        assert_eq!(reply.status, STATUS_PARTIAL);
        assert_eq!(reply.content_length, 100);
        assert_eq!(reply.content_range.as_deref(), Some("bytes 3996-4095/4096"));
    }

    #[test]
    fn a_range_that_cannot_be_satisfied_is_refused_with_the_size() {
        let (store, lease_id) = store_with_lease();
        for header in [
            "bytes=4096-",
            "bytes=5000-6000",
            "bytes=200-100",
            "bytes=abc-def",
            "bytes=0-1,2-3",
            "bytes=-0",
            "items=0-10",
        ] {
            let mut ranged = request(&lease_id);
            ranged.range = Some(header.to_string());
            let error = plan(&ranged, &store, Instant::now()).expect_err(header);
            assert_eq!(error.status(), STATUS_RANGE_NOT_SATISFIABLE, "{header}");
            match error {
                AssetError::Unsatisfiable { total, .. } => assert_eq!(total, TOTAL),
                other => panic!("{header} 应该是 416，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn only_the_lease_id_can_be_asked_for() {
        let (store, _) = store_with_lease();
        let now = Instant::now();
        for uri in [
            "https://example.invalid/asset/0123456789abcdef0123456789abcdef",
            "yomika-image://other/0123456789abcdef0123456789abcdef",
            "yomika-image://asset/",
            "yomika-image://asset/0123456789abcdef0123456789abcdef/extra",
            "yomika-image://asset/0123456789abcdef0123456789abcdef?path=C:\\secret",
            "yomika-image://asset/0123456789abcdef0123456789abcdef#frag",
            "yomika-image://asset/0123456789abcdef0123456789abcde%66",
            "yomika-image://asset/0123456789ABCDEF0123456789ABCDEF",
            "yomika-image://asset/0123456789abcdef0123456789abcde",
            "yomika-image://asset/..%2f..%2fsecret",
        ] {
            let mut bad = request("x");
            bad.uri = uri.to_string();
            let error = plan(&bad, &store, now).expect_err(uri);
            assert_eq!(error.status(), STATUS_BAD_REQUEST, "{uri} 应该被拒");
        }
    }

    #[test]
    fn the_windows_work_around_uri_reaches_the_same_lease() {
        // Windows/Android：wry 把 `http://yomika-image.localhost/asset/{id}` 换回
        // `yomika-image://localhost/asset/{id}` 才交给处理器。形状上多一段 host，
        // 取出来必须是同一张租借；别的多法一律不收。
        let (store, lease_id) = store_with_lease();
        let now = Instant::now();
        let helper = format!("{SCHEME}://localhost/{HOST}/{lease_id}");
        assert_eq!(parse_lease_id(&helper), Ok(lease_id.clone()));

        let mut windows = request(&lease_id);
        windows.uri = helper.clone();
        let reply = plan(&windows, &store, now).expect("Windows 那段 localhost 不该被拒");
        assert_eq!(reply.status, STATUS_OK);

        for bad in [
            format!("{SCHEME}://localhost/other/{lease_id}"),
            format!("{SCHEME}://localhostfoo/{HOST}/{lease_id}"),
            format!("{SCHEME}://localhost/"),
            format!("{SCHEME}://localhost/{HOST}/{lease_id}/extra"),
            format!("{SCHEME}://localhost/{HOST}/0123456789ABCDEF0123456789ABCDEF"),
        ] {
            assert!(parse_lease_id(&bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn a_released_lease_is_not_found() {
        let (store, lease_id) = store_with_lease();
        assert!(store.release(&lease_id).is_some());
        let error = plan(&request(&lease_id), &store, Instant::now()).expect_err("放掉之后不该还能取");
        assert_eq!(error.status(), STATUS_NOT_FOUND);
    }

    #[test]
    fn an_expired_lease_is_gone() {
        let store = LeaseStore::with_limits(Duration::from_secs(5), 4);
        let start = Instant::now();
        let acquired = store
            .acquire(
                LeaseSpec {
                    artifact_id: "art-1".to_string(),
                    job_id: "job-1".to_string(),
                    path: PathBuf::from("C:\\data\\cache\\images\\ab\\ab.bin"),
                    cache_relative: Some("cache/images/ab/ab.bin".to_string()),
                    mime: "image/png".to_string(),
                    byte_length: TOTAL,
                    width: 64,
                    height: 32,
                    pipeline_revision: "worker-v1:abc".to_string(),
                    webview_label: "main".to_string(),
                },
                start,
            )
            .expect("开一张租借");
        let error = plan(
            &request(&acquired.lease.lease_id),
            &store,
            start + Duration::from_secs(6),
        )
        .expect_err("过期之后不该还能取");
        assert_eq!(error.status(), STATUS_GONE);
    }

    #[test]
    fn another_windows_lease_is_forbidden() {
        let (store, lease_id) = store_with_lease();
        let mut other = request(&lease_id);
        other.webview_label = "second-window".to_string();
        let error = plan(&other, &store, Instant::now()).expect_err("别的窗口不该能取");
        assert_eq!(error.status(), STATUS_FORBIDDEN);
    }
}
