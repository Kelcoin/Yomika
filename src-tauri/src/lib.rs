mod bundled_models;
mod cache;
mod commands;
mod data_paths;
mod db;
mod dedup;
mod diagnostics;
mod domain;
mod error_log;
mod inference;
mod model_release;
mod network;
mod settings;

use cache::{
    cache_clear_images, cache_evict, cache_invalidate_archive, cache_read_image, cache_stats,
    cache_store_image,
};
use commands::eh::{capture_eh_login_cookies, check_eh_login_health, close_eh_login_window, fetch_eh_forum_username, fetch_eh_my_tags, get_eh_comments, list_eh_accounts, list_eh_my_tags, login_eh_account, open_eh_login_window, post_eh_comment, read_eh_account_cookie, remove_eh_account, remove_eh_favorite, save_eh_account, search_eh_galleries, set_eh_username_hint, vote_eh_comment};
use commands::legacy::{import_legacy_export, import_worker_export};
use error_log::{error_log_append, error_log_append_batch, error_log_export, error_log_read};
use commands::library::{
    add_archive_to_category, cancel_download, check_server_status, create_task, delete_archive,
    delete_local_archives, delete_search_preset, download_archive, download_url, list_archive_identities,
    list_archives,
    list_archives_by_ids,
    list_archives_page, list_categories, list_local_archives, list_metadata_plugins,
    list_reading_history,
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
use commands::platform::{open_external_url, platform_capabilities, reveal_in_file_manager, write_clipboard_text};
use commands::sync::{
    append_sync_journal, claim_sync_journal, list_sync_accounts, list_sync_journal,
    reset_remote_state, save_sync_account, save_sync_scope, set_sync_journal_state,
    sync_account_credential, sync_remote_scope, test_sync_account,
};
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
    inference_cancel, inference_checkpoint, inference_clear_cache, inference_cpu_scale,
    inference_decensor_page, inference_get_job, inference_import_model_path,
    inference_install_decensor_bundle, inference_install_model, inference_list_models,
    inference_pause, inference_probe, inference_resume, inference_start, inference_upscale_page,
    inference_validate_model,
};
use model_release::{
    model_release_activate, model_release_cancel, model_release_download,
    model_release_download_bundle, model_release_download_default, model_release_fetch_manifest,
    model_release_list_upscalers, model_release_url, model_release_validate,
    model_release_validate_archive, model_release_validate_import, model_release_validate_local,
};
use settings::{import_legacy_preferences, load_preferences, save_preferences};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            data_paths::prepare(app.handle()).map_err(std::io::Error::other)?;
            // 错误日志描述的是这一次运行：先清空，再挂上 panic 钩子。
            error_log::reset(app.handle());
            error_log::install_panic_hook(app.handle());
            let database = Database::open(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database);
            app.manage(DedupScanRegistry::default());
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
            #[cfg(desktop)]
            let builder = builder.decorations(cfg!(not(target_os = "windows")));
            #[cfg(target_os = "windows")]
            let builder =
                builder.data_directory(data_paths::data_dir(app.handle())?.join("webview"));
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_capabilities,
            reveal_in_file_manager,
            open_external_url,
            write_clipboard_text,
            load_preferences,
            save_preferences,
            import_legacy_preferences,
            cache_evict,
            cache_clear_images,
            cache_invalidate_archive,
            cache_read_image,
            cache_stats,
            cache_store_image,
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
            inference_cpu_scale,
            inference_probe,
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
            save_eh_account,
            login_eh_account,
            open_eh_login_window,
            capture_eh_login_cookies,
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
            error_log_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Yomika");
}
