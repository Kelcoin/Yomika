//! 核心的 ONNX 执行体（Task 7-b）。
//!
//! 为什么这份测试在核心而不是留在宿主：宿主与 worker 都要用它，而「宿主那份对了」
//! 不能证明 worker 那份也对——除非它们本来就是同一份。真模型的其余检查（分块接缝、
//! 真显卡上跑没跑节点）留在宿主，因为它们要读宿主侧的目录约定。

use yomika_compute_core::engine::outputs_agree;
use yomika_compute_core::error::ComputeError;

/// 判读规则本身：探针与参照必须「长度相同、全有限、平均绝对差 ≤ 1e-3」。
/// 这条规则是唯一能把「注册成功了」与「算得对」分开的东西（engine.rs 里那段
/// Real-CUGAN 的教训），所以它自己也要被钉住。
#[test]
fn the_reference_rule_accepts_only_pixels_that_match() {
    assert!(outputs_agree(&[0.1, 0.5], &[0.1001, 0.5]));
    // 空输出不是「一致」，是「什么都没算」。
    assert!(!outputs_agree(&[], &[]));
    assert!(!outputs_agree(&[0.1], &[0.1, 0.2]));
    assert!(!outputs_agree(&[f32::NAN], &[0.1]));
    assert!(!outputs_agree(&[0.5], &[0.1]));
    // 两个数量级之外：实测 Real-CUGAN 在 DirectML 上就是这个量级（mean 0.2705）。
    assert!(!outputs_agree(&[0.0; 8], &[0.27; 8]));
}

#[cfg(feature = "ort")]
mod with_ort {
    use super::*;
    use std::path::{Path, PathBuf};
    use yomika_compute_core::onnx::OnnxEngine;
    use yomika_compute_core::runtime::RuntimeId;
    use yomika_compute_core::upscale::UpscaleEngine;

    fn bundled_model() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/models/waifu2x-upconv7/model.onnx")
    }

    /// 声明就错了的清单必须**在开会话之前**被拒：开一次会话要几百毫秒、要显卡内存，
    /// 不能先付出这个代价再发现 `scale` 是 0。
    #[test]
    fn a_zero_scale_manifest_is_rejected_before_the_model_is_opened() {
        let error = match OnnxEngine::open(Path::new("does-not-exist.onnx"), 0, 1_000, 1) {
            Ok(_) => panic!("a zero scale must not open a session"),
            Err(error) => error,
        };
        assert!(matches!(error, ComputeError::InvalidManifest(_)), "{error:?}");
    }

    /// 真模型过核心引擎：尺寸、alpha 由兜底缩放器带过来、以及**真的算过**（不能和
    /// 最近邻结果逐字节相同）。宿主那份测试读的是宿主的目录，这份读核心自己的。
    #[test]
    fn the_bundled_model_upscales_a_tile_through_the_core_engine() {
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        let (engine, choice) =
            OnnxEngine::open_choice(&path, 2, 64_000_000, 1).expect("engine");
        assert_eq!(engine.scale(), 2);
        // 交代里说的那条必须是会话真的用的那条：报告撒谎比回退更糟。
        assert_eq!(engine.runtime(), choice.used);
        // 这条构建没有硬件运行库（`--features cpu`）时，谁都得走 CPU 那条。
        #[cfg(not(all(windows, feature = "directml")))]
        assert_eq!(
            engine.runtime(),
            RuntimeId::Cpu,
            "没有硬件运行库就该走谁都能跑的那条"
        );

        let (width, height) = (72_u32, 64_u32);
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let red = (x * 255 / (width - 1)) as u8;
                let green = (y * 255 / (height - 1)) as u8;
                rgba.extend_from_slice(&[red, green, 128, 200]);
            }
        }
        let output = engine.upscale_tile(&rgba, width, height).expect("run");

        assert_eq!(output.len(), (width * 2 * height * 2 * 4) as usize);
        assert!(output.chunks_exact(4).all(|pixel| pixel[3] == 200));
        let nearest = yomika_compute_core::cpu_scale::cpu_scale_rgba(&rgba, width, height, 2, 64_000_000)
            .expect("nearest")
            .rgba;
        assert_ne!(output, nearest, "和普通放大逐字节相同 = 模型其实没被跑");
    }

    /// 显式点名一条运行库时**不许**偷偷换成另一条：两个运行库算出来的东西不一样，
    /// 「我以为在测显卡，其实测的是 CPU」正是这轮要消灭的那类谎言。
    #[test]
    fn an_explicit_runtime_is_not_swapped_behind_the_callers_back() {
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        let engine = OnnxEngine::open_with_runtime(&path, RuntimeId::Cpu, 2, 64_000_000, 1)
            .expect("explicit CPU");
        assert_eq!(engine.runtime(), RuntimeId::Cpu);
    }
}

#[cfg(feature = "ort")]
#[test]
fn realcugan_neutral_fixture_retains_neutral_chroma() {
    use yomika_compute_core::{onnx::OnnxEngine, runtime::RuntimeId, upscale::UpscaleEngine};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/models/realcugan-2x-conservative-dml1.onnx");
    if !path.is_file() { return; }
    let mut input = Vec::new();
    for y in 0..64 { for x in 0..64 {
        let level = if (x+y)%7 < 3 { 40 } else { 210 };
        input.extend_from_slice(&[level,level,level,255]);
    }}
    let engine = OnnxEngine::open_with_runtime(&path,RuntimeId::Cpu,2,1_000_000,20).unwrap();
    let output = engine.upscale_tile(&input,64,64).unwrap();
    let max_chroma = output.chunks_exact(4).map(|p| p[..3].iter().max().unwrap()-p[..3].iter().min().unwrap()).max().unwrap();
    assert!(max_chroma <= 2, "neutral manga acquired chroma: {max_chroma}");
}
