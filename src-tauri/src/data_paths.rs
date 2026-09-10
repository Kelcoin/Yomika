use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub fn data_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let executable = std::env::current_exe()?;
        Ok(executable
            .parent()
            .ok_or_else(|| io::Error::other("Executable directory unavailable"))?
            .join("data"))
    }
    #[cfg(not(target_os = "windows"))]
    app.path().app_data_dir().map_err(io::Error::other)
}

pub fn prepare(app: &tauri::AppHandle) -> Result<(), String> {
    let target = data_dir(app).map_err(|error| error.to_string())?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let legacy = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let webview = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("EBWebView");
        migrate_legacy(&legacy, &webview, &target)?;
    }
    crate::bundled_models::prepare(&target).map_err(|error| error.to_string())
}

/// Copy-once migration. Source data and an existing portable database always survive.
fn migrate_legacy(source: &Path, webview: &Path, target: &Path) -> Result<(), String> {
    let marker = target.join("storage-layout-v1");
    if marker.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    if source != target && source.exists() {
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("yomika.sqlite3") {
                continue;
            }
            copy_missing(&entry.path(), &target.join(name)).map_err(|error| error.to_string())?;
        }
        let original = source.join("yomika.sqlite3");
        let destination = target.join("yomika.sqlite3");
        if original.is_file() && !destination.exists() {
            // SQLite backup includes committed WAL pages; copying only the main file loses them.
            let connection = rusqlite::Connection::open_with_flags(
                &original,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|error| error.to_string())?;
            let temporary =
                tempfile::NamedTempFile::new_in(target).map_err(|error| error.to_string())?;
            connection
                .backup(rusqlite::DatabaseName::Main, temporary.path(), None)
                .map_err(|error| error.to_string())?;
            temporary
                .as_file()
                .sync_all()
                .map_err(|error| error.to_string())?;
            temporary
                .persist_noclobber(destination)
                .map_err(|error| error.to_string())?;
        }
    }
    if webview.exists() {
        copy_missing(webview, &target.join("webview").join("EBWebView")).map_err(|error| {
            format!("WebView data migration failed; close other Yomika windows and retry: {error}")
        })?;
    }
    fs::write(marker, b"1\n").map_err(|error| error.to_string())
}

fn copy_missing(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other(
            "Data migration cannot follow symbolic links",
        ));
    }
    if target.exists() && fs::symlink_metadata(target)?.file_type().is_symlink() {
        return Err(io::Error::other("Data migration target is a symbolic link"));
    }
    if metadata.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_missing(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else if metadata.is_file() && !target.exists() {
        let parent = target
            .parent()
            .ok_or_else(|| io::Error::other("Missing destination directory"))?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut fs::File::open(source)?, temporary.as_file_mut())?;
        temporary
            .persist_noclobber(target)
            .map_err(|error| error.error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_includes_wal_and_preserves_relative_cache_paths_and_originals() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("old");
        let target = fixture.path().join("new");
        let webview = fixture.path().join("EBWebView");
        fs::create_dir_all(source.join("cache/images")).unwrap();
        fs::create_dir_all(&webview).unwrap();
        fs::write(source.join("cache/images/a.bin"), b"page").unwrap();
        fs::write(webview.join("Preferences"), b"web-settings").unwrap();
        let original = rusqlite::Connection::open(source.join("yomika.sqlite3")).unwrap();
        original.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE reading_progress(page INTEGER); INSERT INTO reading_progress VALUES(42);").unwrap();
        assert!(source.join("yomika.sqlite3-wal").exists());
        migrate_legacy(&source, &webview, &target).unwrap();
        let migrated = rusqlite::Connection::open(target.join("yomika.sqlite3")).unwrap();
        assert_eq!(
            migrated
                .query_row("SELECT page FROM reading_progress", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert_eq!(
            fs::read(target.join("cache/images/a.bin")).unwrap(),
            b"page"
        );
        assert_eq!(
            fs::read(target.join("webview/EBWebView/Preferences")).unwrap(),
            b"web-settings"
        );
        original
            .execute("UPDATE reading_progress SET page=99", [])
            .unwrap();
        migrate_legacy(&source, &webview, &target).unwrap();
        assert_eq!(
            migrated
                .query_row("SELECT page FROM reading_progress", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            42
        );
        assert!(source.join("cache/images/a.bin").exists());
    }

    #[test]
    fn migration_never_overwrites_existing_portable_data_or_models() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("old");
        let target = fixture.path().join("new");
        for directory in [&source, &target] {
            fs::create_dir_all(directory.join("models")).unwrap();
        }
        fs::write(source.join("yomika.sqlite3"), b"unused-old").unwrap();
        fs::write(target.join("yomika.sqlite3"), b"portable").unwrap();
        fs::write(source.join("models/a.onnx"), b"old-model").unwrap();
        fs::write(target.join("models/a.onnx"), b"new-model").unwrap();
        migrate_legacy(&source, &fixture.path().join("missing-webview"), &target).unwrap();
        assert_eq!(
            fs::read(target.join("yomika.sqlite3")).unwrap(),
            b"portable"
        );
        assert_eq!(
            fs::read(target.join("models/a.onnx")).unwrap(),
            b"new-model"
        );
    }
}
