use crate::{db::Database, domain::result::CommandResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use tauri::{Manager, State};
use unarc_rs::unified::{ArchiveEntryKind, ArchiveFormat, ArchiveOptions, UnifiedArchive};

const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
type LocalZip = zip::ZipArchive<std::fs::File>;

enum LocalArchive {
    Zip(LocalZip),
    Other(Box<UnifiedArchive<BufReader<std::fs::File>>>),
}

impl LocalArchive {
    fn open(path: &Path) -> Result<Self, String> {
        let mut file = BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
        let format = ArchiveFormat::detect(&mut file, Some(path)).map_err(|e| e.to_string())?;
        match format {
            Some(ArchiveFormat::Zip) => zip::ZipArchive::new(file.into_inner())
                .map(Self::Zip)
                .map_err(|e| e.to_string()),
            Some(
                format @ (ArchiveFormat::Rar
                | ArchiveFormat::SevenZ
                | ArchiveFormat::Tar
                | ArchiveFormat::Tgz
                | ArchiveFormat::Gz),
            ) => {
                let options = ArchiveOptions::new()
                    .with_max_entry_size(Some(MAX_ENTRY_BYTES))
                    .with_max_total_size(Some(256 * 1024 * 1024));
                let mut archive = format
                    .open_with_options(file, options)
                    .map_err(|e| e.to_string())?;
                if format == ArchiveFormat::Gz {
                    // The download directory accepts .gz as well as .tar.gz.
                    // If a standalone compressed image has no image suffix, treat it as TAR.
                    let name = path
                        .file_stem()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default();
                    if is_image_name(name) {
                        archive.set_single_file_name(name.to_owned());
                    } else {
                        let file =
                            BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
                        archive = ArchiveFormat::Tgz
                            .open_with_options(file, archive.options().clone())
                            .map_err(|e| e.to_string())?;
                    }
                }
                Ok(Self::Other(Box::new(archive)))
            }
            _ => Err("无法识别本地档案的压缩格式".into()),
        }
    }

    fn page_entries(&mut self) -> Result<Vec<usize>, String> {
        let mut pages = Vec::new();
        let mut add = |index, name: &str| {
            if is_image_name(name) {
                pages.push((name.replace('\\', "/").to_lowercase(), index));
            }
        };
        match self {
            Self::Zip(archive) => {
                for index in 0..archive.len() {
                    if let Some(name) = archive.name_for_index(index) {
                        add(index, name);
                    }
                }
            }
            Self::Other(archive) => {
                for (index, entry) in archive.entries_iter().enumerate() {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entry.kind() == ArchiveEntryKind::File {
                        add(index, entry.name());
                    }
                }
            }
        }
        pages.sort_by(|a, b| natural_cmp(&a.0, &b.0).then(a.0.cmp(&b.0)));
        Ok(pages.into_iter().map(|(_, index)| index).collect())
    }

    // Read just the selected entry without expanding paths onto the filesystem.
    fn read_page(&mut self, index: usize) -> Result<Vec<u8>, String> {
        match self {
            Self::Zip(archive) => {
                let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
                if entry.is_dir() || !is_image_name(entry.name()) {
                    return Err("本地页面不存在".into());
                }
                if entry.size() > MAX_ENTRY_BYTES {
                    return Err("页面图片文件过大".into());
                }
                let mut bytes = Vec::new();
                (&mut entry)
                    .take(MAX_ENTRY_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() as u64 > MAX_ENTRY_BYTES {
                    return Err("页面图片文件过大".into());
                }
                Ok(bytes)
            }
            Self::Other(archive) => {
                for current in 0..=index {
                    let entry = archive
                        .next_entry()
                        .map_err(|e| e.to_string())?
                        .ok_or("本地页面不存在")?;
                    if current == index {
                        if entry.kind() != ArchiveEntryKind::File || !is_image_name(entry.name()) {
                            return Err("本地页面不存在".into());
                        }
                        return archive.read(&entry).map_err(|e| e.to_string());
                    }
                    archive.skip(&entry).map_err(|e| e.to_string())?;
                }
                Err("本地页面不存在".into())
            }
        }
    }
}

fn is_image_name(name: &str) -> bool {
    let name = name.replace('\\', "/");
    !name.ends_with('/')
        && !name
            .split('/')
            .any(|part| part.eq_ignore_ascii_case("__MACOSX") || part.starts_with('.'))
        && Path::new(&name)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "gif"
                )
            })
}

