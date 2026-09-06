mod commands;
mod cache;
mod db;
mod diagnostics;
mod dedup;
mod domain;
mod inference;
mod model_release;
mod network;
mod settings;

use commands::library::{
    add_archive_to_category, check_server_status, create_task, delete_archive, list_archives, list_archives_page,
    list_categories, list_reading_history, list_servers, list_tasks, list_watchlist, load_archive_metadata,
    load_archive_thumbnail, load_archive_page_thumbnail, load_reader_manifest, load_reader_page, load_reading_progress,
    refresh_archives, replace_archives, retry_task, save_reading_progress, save_server, set_watchlist,
    update_archive_metadata, list_metadata_plugins, use_metadata_plugin, update_task, upload_archive,
};
use cache::{cache_clear_images, cache_evict, cache_invalidate_archive, cache_read_image, cache_stats, cache_store_image};
use commands::platform::platform_capabilities;
use commands::sync::{
    append_sync_journal, build_sync_segment, claim_sync_journal, create_sync_key, decrypt_sync_manifest,
    encrypt_sync_manifest, list_sync_journal, list_webdav_accounts, merge_sync_manifests,
    save_webdav_account, set_sync_journal_state, sync_webdav_scope,
};
use inference::{inference_cancel, inference_checkpoint, inference_clear_cache, inference_cpu_scale, inference_get_job, inference_install_model, inference_pause, inference_probe, inference_resume, inference_start, inference_validate_model};
use dedup::{dedup_cancel_scan, dedup_check_file, dedup_delete_selected, dedup_find_exact, dedup_import_readoshi, dedup_load_result, dedup_remove_non_duplicate, dedup_resume_scan, dedup_save_feature, dedup_save_non_duplicate, dedup_scan, dedup_scan_chunk, dedup_start_scan};
use commands::eh::{check_eh_login_health, list_eh_accounts, remove_eh_favorite, save_eh_account, search_eh_galleries, set_active_eh_account, vote_eh_comment};
use commands::legacy::import_legacy_export;
use db::Database;
use tauri::Manager;
use settings::{import_legacy_preferences, load_preferences, save_preferences};
use model_release::{model_release_download, model_release_url, model_release_validate, model_release_validate_import};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database = Database::open(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_capabilities,
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
            replace_archives,
            refresh_archives,
            load_reader_manifest,
            load_reader_page,
            list_archives,
            list_archives_page,
            load_archive_metadata,
            load_archive_thumbnail,
            load_archive_page_thumbnail,
            delete_archive,
            create_task,
            list_tasks,
            update_task,
            retry_task,
            upload_archive,
            list_categories,
            add_archive_to_category,
            update_archive_metadata,
            list_metadata_plugins,
            use_metadata_plugin,
            save_reading_progress,
            load_reading_progress,
            set_watchlist,
            list_watchlist,
            list_reading_history,
            append_sync_journal,
            claim_sync_journal,
            list_sync_journal,
            set_sync_journal_state,
            create_sync_key,
            build_sync_segment,
            encrypt_sync_manifest,
            decrypt_sync_manifest,
            merge_sync_manifests,
            save_webdav_account,
            list_webdav_accounts,
            sync_webdav_scope,
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
            inference_clear_cache,
            model_release_url,
            model_release_validate,
            model_release_download,
            model_release_validate_import,
            save_eh_account,
            list_eh_accounts,
            search_eh_galleries,
            remove_eh_favorite,
            vote_eh_comment,
            check_eh_login_health,
            set_active_eh_account,
            dedup_check_file,
            dedup_save_feature,
            dedup_find_exact,
            dedup_start_scan,
            dedup_scan_chunk,
            dedup_scan,
            dedup_cancel_scan,
            dedup_resume_scan,
            dedup_load_result,
            dedup_save_non_duplicate,
            dedup_remove_non_duplicate,
            dedup_delete_selected,
            dedup_import_readoshi,
            import_legacy_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Yomika");
}
