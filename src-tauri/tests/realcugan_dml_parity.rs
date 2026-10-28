//! DirectML/CPU parity harness for the hosted Real-CUGAN graphs.
//!
//! Real-CUGAN computes wrongly on DirectML, and the reason is a negative-pad `Pad`
//! node (isolated case below: mean 0.5); the ONNX `Pad` schema never defines
//! negative pads, so the shipped graphs are rewritten as `Slice` before upload and
//! then agree with the CPU within the release thresholds of docs/71 §4.6. This
//! harness is where that verdict was measured, and it keeps the wall-clock and
//! operator-attribution evidence the backend matrix needs.
//!
//! **It is a development target, not a product path.** 8-g③-iv took ONNX Runtime
//! out of the shipped host binary (`cargo tree -e normal` and `pe-imports.py`
//! both say so); this file still opens sessions because `ort` and
//! `yomika-compute-core` are declared in the host manifest's `[dev-dependencies]`,
//! and `resolver = "2"` keeps those out of a normal build. The product opens
//! graphs in the worker now, under the same `core::runtime` policy these tests
//! hold to.
//!
//! Two things make the diagnosis reproducible:
//!
//! * `tests/gpu/realcugan-parity/patch_negative_pads.py` rewrites the crop
//!   `Pad` nodes whose pads are negative as `Slice`. DirectML computes those
//!   pads wrongly, the ONNX `Pad` schema never defines negative pads, and the
//!   rewrite is byte-identical on the CPU.
//! * `tests/gpu/realcugan-parity/make_cases.py` emits the single-operator
//!   graphs that attribute the defect to one node instead of the whole network.
//!
//! Everything under `debug_outputs/` is a local generated artifact, so a test
//! whose fixture is missing prints why and returns instead of failing: a clean
//! checkout has no models at all (`docs/` and the installed copies are local),
//! and a red suite that only means "no fixture" trains people to ignore red.
//!
//! Run: `scripts\compute\realcugan-parity.ps1` (generates the fixtures first),
//! or `cargo test --test realcugan_dml_parity -- --nocapture --test-threads=1`.

#![cfg(windows)]

use std::path::{Path, PathBuf};

use ort::ep::ExecutionProvider;
use ort::session::Session;
use ort::value::DynValue;

const DEFAULT_WIDTH: usize = 72;
const DEFAULT_HEIGHT: usize = 64;
const CONSERVATIVE: &str = "realcugan-2x-conservative";
const DENOISE: &str = "realcugan-2x-denoise3x";

#[test]
#[ignore = "requires the exported NomosUni fixture and a DirectML GPU"]
fn nomosuni_cpu_gpu_contract() {
    use yomika_compute_core::{onnx::OnnxEngine, runtime::RuntimeId, upscale::UpscaleEngine};
    let path = root().join("src-tauri/target/nomosuni.onnx");
    let cpu = OnnxEngine::open_with_runtime(&path,RuntimeId::Cpu,2,1_000_000,1).unwrap();
    let gpu = OnnxEngine::open_with_runtime(&path,RuntimeId::DirectMl,2,1_000_000,1).unwrap();
    let rgba: Vec<u8> = (0..32*40).flat_map(|i| [(i%32*7) as u8,(i/32*5) as u8,127,255]).collect();
    let expected=cpu.upscale_tile(&rgba,32,40).unwrap();
    let actual=gpu.upscale_tile(&rgba,32,40).unwrap();
    assert_eq!(actual.len(),64*80*4);
    let mae=expected.iter().zip(actual).map(|(a,b)|f64::from(a.abs_diff(b))).sum::<f64>()/expected.len() as f64;
    assert!(mae<1.0,"NomosUni CPU/DirectML MAE={mae}");
}