fn thumbnail(bytes: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, String> {
    static GENERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = GENERATION.lock().unwrap_or_else(|error| error.into_inner());
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(width, height)
        .to_rgb8();
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    Ok(output)
}

fn generate_cover(path: &Path) -> Result<Vec<u8>, String> {
    let index = *LocalArchive::open(path)?
        .page_entries()?
        .first()
        .ok_or("本地档案没有可显示的图片")?;
    thumbnail(LocalArchive::open(path)?.read_page(index)?, 320, 480)
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a = a.chars().peekable();
    let mut b = b.chars().peekable();
    loop {
        match (a.peek(), b.peek()) {
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut x = String::new();
                let mut y = String::new();
                while a.peek().is_some_and(char::is_ascii_digit) {
                    x.push(a.next().unwrap());
                }
                while b.peek().is_some_and(char::is_ascii_digit) {
                    y.push(b.next().unwrap());
                }
                let x = x.trim_start_matches('0');
                let y = y.trim_start_matches('0');
                let order = x.len().cmp(&y.len()).then(x.cmp(y));
                if !order.is_eq() {
                    return order;
                }
            }
            _ => match (a.next(), b.next()) {
                (Some(x), Some(y)) if x == y => {}
                (x, y) => return x.cmp(&y),
            },
        }
    }
}

#[tauri::command]
pub async fn load_local_archive_cover(
    app: tauri::AppHandle,
    path: String,
    database: State<'_, Database>,
) -> Result<CommandResult<String>, String> {
    // An IPC caller can only ask for a registered local archive, never any file.
    let known = database
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_archives WHERE path=?1)",
            [&path],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?;
    if !known {
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "本地档案不存在",
            false,
        ));
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("local-covers");
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let source = Path::new(&path);
        let meta = source.metadata().map_err(|e| e.to_string())?;
        let revision = format!("{path}:{}:{:?}:v1", meta.len(), meta.modified());
        let cached = cache.join(format!(
            "{}.jpg",
            blake3::hash(revision.as_bytes()).to_hex()
        ));
        let bytes = match std::fs::read(&cached) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Bound simultaneous decodes on phones: many visible covers
                // must not each allocate a full-resolution image at once.
                static GENERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
                let _guard = GENERATION.lock().unwrap_or_else(|error| error.into_inner());
                let bytes = match std::fs::read(&cached) {
                    Ok(bytes) => bytes,
                    Err(_) => generate_cover(source)?,
                };
                std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
                std::fs::write(cached, &bytes).map_err(|e| e.to_string())?;
                bytes
            }
        };
        Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(match result {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure("LOCAL_COVER_UNAVAILABLE", error, false),
    })
}

fn registered_archive(
    database: &Database,
    path: &str,
) -> Result<Option<(String, Vec<String>)>, String> {
    use rusqlite::OptionalExtension;
    database
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .query_row(
            "SELECT title, tags_json FROM local_archives WHERE path=?1",
            [path],
            |row| {
                let tags: Option<String> = row.get(1)?;
                Ok((
                    row.get(0)?,
                    tags.and_then(|text| serde_json::from_str(&text).ok())
                        .unwrap_or_default(),
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_local_archive_manifest(
    path: String,
    database: State<'_, Database>,
) -> Result<CommandResult<serde_json::Value>, String> {
    let Some((title, tags)) = registered_archive(&database, &path)? else {
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "本地档案不存在",
            false,
        ));
    };
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let path = Path::new(&path);
        let size_bytes = path.metadata().map_err(|error| error.to_string())?.len();
        let entries = LocalArchive::open(path)?.page_entries()?;
        if entries.is_empty() { return Err("本地档案没有可显示的图片".into()); }
        Ok(serde_json::json!({ "title": title, "tags": tags, "sizeBytes": size_bytes, "entries": entries }))
    }).await.map_err(|e| e.to_string())?;
    Ok(match result {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    })
}

#[tauri::command]
pub async fn load_local_archive_page(
    path: String,
    entry: usize,
    database: State<'_, Database>,
) -> Result<CommandResult<String>, String> {
    if registered_archive(&database, &path)?.is_none() {
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "本地档案不存在",
            false,
        ));
    }
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let bytes = LocalArchive::open(Path::new(&path))?.read_page(entry)?;
        Ok(format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(thumbnail(bytes, 240, 360)?)
        ))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(match result {
        Ok(value) => CommandResult::success(value),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    })
}

