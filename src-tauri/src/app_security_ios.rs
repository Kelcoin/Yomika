//! iOS LocalAuthentication and a native, opaque app-switcher privacy cover.
//! UIKit is touched only on its main thread. No credentials cross this module.
use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    MainThreadMarker,
};
use objc2_foundation::{
    ns_string, NSError, NSNotification, NSNotificationCenter, NSObjectProtocol,
};
use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
use objc2_ui_kit::{UIColor, UIUserInterfaceStyle, UIView, UIViewAutoresizing};
use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

static PASSWORD: AtomicBool = AtomicBool::new(false);
static LOCK_BACKGROUND: AtomicBool = AtomicBool::new(false);
static HIDE_PREVIEW: AtomicBool = AtomicBool::new(false);
static LOCKED: AtomicBool = AtomicBool::new(false);
static AUTHENTICATING: AtomicBool = AtomicBool::new(false);
static AUTH_RESUME_PENDING: AtomicBool = AtomicBool::new(false);
static AUTH_GENERATION: AtomicU64 = AtomicU64::new(0);
static BACKGROUNDED: AtomicBool = AtomicBool::new(false);
thread_local! {
    static ROOT: RefCell<Option<Retained<UIView>>> = const { RefCell::new(None) };
    static COVER: RefCell<Option<Retained<UIView>>> = const { RefCell::new(None) };
    // NotificationCenter owns its blocks; retaining its observer tokens keeps the
    // registrations explicitly alive for the lifetime of the application.
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(Vec::new()) };
    static AUTH_CONTEXT: RefCell<Option<Retained<LAContext>>> = const { RefCell::new(None) };
}

pub fn available() -> bool {
    unsafe {
        LAContext::new()
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
            .is_ok()
    }
}

pub fn biometric_label() -> &'static str {
    let context = unsafe { LAContext::new() };
    unsafe {
        let _ = context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics);
        match context.biometryType() {
            LABiometryType::FaceID => "Face ID",
            LABiometryType::TouchID => "Touch ID",
            _ => "系统认证",
        }
    }
}

pub fn locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

fn cover(visible: bool) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    crate::native_reader::cover_ios(visible);
    COVER.with(|slot| {
        if !visible {
            if let Some(view) = slot.borrow_mut().take() {
                view.removeFromSuperview();
            }
            return;
        }
        if slot.borrow().is_some() {
            return;
        }
        ROOT.with(|root| {
            let root = root.borrow();
            let Some(root) = root.as_ref() else { return };
            let parent = root.superview().unwrap_or_else(|| root.clone());
            let shield = UIView::new(mtm);
            shield.setFrame(parent.bounds());
            shield.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            shield.setBackgroundColor(Some(&UIColor::blackColor()));
            shield.setUserInteractionEnabled(true);
            parent.addSubview(&shield);
            *slot.borrow_mut() = Some(shield);
        });
    });
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(action());
    })
    .map_err(|_| "无法调用系统安全界面")?;
    receive.await.map_err(|_| "系统安全界面不可用".into())
}

pub async fn configure(
    app: &AppHandle,
    password_enabled: bool,
    lock_on_background: bool,
    hide_preview: bool,
    locked: bool,
) -> Result<(), String> {
    PASSWORD.store(password_enabled, Ordering::SeqCst);
    LOCK_BACKGROUND.store(lock_on_background, Ordering::SeqCst);
    HIDE_PREVIEW.store(hide_preview, Ordering::SeqCst);
    let locked =
        password_enabled && (locked || (BACKGROUNDED.load(Ordering::SeqCst) && lock_on_background));
    LOCKED.store(locked, Ordering::SeqCst);
    // Keep the shield until the frontend has committed its lock/error screen.
    // An ordinary in-app settings change must not cover an unlocked foreground.
    if locked {
        on_main(app, || cover(true)).await?;
    }
    Ok(())
}

pub async fn ready(app: &AppHandle) -> Result<(), String> {
    on_main(app, || {
        if !BACKGROUNDED.load(Ordering::SeqCst) {
            cover(false);
        }
    })
    .await
}

pub async fn authenticate(app: &AppHandle) -> Result<(), String> {
    if AUTHENTICATING.swap(true, Ordering::SeqCst) {
        return Err("系统认证正在进行".into());
    }
    struct AuthenticationGuard;
    impl Drop for AuthenticationGuard {
        fn drop(&mut self) {
            AUTHENTICATING.store(false, Ordering::SeqCst);
        }
    }
    let _guard = AuthenticationGuard;
    let auth_generation = AUTH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let (send, receive) = tokio::sync::oneshot::channel();
    let result_app = app.clone();
    let started = on_main(app, move || {
        let context = unsafe { LAContext::new() };
        // This policy offers Face ID / Touch ID and the OS passcode fallback.
        // The app's separate password remains available in the React gate.
        if unsafe { context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_err()
        {
            let _ = send.send(false);
            return;
        }
        let sender = Mutex::new(Some(send));
        let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
            if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = sender.send(success.as_bool());
            }
            // UIApplication's transient inactive/active cycle belongs to this
            // prompt, while didEnterBackground still always locks the app.
            let _ = result_app.run_on_main_thread(move || {
                if AUTH_GENERATION.load(Ordering::SeqCst) == auth_generation {
                    AUTH_CONTEXT.with(|slot| {
                        slot.borrow_mut().take();
                    });
                }
            });
        });
        AUTH_CONTEXT.with(|slot| *slot.borrow_mut() = Some(context.clone()));
        unsafe {
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                ns_string!("解锁 Yomika"),
                &reply,
            );
        }
    })
    .await;
    if let Err(error) = started {
        return Err(error);
    }
    let passed = receive.await.map_err(|_| "系统认证未完成")?;
    if AUTH_GENERATION.load(Ordering::SeqCst) != auth_generation {
        return Err("离开应用后系统认证已取消".into());
    }
    if passed {
        Ok(())
    } else {
        Err("系统认证已取消或未通过".into())
    }
}