#[test]
#[ignore = "requires the pinned Real-ESRGAN model and a DirectML GPU"]
fn realesrgan_x4plus_cpu_gpu_contract() {
    use yomika_compute_core::{onnx::OnnxEngine, runtime::RuntimeId, upscale::UpscaleEngine};
    let path = root().join("src-tauri/target/realesrgan_x4plus.onnx");
    let bytes = std::fs::read(&path).expect("download the pinned catalog model first");
    use sha2::{Digest, Sha256};
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), "1c0fc21d1d6d7df7f39c1fa23c73138a87a01ea0b3ac56ebd0ea943e62e12800");
    let cpu = OnnxEngine::open_with_runtime(&path, RuntimeId::Cpu, 4, 16_000_000, 1).unwrap();
    let gpu = OnnxEngine::open_with_runtime(&path, RuntimeId::DirectMl, 4, 16_000_000, 1).unwrap();
    let rgba: Vec<u8> = (0..32*40).flat_map(|i| [(i%32*7) as u8, (i/32*5) as u8, 127, 255]).collect();
    let reference = cpu.upscale_tile(&rgba,32,40).unwrap();
    let result = gpu.upscale_tile(&rgba,32,40).unwrap();
    assert_eq!(result.len(), 128*160*4);
    let error = reference.iter().zip(&result).map(|(a,b)|f64::from(a.abs_diff(*b))).sum::<f64>()/result.len() as f64;
    assert!(error < 1.0, "Real-ESRGAN CPU/GPU mismatch: {error}");
}