#[tauri::command]
pub async fn load_local_archive_original(
    path: String,
    entry: usize,
    database: State<'_, Database>,
) -> Result<tauri::ipc::Response, String> {
    use crate::domain::result::into_binary_response;
    if registered_archive(&database, &path)?.is_none() {
        return Ok(into_binary_response(CommandResult::failure(
            "LRR_NOT_FOUND",
            "本地档案不存在",
            false,
        )));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        LocalArchive::open(Path::new(&path))?.read_page(entry)
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(into_binary_response(match result {
        Ok(bytes) => CommandResult::success(bytes),
        Err(error) => CommandResult::failure("INVALID_RESPONSE", error, false),
    }))
}

#[tauri::command]
pub async fn open_local_archive_reader_file(
    path: String,
    entry: usize,
    task_id: Option<String>,
    reader_session: Option<u32>,
    page_index: Option<i64>,
    database: State<'_, Database>,
    compute: State<'_, crate::compute::ComputeHandle>,
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<CommandResult<Option<crate::commands::library::ReaderCachedFile>>, String> {
    use std::io::{Seek, Write};
    let task = crate::inference::cancel::begin(task_id.as_deref());
    if task.cancelled() {
        return Ok(CommandResult::success(None));
    }
    if registered_archive(&database, &path)?.is_none() {
        return Ok(CommandResult::failure("LRR_NOT_FOUND", "本地档案不存在", false));
    }
    let data = crate::data_paths::data_dir(&app).map_err(|error| error.to_string())?;
    let cancel = task.token();
    let opened = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        if cancel.cancelled() {
            return Ok(None);
        }
        let bytes = LocalArchive::open(Path::new(&path))?.read_page(entry)?;
        if cancel.cancelled() {
            return Ok(None);
        }
        let location = crate::cache::CachedBlobLocation {
            path: std::path::PathBuf::new(),
            content_hash: blake3::hash(&bytes).to_hex().to_string(),
            byte_length: bytes.len() as u64,
        };
        let mut file = tempfile::tempfile_in(data).map_err(|error| error.to_string())?;
        file.write_all(&bytes).and_then(|_| file.rewind()).map_err(|error| error.to_string())?;
        Ok(Some((location, file)))
    }).await.map_err(|error| error.to_string())?;
    let (location, file) = match opened {
        Ok(Some(value)) if !task.cancelled() => value,
        Ok(_) => return Ok(CommandResult::success(None)),
        Err(error) => return Ok(CommandResult::failure("INVALID_RESPONSE", error, false)),
    };
    crate::commands::library::lease_open_reader_file(
        &database, &compute, webview.label(), "reader-local", location, file, reader_session.zip(page_index),
    )
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalArchiveProgress {
    page_index: usize,
    continuous: bool,
}

#[tauri::command(async)]
pub fn local_archive_progress(
    path: String,
    progress: Option<LocalArchiveProgress>,
    allow_regression: Option<bool>,
    database: State<'_, Database>,
) -> Result<CommandResult<Option<LocalArchiveProgress>>, String> {
    let connection = database.connection.lock().map_err(|e| e.to_string())?;
    read_or_save_progress(&connection, &path, progress, allow_regression)
}

fn read_or_save_progress(
    connection: &rusqlite::Connection,
    path: &str,
    progress: Option<LocalArchiveProgress>,
    allow_regression: Option<bool>,
) -> Result<CommandResult<Option<LocalArchiveProgress>>, String> {
    use rusqlite::OptionalExtension;
    let stored: Option<Option<String>> = connection
        .query_row(
            "SELECT reading_progress_json FROM local_archives WHERE path=?1",
            [&path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(stored) = stored else {
        return Ok(CommandResult::failure(
            "LRR_NOT_FOUND",
            "本地档案不存在",
            false,
        ));
    };
    let stored: Option<LocalArchiveProgress> = stored
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok());
    let Some(mut progress) = progress else {
        return Ok(CommandResult::success(stored));
    };
    if allow_regression == Some(false) {
        if let Some(stored) = stored {
            progress.page_index = progress.page_index.max(stored.page_index);
        }
    }
    let data = serde_json::to_string(&progress).map_err(|e| e.to_string())?;
    connection
        .execute(
            "UPDATE local_archives SET reading_progress_json=?2 WHERE path=?1",
            [path, &data],
        )
        .map_err(|e| e.to_string())?;
    Ok(CommandResult::success(Some(progress)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn downloaded_copy_progress_is_independent_of_online_progress_and_other_copies() {
        let database = Database::open_path(":memory:").unwrap();
        let connection = database.connection.lock().unwrap();
        connection.execute_batch("INSERT INTO local_archives (path, archive_id, title, file_size, added_at)
            VALUES ('first.cbz', 'same-id', 'First', 0, 1), ('second.cbz', 'same-id', 'Second', 0, 1);").unwrap();
        let saved = read_or_save_progress(
            &connection,
            "first.cbz",
            Some(LocalArchiveProgress {
                page_index: 9,
                continuous: true,
            }),
            None,
        )
        .unwrap();
        assert!(matches!(
            saved,
            CommandResult::Success {
                value: Some(LocalArchiveProgress {
                    page_index: 9,
                    continuous: true
                }),
                ..
            }
        ));
        assert!(matches!(
            read_or_save_progress(&connection, "second.cbz", None, None).unwrap(),
            CommandResult::Success { value: None, .. }
        ));
        let online_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM reading_progress", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(online_count, 0);
    }

    #[test]
    fn cover_uses_first_natural_page_without_extracting_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.cbz");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, color) in [("10.png", [0, 255, 0]), ("2.png", [255, 0, 0])] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            let image = image::RgbImage::from_pixel(600, 900, image::Rgb(color));
            let mut png = Cursor::new(Vec::new());
            image.write_to(&mut png, image::ImageFormat::Png).unwrap();
            archive.write_all(png.get_ref()).unwrap();
        }
        archive.finish().unwrap();
        let cover = image::load_from_memory(&generate_cover(&path).unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(cover.dimensions(), (320, 480));
        assert!(cover.get_pixel(100, 100)[0] > 240);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
