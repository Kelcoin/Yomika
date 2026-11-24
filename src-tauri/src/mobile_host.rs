//! 移动端的原生宿主：Kotlin 侧那个 `app.yomika.reader.MobileHost` 插件。
//!
//! 两件事只有原生侧做得到：
//!
//! 1. **登录页**。Android 上应用自己的 webview 就是 activity 的内容视图
//!    （wry 建 webview 时对它调 `setContentView`），所以「另开一个窗口」会把应用自己的
//!    界面顶掉，而「顶层导航走」等于把整个应用换掉——两条路都试过，两条都闪退。原生侧
//!    可以往内容视图**上面**再叠一层 WebView：应用原样在下面活着，登录页只是一层浮层，
//!    这也是 JHenTai 的做法（它把 WebView 当控件放进自己的页面）。
//! 2. **写文件**。`dialog.save` 在 Android 上给回来的是 SAF 的 `content://` URI，
//!    `std::fs` 写不了它，得用 ContentResolver。
//!
//! 注册（`register_android_plugin`）失败不算致命：把状态留空，用到它的命令如实报
//! 「原生宿主不可用」，界面照常跑——装不上的功能不该把应用一起带走。

use std::sync::Mutex;

use serde_json::json;
use tauri::plugin::{PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

/// Kotlin 插件类：包名 + 类名（`find_class` 会走 `Class.forName`）。
const HOST_PACKAGE: &str = "app.yomika.reader";
const HOST_CLASS: &str = "MobileHost";
/// Rust 侧的插件名：Kotlin 按这个名字找到插件实例派发命令。
const HOST_PLUGIN: &str = "mobile_host";

/// 宿主句柄。注册在 `setup` 里做一次，命令随时来取。
#[derive(Default)]
pub struct MobileHostState(Mutex<Option<PluginHandle<Wry>>>);

impl MobileHostState {
    fn take(&self) -> Option<PluginHandle<Wry>> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new(HOST_PLUGIN)
        .setup(|app, api| {
            let state = match api.register_android_plugin(HOST_PACKAGE, HOST_CLASS) {
                Ok(handle) => {
                    MobileHostState(Mutex::new(Some(handle)))
                }
                Err(error) => {
                    crate::error_log::record_step(
                        app,
                        "core/mobile-host",
                        &format!("原生宿主注册失败：{error}"),
                    );
                    MobileHostState::default()
                }
            };
            app.manage(state);
            Ok(())
        })
        .build()
}

fn handle(app: &AppHandle) -> Option<PluginHandle<Wry>> {
    app.try_state::<MobileHostState>()?.take()
}

/// 没法干活的统一答复：命令照常返回失败，界面上是一句人话。
fn unavailable() -> String {
    String::from("当前平台没有原生宿主")
}

/// 一次原生登录面板的轮询结果：`cookie` 是刚看到的 Cookie 头（三个域拼起来的原文），
/// `open` 表示面板还在。筛不筛得出会话由调用方决定——那条规则只有一处（Rust）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    #[serde(default)]
    pub cookie: Option<String>,
    #[serde(default)]
    pub open: bool,
}

async fn call<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    payload: serde_json::Value,
) -> Result<T, String> {
    let handle = handle(app).ok_or_else(unavailable)?;
    handle
        .run_mobile_plugin_async::<T>(command, payload)
        .await
        .map_err(|error| error.to_string())
}

/// Security bridge stays native; it never exposes password material to Kotlin.
pub async fn security_call<T: serde::de::DeserializeOwned>(
    app: &AppHandle, command: &str, payload: serde_json::Value,
) -> Result<T, String> { call(app, command, payload).await }

pub(crate) async fn prepare_reader_slot(
    app: &AppHandle,
    file: crate::compute::leases::ReaderFile,
    right_file: Option<crate::compute::leases::ReaderFile>,
    aspect: f32,
    slot: i32,
    page: i32,
    session: u32,
) -> Result<bool, String> {
    use std::os::fd::AsRawFd;

    let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    let files = [Some(file.clone()), right_file.clone()];
    let animations = tokio::task::spawn_blocking(move || {
        files.map(|source| -> Result<Option<std::fs::File>, ()> {
            let Some(source) = source else { return Ok(None); };
            let file = source.lock().map_err(|_| ())?;
            crate::native_reader::animation::Animation::prepare_apng(&file, &cache)
        })
    }).await.map_err(|error| error.to_string())?;
    let [Ok(left_animation), Ok(right_animation)] = animations else { return Ok(false); };
    let fd = file.lock().map_err(|_| "Reader file unavailable")?.as_raw_fd();
    let right_fd = match &right_file {
        Some(file) => file.lock().map_err(|_| "Reader file unavailable")?.as_raw_fd(),
        None => -1,
    };
    // Keep the file alive until Kotlin opens its independently owned descriptor.
    #[derive(serde::Deserialize)]
    struct PreparedSlot { prepared: bool }
    let prepared = call::<PreparedSlot>(app, "prepareReaderSlot", json!({
        "fd": fd, "rightFd": right_fd,
        "animationFd": left_animation.as_ref().map_or(-1, AsRawFd::as_raw_fd),
        "rightAnimationFd": right_animation.as_ref().map_or(-1, AsRawFd::as_raw_fd),
        "aspect": aspect, "slot": slot, "page": page, "session": session,
    }))
        .await.is_ok_and(|result| result.prepared);
    drop((file, right_file, left_animation, right_animation));
    Ok(prepared)
}

