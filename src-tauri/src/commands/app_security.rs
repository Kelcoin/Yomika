//! Local app privacy lock. Credentials are deliberately outside preferences/export storage.
use crate::domain::result::CommandResult;
use ring::{
    pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    num::NonZeroU32,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const ITERATIONS: u32 = 600_000;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    password: Option<Password>,
    #[serde(default)]
    biometric_enabled: bool,
    #[serde(default)]
    lock_on_background: bool,
    #[serde(default)]
    hide_preview: bool,
    #[serde(default)]
    failures: u32,
    #[serde(default)]
    blocked_until: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Password {
    salt: [u8; 16],
    digest: [u8; 32],
}
impl Password {
    fn new(password: &str) -> Result<Self, String> {
        if !(6..=1024).contains(&password.chars().count()) {
            return Err("密码需要 6–1024 个字符".into());
        }
        let mut result = Self {
            salt: [0; 16],
            digest: [0; 32],
        };
        SystemRandom::new()
            .fill(&mut result.salt)
            .map_err(|_| "无法生成安全随机数")?;
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(ITERATIONS).unwrap(),
            &result.salt,
            password.as_bytes(),
            &mut result.digest,
        );
        Ok(result)
    }
    fn verify(&self, password: &str) -> bool {
        password.len() <= 4096
            && pbkdf2::verify(
                pbkdf2::PBKDF2_HMAC_SHA256,
                NonZeroU32::new(ITERATIONS).unwrap(),
                &self.salt,
                password.as_bytes(),
                &self.digest,
            )
            .is_ok()
    }
}
struct Inner {
    config: Config,
    locked: bool,
    generation: u64,
}
pub struct AppSecurity {
    inner: Mutex<Inner>,
    path: PathBuf,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    supported: bool,
    locked: bool,
    password_enabled: bool,
    biometric_enabled: bool,
    lock_on_background: bool,
    hide_preview: bool,
    biometric_available: bool,
    biometric_label: &'static str,
    preview_protection_available: bool,
    platform_note: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecurityUpdate {
    password: Option<String>,
    current_password: Option<String>,
    biometric_enabled: Option<bool>,
    lock_on_background: Option<bool>,
    hide_preview: Option<bool>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
impl AppSecurity {
    fn save(&self, config: &Config) -> Result<(), String> {
        use std::io::Write;
        let parent = self.path.parent().ok_or("安全设置目录不可用")?;
        std::fs::create_dir_all(parent).map_err(|_| "无法创建安全设置目录")?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法保存安全设置")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "无法保护安全设置")?;
        }
        file.write_all(&serde_json::to_vec(config).map_err(|_| "无法编码安全设置")?)
            .map_err(|_| "无法保存安全设置")?;
        file.as_file().sync_all().map_err(|_| "无法保存安全设置")?;
        file.persist(&self.path).map_err(|_| "无法替换安全设置")?;
        Ok(())
    }
    fn configure(
        &self,
        inner: &mut Inner,
        config: SecurityUpdate,
        biometric_available: bool,
    ) -> Result<(Config, bool), String> {
        if inner.config.password.is_some() {
            self.authenticate(
                inner,
                config
                    .current_password
                    .as_deref()
                    .ok_or("更改安全设置需要当前密码")?,
            )?;
        }
        let mut next = inner.config.clone();
        if let Some(password) = config.password {
            next.password = if password.is_empty() {
                None
            } else {
                Some(Password::new(&password)?)
            };
        }
        if let Some(value) = config.biometric_enabled {
            if value && !biometric_available {
                return Err("当前设备没有可用的系统生物认证".into());
            }
            next.biometric_enabled = value;
        }
        if let Some(value) = config.lock_on_background {
            next.lock_on_background = value;
        }
        if let Some(value) = config.hide_preview {
            if value && !cfg!(any(windows, target_os = "android", target_os = "ios")) {
                return Err("当前平台不支持预览保护".into());
            }
            next.hide_preview = value;
        }
        if next.password.is_none() {
            next.biometric_enabled = false;
            next.lock_on_background = false;
        }
        let locked = inner.locked && next.password.is_some();
        self.save(&next)?;
        inner.config = next.clone();
        inner.locked = locked;
        inner.generation = inner.generation.wrapping_add(1);
        Ok((next, locked))
    }
    fn authenticate_request(
        &self,
        inner: &mut Inner,
        password: &str,
        generation: u64,
    ) -> Result<Config, String> {
        if inner.generation != generation {
            return Err("安全状态已更改，请重新认证".into());
        }
        self.authenticate(inner, password)?;
        // Platform acceptance and a second generation check must precede unlock.
        Ok(inner.config.clone())
    }
    fn authenticate(&self, inner: &mut Inner, password: &str) -> Result<(), String> {
        let time = now();
        if inner.config.blocked_until > time {
            return Err(format!(
                "请等待 {} 秒后再试",
                inner.config.blocked_until - time
            ));
        }
        if !inner
            .config
            .password
            .as_ref()
            .is_some_and(|stored| stored.verify(password))
        {
            inner.config.failures = inner.config.failures.saturating_add(1);
            let delay = if inner.config.failures < 3 {
                0
            } else {
                2u64 << inner.config.failures.saturating_sub(3).min(8)
            };
            inner.config.blocked_until = now() + delay;
            self.save(&inner.config)?;
            return Err("密码不正确".into());
        }
        inner.config.failures = 0;
        inner.config.blocked_until = 0;
        self.save(&inner.config)
    }
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "安全设置目录不可用")?
        .join("app-security.json");
    let config: Config = match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "本机安全设置损坏，无法安全启动")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(_) => return Err("无法读取本机安全设置".into()),
    };
    let locked = config.password.is_some();
    app.manage(AppSecurity {
        path,
        inner: Mutex::new(Inner {
            config,
            locked,
            generation: 0,
        }),
    });
    Ok(())
}
#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileStatus {
    locked: bool,
    biometric_available: bool,
    lock_generation: u64,
}
#[cfg(windows)]
static WINDOWS_AUTHENTICATING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(windows)]
struct WindowsAuthentication;
#[cfg(windows)]
impl WindowsAuthentication {
    fn begin() -> Result<Self, String> {
        WINDOWS_AUTHENTICATING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .map_err(|_| "系统认证正在进行")?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for WindowsAuthentication {
    fn drop(&mut self) {
        WINDOWS_AUTHENTICATING.store(false, std::sync::atomic::Ordering::Release);
    }
}
#[cfg(windows)]
async fn windows_hello_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        use windows::{
            Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability},
            Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        };
        if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() {
            return false;
        }
        let available = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.join())
            .is_ok_and(|result| result == UserConsentVerifierAvailability::Available);
        unsafe {
            RoUninitialize();
        }
        available
    })
    .await
    .unwrap_or(false)
}
#[cfg(windows)]
fn windows_hello_result(
    result: windows::Security::Credentials::UI::UserConsentVerificationResult,
) -> Result<(), String> {
    use windows::Security::Credentials::UI::UserConsentVerificationResult as Result;
    if result == Result::Verified {
        Ok(())
    } else {
        Err("Windows Hello 认证未完成，请重试或使用应用密码".into())
    }
}
#[cfg(windows)]
async fn windows_hello_authenticate(app: &AppHandle) -> Result<WindowsAuthentication, String> {
    use windows::{
        Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier},
        Win32::{
            Foundation::HWND, System::WinRT::IUserConsentVerifierInterop,
            UI::WindowsAndMessaging::GetForegroundWindow,
        },
    };
    let guard = WindowsAuthentication::begin()?;
    let hwnd = app
        .get_webview_window("main")
        .ok_or("主窗口不可用")?
        .hwnd()
        .map_err(|_| "主窗口不可用")?
        .0 as usize;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Desktop WinRT consent must be attached to our HWND; start on the owning UI thread.
    app.run_on_main_thread(move || {
        let operation = (|| -> windows::core::Result<windows_future::IAsyncOperation<UserConsentVerificationResult>> {
            let owner = HWND(hwnd as *mut std::ffi::c_void);
            if unsafe { GetForegroundWindow() } != owner { return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x800704C7u32 as i32))); }
            let interop: IUserConsentVerifierInterop = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
            unsafe { interop.RequestVerificationForWindowAsync(owner, &windows::core::HSTRING::from("解锁 Yomika")) }
        })();
        let _ = sender.send(operation);
    }).map_err(|_| "无法启动 Windows Hello")?;
    let operation = receiver
        .await
        .map_err(|_| "无法启动 Windows Hello")?
        .map_err(|_| "无法启动 Windows Hello")?;
    windows_hello_result(operation.await.map_err(|_| "Windows Hello 认证未完成")?)?;
    // The owner normally regains focus just after consent completes. Never unlock
    // an app which remains behind another application, even after a verified result.
    let foreground = tauri::async_runtime::spawn_blocking(move || {
        for _ in 0..10 {
            if unsafe { GetForegroundWindow() }.0 as usize == hwnd {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    })
    .await
    .map_err(|_| "无法确认窗口状态")?;
    if !foreground {
        return Err("应用已进入后台，请返回后重新认证".into());
    }
    Ok(guard)
}
async fn mobile_status(app: &AppHandle) -> Result<(bool, bool), String> {
    #[cfg(target_os = "android")]
    {
        let s: MobileStatus =
            crate::mobile_host::security_call(app, "securityStatus", serde_json::json!({})).await?;
        return Ok((s.locked, s.biometric_available));
    }
    #[cfg(windows)]
    {
        let _ = app;
        return Ok((false, windows_hello_available().await));
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        return Ok((
            crate::app_security_ios::locked(),
            crate::app_security_ios::available(),
        ));
    }
    #[cfg(not(any(windows, target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Ok((false, false))
    }
}
async fn platform_epoch(app: &AppHandle) -> Result<Option<u64>, String> {
    #[cfg(target_os = "android")]
    {
        let status: MobileStatus =
            crate::mobile_host::security_call(app, "securityStatus", serde_json::json!({})).await?;
        return Ok(Some(status.lock_generation));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}
fn complete_unlock(inner: &mut Inner, generation: u64) -> Result<(), String> {
    if inner.generation != generation {
        return Err("安全状态已更改，请重新认证".into());
    }
    inner.locked = false;
    inner.generation = inner.generation.wrapping_add(1);
    Ok(())
}
async fn apply_platform(app: &AppHandle, config: &Config, locked: bool) -> Result<(), String> {
    apply_platform_with_epoch(app, config, locked, None).await
}
async fn apply_platform_with_epoch(
    app: &AppHandle,
    config: &Config,
    locked: bool,
    expected_epoch: Option<u64>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_host::security_call::<serde_json::Value>(app, "securityConfigure", serde_json::json!({"passwordEnabled":config.password.is_some(),"lockOnBackground":config.lock_on_background,"hidePreview":config.hide_preview,"locked":locked,"expectedLockGeneration":expected_epoch.map(|epoch| epoch as i64).unwrap_or(-1)})).await?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = expected_epoch;
    #[cfg(windows)]
    {
        if locked {
            cover_webview(app, true);
        }
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_content_protected(config.hide_preview)
                .map_err(|_| "系统未能设置窗口预览保护")?;
        }
    }
    #[cfg(target_os = "ios")]
    crate::app_security_ios::configure(
        app,
        config.password.is_some(),
        config.lock_on_background,
        config.hide_preview,
        locked,
    )
    .await?;
    #[cfg(not(any(target_os = "android", target_os = "ios", windows)))]
    {
        let _ = (app, config, locked);
    }
    Ok(())
}
async fn status(app: &AppHandle, state: &AppSecurity) -> Result<SecurityStatus, String> {
    let (native_locked, biometric_available) = mobile_status(app).await?;
    let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
    if native_locked && inner.config.password.is_some() {
        inner.locked = true;
    }
    let config = &inner.config;
    Ok(SecurityStatus {
        supported: true,
        locked: inner.locked,
        password_enabled: config.password.is_some(),
        biometric_enabled: config.biometric_enabled,
        lock_on_background: config.lock_on_background,
        hide_preview: config.hide_preview,
        biometric_available,
        biometric_label: {
            #[cfg(target_os = "ios")]
            {
                crate::app_security_ios::biometric_label()
            }
            #[cfg(not(target_os = "ios"))]
            {
                if cfg!(windows) {
                    "Windows Hello"
                } else {
                    "生物认证"
                }
            }
        },
        preview_protection_available: cfg!(any(windows, target_os = "android", target_os = "ios")),
        platform_note: if cfg!(windows) {
            "Windows Hello 可使用系统配置的 PIN、指纹或人脸；窗口预览/捕获排除依赖系统支持，透明窗口或部分捕获工具可能不支持。"
        } else if cfg!(target_os = "ios") {
            "Face ID / Touch ID 使用系统认证；后台预览使用原生遮罩，系统截图不受此设置限制。"
        } else if cfg!(target_os = "android") {
            "预览保护使用 FLAG_SECURE，同时限制系统截图和录屏。"
        } else {
            "当前平台不支持系统生物认证及任务预览保护。"
        },
    })
}
async fn publish(app: &AppHandle, state: &AppSecurity) -> Result<SecurityStatus, String> {
    let result = status(app, state).await?;
    let _ = app.emit("app-security-changed", &result);
    Ok(result)
}
async fn app_security_status_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
) -> Result<SecurityStatus, String> {
    status(&app, &state).await
}
async fn app_security_configure_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
    config: SecurityUpdate,
) -> Result<SecurityStatus, String> {
    // CPU-intensive password derivation runs on Tauri's blocking pool, never the UI thread.
    let (_, biometric_available) = mobile_status(&app).await?;
    let task_app = app.clone();
    let (next, locked, previous, previous_locked, generation) =
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let state = task_app.state::<AppSecurity>();
            let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
            let previous_locked = inner.locked;
            let previous = inner.config.clone();
            let (next, locked) = state.configure(&mut inner, config, biometric_available)?;
            Ok((next, locked, previous, previous_locked, inner.generation))
        })
        .await
        .map_err(|_| "安全设置任务失败")??;
    if let Err(error) = apply_platform(&app, &next, locked).await {
        let rollback_app = app.clone();
        let restored = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
            let state = rollback_app.state::<AppSecurity>();
            let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
            if inner.generation != generation {
                return Ok(false);
            }
            state.save(&previous)?;
            inner.config = previous;
            inner.locked = previous_locked;
            inner.generation = inner.generation.wrapping_add(1);
            Ok(true)
        })
        .await
        .map_err(|_| "安全设置回退失败")??;
        if restored {
            let _ = restore_platform(&app).await;
            let _ = publish(&app, &state).await;
        }
        return Err(error);
    }
    publish(&app, &state).await
}
async fn app_security_unlock_password_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
    password: String,
) -> Result<SecurityStatus, String> {
    let generation = state.inner.lock().map_err(|_| "安全状态不可用")?.generation;
    let epoch = platform_epoch(&app).await?;
    let task_app = app.clone();
    let config = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let state = task_app.state::<AppSecurity>();
        let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
        state.authenticate_request(&mut inner, &password, generation)
    })
    .await
    .map_err(|_| "认证任务失败")??;
    if let Err(error) = apply_platform_with_epoch(&app, &config, false, epoch).await {
        let _ = restore_platform(&app).await;
        return Err(error);
    }
    let committed = {
        let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
        complete_unlock(&mut inner, generation)
    };
    if let Err(error) = committed {
        let _ = restore_platform(&app).await;
        return Err(error);
    }
    publish(&app, &state).await
}
async fn app_security_unlock_biometric_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
) -> Result<SecurityStatus, String> {
    let generation = {
        let inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
        if !inner.config.biometric_enabled || inner.config.password.is_none() {
            return Err("未启用生物认证".into());
        }
        if !inner.locked {
            return Err("当前应用未锁定".into());
        }
        inner.generation
    };
    let epoch = platform_epoch(&app).await?;
    #[cfg(target_os = "android")]
    crate::mobile_host::security_call::<serde_json::Value>(
        &app,
        "securityAuthenticate",
        serde_json::json!({}),
    )
    .await?;
    #[cfg(windows)]
    let authentication = windows_hello_authenticate(&app).await?;
    #[cfg(windows)]
    drop(authentication);
    #[cfg(target_os = "ios")]
    crate::app_security_ios::authenticate(&app).await?;
    #[cfg(not(any(windows, target_os = "android", target_os = "ios")))]
    {
        let _ = (app, generation, epoch);
        return Err("当前平台不支持系统生物认证".into());
    }
    #[cfg(any(windows, target_os = "android", target_os = "ios"))]
    {
        let config = {
            let inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
            if inner.generation != generation {
                return Err("安全状态已更改，请重新认证".into());
            }
            #[cfg(windows)]
            {
                let owner = app
                    .get_webview_window("main")
                    .ok_or("主窗口不可用")?
                    .hwnd()
                    .map_err(|_| "主窗口不可用")?;
                if unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }.0
                    != owner.0
                {
                    return Err("应用已进入后台，请返回后重新认证".into());
                }
            }
            inner.config.clone()
        };
        if let Err(error) = apply_platform_with_epoch(&app, &config, false, epoch).await {
            let _ = restore_platform(&app).await;
            return Err(error);
        }
        let committed = {
            let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
            complete_unlock(&mut inner, generation)
        };
        if let Err(error) = committed {
            let _ = restore_platform(&app).await;
            return Err(error);
        }
        publish(&app, &state).await
    }
}
#[cfg(windows)]
fn cover_webview(app: &AppHandle, covered: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(move |webview| unsafe {
            let _ = webview.controller().SetIsVisible(!covered);
        });
    }
}
pub fn background(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppSecurity>() {
        if let Ok(mut inner) = state.inner.lock() {
            if inner.config.lock_on_background && inner.config.password.is_some() {
                // The HWND-bound Hello modal takes focus from its already-locked
                // owner. Its OS result plus foreground check controls completion.
                #[cfg(windows)]
                if inner.locked && WINDOWS_AUTHENTICATING.load(std::sync::atomic::Ordering::Acquire)
                {
                    return;
                }
                inner.locked = true;
                inner.generation = inner.generation.wrapping_add(1);
                #[cfg(windows)]
                cover_webview(app, true);
                let _ = app.emit("app-security-lock", ());
            }
        }
    }
}
async fn app_security_lock_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
) -> Result<SecurityStatus, String> {
    let config = {
        let mut inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
        inner.locked = inner.config.password.is_some();
        inner.generation = inner.generation.wrapping_add(1);
        inner.config.clone()
    };
    apply_platform(&app, &config, config.password.is_some()).await?;
    publish(&app, &state).await
}
async fn app_security_background_impl(
    app: AppHandle,
    state: State<'_, AppSecurity>,
) -> Result<SecurityStatus, String> {
    background(&app);
    publish(&app, &state).await
}
async fn app_security_ready_impl(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    crate::mobile_host::security_call::<serde_json::Value>(
        &app,
        "securityReady",
        serde_json::json!({}),
    )
    .await?;
    #[cfg(target_os = "ios")]
    crate::app_security_ios::ready(&app).await?;
    #[cfg(windows)]
    cover_webview(&app, false);
    #[cfg(not(any(windows, target_os = "android", target_os = "ios")))]
    let _ = app;
    Ok(())
}
fn reply<T>(result: Result<T, String>) -> CommandResult<T> {
    match result {
        Ok(value) => CommandResult::success(value),
        Err(message) => CommandResult::failure("APP_SECURITY_AUTH", message, true),
    }
}
#[tauri::command]
pub async fn app_security_status(app: AppHandle) -> CommandResult<SecurityStatus> {
    reply(app_security_status_impl(app.clone(), app.state::<AppSecurity>()).await)
}
#[tauri::command]
pub async fn app_security_configure(
    app: AppHandle,
    config: SecurityUpdate,
) -> CommandResult<SecurityStatus> {
    reply(app_security_configure_impl(app.clone(), app.state::<AppSecurity>(), config).await)
}
#[tauri::command]
pub async fn app_security_unlock_password(
    app: AppHandle,
    password: String,
) -> CommandResult<SecurityStatus> {
    reply(
        app_security_unlock_password_impl(app.clone(), app.state::<AppSecurity>(), password).await,
    )
}
#[tauri::command]
pub async fn app_security_unlock_biometric(app: AppHandle) -> CommandResult<SecurityStatus> {
    reply(app_security_unlock_biometric_impl(app.clone(), app.state::<AppSecurity>()).await)
}
#[tauri::command]
pub async fn app_security_lock(app: AppHandle) -> CommandResult<SecurityStatus> {
    reply(app_security_lock_impl(app.clone(), app.state::<AppSecurity>()).await)
}
#[tauri::command]
pub async fn app_security_background(app: AppHandle) -> CommandResult<SecurityStatus> {
    reply(app_security_background_impl(app.clone(), app.state::<AppSecurity>()).await)
}
#[tauri::command]
pub async fn app_security_ready(app: AppHandle) -> CommandResult<()> {
    reply(app_security_ready_impl(app).await)
}
pub async fn restore_platform(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppSecurity>();
    let (config, locked) = {
        let inner = state.inner.lock().map_err(|_| "安全状态不可用")?;
        (inner.config.clone(), inner.locked)
    };
    apply_platform(app, &config, locked).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn windows_authentication_serializes_prompts_and_releases_on_cancel() {
        let first = WindowsAuthentication::begin().unwrap();
        assert!(WindowsAuthentication::begin().is_err());
        drop(first);
        let retry = WindowsAuthentication::begin().unwrap();
        drop(retry);
        assert!(!WINDOWS_AUTHENTICATING.load(std::sync::atomic::Ordering::Acquire));
    }
    #[cfg(windows)]
    #[test]
    fn windows_hello_only_verified_authenticates() {
        use windows::Security::Credentials::UI::UserConsentVerificationResult as Result;
        assert!(windows_hello_result(Result::Verified).is_ok());
        for result in [
            Result::Canceled,
            Result::DeviceBusy,
            Result::DeviceNotPresent,
            Result::DisabledByPolicy,
            Result::NotConfiguredForUser,
            Result::RetriesExhausted,
            Result(99),
        ] {
            assert!(windows_hello_result(result).is_err());
        }
    }
    #[test]
    fn commands_serialize_expected_envelope() {
        let success = serde_json::to_value(reply(Ok::<_, String>(()))).unwrap();
        assert_eq!(success["ok"], true);
        assert!(success["value"].is_null());
        let failure = serde_json::to_value(reply::<()>(Err("密码不正确".into()))).unwrap();
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["code"], "APP_SECURITY_AUTH");
    }
    #[test]
    fn passwords_are_salted_and_verified() {
        let a = Password::new("correct horse").unwrap();
        let b = Password::new("correct horse").unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.digest, b.digest);
        assert!(a.verify("correct horse"));
        assert!(!a.verify("incorrect horse"));
        assert!(Password::new("short").is_err());
    }
    #[test]
    fn failures_persist_and_block_even_correct_password() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppSecurity {
            path: dir.path().join("security.json"),
            inner: Mutex::new(Inner {
                config: Config::default(),
                locked: false,
                generation: 0,
            }),
        };
        let mut inner = Inner {
            config: Config {
                password: Some(Password::new("correct horse").unwrap()),
                ..Config::default()
            },
            locked: true,
            generation: 0,
        };
        for _ in 0..3 {
            assert!(state.authenticate(&mut inner, "wrong").is_err());
        }
        assert!(state.authenticate(&mut inner, "correct horse").is_err());
        let stored: Config = serde_json::from_slice(&std::fs::read(&state.path).unwrap()).unwrap();
        assert_eq!(stored.failures, 3);
        assert!(stored.blocked_until > now());
        inner.config.blocked_until = 0;
        state.authenticate(&mut inner, "correct horse").unwrap();
        assert_eq!(inner.config.failures, 0);
    }
    #[test]
    fn disabling_or_changing_settings_requires_current_password() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppSecurity {
            path: dir.path().join("security.json"),
            inner: Mutex::new(Inner {
                config: Config::default(),
                locked: false,
                generation: 0,
            }),
        };
        let mut inner = Inner {
            config: Config {
                password: Some(Password::new("correct horse").unwrap()),
                biometric_enabled: true,
                lock_on_background: true,
                ..Config::default()
            },
            locked: true,
            generation: 0,
        };
        let update = |current| SecurityUpdate {
            password: Some(String::new()),
            current_password: current,
            biometric_enabled: None,
            lock_on_background: None,
            hide_preview: None,
        };
        assert!(state.configure(&mut inner, update(None), true).is_err());
        assert!(inner.config.password.is_some());
        assert!(inner.locked);
        assert!(state
            .configure(&mut inner, update(Some("wrong".into())), true)
            .is_err());
        assert!(inner.config.password.is_some());
        state
            .configure(&mut inner, update(Some("correct horse".into())), true)
            .unwrap();
        assert!(inner.config.password.is_none());
        assert!(!inner.config.biometric_enabled);
        assert!(!inner.config.lock_on_background);
        assert!(!inner.locked);
    }
    #[test]
    fn password_cannot_override_a_newer_background_lock() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppSecurity {
            path: dir.path().join("security.json"),
            inner: Mutex::new(Inner {
                config: Config::default(),
                locked: false,
                generation: 0,
            }),
        };
        let mut inner = Inner {
            config: Config {
                password: Some(Password::new("correct horse").unwrap()),
                ..Config::default()
            },
            locked: true,
            generation: 7,
        };
        // Background completed before the queued password worker starts.
        assert!(state
            .authenticate_request(&mut inner, "correct horse", 6)
            .is_err());
        assert!(inner.locked);
        assert_eq!(inner.config.failures, 0);
        // Background/resume happened after verification but before platform commit.
        state
            .authenticate_request(&mut inner, "correct horse", 7)
            .unwrap();
        assert!(inner.locked);
        inner.generation = 8;
        assert!(complete_unlock(&mut inner, 7).is_err());
        assert!(inner.locked);
        state
            .authenticate_request(&mut inner, "correct horse", 8)
            .unwrap();
        complete_unlock(&mut inner, 8).unwrap();
        assert!(!inner.locked);
    }
    #[test]
    fn config_does_not_accept_malformed_password() {
        assert!(serde_json::from_str::<Config>(r#"{"password":{"salt":[],"digest":[]}}"#).is_err());
        assert!(serde_json::from_str::<Config>(r#"{"password":null,"unexpected":true}"#).is_err());
        assert!(!Config::default().lock_on_background);
    }
}
