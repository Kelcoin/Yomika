use std::io::{Cursor, Read};
use std::path::Path;
use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{Manager, State};
use crate::{db::Database, domain::result::CommandResult};

// Read a single entry, never expand a complete archive or trust its paths.
fn generate_cover(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("无法读取本地 ZIP/CBZ 封面：{e}"))?;
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let extension = Path::new(&name).extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !entry.is_dir() && !name.starts_with("__MACOSX/") && matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif") {
            entries.push((name.to_lowercase(), index));
        }
    }
    entries.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    let (_, index) = entries.first().ok_or("本地档案没有可显示的图片")?;
    let mut entry = archive.by_index(*index).map_err(|e| e.to_string())?;
    if entry.size() > 32 * 1024 * 1024 { return Err("封面图片文件过大".into()); }
    let mut bytes = Vec::new();
    (&mut entry).take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|e| e.to_string())?.thumbnail(320, 480).to_rgb8();
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85).encode_image(&image).map_err(|e| e.to_string())?;
    Ok(output)
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a = a.chars().peekable();
    let mut b = b.chars().peekable();
    loop {
        match (a.peek(), b.peek()) {
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut x = String::new(); let mut y = String::new();
                while a.peek().is_some_and(char::is_ascii_digit) { x.push(a.next().unwrap()); }
                while b.peek().is_some_and(char::is_ascii_digit) { y.push(b.next().unwrap()); }
                let x = x.trim_start_matches('0'); let y = y.trim_start_matches('0');
                let order = x.len().cmp(&y.len()).then(x.cmp(y));
                if !order.is_eq() { return order; }
            }
            _ => match (a.next(), b.next()) {
                (Some(x), Some(y)) if x == y => {},
                (x, y) => return x.cmp(&y),
            }
        }
    }
}

#[tauri::command]
pub async fn load_local_archive_cover(app: tauri::AppHandle, path: String, database: State<'_, Database>) -> Result<CommandResult<String>, String> {
    // An IPC caller can only ask for a registered local archive, never any file.
    let known = database.connection.lock().map_err(|e| e.to_string())?
        .query_row("SELECT EXISTS(SELECT 1 FROM local_archives WHERE path=?1)", [&path], |row| row.get::<_, bool>(0)).map_err(|e| e.to_string())?;
    if !known { return Ok(CommandResult::failure("LRR_NOT_FOUND", "本地档案不存在", false)); }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("local-covers");
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let source = Path::new(&path);
        let meta = source.metadata().map_err(|e| e.to_string())?;
        let revision = format!("{path}:{}:{:?}:v1", meta.len(), meta.modified());
        let cached = cache.join(format!("{}.jpg", blake3::hash(revision.as_bytes()).to_hex()));
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
    }).await.map_err(|e| e.to_string())?;
    Ok(match result { Ok(value) => CommandResult::success(value), Err(error) => CommandResult::failure("LOCAL_COVER_UNAVAILABLE", error, false) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn cover_uses_first_natural_page_without_extracting_archive() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.cbz");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, color) in [("10.png", [0, 255, 0]), ("2.png", [255, 0, 0])] {
            archive.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            let image = image::RgbImage::from_pixel(600, 900, image::Rgb(color));
            let mut png = Cursor::new(Vec::new());
            image.write_to(&mut png, image::ImageFormat::Png).unwrap();
            archive.write_all(png.get_ref()).unwrap();
        }
        archive.finish().unwrap();
        let cover = image::load_from_memory(&generate_cover(&path).unwrap()).unwrap().to_rgb8();
        assert_eq!(cover.dimensions(), (320, 480));
        assert!(cover.get_pixel(100, 100)[0] > 240);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
