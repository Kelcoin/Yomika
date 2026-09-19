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

#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<()> {
    let parsed = match url::Url::parse(&url) {
        Ok(value) if matches!(value.scheme(), "http" | "https") => value,
        _ => {
            return CommandResult::failure(
                "INVALID_RESPONSE",
                "Only HTTP and HTTPS links can be opened",
                false,
            )
        }
    };

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(parsed.as_str())
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(parsed.as_str())
        .spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "External links are unsupported on this platform",
    ));

    match result {
        Ok(_) => CommandResult::success(()),
        Err(error) => CommandResult::failure("PLATFORM_UNAVAILABLE", error.to_string(), true),
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
        assert!(matches!(
            open_external_url("file:///tmp/private".into()),
            CommandResult::Failure { .. }
        ));
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
