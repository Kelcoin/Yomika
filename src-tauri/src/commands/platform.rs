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

fn secure_storage_available() -> bool {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", target_os = "android", target_os = "ios"))]
    { return true; }
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
