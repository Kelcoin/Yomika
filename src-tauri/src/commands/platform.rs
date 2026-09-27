use serde::Serialize;

use crate::domain::result::CommandResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    platform: &'static str,
    native: bool,
    secure_storage: bool,
    file_system: bool,
    background_tasks: bool,
    native_inference: bool,
}

#[tauri::command]
pub fn platform_capabilities() -> CommandResult<PlatformCapabilities> {
    CommandResult::success(PlatformCapabilities {
        platform: current_platform(),
        native: true,
        secure_storage: secure_storage_available(),
        file_system: true,
        background_tasks: false,
        native_inference: true,
    })
}

/** The webview's own clipboard API makes WebView2 ask the user for clipboard
 * permission on every write; the native side writes without any prompt, so
 * text exports (cookies, archive ids, migration JSON) go through here. */
#[tauri::command]
pub fn write_clipboard_text(text: String) -> CommandResult<()> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = text;
        return CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            "Native clipboard is not available on this platform",
            false,
        );
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(clipboard) => clipboard,
            Err(error) => return CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false),
        };
        match clipboard.set_text(text) {
            Ok(()) => CommandResult::success(()),
            Err(error) => CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), false),
        }
    }
}

/// 用系统浏览器打开一个网页链接。
///
/// 桌面各平台都有现成的命令行工具；**Android 只有 Intent 一条路**（`ACTION_VIEW`），
/// 而那要原生代码——手机上的「打不开外部链接」就是这条分支曾经直接报
/// `PLATFORM_UNAVAILABLE`（文档链接、来源链接、仓库地址全点不动）。现在借 `mobile_host`
/// 那个原生宿主把它送出去。
/// 系统栏（状态栏 / 手势条）占掉的高度，CSS 像素，与页面 1:1。
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize)]
pub struct SystemInsets {
    #[serde(default)]
    pub top: i32,
    #[serde(default)]
    pub bottom: i32,
}

/// 系统栏把页面推到哪儿了。
///
/// 应用在 Android 上是**边到边**的（内容画到屏幕边缘，见 `MainActivity` 的注释），
/// 而 WebView 不会把状态栏高度交给 `env(safe-area-inset-*)`——那个只给刘海。所以高度由
/// 原生侧量好交给页面（`--safe-top` / `--safe-bottom`），页面自己避开。桌面窗口没有系统
/// 栏叠在页面上，一律 0。
#[tauri::command]
pub async fn system_insets(app: tauri::AppHandle) -> CommandResult<SystemInsets> {
    #[cfg(target_os = "android")]
    {
        match crate::mobile_host::system_insets(&app).await {
            Ok(insets) => CommandResult::success(insets),
            Err(message) => CommandResult::failure("PLATFORM_UNAVAILABLE", message, true),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        CommandResult::success(SystemInsets { top: 0, bottom: 0 })
    }
}

/// 系统栏图标的明暗：跟着**应用主题**走，而不是跟着系统主题走——应用可以整体是深色的，
/// 而系统设成浅色，那时状态栏图标会是深色，落在深色背景上等于看不见（「状态栏很突兀」
/// 有一半是它）。其余平台没有这件事。
#[tauri::command]
pub async fn set_system_bar_style(app: tauri::AppHandle, dark: bool) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    {
        match crate::mobile_host::set_system_bar_style(&app, dark).await {
            Ok(()) => CommandResult::success(()),
            Err(message) => CommandResult::failure("PLATFORM_UNAVAILABLE", message, true),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, dark);
        CommandResult::success(())
    }
}

/// 只放 http/https 出去：别的 scheme 交给系统，等于把任意 Intent 交给页面。
fn parse_web_url(url: &str) -> Result<url::Url, CommandResult<()>> {
    match url::Url::parse(url) {
        Ok(value) if matches!(value.scheme(), "http" | "https") => Ok(value),
        _ => Err(CommandResult::failure(
            "INVALID_RESPONSE",
            "Only HTTP and HTTPS links can be opened",
            false,
        )),
    }
}

/// 首帧信号：index.html 的品牌帧画完（rAF 之后）由内联脚本调用。
/// 亮出主窗。移动端主窗由原生壳持有且始终可见，show 是无操作的。
#[tauri::command]
pub fn frontend_ready(app: tauri::AppHandle) -> CommandResult<()> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
    CommandResult::success(())
}

