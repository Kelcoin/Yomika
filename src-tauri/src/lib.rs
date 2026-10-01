mod app_release;
mod bundled_models;
mod cache;
// 命令调度的不变量（同步命令不许 `block_on`、不许锁那把全局库锁、不许等子进程）。
// 只在测试里编：它读的是 crate 自己的源码，没有运行期价值。
#[cfg(test)]
mod command_dispatch;
mod commands;
mod compute_center;
mod credentials;
mod data_paths;
mod data_transfer;
// 模块本身在所有平台都编：Windows 里是 D3D12 + NGX 那一套，其它平台上只剩
// `dlssnr::commands` 那组「不可用」的命令壳（`generate_handler!` 要求命令名在所有
// 平台都存在，前端也只按名字调）。
mod dlssnr;
mod db;
mod dedup;
mod diagnostics;
mod domain;
mod error_log;
mod inference;
mod model_release;
#[cfg(target_os = "android")]
mod mobile_host;
mod network;
// 凭据落盘的唯一入口：桌面走系统凭据库，移动端走数据目录里的 secrets.json
// （keyring 3.6.3 在安卓上没有后端，会退化成一个写不进去的 mock）。
mod secret_store;
mod settings;
mod tray_menu;

use cache::{
    cache_clear_images, cache_evict, cache_invalidate_archive, cache_read_image, cache_stats,
};
use commands::eh::{capture_eh_login_cookies, cancel_eh_in_app_login, start_eh_in_app_login, take_eh_in_app_login, InAppLoginState, check_eh_login_health, close_eh_login_window, fetch_eh_forum_username, fetch_eh_my_tags, get_eh_comments, list_eh_accounts, list_eh_my_tags, login_eh_account, open_eh_login_window, post_eh_comment, read_eh_account_cookie, remove_eh_account, remove_eh_favorite, save_eh_account, search_eh_galleries, set_eh_username_hint, vote_eh_comment};
use commands::legacy::{import_legacy_export, import_worker_export};
use error_log::{error_log_append, error_log_append_batch, error_log_clear, error_log_export, error_log_read};
use commands::library::{
    add_archive_to_category, cancel_download, check_server_status, create_task, delete_archive,
    delete_local_archives, delete_search_preset, download_archive, download_url, list_archive_identities,
    list_archives,
    list_archives_by_ids,
    list_archives_page, list_categories, list_local_archives, list_metadata_plugins,
    delete_history_records, list_reading_history, read_favorites_category,
    get_archive_membership, list_reading_list, list_search_presets, list_servers, list_tasks, list_watchlist,
    load_archive_metadata, load_archive_page_thumbnail, load_archive_thumbnail,
    load_reader_manifest, load_reader_page, load_reading_progress, pause_download,
    probe_new_archives,
    prune_dangling_records, prune_history,
    read_server_api_key, refresh_archives, remove_archive_from_category, replace_archives,
    resume_download, retry_task, save_reading_progress, save_search_preset, save_server,
    search_archives_page,
    set_server_enabled,
    search_random_archives,
    set_reading_list, set_watchlist, update_archive_metadata, update_task, upload_archive,
    use_metadata_plugin, verify_archives_exist,
};
use commands::platform::{
    app_build_info, frontend_ready, open_external_url, platform_capabilities, read_text_file,
    reveal_in_file_manager, save_text_file, set_system_bar_style, system_insets,
    write_clipboard_text,
};
#[cfg(target_os = "windows")]
use commands::platform::set_big_window_icon;
use commands::sync::{
    append_sync_journal, claim_sync_journal, export_scoped_data, import_scoped_data,
    list_sync_accounts, list_sync_journal,
    reset_remote_state, save_sync_account, save_sync_scope, set_sync_journal_state,
    sync_account_credential, sync_remote_scope, test_sync_account,
};
use credentials::{export_data, import_data};
use db::Database;
use dedup::{
    dedup_cancel_scan, dedup_check_file, dedup_delete_selected, dedup_delete_session,
    dedup_find_exact, dedup_import_readoshi, dedup_list_non_duplicates, dedup_list_sessions,
    dedup_load_result, dedup_remove_non_duplicate, dedup_resume_scan, dedup_save_feature,
    dedup_save_non_duplicate, dedup_save_non_duplicates, dedup_save_selection,
    dedup_scan, dedup_scan_chunk,
    dedup_scan_progress, dedup_start_scan,
    DedupScanRegistry,
};
use inference::{
    inference_cancel, inference_cancel_page, inference_checkpoint, inference_clear_cache,
    inference_decensor_page, inference_get_job, inference_import_model_path,
    inference_install_decensor_bundle, inference_install_model, inference_list_models,
    inference_pause, inference_probe, inference_resume, inference_start, inference_upscale_page,
    inference_validate_model,
};
use app_release::app_release_latest;
use model_release::{
    model_release_activate, model_release_cancel, model_release_download,
    model_release_download_bundle, model_release_download_default, model_release_fetch_manifest,
    model_release_list_upscalers, model_release_url, model_release_validate,
    model_release_validate_archive, model_release_validate_import, model_release_validate_local,
};
use settings::{import_legacy_preferences, load_preferences, save_preferences};
use dlssnr::commands::{
    dlssnr_apply_page, dlssnr_catalog, dlssnr_download_variant, dlssnr_import_dll, dlssnr_probe,
    dlssnr_status,
};
use compute_center::{
    compute_center_configure, compute_center_revoke_pairing, compute_center_status, compute_discover, compute_pair_request,
    compute_pair_confirm, remote_compute_capabilities, remote_compute_process,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    let background_launch = std::env::args().any(|arg| arg == "--background");
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // 原生宿主只有 Android 有（登录面板 + SAF 写文件），别的平台那两条路走别的实现。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile_host::plugin());
    builder
        .setup(move |app| {
            data_paths::prepare(app.handle()).map_err(std::io::Error::other)?;
            // 错误日志留两轮：先把「本轮」翻成「上一轮」（上一轮的现场是这次闪退唯一的
            // 线索），再挂上 panic 钩子。
            error_log::rotate(app.handle());
            error_log::install_panic_hook(app.handle());
            let database = Database::open(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database);
            app.manage(DedupScanRegistry::default());
            app.manage(InAppLoginState::default());
            // 算力中心：进程内一份句柄（服务是否在跑、令牌读的是设置里的那一份）。
            // 存值本身而不是 `Arc`：命令那边取的是 `State<ComputeCenter>`，存成
            // `Arc<ComputeCenter>` 会按另一个 TypeId 登记，`state()` 找不到就 panic
            // ——命令里 panic 会直接跨 FFI 边界中止整个进程（用户看到的就是闪退）。
            app.manage(compute_center::ComputeCenter::new());
            if let Err(error) = compute_center::restore_on_launch(app.handle()) {
                eprintln!("无法恢复远端处理服务：{error}");
            }
            #[cfg(target_os = "windows")]
            {
                use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
                // 右键菜单是应用自己画的（见 `tray_menu`）：系统菜单的宽度与悬停高亮
                // 都改不了。所以托盘不再挂 `MenuBuilder`，右键由这里弹出那个小窗口。
                //
                // `button_state` **有意不筛**：托盘事件是按下还是抬起时发的，各平台/各版本
                // 不一定一致，而这台机器上没法真的点一次托盘图标来确认。少筛一个字段就是
                // 少一个「菜单根本不弹」的失败模式；重复触发也无害——`show_at` 对同一个位置
                // 是幂等的（再设一次位置、再 `show` + `set_focus`）。
                let mut tray = TrayIconBuilder::new()
                    .tooltip("Yomika")
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        match event {
                            TrayIconEvent::Click { button: MouseButton::Right, position, .. } => {
                                tray_menu::show_at(tray.app_handle(), position);
                            }
                            // 左键直接把主窗叫回来：菜单万一没弹出来，应用也不能变成一个
                            // 只有右键才够得着的东西（系统菜单原本还提供了这一条路）。
                            TrayIconEvent::Click { button: MouseButton::Left, .. } => {
                                if let Some(main) = tray.app_handle().get_webview_window("main") {
                                    let _ = main.show();
                                    let _ = main.unminimize();
                                    let _ = main.set_focus();
                                }
                            }
                            _ => {}
                        }
                    });
                // 托盘图标是**单独一份**（`assets/yomika-tray.svg` → `icons/tray-32.png`），
                // 不是应用图标：print 那版的笔画在 512 单位里只有 18，落到托盘给的 16px 上
                // 是 0.56px，整块糊成一团灰（用户报的「小尺寸下很难看清」）。托盘那版把
                // 字形改成实心、减到三个元素、每一条边压在 32 单位网格上。
                //
                // 解不出来就退回应用图标：托盘没有图标比图标糊一点糟得多。
                let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-32.png"))
                    .ok()
                    .or_else(|| app.default_window_icon().cloned());
                if let Some(icon) = tray_icon { tray = tray.icon(icon); }
                tray.build(app)?;
                let menu = tray_menu::install(app.handle())?;
                // 开发/验收用：带上 `--tray-menu-preview` 就把菜单窗口摆到主屏右下角，
                // 好量它的尺寸、圆角与悬停。与 `--background` 同类，只在带这个参数时生效。
                //
                // **必须等主窗先亮**：主窗 `frontend_ready` 时会 `show()` + `set_focus()`，
                // 菜单在那之前弹出来就会被自己的「失焦即收起」收掉（那正是它该做的事）。
                if std::env::args().any(|arg| arg == "--tray-menu-preview") {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(6));
                        let target = handle
                            .primary_monitor()
                            .ok()
                            .flatten()
                            .map(|monitor| {
                                let position = monitor.position();
                                let area = monitor.size();
                                (
                                    f64::from(position.x) + f64::from(area.width) - 160.0,
                                    f64::from(position.y) + f64::from(area.height) - 140.0,
                                )
                            })
                            .unwrap_or((900.0, 700.0));
                        tray_menu::show_at(&handle, tauri::PhysicalPosition::new(target.0, target.1));
                    });
                }
                let _ = &menu;
            }
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| std::io::Error::other("Main window configuration unavailable"))?;
            let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
            // Windows draws its own themed title bar (TitleBar.tsx); other
            // desktop platforms keep their native window chrome. `decorations`
            // only exists in Tauri's desktop build — the mobile runtime has no
            // window frame to decorate — so the call has to carry the same gate,
            // or the iOS/Android targets fail to compile here.
            //
            // 这一条**不是**拖动/缩放的性能开关：窗口卡顿的根因是同步的
            // `#[tauri::command]` 在 WebView2 的 UI 线程上跑长任务（缓存统计实测
            // 273ms、档案分页 71ms，见 cache.rs / commands/library.rs 里那些
            // `#[tauri::command(async)]`），换成原生边框只让迟钝更明显。
            // 关掉系统装饰之后窗口也没有系统投影，AppShell 的栅格自己画出顶栏。
            #[cfg(desktop)]
            let mut builder = builder.decorations(cfg!(not(target_os = "windows")));
            #[cfg(target_os = "windows")]
            { builder = builder.shadow(false); }
            // 桌面端主窗先藏着：webview 画出 index.html 的品牌帧后再亮窗
            // （frontend_ready / 10 秒兜底），「纯色空窗」那一段就不再存在。
            // 移动端没有这个空窗（原生壳自带启动画面），保持直出。
            #[cfg(desktop)]
            {
                builder = builder.visible(false);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                    #[cfg(target_os = "windows")]
                    if background_launch { return; }
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.show();
                    }
                });
            }

            #[cfg(target_os = "windows")]
            let builder =
                builder.data_directory(data_paths::data_dir(app.handle())?.join("webview"));
            let main_window = builder.build()?;
            // Windows 的任务栏按钮与 Alt+Tab 读的是 **ICON_BIG**，而 tao 只设了
            // ICON_SMALL（`WM_SETICON` 带 ICON_SMALL，见 tao 的 set_window_icon），
            // 窗口类的图标又是空的：于是那两处只能靠系统的兜底，落到的就是那个
            // 通用「窗口」占位图标（用户报的「任务栏图标丢失」）。图标组本来就被
            // tauri-build 编进 exe 了，这里把它按 ICON_BIG 显式设上——资源 id 1
            // 就是那一个组，Windows 自己会挑合适的那一档尺寸。
            #[cfg(target_os = "windows")]
            set_big_window_icon(&main_window);
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = main_window.hwnd() {
                use windows::Win32::{Foundation::HWND, Graphics::Dwm::{DwmSetWindowAttribute, DWM_WINDOW_CORNER_PREFERENCE, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND}};
                unsafe {
                    let border_color = DWMWA_COLOR_NONE;
                    // DWM draws a separate border outside the WebView. Removing it is
                    // what makes the app-drawn title bar reach the window edge
                    // instead of sitting inside a one-pixel system outline. This
                    // leaves Tao's resize hit testing and taskbar auto-hide inset
                    // intact.
                    let _ = DwmSetWindowAttribute(
                        HWND(hwnd.0),
                        DWMWA_BORDER_COLOR,
                        &border_color as *const u32 as *const std::ffi::c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                    // Win11 只给**带系统边框**的窗口画圆角。这个窗口没有边框（顶栏是
                    // 应用自己画的，见上面 `decorations`），所以四周是直角。显式要一次
                    // 圆角就回来了：窗口区域被裁成圆角，四角露出桌面。
                    //
                    // 这一条必须和上面那条**一起去掉**才对称：只恢复边框颜色而不恢复
                    // 圆角，就是用户报的「窗口四周缺少圆角」。
                    let corner = DWMWCP_ROUND;
                    let _ = DwmSetWindowAttribute(
                        HWND(hwnd.0),
                        DWMWA_WINDOW_CORNER_PREFERENCE,
                        &corner as *const DWM_WINDOW_CORNER_PREFERENCE as *const std::ffi::c_void,
                        std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                    );
                }
            }
            let _ = main_window;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 菜单窗口靠「失焦」收起：点到别处（包括主窗）就是取消。它自己从不关闭，
            // 所以这里只藏不销毁，下一次右键要能立刻再弹出来。
            #[cfg(target_os = "windows")]
            if window.label() == tray_menu::MENU_WINDOW {
                if matches!(event, tauri::WindowEvent::Focused(false) | tauri::WindowEvent::CloseRequested { .. }) {
                    tray_menu::hide(window.app_handle());
                }
                return;
            }
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" { return; }
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let app = window.app_handle();
                    let close_to_tray = app.try_state::<Database>()
                        .and_then(|database| database.connection.lock().ok()
                            .and_then(|connection| settings::load_preferences_from(&connection).ok()))
                        .is_some_and(|snapshot| snapshot.close_to_tray);
                    if close_to_tray {
                        let _ = window.hide();
                    } else {
                        let _ = window.destroy();
                    }
                });
            }
            #[cfg(not(target_os = "windows"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            platform_capabilities,
            reveal_in_file_manager,
            open_external_url,
            write_clipboard_text,
            save_text_file,
            read_text_file,
            system_insets,
            set_system_bar_style,
            load_preferences,
            save_preferences,
            import_legacy_preferences,
            cache_evict,
            cache_clear_images,
            cache_invalidate_archive,
            cache_read_image,
            cache_stats,
                    list_servers,
            check_server_status,
            save_server,
            set_server_enabled,
            read_server_api_key,
            replace_archives,
            refresh_archives,
            probe_new_archives,
            search_random_archives,
            load_reader_manifest,
            load_reader_page,
            list_archives,
            list_archive_identities,
            list_archives_by_ids,
            verify_archives_exist,
            list_archives_page,
            search_archives_page,
            load_archive_metadata,
            load_archive_thumbnail,
            load_archive_page_thumbnail,
            delete_archive,
            download_archive,
            pause_download,
            resume_download,
            cancel_download,
            list_local_archives,
            delete_local_archives,
            create_task,
            list_tasks,
            update_task,
            retry_task,
            upload_archive,
            download_url,
            list_categories,
            read_favorites_category,
            add_archive_to_category,
            remove_archive_from_category,
            update_archive_metadata,
            list_metadata_plugins,
            use_metadata_plugin,
            save_reading_progress,
            load_reading_progress,
            set_watchlist,
            list_watchlist,
            list_reading_history,
            delete_history_records,
            prune_history,
            prune_dangling_records,
            set_reading_list,
            list_reading_list,
            get_archive_membership,
            save_search_preset,
            list_search_presets,
            delete_search_preset,
            append_sync_journal,
            claim_sync_journal,
            list_sync_journal,
            set_sync_journal_state,
            save_sync_account,
            save_sync_scope,
            list_sync_accounts,
            sync_remote_scope,
            test_sync_account,
            reset_remote_state,
            sync_account_credential,
            export_scoped_data,
            import_scoped_data,
            export_data,
            import_data,
            inference_probe,
            dlssnr_status,
            dlssnr_probe,
            dlssnr_import_dll,
            dlssnr_catalog,
            dlssnr_download_variant,
            dlssnr_apply_page,
            compute_center_status,
            compute_center_configure,
            compute_center_revoke_pairing,
            compute_discover,
            compute_pair_request,
            compute_pair_confirm,
            remote_compute_capabilities,
            remote_compute_process,
            inference_start,
            inference_get_job,
            inference_cancel,
            inference_checkpoint,
            inference_pause,
            inference_resume,
            inference_validate_model,
            inference_install_model,
            inference_import_model_path,
            inference_install_decensor_bundle,
            inference_list_models,
            inference_clear_cache,
            app_release_latest,
            model_release_url,
            model_release_fetch_manifest,
            model_release_list_upscalers,
            model_release_validate,
            model_release_download,
            model_release_download_bundle,
            model_release_download_default,
            model_release_validate_import,
            model_release_cancel,
            model_release_validate_archive,
            model_release_activate,
            model_release_validate_local,
            inference_upscale_page,
            inference_decensor_page,
            inference_cancel_page,
            save_eh_account,
            login_eh_account,
            open_eh_login_window,
            capture_eh_login_cookies,
            start_eh_in_app_login,
            take_eh_in_app_login,
            cancel_eh_in_app_login,
            close_eh_login_window,
            list_eh_accounts,
            read_eh_account_cookie,
            remove_eh_account,
            search_eh_galleries,
            remove_eh_favorite,
            vote_eh_comment,
            get_eh_comments,
            post_eh_comment,
            check_eh_login_health,
            fetch_eh_forum_username,
            set_eh_username_hint,
            fetch_eh_my_tags,
            list_eh_my_tags,
            dedup_check_file,
            dedup_save_feature,
            dedup_find_exact,
            dedup_start_scan,
            dedup_scan_chunk,
            dedup_scan,
            dedup_scan_progress,
            dedup_save_selection,
            dedup_list_sessions,
            dedup_delete_session,
            dedup_cancel_scan,
            dedup_resume_scan,
            dedup_load_result,
            dedup_save_non_duplicate,
            dedup_save_non_duplicates,
            dedup_remove_non_duplicate,
            dedup_delete_selected,
            dedup_import_readoshi,
            dedup_list_non_duplicates,
            import_legacy_export,
            import_worker_export,
            error_log_append,
            error_log_append_batch,
            error_log_read,
            error_log_clear,
            error_log_export,
            app_build_info,
            tray_menu::tray_menu_state,
            tray_menu::tray_menu_choose,
            tray_menu::tray_menu_dismiss
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Yomika");
}
