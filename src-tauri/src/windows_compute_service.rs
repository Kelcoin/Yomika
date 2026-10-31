//! SCM entry point for the same portable executable, without Tauri/WebView/tray.
//! The service has its own worker/staging tree; models and preferences are shared.
use crate::compute::{
    manager::{no_events, ComputeManager, SupervisorConfig, WorkerEngine},
    models::ModelCatalog,
};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant},
};
use windows_service::{
    define_windows_service,
    service::*,
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};
mod runtime;

const NAME: &str = "YomikaRemoteProcessing";
const SERVICE_ARG: &str = "--compute-service";

fn root() -> Result<PathBuf, String> {
    if matches!(
        std::env::args().nth(1).as_deref(),
        Some(SERVICE_ARG | "--compute-service-host")
    ) {
        return Ok(configuration()?.data);
    }
    Ok(std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("程序目录不可用")?
        .join("data"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Configuration {
    data: PathBuf,
    owner: String,
}
fn directory() -> Result<PathBuf, String> {
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    };
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None)
            .map_err(|e| e.to_string())?;
        let value = path.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(path.0.cast()));
        Ok(PathBuf::from(value?).join("YomikaRemoteProcessing"))
    }
}
fn configuration() -> Result<Configuration, String> {
    serde_json::from_slice(
        &std::fs::read(directory()?.join("service.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn scm() -> Result<ServiceManager, String> {
    ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| e.to_string())
}

pub fn installed() -> bool {
    scm()
        .and_then(|m| {
            m.open_service(NAME, ServiceAccess::QUERY_STATUS)
                .map_err(|e| e.to_string())
        })
        .is_ok()
}

pub fn running() -> bool {
    scm()
        .and_then(|m| {
            m.open_service(NAME, ServiceAccess::QUERY_STATUS)
                .map_err(|e| e.to_string())
        })
        .and_then(|s| s.query_status().map_err(|e| e.to_string()))
        .is_ok_and(|s| s.current_state == ServiceState::Running)
}

pub fn dispatch() -> bool {
    let arg = std::env::args().nth(1).unwrap_or_default();
    if arg == "--compute-service-host" {
        if let Err(error) = runtime::host(&std::env::args().nth(2).unwrap_or_default()) {
            note(&error);
        }
        return true;
    }
    if arg == SERVICE_ARG {
        if let Err(error) = service_dispatcher::start(NAME, ffi_service_main) {
            note(&error.to_string());
        }
        return true;
    }
    let enabled = match arg.as_str() {
        "--install-compute-service" => true,
        "--uninstall-compute-service" => false,
        _ => return false,
    };
    let result = register(enabled);
    if let Err(error) = &result {
        note(error);
    }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn note(error: &str) {
    // Never follow a user-controlled log path from the privileged controller.
    let location = if std::env::args().nth(1).as_deref() == Some("--compute-service-host") {
        root().map(|root| root.join("logs"))
    } else {
        directory()
    };
    if let Ok(location) = location {
        let _ = std::fs::create_dir_all(&location);
        let _ = std::fs::write(location.join("windows-compute-service.log"), error);
    }
}

fn info() -> Result<ServiceInfo, String> {
    Ok(ServiceInfo {
        name: NAME.into(),
        display_name: "Yomika 远程后处理".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: directory()?.join("yomika-service.exe"),
        launch_arguments: vec![SERVICE_ARG.into()],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    })
}

fn register(enabled: bool) -> Result<(), String> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| e.to_string())?;
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::QUERY_CONFIG
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::DELETE;
    let existing = manager.open_service(NAME, access);
    if !enabled && !installed() {
        return Ok(());
    }
    let created = existing.is_err();
    if !created && configuration()?.data != root()? {
        return Err("服务属于另一份 Yomika，请先在原目录关闭 Windows 服务".into());
    }
    if enabled {
        if let Ok(service) = &existing {
            if service
                .query_status()
                .map_err(|e| e.to_string())?
                .current_state
                != ServiceState::Stopped
            {
                service.stop().map_err(|e| e.to_string())?;
                wait_state(service, ServiceState::Stopped)?;
            }
        }
        // SCM executes only the administrator-owned copy. User-writable models
        // and DLLs are opened exclusively by the ordinary user's runtime.
        let target = directory()?;
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let source = std::env::current_exe().map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match std::fs::copy(&source, target.join("yomika-service.exe")) {
                Ok(_) => break,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(200))
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        if let Some(parent) = source.parent() {
            let dml = parent.join("DirectML.dll");
            if dml.is_file() {
                std::fs::copy(dml, target.join("DirectML.dll")).map_err(|e| e.to_string())?;
            }
        }
        let worker = crate::compute::worker_binary::ensure(
            &target.join("yomika-compute-worker.exe"),
            &target,
            crate::compute::worker_binary::payload(),
        );
        if !worker.is_file() {
            return Err("服务所需的计算进程载荷不可用".into());
        }
        let config = Configuration {
            data: root()?,
            owner: std::env::args().nth(2).unwrap_or(
                yomika_compute_transport::server::current_user_sid().map_err(|e| e.to_string())?,
            ),
        };
        if config.owner.len() > 128
            || !config.owner.starts_with("S-1-")
            || !config
                .owner
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b'-' || c == b'S')
        {
            return Err("Windows 用户标识无效".into());
        }
        std::fs::write(
            target.join("service.json"),
            serde_json::to_vec(&config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    let service = match existing {
        Ok(service) => {
            let config = service.query_config().map_err(|e| e.to_string())?;
            // A second portable copy must never silently take over another installation.
            let expected = info()?;
            let registered = config
                .executable_path
                .to_string_lossy()
                .to_ascii_lowercase();
            let own = expected
                .executable_path
                .to_string_lossy()
                .to_ascii_lowercase();
            if registered != format!("\"{own}\" {SERVICE_ARG}")
                && registered != format!("{own} {SERVICE_ARG}")
            {
                return Err("服务属于另一份 Yomika，请先在原目录关闭 Windows 服务".into());
            }
            if enabled {
                service
                    .change_config(&expected)
                    .map_err(|e| e.to_string())?;
            }
            service
        }
        Err(_) if enabled => manager
            .create_service(&info()?, access)
            .map_err(|e| e.to_string())?,
        Err(error) => return Err(error.to_string()),
    };
    if enabled {
        let start = || -> Result<(), String> {
            service.set_description("独立于 Yomika 客户端提供局域网超分与 DLSSNR；使用程序旁 data 目录中的模型和设置。请勿移动程序目录。").map_err(|e| e.to_string())?;
            if service
                .query_status()
                .map_err(|e| e.to_string())?
                .current_state
                != ServiceState::Running
            {
                service.start::<&str>(&[]).map_err(|e| e.to_string())?;
            }
            wait_state(&service, ServiceState::Running)
        };
        if let Err(error) = start() {
            if created {
                let _ = service.stop();
                let _ = service.delete();
            }
            return Err(error);
        }
    } else {
        if service
            .query_status()
            .map_err(|e| e.to_string())?
            .current_state
            != ServiceState::Stopped
        {
            service.stop().map_err(|e| e.to_string())?;
            wait_state(&service, ServiceState::Stopped)?;
        }
        service.delete().map_err(|e| e.to_string())?;
        drop(service);
        // Only our fixed deployment files, never the portable data directory.
        let target = directory()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while target.join("yomika-service.exe").exists() {
            if std::fs::remove_file(target.join("yomika-service.exe")).is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if let Ok(files) = std::fs::read_dir(&target) {
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                if matches!(
                    name.as_str(),
                    "DirectML.dll" | "service.json" | "windows-compute-service.log"
                ) || (name.starts_with("yomika-compute-worker-") && name.ends_with(".exe"))
                {
                    let _ = std::fs::remove_file(file.path());
                }
            }
        }
        let _ = std::fs::remove_dir(target.join("runtime"));
        let _ = std::fs::remove_dir(target);
    }
    Ok(())
}

fn wait_state(service: &Service, target: ServiceState) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = service.query_status().map_err(|e| e.to_string())?;
        if state.current_state == target {
            return Ok(());
        }
        if target == ServiceState::Running && state.current_state == ServiceState::Stopped {
            return Err(format!("服务启动失败：{:?}", state.exit_code));
        }
        if Instant::now() >= deadline {
            return Err("等待 Windows 服务响应超时".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Only the fixed install/uninstall verbs can be elevated; no caller-supplied script/path.
pub fn configure(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.to_string_lossy().replace('\'', "''");
    let verb = if enabled {
        "--install-compute-service"
    } else {
        "--uninstall-compute-service"
    };
    let owner = yomika_compute_transport::server::current_user_sid().map_err(|e| e.to_string())?;
    let script = format!("try {{$p=Start-Process -FilePath '{path}' -ArgumentList @('{verb}','{owner}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode}} catch {{exit 1}}");
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let result = crate::hidden_process::command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .status()
        .map_err(|e| e.to_string())?;
    if result.success() {
        Ok(())
    } else {
        Err("Windows 服务操作未完成：请允许管理员授权，并检查 Program Files/YomikaRemoteProcessing/windows-compute-service.log".into())
    }
}

pub(crate) fn read_preferences(data: &Path) -> Result<crate::settings::PreferenceSnapshot, String> {
    let connection = rusqlite::Connection::open_with_flags(
        data.join("yomika.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    crate::settings::load_preferences_from(&connection)
}

define_windows_service!(ffi_service_main, service_main);
fn service_main(_: Vec<OsString>) {
    if let Err(error) = run_service() {
        note(&error);
    }
}

fn run_service() -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let handle = service_control_handler::register(NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .map_err(|e| e.to_string())?;
    let status = |state, code| {
        handle
            .set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: if state == ServiceState::Running {
                    ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
                } else {
                    ServiceControlAccept::empty()
                },
                exit_code: ServiceExitCode::Win32(code),
                checkpoint: if state == ServiceState::StartPending {
                    1
                } else {
                    0
                },
                wait_hint: Duration::from_secs(20),
                process_id: None,
            })
            .map_err(|e| e.to_string())
    };
    status(ServiceState::StartPending, 0)?;
    let result = runtime::control(&rx, || status(ServiceState::Running, 0));
    let _ = status(ServiceState::Stopped, if result.is_ok() { 0 } else { 1 });
    result
}

fn serve_until_stopped(
    rx: &mpsc::Receiver<()>,
    started: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let data = root()?;
    let snapshot = read_preferences(&data)?;
    // Separate staging, input grants, artefacts and NGX contexts from the GUI worker.
    let workspace = data.join("windows-service");
    let staging = workspace.join("compute/staging");
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(crate::compute::inputs::inputs_root_for(&staging))
        .map_err(|e| e.to_string())?;
    let worker = crate::compute::worker_binary::ensure(
        &crate::compute::worker_binary_path(),
        &workspace,
        crate::compute::worker_binary::payload(),
    );
    let mut config = SupervisorConfig::new(worker, staging);
    if std::env::var_os("YOMIKA_NGX_LOG").is_some() {
        config.extra_env.push(("YOMIKA_NGX_LOG".into(), "1".into()));
    }
    config.worker_engine = WorkerEngine::Onnx;
    config.models = Some(ModelCatalog::new(&data));
    config.publish_root = Some(workspace.clone());
    let mut ngx_config = config.clone();
    ngx_config.staging_root = workspace.join("ngx/staging");
    ngx_config.inputs_root = crate::compute::inputs::inputs_root_for(&ngx_config.staging_root);
    ngx_config.publish_root = Some(workspace.join("ngx"));
    std::fs::create_dir_all(&ngx_config.staging_root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&ngx_config.inputs_root).map_err(|e| e.to_string())?;
    let ngx_manager = ComputeManager::start(ngx_config, no_events()).map_err(|e| e.to_string())?;
    let manager = ComputeManager::start(config, no_events()).map_err(|e| e.to_string())?;
    let center = crate::compute_center::ComputeCenter::new();
    let update = |snapshot: &crate::settings::PreferenceSnapshot| -> Result<(), String> {
        center.set_token(&snapshot.compute_center_token);
        if center
            .running_port()
            .is_some_and(|port| port != snapshot.compute_center_port)
            || !snapshot.compute_center_enabled
        {
            center.stop();
        }
        if snapshot.compute_center_enabled {
            center.start(
                crate::compute_center::ServerContext {
                    model_data: data.clone(),
                    data: data.clone(),
                    app: None,
                    manager: Some(manager.clone()),
                    dlssnr_manager: Some(ngx_manager.clone()),
                },
                snapshot.compute_center_port,
            )?;
        }
        Ok(())
    };
    update(&snapshot)?;
    started()?;
    while matches!(
        rx.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ) {
        if let Ok(snapshot) = read_preferences(&data) {
            if let Err(error) = update(&snapshot) {
                note(&error);
            }
        }
    }
    center.stop();
    manager.shutdown();
    ngx_manager.shutdown();
    Ok(())
}