/// Opt-in regression on an actual page; vary shapes within one cached session.
/// YOMIKA_PARITY_IMAGE points at a local image, never a network archive.
#[test]
#[ignore = "requires a local page fixture and DirectML GPU"]
fn real_page_tiles_match_cpu() {
    use yomika_compute_core::{onnx::OnnxEngine, runtime::RuntimeId, upscale::UpscaleEngine};
    let image_path = std::env::var("YOMIKA_PARITY_IMAGE").expect("YOMIKA_PARITY_IMAGE");
    let page = image::load_from_memory(&std::fs::read(image_path).unwrap()).unwrap().to_rgba8();
    for stem in [CONSERVATIVE, DENOISE] {
        let suffix = std::env::var("YOMIKA_PARITY_MODEL_SUFFIX").unwrap_or_else(|_| "-dml1".into());
        let model = root().join("docs/models").join(format!("{stem}{suffix}.onnx"));
        let cpu = OnnxEngine::open_with_runtime(&model, RuntimeId::Cpu, 2, 16_000_000, 20).unwrap();
        let gpu = OnnxEngine::open_with_runtime(&model, RuntimeId::DirectMl, 2, 16_000_000, 20).unwrap();
        let edge = std::env::var("YOMIKA_PARITY_TILE").ok().map(|s| s.parse().unwrap()).unwrap_or(1024);
        let tiles = yomika_compute_core::upscale::plan_tiles(page.width(),page.height(),edge,8);
        let mut assembled = vec![0;page.width() as usize*page.height() as usize*16];
        for planned in tiles {
            let (x,y,w,h)=(planned.padded_x,planned.padded_y,planned.padded_width,planned.padded_height);
            let tile = image::imageops::crop_imm(&page,x,y,w,h).to_image();
            let a = cpu.upscale_tile(tile.as_raw(), w,h).unwrap();
            let b = gpu.upscale_tile(tile.as_raw(), w,h).unwrap();
            yomika_compute_core::upscale::blit_tile(&mut assembled,page.width()*2,&planned,2,&b).unwrap();
            if x == 0 && y == 0 {
                image::save_buffer(std::env::temp_dir().join(format!("yomika-{stem}-tile.png")), &b, w*2,h*2,image::ColorType::Rgba8).unwrap();
            }
            let mean = a.iter().zip(&b).map(|(a,b)| f64::from(a.abs_diff(*b))).sum::<f64>() / a.len() as f64;
            eprintln!("{stem} tile {x},{y} {w}x{h}: mean byte error {mean}");
            assert!(mean < 1.0, "GPU diverges on real page: {mean}");
        }
        image::save_buffer(std::env::temp_dir().join(format!("yomika-{stem}-{edge}-page.png")), &assembled,page.width()*2,page.height()*2,image::ColorType::Rgba8).unwrap();
        assert!(gpu.requires_whole_frame());
        let corrected = yomika_compute_core::upscale::upscale_rgba(&gpu,page.as_raw(),page.width(),page.height(),
            yomika_compute_core::upscale::UpscaleOptions { tile_size: 2048, max_pixels:16_000_000, ..Default::default() }).unwrap();
        assert_eq!(corrected.tiles,1,"global attention was split into independent tiles");
        let reference = cpu.upscale_tile(page.as_raw(),page.width(),page.height()).unwrap();
        let error = reference.iter().zip(&corrected.rgba).map(|(a,b)|f64::from(a.abs_diff(*b))).sum::<f64>() / reference.len() as f64;
        assert!(error < 1.0,"whole-page reference mismatch: {error}");
        image::save_buffer(std::env::temp_dir().join(format!("yomika-{stem}-corrected-page.png")),&corrected.rgba,corrected.width,corrected.height,image::ColorType::Rgba8).unwrap();
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .to_path_buf()
}

/// Where `patch_negative_pads.py` and `make_cases.py` write, overridable so a
/// caller can point the harness at a fixture set produced elsewhere.
fn fixtures_dir() -> PathBuf {
    std::env::var("YOMIKA_PARITY_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root().join("debug_outputs").join("task1-gpu"))
}

fn stock(stem: &str) -> PathBuf {
    std::env::var("YOMIKA_PARITY_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root().join("docs").join("models"))
        .join(format!("{stem}.onnx"))
}

fn rewritten(stem: &str) -> PathBuf {
    fixtures_dir().join(format!("{stem}-sliced.onnx"))
}

fn waifu2x() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models")
        .join("waifu2x-upconv7")
        .join("model.onnx")
}

/// Announce the fixture instead of asserting on it: a missing local artifact is
/// not a code defect, but it must never look like a passing measurement.
fn missing(path: &Path) -> bool {
    if path.exists() {
        return false;
    }
    println!(
        "skipped: {} is not present (generate fixtures with scripts\\compute\\realcugan-parity.ps1)",
        path.display()
    );
    true
}

/// The density of tiles the product feeds is not the density of the 72x64
/// validation probe, and a crop bug could in principle only show up on some
/// sizes — so the probe size is overridable instead of baked in.
fn probe_size(key: &str, fallback: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &usize| *value >= 32)
        .unwrap_or(fallback)
}

fn width() -> usize {
    probe_size("YOMIKA_PROBE_WIDTH", DEFAULT_WIDTH)
}

fn height() -> usize {
    probe_size("YOMIKA_PROBE_HEIGHT", DEFAULT_HEIGHT)
}

/// The product gives the CPU path `available - 1` threads clamped to 1..=2
/// (`inference::session::cpu_threads`). Divergence probes run one thread so
/// their numbers stay comparable; a timing run sets this to the product's count,
/// otherwise the CPU column flatters DirectML.
fn probe_threads() -> usize {
    std::env::var("YOMIKA_PROBE_THREADS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|value: &usize| *value >= 1)
        .unwrap_or(1)
}

/// Same builder policy the product uses, so the answer describes the shipped
/// path rather than a convenient one.
fn build(directml: bool, path: &Path) -> Session {
    build_with(directml, path, None)
}

/// `profiling` writes an ORT profile for the run, which carries each node's
/// assigned execution provider — the spec's "the GPU must be shown doing the
/// work" evidence, rather than inferring it from wall-clock time.
fn build_with(directml: bool, path: &Path, profiling: Option<&Path>) -> Session {
    let cpu = ort::ep::CPU::default().with_arena_allocator(false).build();
    let builder = Session::builder()
        .expect("session builder")
        .with_intra_threads(probe_threads())
        .expect("intra threads")
        .with_inter_threads(1)
        .expect("inter threads")
        .with_intra_op_spinning(false)
        .expect("intra op spinning")
        .with_inter_op_spinning(false)
        .expect("inter op spinning")
        .with_parallel_execution(false)
        .expect("parallel execution")
        .with_memory_pattern(false)
        .expect("memory pattern");
    let builder = match profiling {
        Some(prefix) => builder.with_profiling(prefix).expect("profiling"),
        None => builder,
    };
    let path = path.to_str().expect("utf-8 model path");
    if directml {
        builder
            .with_execution_providers([
                ort::ep::DirectML::default()
                    .with_performance_preference(
                        ort::ep::directml::PerformancePreference::HighPerformance,
                    )
                    .build()
                    .error_on_failure(),
                cpu,
            ])
            .expect("directml providers")
            .commit_from_file(path)
            .expect("directml session")
    } else {
        builder
            .with_execution_providers([cpu])
            .expect("cpu providers")
            .commit_from_file(path)
            .expect("cpu session")
    }
}

/// The probe input the product's own GPU validation uses.
fn probe_input() -> Vec<f32> {
    let width = width();
    let height = height();
    let mut input = vec![0.0_f32; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            input[y * width + x] = x as f32 / (width - 1).max(1) as f32;
            input[width * height + y * width + x] = y as f32 / (height - 1).max(1) as f32;
            input[2 * width * height + y * width + x] = 0.5;
        }
    }
    input
}

fn extract(value: &DynValue) -> Result<(Vec<i64>, Vec<f32>), String> {
    match value.try_extract_tensor::<f32>() {
        Ok((shape, values)) => Ok((shape.as_ref().to_vec(), values.to_vec())),
        Err(error) => Err(format!("not a float tensor: {error}")),
    }
}

/// Every output the model declares, which for these graphs is exactly one.
fn run_all(session: &mut Session, input: &[f32]) -> Result<(Vec<i64>, Vec<f32>), String> {
    let tensor = ort::value::Tensor::from_array((
        [1_i64, 3, height() as i64, width() as i64],
        input.to_vec(),
    ))
    .map_err(|error| error.to_string())?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|error| error.to_string())?;
    let value = outputs
        .iter()
        .next()
        .map(|(_, value)| value)
        .ok_or_else(|| "the model declared no outputs".to_string())?;
    extract(&value)
}

