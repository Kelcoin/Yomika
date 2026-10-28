use std::{
    fs,
    io::{self, Write},
    path::Path,
};

const FILES: &[(&str, &[u8])] = &[
    #[cfg(target_os = "android")]
    ("model.tflite", include_bytes!("../resources/models/waifu2x-upconv7/model.tflite")),
    #[cfg(target_os = "android")]
    ("yomika-accelerator.json", include_bytes!("../resources/models/waifu2x-upconv7/yomika-accelerator.json")),
    (
        "model.onnx",
        include_bytes!("../resources/models/waifu2x-upconv7/model.onnx"),
    ),
    (
        "LICENSE.txt",
        include_bytes!("../resources/models/waifu2x-upconv7/LICENSE.txt"),
    ),
    (
        "provenance.json",
        include_bytes!("../resources/models/waifu2x-upconv7/provenance.json"),
    ),
    (
        "yomika-model.json",
        include_bytes!("../resources/models/waifu2x-upconv7/yomika-model.json"),
    ),
];

pub fn prepare(data: &Path) -> io::Result<()> {
    let root = data.join("models/waifu2x-upconv7/1");
    fs::create_dir_all(&root)?;
    // Publish the manifest last; discovery must never expose a partial model.
    for (name, bytes) in FILES {
        let path = root.join(name);
        if path.is_file() {
            continue;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&root)?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        if let Err(error) = temporary.persist_noclobber(path) {
            if error.error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error.error);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::upscale::UpscaleEngine;

    #[test]
    fn bundled_waifu2x_installs_and_runs_without_overwriting_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        prepare(directory.path()).unwrap();
        let root = directory.path().join("models/waifu2x-upconv7/1");
        let manifest: crate::inference::ModelManifest =
            serde_json::from_slice(&fs::read(root.join("yomika-model.json")).unwrap()).unwrap();
        assert_eq!(manifest.scale, 2);
        crate::inference::validate_model_bytes(
            &manifest,
            &fs::read(root.join("model.onnx")).unwrap(),
        )
        .unwrap();
        let engine =
            crate::inference::onnx::OnnxEngine::open(&root.join("model.onnx"), 2, 64000000, 1)
                .unwrap();
        let pixels: Vec<u8> = (0..35)
            .flat_map(|i| [(i * 5) as u8, 80, 160, 127])
            .collect();
        let output = engine.upscale_tile(&pixels, 7, 5).unwrap();
        assert_eq!(output.len(), 14 * 10 * 4);
        assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 127));
        let pixels: Vec<u8> = (0..35 * 29)
            .flat_map(|i| [(i % 251) as u8, ((i * 17) % 251) as u8, 160, 127])
            .collect();
        let whole = engine.upscale_tile(&pixels, 35, 29).unwrap();
        let tiled = crate::inference::upscale::upscale_rgba(
            &engine,
            &pixels,
            35,
            29,
            crate::inference::upscale::UpscaleOptions {
                tile_size: 16,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            whole
                .iter()
                .zip(&tiled.rgba)
                .all(|(&a, &b)| a.abs_diff(b) <= 1),
            "tile edges must match whole-image inference"
        );
        fs::write(root.join("LICENSE.txt"), b"existing").unwrap();
        prepare(directory.path()).unwrap();
        assert_eq!(fs::read(root.join("LICENSE.txt")).unwrap(), b"existing");
    }
}
