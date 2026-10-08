//! 宿主侧的真模型测试：这份构建发布出去的那几份 ONNX 图，真的跑得起来吗。
//!
//! 一次推理怎么做（张量布局、边缘生长、形状与有限性检查、GPU 实测探针）全在
//! `yomika_compute_core::onnx`，产品路径上一页都不从这里走（8-g③-iv 之后连宿主的
//! 会话都没有了）。留着这个模块是因为这些用例是**唯一**拿真图、真资源路径跑的证据：
//! 核心那边验证的是布局假设自洽，证明不了这些假设与仓库里那几份图一致；而
//! `tests/realcugan_dml_parity.rs` 那类夹具量的是另一件事。所以它整体进 `#[cfg(test)]`
//! （见 `inference.rs` 的模块声明）：模型文件与目录结构属于宿主仓库，测试二进制为此
//! 仍旧链 ONNX Runtime，出厂的那份二进制不链。

use std::path::Path;

pub use yomika_compute_core::onnx::OnnxEngine;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::upscale::UpscaleEngine;
    use yomika_compute_core::runtime::RuntimeId;

    /// A gradient tile whose red rises left to right and green top to bottom, both
    /// spanning the full range so a wrap-around or a channel swap is visible.
    fn gradient_rgba(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let red = (x * 255 / (width - 1).max(1)) as u8;
                let green = (y * 255 / (height - 1).max(1)) as u8;
                rgba.extend_from_slice(&[red, green, 128, 200]);
            }
        }
        rgba
    }

    /// One hosted model, run for real: size, channel order and alpha are all
    /// checked, so a bad export cannot reach the release.
    ///
    /// 核心那边的测试验证的是我自己的布局假设自洽；这一组是唯一能证明这些假设与真实
    /// 的图一致的检查——一个转置的、或 channels-last 的模型能通过其它所有测试，却输出
    /// 垃圾。
    fn assert_model_upscales(model: &std::path::Path, scale: u32, min_input_edge: u32) {
        let engine = match OnnxEngine::open(model, scale, 64_000_000, min_input_edge) {
            Ok(engine) => engine,
            Err(error) => panic!("opening {} failed: {error:?}", model.display()),
        };
        let (width, height) = (72_u32, 64_u32);
        let rgba = gradient_rgba(width, height);

        let output = match engine.upscale_tile(&rgba, width, height) {
            Ok(output) => output,
            Err(error) => panic!("running {} failed: {error:?}", model.display()),
        };
        assert_eq!(
            output.len(),
            (width * scale * height * scale * 4) as usize,
            "{} returned the wrong size",
            model.display()
        );
        // Alpha is carried by the fallback scaler, not the model.
        assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
        // The model must have written something other than the nearest-neighbour
        // input it was handed; identical output means the run was a no-op.
        let nearest = crate::inference::cpu_scale_rgba(&rgba, width, height, scale, 64_000_000)
            .expect("nearest-neighbour reference")
            .rgba;
        assert_ne!(
            output, nearest,
            "{} matched plain upscaling exactly",
            model.display()
        );
        // Red still rises left to right in the enlarged tile, so the channels did
        // not come back permuted.
        let stride = (width * scale) as usize * 4;
        let row = (height * scale / 2) as usize * stride;
        assert!(
            output[row] < output[row + stride - 4],
            "{} no longer increases along x",
            model.display()
        );
    }

    /// The hosted models, as the published catalog declares them, run for real.
    /// Scale and the minimum tile edge are read from the catalog fixture rather
    /// than repeated here: the file the app downloads against is the file this
    /// test trusts. The fixtures are the very bytes uploaded to the model
    /// repository, kept out of git under `docs/models/` — the loop skips them when
    /// they are absent (CI has no 100 MB of ONNX), so locally is where this test
    /// earns its keep.
    #[test]
    fn the_hosted_upscale_models_upscale_a_tile() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let Ok(bytes) = std::fs::read(directory.join("upscale-manifest.json")) else {
            eprintln!("skipping: no catalog fixture");
            return;
        };
        let catalog: crate::model_release::UpscaleCatalog =
            serde_json::from_slice(&bytes).expect("catalog fixture is valid JSON");
        for id in crate::model_release::HOSTED_UPSCALE_MODEL_IDS {
            let hosted = catalog
                .models
                .iter()
                .find(|model| model.id == *id)
                .unwrap_or_else(|| panic!("{id} is no longer in the published catalog"));
            let model = directory.join(format!("{id}.onnx"));
            if !model.exists() {
                eprintln!("skipping: {} is not present", model.display());
                continue;
            }
            assert_model_upscales(&model, hosted.scale, hosted.min_input_edge.unwrap_or(1));
        }
    }

    /// A tile thinner than the graph's floor is grown and cropped, not refused.
    /// The tiler really does hand out 9 px strips at a page's right edge, and
    /// Real-CUGAN's 18 px reflect padding cannot run on one.
    #[test]
    fn a_tile_below_the_models_floor_is_grown_and_cropped() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let model = directory.join("realcugan-2x-conservative.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let floor = 20;
        let engine = OnnxEngine::open(&model, 2, 64_000_000, floor).expect("engine");
        // Without the floor this exact call is what a page edge produces today:
        // ONNX Runtime answers "Pad reflect: pre-pad (18) exceeds maximum allowed
        // (7)". The engine has to absorb it and still answer 2x.
        for (width, height) in [(9_u32, 9_u32), (9, 64), (64, 9), (3, 3)] {
            let rgba = gradient_rgba(width, height);
            let output = engine
                .upscale_tile(&rgba, width, height)
                .unwrap_or_else(|error| panic!("{width}x{height} tile: {error:?}"));
            assert_eq!(output.len(), (width * 2 * height * 2 * 4) as usize, "{width}x{height}");
            assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
        }
        // And with no floor declared, the same strip is left exactly as it was:
        // the growth is what makes the model usable, not something the model does.
        let unpadded = OnnxEngine::open(&model, 2, 64_000_000, 1).expect("engine");
        assert!(unpadded.upscale_tile(&gradient_rgba(9, 9), 9, 9).is_err());
    }

    /// The whole tiling pipeline over a page whose width leaves a strip the model
    /// cannot take on its own. 129 px at tile 128 / margin 8 leaves 9 px in the
    /// last column, which is where a Real-CUGAN page would fail to render before
    /// the engine grew it.
    #[test]
    fn a_page_whose_edge_strip_is_too_thin_still_upscales() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let model = directory.join("realcugan-2x-conservative.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let (width, height) = (129_u32, 137_u32);
        let planned = crate::inference::upscale::plan_tiles(
            width,
            height,
            crate::inference::upscale::DEFAULT_TILE_SIZE,
            crate::inference::upscale::DEFAULT_TILE_PADDING,
        );
        assert!(
            planned
                .iter()
                .any(|tile| tile.padded_width < 20 || tile.padded_height < 20),
            "this page no longer plans a thin strip, so the test proves nothing"
        );

        let engine = OnnxEngine::open(&model, 2, 64_000_000, 20).expect("engine");
        let rgba = gradient_rgba(width, height);
        let options = crate::inference::upscale::UpscaleOptions {
            max_pixels: 64_000_000,
            ..crate::inference::upscale::UpscaleOptions::default()
        };
        let started = std::time::Instant::now();
        let upscaled =
            crate::inference::upscale::upscale_rgba(&engine, &rgba, width, height, options)
                .expect("upscale a whole page");
        eprintln!(
            "129x137 through {} tiles in {:?}",
            upscaled.tiles,
            started.elapsed()
        );
        assert_eq!((upscaled.width, upscaled.height), (258, 274));
        assert!(upscaled.rgba.chunks_exact(4).all(|pixel| pixel[3] == 200));
        // The page really was upscaled, not passed through.
        let nearest = crate::inference::cpu_scale_rgba(&rgba, width, height, 2, 64_000_000)
            .expect("nearest")
            .rgba;
        assert_ne!(upscaled.rgba, nearest);
    }

    /// 分块不是整页，而且**换多大的边距都救不回来**：这几份图里各有四处 `ReduceMean`
    /// 在**每块自己的特征图上**做空间池化（结构上由
    /// `tests/gpu/realcugan-parity/scan_global_attention.py -ScanTiling` 扫出来），
    /// 于是「这一块算出来的东西」取决于这块有多大、里面有什么。要是把注意力那几处
    /// 的池化在整页统计上做，或者整页一次推理，才谈得上精确；tile 变大只是把差距
    /// 压小（docs/89 的曲线）。
    ///
    /// 这条钉的是**曲线的方向**（大块更接近整页）与数量级，不是某台机器的绝对值：
    /// 换 CPU、换一版 ORT，绝对值会动，方向不会。整页与分块两边都是真模型真推理，
    /// 所以它同时是「分块管道没被改坏」的回归线。
    #[test]
    fn a_tiled_page_is_not_the_whole_page_and_a_bigger_tile_comes_closer() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        let model = directory.join("realcugan-2x-conservative.onnx");
        if !model.exists() {
            eprintln!("skipping: {} is not present", model.display());
            return;
        }
        let (width, height) = (1024_u32, 768_u32);
        let rgba = gradient_rgba(width, height);
        let engine = OnnxEngine::open(&model, 2, 64_000_000, 20).expect("engine");
        let whole = engine
            .upscale_tile(&rgba, width, height)
            .expect("the whole page in one pass");
        let error = |tile: u32| -> (f64, usize) {
            let options = crate::inference::upscale::UpscaleOptions {
                tile_size: tile,
                tile_padding: crate::inference::upscale::DEFAULT_TILE_PADDING,
                max_pixels: 64_000_000,
                ..crate::inference::upscale::UpscaleOptions::default()
            };
            let tiled =
                crate::inference::upscale::upscale_rgba(&engine, &rgba, width, height, options)
                    .expect("upscale the page in tiles");
            let difference = tiled
                .rgba
                .iter()
                .zip(whole.iter())
                .map(|(tiled, page)| tiled.abs_diff(*page) as f64)
                .sum::<f64>()
                / whole.len() as f64;
            (difference, tiled.tiles)
        };
        let (small, small_tiles) = error(128);
        let (big, big_tiles) = error(512);
        assert!(
            small_tiles > big_tiles && big_tiles > 1,
            "两条都要真的是分块：tile 128 走了 {small_tiles} 块，tile 512 走了 {big_tiles} 块"
        );
        eprintln!(
            "分块 vs 整页 {width}x{height}（平均字节差，1/255 = {:.3e}）：tile 128 = {small:.3e}（{small_tiles} 块），tile 512 = {big:.3e}（{big_tiles} 块）",
            1.0 / 255.0
        );
        // 方向要**明显**：实测这条梯度页上 128 是 512 的 1.76 倍，结构化页上是 2.14 倍，
        // 所以 1.3 倍是留了余量的下限；只写 `> big` 的话，差了 0.1% 也算过。
        assert!(
            small > big * 1.3,
            "tile 变大不再明显更接近整页：128 = {small:.3e}，512 = {big:.3e}"
        );
        assert!(
            big > 0.0,
            "分块与整页逐位相同——图里的空间池化不见了，这条断言要先重写"
        );
        // 上限只是「有没有别的东西坏掉了」的报警线，不是质量指标：这条梯度页离自然图像
        // 统计很远（一条纯斜坡），绝对值比 docs/89 里那些页状输入大一个量级，实测
        // 8.952e-02，所以线放在 2e-1。真要收紧质量，得拿页状输入去测。
        assert!(
            small < 2.0e-1,
            "分块与整页的差距比实测大了一个量级：{small:.3e}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_selected_provider_matches_cpu_reference_for_real_models() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/models");
        for (id, scale, floor) in [("waifu2x-upconv7", 2, 1), ("realcugan-2x-conservative", 2, 20), ("realcugan-2x-denoise3x", 2, 20), ("realesr-general-x4v3", 4, 1)] {
            let path = if id == "waifu2x-upconv7" { Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models/waifu2x-upconv7/model.onnx") } else { root.join(format!("{id}.onnx")) };
            if !path.is_file() { continue; }
            let chosen = OnnxEngine::open(&path, scale, 64_000_000, floor).unwrap();
            // 强制 CPU 参照：同一个文件、同一个形状，只换运行库。
            let cpu = OnnxEngine::open_with_runtime(&path, RuntimeId::Cpu, scale, 64_000_000, floor).unwrap();
            let rgba = gradient_rgba(72, 64);
            let a = chosen.upscale_tile(&rgba, 72, 64).unwrap();
            let b = cpu.upscale_tile(&rgba, 72, 64).unwrap();
            let mean = a.iter().zip(&b).map(|(a,b)| a.abs_diff(*b) as u64).sum::<u64>() as f64 / a.len() as f64;
            let row = (64 * scale / 2 * 72 * scale * 4) as usize;
            assert!(mean < 1.0, "{id}: 选中的运行库与 CPU 参照相差 {mean}");
            // 打出**实际**选中的那条：DirectML 在负 pad 上算错，Real-CUGAN 会因此
            // 被实测探针打回 CPU，这一行是那种回退唯一可见的地方。
            eprintln!("{id}: runtime={} mean byte error={mean:.3}; ref row ends={}/{}", chosen.runtime().as_str(), b[row], b[row+(72*scale*4) as usize-4]);
        }
    }

}