#[tauri::command]
pub async fn open_external_url(app: tauri::AppHandle, url: String) -> CommandResult<()> {
    let parsed = match parse_web_url(&url) {
        Ok(parsed) => parsed,
        Err(rejected) => return rejected,
    };

    #[cfg(target_os = "android")]
    let result = crate::mobile_host::open_external_url(&app, parsed.as_str()).await;
    // 桌面各平台用现成的命令行工具，用不到 AppHandle——只有 Android 那条路要它。
    #[cfg(not(target_os = "android"))]
    let _ = &app;
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(parsed.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    let result: Result<(), String> = Err(String::from(
        "External links are unsupported on this platform",
    ));

    match result {
        Ok(()) => CommandResult::success(()),
        Err(message) => CommandResult::failure("PLATFORM_UNAVAILABLE", message, true),
    }
}

/// 把一段文本写到用户选定的位置（导入导出的「导出为文件」走这里）。
///
/// Android 上 `dialog.save` 交回来的是 SAF 的 `content://` URI（系统的「新建文档」已经
/// 把文件建好了，零字节），`std::fs` 对它无能为力，得走原生那层 ContentResolver——
/// 与错误日志导出是同一条路，所以那段实现留在 `mobile_host` 里，两边共用。
#[tauri::command]
pub async fn save_text_file(
    app: tauri::AppHandle,
    path: String,
    contents: String,
) -> CommandResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return CommandResult::failure("INVALID_INPUT", "导出路径为空", false);
    }
    #[cfg(target_os = "android")]
    let written = crate::mobile_host::write_text_file(&app, trimmed, &contents).await;
    #[cfg(not(target_os = "android"))]
    let written = {
        let _ = &app;
        std::fs::write(trimmed, contents).map_err(|error| error.to_string())
    };
    match written {
        Ok(()) => CommandResult::success(trimmed.to_string()),
        Err(message) => CommandResult::failure("UNKNOWN", message, true),
    }
}

/// 读回用户选定的文本文件（「从文件导入」走这里）。Android 上同样是 SAF 的
/// `content://` URI，只有原生侧读得动。
#[tauri::command]
pub async fn read_text_file(app: tauri::AppHandle, path: String) -> CommandResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return CommandResult::failure("INVALID_INPUT", "文件路径为空", false);
    }
    #[cfg(target_os = "android")]
    let read = crate::mobile_host::read_text_file(&app, trimmed).await;
    #[cfg(not(target_os = "android"))]
    let read: Result<String, String> = {
        let _ = &app;
        // 导出的文件是 UTF-8；不是的话就直说（旧版导出的编码没法猜），由调用方去报
        // 「这不是本应用的导出」。
        match std::fs::read(trimmed) {
            Err(error) => Err(error.to_string()),
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| String::from("文件不是 UTF-8 文本")),
        }
    };
    match read {
        Ok(text) => CommandResult::success(text),
        Err(message) => CommandResult::failure("UNKNOWN", message, true),
    }
}

/// 在资源管理器里定位一个本机文件：文件夹打开且文件被选中。只有 Windows 有
/// 这个动作（调用方按平台藏按钮，这里再兜底拒绝）；路径必须真实存在。
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> CommandResult<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        return CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            "此动作仅在 Windows 上可用",
            false,
        );
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        if path.trim().is_empty() {
            return CommandResult::failure("INVALID_RESPONSE", "路径为空", false);
        }
        if !std::path::Path::new(&path).is_file() {
            return CommandResult::failure("INVALID_RESPONSE", "文件不存在或已被移动", false);
        }
        // `/select,"<path>"`：打开所在文件夹并选中该文件。整段作为一个参数交给
        // explorer 自己解析（路径里有空格也由引号护住）。
        let result = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn();
        match result {
            Ok(_) => CommandResult::success(()),
            Err(error) => CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), true),
        }
    }
}

fn secure_storage_available() -> bool {
    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android",
        target_os = "ios"
    ))]
    {
        return true;
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_reports_available_secure_storage_and_cpu_inference() {
        let result = platform_capabilities();
        match result {
            CommandResult::Success { value, .. } => {
                assert!(value.native);
                assert!(value.secure_storage);
                assert!(value.native_inference);
            }
            CommandResult::Failure { .. } => panic!("platform probe failed"),
        }
    }

    #[test]
    fn external_url_rejects_non_web_schemes() {
        assert!(parse_web_url("file:///tmp/private").is_err());
        assert!(parse_web_url("javascript:alert(1)").is_err());
        assert!(parse_web_url("intent://evil#Intent;scheme=http;end").is_err());
        assert!(parse_web_url("https://forums.e-hentai.org/index.php").is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_refuses_paths_that_are_not_real_files() {
        assert!(matches!(
            reveal_in_file_manager("".into()),
            CommandResult::Failure { .. }
        ));
        assert!(matches!(
            reveal_in_file_manager("E:\\definitely\\not\\here.zip".into()),
            CommandResult::Failure { .. }
        ));
    }
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "linux")]
    return "linux";
    #[cfg(target_os = "android")]
    return "android";
    #[cfg(target_os = "ios")]
    return "ios";
    #[allow(unreachable_code)]
    "browser"
}
