mod commands;
mod cache;
mod db;
mod diagnostics;
mod dedup;
mod domain;
mod inference;
mod network;
mod settings;

use commands::library::{
    add_archive_to_category, create_task, delete_archive, list_archives, list_categories,
    list_reading_history, list_servers, list_tasks, list_watchlist, load_archive_metadata,
    load_archive_thumbnail, load_reader_manifest, load_reader_page, load_reading_progress,
    refresh_archives, replace_archives, retry_task, save_reading_progress, save_server, set_watchlist,
    update_archive_metadata, update_task, upload_archive,
};
use cache::cache_evict;
use commands::platform::platform_capabilities;
use commands::sync::{
    append_sync_journal, build_sync_segment, claim_sync_journal, create_sync_key, decrypt_sync_manifest,
    encrypt_sync_manifest, list_sync_journal, list_webdav_accounts, merge_sync_manifests,
    save_webdav_account, set_sync_journal_state, sync_webdav_scope,
};
use inference::{inference_cancel, inference_checkpoint, inference_clear_cache, inference_cpu_scale, inference_get_job, inference_install_model, inference_pause, inference_probe, inference_resume, inference_start, inference_validate_model};
use dedup::{dedup_check_file, dedup_find_exact, dedup_save_feature};
use commands::eh::{list_eh_accounts, save_eh_account};
use commands::legacy::import_legacy_export;
use db::Database;
use tauri::Manager;
use settings::{import_legacy_preferences, load_preferences, save_preferences};

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
            list_servers,
            save_server,
            replace_archives,
            refresh_archives,
            load_reader_manifest,
            load_reader_page,
            list_archives,
            load_archive_metadata,
            load_archive_thumbnail,
            delete_archive,
            create_task,
            list_tasks,
            update_task,
            retry_task,
            upload_archive,
            list_categories,
            add_archive_to_category,
            update_archive_metadata,
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
            save_eh_account,
            list_eh_accounts,
            dedup_check_file,
            dedup_save_feature,
            dedup_find_exact,
            import_legacy_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Yomika");
}