pub async fn login_open(app: &AppHandle, url: &str, user_agent: &str) -> Result<(), String> {
    call::<serde_json::Value>(app, "ehLoginOpen", json!({ "url": url, "userAgent": user_agent }))
        .await
        .map(|_| ())
}

pub async fn login_poll(app: &AppHandle) -> Result<LoginPoll, String> {
    call::<LoginPoll>(app, "ehLoginPoll", json!({})).await
}

pub async fn login_close(app: &AppHandle) -> Result<(), String> {
    call::<serde_json::Value>(app, "ehLoginClose", json!({}))
        .await
        .map(|_| ())
}

/// 通过 SAF 的 `content://` URI（或普通路径）写一份文本。
pub async fn write_text_file(app: &AppHandle, path: &str, contents: &str) -> Result<(), String> {
    call::<serde_json::Value>(
        app,
        "writeTextFile",
        json!({ "path": path, "contents": contents }),
    )
    .await
    .map(|_| ())
}

pub async fn pick_download_directory(app: &AppHandle) -> Result<Option<String>, String> {
    #[derive(serde::Deserialize)]
    struct PickerReply { path: Option<String> }
    call::<PickerReply>(app, "pickDownloadDirectory", json!({})).await.map(|reply| reply.path)
}

pub async fn copy_archive_to_download_directory(app: &AppHandle, directory: &str, path: &str) -> Result<(), String> {
    call::<serde_json::Value>(app, "copyArchiveToDownloadDirectory", json!({ "directory": directory, "path": path }))
        .await.map(|_| ())
}

pub async fn show_toast(app: &AppHandle, text: &str) -> Result<bool, String> {
    #[derive(serde::Deserialize)]
    struct ToastResult {
        shown: bool,
    }
    call::<ToastResult>(app, "showToast", json!({ "text": text }))
        .await
        .map(|result| result.shown)
}

pub async fn write_clipboard_text(app: &AppHandle, text: &str) -> Result<(), String> {
    call::<serde_json::Value>(app, "writeClipboardText", json!({ "text": text }))
        .await.map(|_| ())
}

/// 通过 SAF 的 `content://` URI（或普通路径）读一份文本。
pub async fn read_text_file(app: &AppHandle, path: &str) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct ReadReply {
        #[serde(default)]
        contents: String,
    }
    call::<ReadReply>(app, "readTextFile", json!({ "path": path }))
        .await
        .map(|reply| reply.contents)
}

/// 用系统浏览器打开链接：Android 上只有 `Intent.ACTION_VIEW` 这一条路，而它要原生代码。
pub async fn open_external_url(app: &AppHandle, url: &str) -> Result<(), String> {
    call::<serde_json::Value>(app, "openExternalUrl", json!({ "url": url }))
        .await
        .map(|_| ())
}

/// 系统栏（状态栏 / 手势条）占掉的高度，CSS 像素，与页面 1:1。类型归 `platform` 那个
/// 命令所有（前端两边共用一个形状），这里只是把它从原生侧读回来。
pub type SystemInsets = crate::commands::platform::SystemInsets;

/// 状态栏/导航栏把页面推到哪儿了。应用是边到边的（内容画到屏幕边缘），所以这个高度得由
/// 页面自己避开——Android 的 WebView 不会把系统栏高度交给 `env(safe-area-inset-*)`。
pub async fn system_insets(app: &AppHandle) -> Result<SystemInsets, String> {
    call::<SystemInsets>(app, "insets", json!({})).await
}

/// 系统栏图标的明暗跟着应用主题走：浅色主题下用深色图标，否则图标和背景糊在一起。
pub async fn set_system_bar_style(app: &AppHandle, dark: bool) -> Result<(), String> {
    call::<serde_json::Value>(app, "setSystemBarStyle", json!({ "dark": dark }))
        .await
        .map(|_| ())
}

pub async fn set_status_bar_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    call::<serde_json::Value>(app, "setStatusBarVisible", json!({ "visible": visible }))
        .await.map(|_| ())
}

pub async fn set_reader_keyboard_overlay(app: &AppHandle, enabled: bool) -> Result<(), String> {
    call::<serde_json::Value>(app, "setReaderKeyboardOverlay", json!({ "enabled": enabled }))
        .await
        .map(|_| ())
}

/// 触感反馈：长按这类「按住了」的确认。档位（`light` / `medium` / `heavy` / `selection`）
/// 由原生侧映射到系统预置的振动效果；设备没有马达时原生侧安静收场，这里照样成功。
pub async fn vibrate(app: &AppHandle, kind: &str) -> Result<(), String> {
    call::<serde_json::Value>(app, "vibrate", json!({ "kind": kind }))
        .await
        .map(|_| ())
}