fn run_cpu_and_gpu(path: &Path) -> Result<((Vec<i64>, Vec<f32>), Parity), String> {
    let input = probe_input();
    let (cpu_shape, cpu_values) = run_all(&mut build(false, path), &input)?;
    let (gpu_shape, gpu_values) = run_all(&mut build(true, path), &input)?;
    if cpu_shape != gpu_shape {
        return Err(format!("shape cpu={cpu_shape:?} dml={gpu_shape:?}"));
    }
    let parity = Parity::measure(&cpu_shape, &cpu_values, &gpu_values)?;
    Ok(((cpu_shape, cpu_values), parity))
}

/// How far one provider's answer is from the other's, in the units docs/71 §4.6
/// gates on. Mean alone would hide a single channel drifting, and p99 alone
/// would hide a systematic bias, so both are kept next to the histogram.
#[derive(Debug)]
struct Parity {
    mean: f64,
    p99: f64,
    max: f64,
    psnr: f64,
    channel_means: Vec<f64>,
    differing: usize,
    count: usize,
}

impl Parity {
    fn measure(shape: &[i64], cpu: &[f32], gpu: &[f32]) -> Result<Parity, String> {
        if cpu.len() != gpu.len() {
            return Err(format!("length cpu={} dml={}", cpu.len(), gpu.len()));
        }
        if cpu.is_empty() {
            return Err("empty tensor".into());
        }
        let channels = shape.get(1).copied().unwrap_or(1).max(1) as usize;
        let plane = cpu.len() / channels;
        if plane * channels != cpu.len() {
            return Err(format!("shape {shape:?} does not divide {} elements", cpu.len()));
        }
        let mut deltas = Vec::with_capacity(cpu.len());
        let mut channel_means = vec![0.0_f64; channels];
        let mut squared = 0.0_f64;
        let mut differing = 0_usize;
        for (index, (cpu_value, gpu_value)) in cpu.iter().zip(gpu).enumerate() {
            if !cpu_value.is_finite() || !gpu_value.is_finite() {
                return Err(format!(
                    "non-finite value at {index}: cpu={cpu_value} dml={gpu_value}"
                ));
            }
            let delta = f64::from((cpu_value - gpu_value).abs());
            deltas.push(delta);
            squared += f64::from((cpu_value - gpu_value).powi(2));
            if delta > 0.0 {
                differing += 1;
            }
            channel_means[index / plane] += delta;
        }
        let mean = deltas.iter().sum::<f64>() / deltas.len() as f64;
        deltas.sort_by(|a, b| a.partial_cmp(b).expect("delta ordering"));
        let p99 = deltas[((deltas.len() as f64 * 0.99) as usize).min(deltas.len() - 1)];
        let max = deltas[deltas.len() - 1];
        for sum in &mut channel_means {
            *sum /= plane as f64;
        }
        let mse = squared / deltas.len() as f64;
        let psnr = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (1.0 / mse).log10()
        };
        Ok(Parity {
            mean,
            p99,
            max,
            psnr,
            channel_means,
            differing,
            count: deltas.len(),
        })
    }

    /// docs/71 §4.6: the float probe keeps its 1e-3 mean budget, the release gate
    /// is per-channel mean <= 1/255 and p99 <= 3/255. `Err` quotes the threshold
    /// that was missed, because "parity failed" alone does not say what to fix.
    fn verdict(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        if self.mean > 1e-3 {
            failures.push(format!("mean {:.9} > 1e-3", self.mean));
        }
        if self.p99 > 3.0 / 255.0 {
            failures.push(format!("p99 {:.9} > 3/255 = {:.6}", self.p99, 3.0 / 255.0));
        }
        for (channel, mean) in self.channel_means.iter().enumerate() {
            if *mean > 1.0 / 255.0 {
                failures.push(format!(
                    "channel {channel} mean {mean:.9} > 1/255 = {:.6}",
                    1.0 / 255.0
                ));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn line(&self) -> String {
        format!(
            "mean={:.9} p99={:.9} max={:.9} psnr={:.2}dB differing={}/{} ({:.4}%)",
            self.mean,
            self.p99,
            self.max,
            self.psnr,
            self.differing,
            self.count,
            100.0 * self.differing as f64 / self.count as f64
        )
    }
}

/// ORT's profile names the provider on every node event. Counting them is the
/// spec's "show the GPU doing the work" evidence — a matching output says
/// nothing about which engine produced it, and a provider that silently ran
/// everything on the CPU would pass a comparison-only gate.
fn provider_counts(profile: &str) -> (usize, usize) {
    (
        profile.matches("DmlExecutionProvider").count(),
        profile.matches("CPUExecutionProvider").count(),
    )
}

/// The comparator is the gate, so the gate needs its own controls: it has to
/// reject a NaN, a shape that no longer matches, a channel rotation, and a
/// difference above the thresholds — and accept a difference below them.
#[test]
fn the_gate_rejects_nan_a_shape_change_a_channel_swap_and_a_large_drift() {
    let good: Vec<f32> = (0..12).map(|index| index as f32 / 12.0).collect();
    let shape = vec![1_i64, 3, 2, 2];

    let identical = Parity::measure(&shape, &good, &good).expect("identical measures");
    assert!(identical.verdict().is_ok(), "identical output must pass");
    assert_eq!(identical.mean, 0.0);
    assert_eq!(identical.max, 0.0);

    let tiny: Vec<f32> = good.iter().map(|value| value + 1e-7).collect();
    let tiny = Parity::measure(&shape, &good, &tiny).expect("tiny delta measures");
    assert!(tiny.verdict().is_ok(), "1e-7 of float noise must pass");

    let mut nan = good.clone();
    nan[3] = f32::NAN;
    assert!(
        Parity::measure(&shape, &good, &nan).is_err(),
        "a NaN must not measure as parity"
    );

    let shortened = &good[..good.len() - 1];
    assert!(
        Parity::measure(&shape, &good, shortened).is_err(),
        "a shorter tensor must not measure as parity"
    );

    let swapped: Vec<f32> = (0..3)
        .flat_map(|channel| {
            let next = (channel + 1) % 3;
            good[(next * 4)..((next + 1) * 4)].to_vec()
        })
        .collect();
    let swapped = Parity::measure(&shape, &good, &swapped).expect("channel swap measures");
    assert!(
        swapped.verdict().is_err(),
        "a channel rotation must fail the gate, not pass as 1e-7 noise"
    );

    let drifted: Vec<f32> = good.iter().map(|value| value + 0.01).collect();
    let drifted = Parity::measure(&shape, &good, &drifted).expect("drift measures");
    let failure = drifted.verdict().expect_err("0.01 drift must fail the gate");
    assert!(failure.contains("1/255"), "failure should quote the gate: {failure}");
}

/// A profile with no DirectML node is not evidence about the GPU, even when the
/// numbers match — this is the check that stops a CPU fallback from being
/// reported as a working GPU backend.
#[test]
fn a_profile_without_gpu_operators_is_not_evidence() {
    let cpu_only = r#"{"cat":"Node","args":{"provider":"CPUExecutionProvider","op_name":"Conv"}}"#;
    let (dml, cpu) = provider_counts(cpu_only);
    assert_eq!((dml, cpu), (0, 1));
    assert!(dml == 0, "a CPU-only profile must not count as GPU evidence");

    let mixed = r#"{"args":{"provider":"DmlExecutionProvider"}}{"args":{"provider":"CPUExecutionProvider"}}"#;
    assert_eq!(provider_counts(mixed), (1, 1));
}

/// The rewritten graphs are the candidate: DirectML on them must match the CPU
/// reference inside the release thresholds, and the profile must show DirectML
/// nodes producing the result.
#[test]
fn directml_matches_cpu_on_the_rewritten_realcugan_graphs() {
    println!(
        "probe {}x{}, cpu threads {}, directml available: {:?}",
        width(),
        height(),
        probe_threads(),
        ort::ep::DirectML::default().is_available()
    );
    let mut checked = 0_usize;
    for stem in [CONSERVATIVE, DENOISE] {
        let path = rewritten(stem);
        if missing(&path) {
            continue;
        }
        let (_shape, parity) = run_cpu_and_gpu(&path).expect("rewritten graph runs on both");
        println!("{stem} rewritten: {}", parity.line());
        for (channel, mean) in parity.channel_means.iter().enumerate() {
            println!("  channel {channel}: mean={mean:.9}");
        }
        assert!(
            parity.verdict().is_ok(),
            "{stem} rewritten failed the gate: {:?}",
            parity.verdict()
        );

        let prefix = fixtures_dir().join("dml-profile");
        let mut session = build_with(true, &path, Some(&prefix));
        let input = probe_input();
        run_all(&mut session, &input).expect("profiled run");
        let file = session.end_profiling().expect("profile written");
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let (dml, cpu) = provider_counts(&text);
        println!("  profile {file}: dml nodes={dml} cpu nodes={cpu}");
        assert!(
            dml > 0,
            "{stem} reported parity but DirectML ran no node, so the run proves nothing about the GPU"
        );
        checked += 1;
    }
    if checked == 0 {
        println!("no rewritten graph was present; nothing measured");
    }
}

/// The stock graphs must fail the same gate. Without this the harness could pass
/// because it is not really measuring anything, and the reason the rewrite exists
/// would live only in a log file.
#[test]
fn the_stock_graphs_are_rejected_by_the_same_gate() {
    for stem in [CONSERVATIVE, DENOISE] {
        let path = stock(stem);
        if missing(&path) {
            continue;
        }
        let (_shape, parity) = run_cpu_and_gpu(&path).expect("stock graph runs on both");
        println!("{stem} stock: {}", parity.line());
        let failure = parity
            .verdict()
            .expect_err("the stock graph is expected to diverge on DirectML");
        println!("  rejected: {failure}");
    }
}

/// One operator at a time, so a DirectML defect is attributed instead of guessed:
/// every `Pad` mode, a dynamic-pads `Pad`, Conv, ConvTranspose and LeakyRelu are
/// exact, and the negative-pad crop is the one that is not.
#[test]
fn isolated_cases_attribute_the_defect_to_negative_pad_pads() {
    let cases = [
        "pad-constant-static",
        "pad-reflect-static",
        "pad-edge-static",
        "pad-negative-static",
        "pad-dynamic-pads",
        "conv-only",
        "conv-leaky",
        "convtranspose-only",
    ];
    let mut measured = 0_usize;
    for name in cases {
        let path = fixtures_dir().join(format!("case-{name}.onnx"));
        if missing(&path) {
            continue;
        }
        let (_shape, parity) = run_cpu_and_gpu(&path).expect("case runs on both");
        println!("case {name:22} {}", parity.line());
        if name == "pad-negative-static" {
            assert!(
                parity.verdict().is_err(),
                "a negative-pad crop is supposed to be where DirectML breaks; if it now \
                 passes, the machine's DirectML changed and the matrix needs re-measuring"
            );
        } else {
            assert!(
                parity.verdict().is_ok(),
                "{name} is supposed to agree between providers: {:?}",
                parity.verdict()
            );
        }
        measured += 1;
    }
    if measured == 0 {
        println!("no isolated case was present; nothing measured");
    }
}

/// The matrix needs a speed column next to the correctness column: a candidate
/// that is exact but slower than CPU is not a candidate. Both providers run in
/// one process, so this measures per-inference latency only — memory has to come
/// from an isolated process (`scripts\compute\sample-compute-resources.ps1`).
#[test]
fn candidate_timings_on_a_real_tile() {
    let candidates = [
        ("realcugan-2x-conservative stock", stock(CONSERVATIVE)),
        ("realcugan-2x-conservative rewritten", rewritten(CONSERVATIVE)),
        ("realcugan-2x-denoise3x stock", stock(DENOISE)),
        ("realcugan-2x-denoise3x rewritten", rewritten(DENOISE)),
        ("waifu2x-upconv7 (clean graph)", waifu2x()),
    ];
    let runs: usize = std::env::var("YOMIKA_PROBE_RUNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5);
    let input = probe_input();
    println!(
        "timing at {}x{}, {runs} timed runs after one warm-up",
        width(),
        height()
    );
    for (label, path) in candidates {
        if !path.exists() {
            println!("{label:34} missing");
            continue;
        }
        let mut cpu = build(false, &path);
        let mut gpu = build(true, &path);
        let (Ok((_, cpu_first)), Ok((_, gpu_first))) =
            (run_all(&mut cpu, &input), run_all(&mut gpu, &input))
        else {
            println!("{label:34} warm-up failed");
            continue;
        };
        let mut cpu_ms = Vec::with_capacity(runs);
        let mut gpu_ms = Vec::with_capacity(runs);
        for _ in 0..runs {
            let start = std::time::Instant::now();
            let cpu_run = run_all(&mut cpu, &input);
            cpu_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            let start = std::time::Instant::now();
            let gpu_run = run_all(&mut gpu, &input);
            gpu_ms.push(start.elapsed().as_secs_f64() * 1000.0);
            let _ = (cpu_run, gpu_run);
        }
        cpu_ms.sort_by(|a, b| a.partial_cmp(b).expect("cpu timing"));
        gpu_ms.sort_by(|a, b| a.partial_cmp(b).expect("gpu timing"));
        let median = |values: &[f64]| values.get(values.len() / 2).copied().unwrap_or(f64::NAN);
        let speedup = median(&cpu_ms) / median(&gpu_ms);
        let verdict = match Parity::measure(&[1, 3, 1, 1], &cpu_first, &gpu_first) {
            Ok(parity) => parity.line(),
            Err(note) => note,
        };
        println!(
            "{label:34} cpu {:8.1}ms  dml {:8.1}ms  {speedup:5.2}x  {verdict}",
            median(&cpu_ms),
            median(&gpu_ms)
        );
    }
}

/// Runs a steady load on one provider so an external sampler can watch this
/// process's private commit and the card's memory. Two providers in one process
/// cannot be told apart, so this runs one provider per process and prints its own
/// markers for the sampler to bracket.
#[test]
fn holds_a_steady_load_for_resource_sampling() {
    let provider = std::env::var("YOMIKA_PROBE_PROVIDER").unwrap_or_else(|_| "dml".into());
    let fallback = rewritten(CONSERVATIVE);
    let model = std::env::var("YOMIKA_PROBE_MODEL").unwrap_or_else(|_| fallback.display().to_string());
    let runs: usize = std::env::var("YOMIKA_PROBE_RUNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3);
    let directml = provider.eq_ignore_ascii_case("dml") || provider.eq_ignore_ascii_case("directml");
    let input = probe_input();
    println!("resource sample: provider={provider} model={model} runs={runs}");
    let mut session = build(directml, Path::new(&model));
    println!("MARK session-ready");
    for run in 0..runs {
        let start = std::time::Instant::now();
        match run_all(&mut session, &input) {
            Ok(_) => println!(
                "MARK run-{run} {:.1}ms",
                start.elapsed().as_secs_f64() * 1000.0
            ),
            Err(note) => println!("MARK run-{run} failed: {note}"),
        }
    }
    println!("MARK done");
}
