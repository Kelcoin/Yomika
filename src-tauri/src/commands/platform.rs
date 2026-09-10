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