fn apply_theme(view: &UIView, style: UIUserInterfaceStyle) {
    if let Some(window) = view.window() {
        window.setOverrideUserInterfaceStyle(style);
    }
}

pub(crate) fn set_theme(app: &AppHandle, theme: &str) {
    let style = match theme {
        "dark" => UIUserInterfaceStyle::Dark,
        "light" => UIUserInterfaceStyle::Light,
        _ => UIUserInterfaceStyle::Unspecified,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(move |webview| {
            if let Some(view) = unsafe { Retained::retain(webview.inner().cast::<UIView>()) } {
                apply_theme(&view, style);
            }
        });
    }
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
    let app = app.clone();
    window
        .with_webview(move |webview| {
            let Some(_mtm) = MainThreadMarker::new() else {
                return;
            };
            // Tauri owns this WKWebView. Retain its UIView superclass while native
            // notification callbacks need it, without taking ownership of the pointer.
            let root = unsafe { Retained::retain(webview.inner().cast::<UIView>()) };
            ROOT.with(|slot| *slot.borrow_mut() = root);
            if LOCKED.load(Ordering::SeqCst) { cover(true); }
            let center = NSNotificationCenter::defaultCenter();
            for name in [
                ns_string!("UIApplicationWillResignActiveNotification"),
                ns_string!("UIApplicationDidEnterBackgroundNotification"),
                ns_string!("UIApplicationDidBecomeActiveNotification"),
                ns_string!("UIApplicationDidReceiveMemoryWarningNotification"),
            ] {
                let app = app.clone();
                let is_background =
                    name == ns_string!("UIApplicationDidEnterBackgroundNotification");
                let is_active = name == ns_string!("UIApplicationDidBecomeActiveNotification");
                let is_memory_warning = name == ns_string!("UIApplicationDidReceiveMemoryWarningNotification");
                let callback = RcBlock::new(move |_notification: NonNull<NSNotification>| {
                    if is_memory_warning {
                        crate::native_reader::trim_ios_memory();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("window.dispatchEvent(new Event('yomika-memory-warning'))");
                        }
                        return;
                    }
                    if is_active {
                        let backgrounded = BACKGROUNDED.swap(false, Ordering::SeqCst);
                        let auth_resume = AUTH_RESUME_PENDING.swap(false, Ordering::SeqCst);
                        if !backgrounded && auth_resume {
                            return;
                        }
                        if backgrounded { crate::commands::app_security::foreground(&app); }
                        if COVER.with(|slot| slot.borrow().is_some()) || LOCKED.load(Ordering::SeqCst) {
                            // This asks React to fetch authoritative state while the
                            // native shield remains until its ready acknowledgement.
                            let _ = app.emit("app-security-lock", ());
                        }
                        return;
                    }
                    if is_background {
                        BACKGROUNDED.store(true, Ordering::SeqCst);
                        crate::commands::app_security::background(&app);
                        AUTH_RESUME_PENDING.store(false, Ordering::SeqCst);
                        // Going Home is a real departure, even while a Face ID
                        // sheet is active and automatic background lock is off.
                        AUTH_GENERATION.fetch_add(1, Ordering::SeqCst);
                        let context = AUTH_CONTEXT.with(|slot| slot.borrow_mut().take());
                        if let Some(context) = context {
                            unsafe {
                                context.invalidate();
                            }
                        }
                    } else if AUTHENTICATING.load(Ordering::SeqCst) {
                        AUTH_RESUME_PENDING.store(true, Ordering::SeqCst);
                        return;
                    }
                    let lock =
                        PASSWORD.load(Ordering::SeqCst) && LOCK_BACKGROUND.load(Ordering::SeqCst);
                    if HIDE_PREVIEW.load(Ordering::SeqCst) || PASSWORD.load(Ordering::SeqCst) {
                        cover(true);
                    }
                    if lock {
                        LOCKED.store(true, Ordering::SeqCst);
                        crate::commands::app_security::background(&app);
                    }
                });
                let token = unsafe {
                    // UIApplication posts these notifications on the main
                    // thread. A nil operation queue runs synchronously, before
                    // iOS takes its task-switcher snapshot.
                    center.addObserverForName_object_queue_usingBlock(
                        Some(name),
                        None,
                        None,
                        &callback,
                    )
                };
                OBSERVERS.with(|observers| observers.borrow_mut().push(token));
            }
        })
        .map_err(|_| "无法安装系统安全保护".into())
}
