pub(crate) fn publish_archive_download(
    part: &std::path::Path,
    directory: &std::path::Path,
    filename: &str,
) -> Result<String, String> {
    publish_with_link(part, directory, filename, |source, destination| {
        std::fs::hard_link(source, destination)
    })
}

fn publish_with_link(
    part: &std::path::Path,
    directory: &std::path::Path,
    filename: &str,
    link: impl Fn(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<String, String> {
    for suffix in 0..1000 {
        let name = if suffix == 0 {
            filename.to_string()
        } else {
            let path = std::path::Path::new(filename);
            format!(
                "{} ({suffix}).{}",
                path.file_stem().unwrap_or_default().to_string_lossy(),
                path.extension().unwrap_or_default().to_string_lossy()
            )
        };
        let destination = directory.join(name);
        match link(part, &destination) {
            Ok(()) => {
                std::fs::remove_file(part).map_err(|error| error.to_string())?;
                return Ok(destination.to_string_lossy().into_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            // Android emulated storage (FUSE) and FAT volumes reject hard links
            // even when ordinary file writes are permitted. Reserve the destination
            // exclusively so a concurrent download can never be overwritten.
            Err(_) => match copy_exclusive(part, &destination) {
                Ok(()) => {
                    std::fs::remove_file(part).map_err(|error| error.to_string())?;
                    return Ok(destination.to_string_lossy().into_owned());
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            },
        }
    }
    Err("Too many existing copies of this archive".into())
}

fn copy_exclusive(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    let mut input = std::fs::File::open(source)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    drop(output);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(std::path::PathBuf);
    impl Directory {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("yomika-publish-{}-{stamp}", std::process::id()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn publishes_when_android_storage_rejects_hard_links_without_overwriting() {
        let directory = Directory::new();
        let part = directory.0.join("archive.zip.part");
        std::fs::write(&part, b"new archive").unwrap();
        std::fs::write(directory.0.join("archive.zip"), b"existing archive").unwrap();
        let path = publish_with_link(&part, &directory.0, "archive.zip", |_, _| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        })
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"new archive");
        assert_eq!(
            std::fs::read(directory.0.join("archive.zip")).unwrap(),
            b"existing archive"
        );
        assert!(!part.exists());
    }

    #[test]
    fn failed_publication_keeps_the_download_for_retry() {
        let directory = Directory::new();
        let part = directory.0.join("archive.zip.part");
        std::fs::write(&part, b"complete download").unwrap();
        assert!(
            publish_archive_download(&part, &directory.0.join("missing"), "archive.zip").is_err()
        );
        assert_eq!(std::fs::read(&part).unwrap(), b"complete download");
    }

    #[test]
    fn normal_publication_moves_the_complete_archive() {
        let directory = Directory::new();
        let part = directory.0.join("archive.zip.part");
        std::fs::write(&part, b"complete download").unwrap();
        let path = publish_archive_download(&part, &directory.0, "archive.zip").unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"complete download");
        assert!(!part.exists());
    }
}
