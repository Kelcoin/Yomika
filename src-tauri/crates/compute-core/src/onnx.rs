//! ONNX 超分执行体：把一张 RGBA 瓦片过模型，并把「这条运行库算得对不对」问出来。
//!
//! 这里是宿主与 worker **共用**的那一份（docs/71 §5.1）。搬运时一个字节的算法都没改
//! ——分块、裁剪、回贴、预算全都还在 [`crate::upscale`]，本模块只做「一张瓦片进、
//! 一张瓦片出」。变的只有三处：错误类型换成核心的 [`ComputeError`]、运行库策略换成
//! [`crate::runtime`]、以及**会话缓存不再在这里**（进程级缓存是宿主生命周期的事：
//! worker 里同时只有一个模型，缓存反而会挡住 idle 释放）。
//!
//! 超分模型只认 NCHW 的浮点 RGB，没有 alpha 的概念；alpha 由同一条最近邻兜底路径
//! 单独带过去，所以模型的回答永远不可能带来一个尺寸对不上的缓冲区。

use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use crate::cpu_scale::cpu_scale_rgba;
use crate::engine::{outputs_agree, ValidationVerdict};
use crate::error::ComputeError;
use crate::inputs::file_fingerprint;
use crate::probe::{self, ProbeKey, ProbeKind};
use crate::runtime::{available_runtimes, open_session, platform_preference, RuntimeId};
use crate::tensor::{nchw_over_rgba, pad_rgba_edges, rgba_to_nchw};
use crate::upscale::UpscaleEngine;

/// 探针用的瓦片尺寸（源像素）。72×64 是历史值：够大能跨过 Real-CUGAN 图内那 18 px
/// 反射垫边，够小不至于让探针本身变成一次真实的显存占用。
const PROBE_WIDTH: usize = 72;
const PROBE_HEIGHT: usize = 64;

/// 这一次「谁在算」的完整交代：想要谁、实际用了谁、实测结论是什么。
///
/// 它与 [`crate::engine::EngineResolution`] 不是一回事：那一个是「拿到平台事实表之后
/// 怎么选后端」，翻的是**事实**；这一条是**实测**出来的——「这份模型在这条运行库上算
/// 得对不对」只能跑一次才知道，而且这条交代要随产物一起回到宿主与用户眼前。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeChoice {
    /// 平台偏好里排第一的那条（Windows 是 directml，苹果 coreml，安卓 nnapi，其余
    /// cpu）。它只表达「想用哪个」，不代表这台机器/这份构建真的有。
    pub requested: RuntimeId,
    /// 真的用来跑的那条。
    pub used: RuntimeId,
    /// 对 `used` 的实测结论。`used != requested` 时它就是回退原因。
    pub verdict: ValidationVerdict,
}

impl RuntimeChoice {
    /// 用户要的没给上，就是回退了。
    pub fn fell_back(&self) -> bool {
        self.used != self.requested
    }

    /// 给用户看的一句话：想用谁、为什么没用上。没回退就没什么可说的。
    pub fn fallback_reason(&self) -> Option<&str> {
        if !self.fell_back() {
            return None;
        }
        Some(match &self.verdict {
            ValidationVerdict::Failed { reason } => reason.as_str(),
            ValidationVerdict::NotTested => "这条运行库在这台机器上不可用（没装上，或没有可用设备）",
            // 探针通过就不会被换掉，所以这一条到不了；留着只是为了让 match 穷尽。
            ValidationVerdict::Passed => "这份构建只能给 CPU",
        })
    }
}

/// 一个已经装载好的 ONNX 超分模型。
///
/// `Session::run` 要 `&mut`，而 [`UpscaleEngine::upscale_tile`] 拿的是 `&self`（整幅图
/// 期间管道一直握着这个引擎），所以这里必须有一个互斥量。实际不会争用：一次只放
/// 大一张图。
pub struct OnnxEngine {
    session: Mutex<ort::session::Session>,
    /// **实际**用上的那条运行库（不是「想要」的那条）。两个运行库算出来的东西不一样，
    /// 缓存键与给用户看的报告都要用这个值，不许用偏好顺序。
    runtime: RuntimeId,
    scale: u32,
    max_pixels: usize,
    /// 图自己能接受的最小边（源像素）。Real-CUGAN 图内反射 18 px、边小于 20 就报错，
    /// 而分块器在页面右缘真的会递过来一条 9 px 的窄条；小于这个值时瓦片先按边缘复制
    /// 长大，答完再裁回来。
    min_input_edge: u32,
}

impl OnnxEngine {
    /// 用**指定**的运行库打开，不换也不回退。调用方要自己确保这条运行库对这份模型
    /// 实测通过（[`validate_runtime`]）——「点的是显卡、跑的是 CPU」正是这轮要消灭的
    /// 那类谎话。
    pub fn open_with_runtime(
        path: &Path,
        runtime: RuntimeId,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<Self, ComputeError> {
        if scale == 0 {
            return Err(ComputeError::InvalidManifest(
                "model scale must be at least 1".into(),
            ));
        }
        let session = open_session(path, runtime)
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX session failed: {error}")))?;
        Ok(Self {
            session: Mutex::new(session),
            runtime,
            scale,
            max_pixels,
            min_input_edge: min_input_edge.max(1),
        })
    }

    /// 首选运行库 + 一次实测探针：探针不过就用 CPU 参照（并留一条日志），并把
    /// 「想要谁 / 用了谁 / 为什么」原样交出去。
    ///
    /// 这是宿主一路沿用下来的行为，也是 docs/71 §5.3 的落地方式：`scale` 与最小边
    /// 来自清单而不是图，而「这条运行库对这份模型算得对不对」只能实测。
    ///
    /// 实测结论走 [`validate_runtime_cached`]：同一份模型（内容指纹）问第二遍不再重探
    /// ——docs/71 对这条的要求是「GPU probe 只在冷 model/新环境执行」，而每一页都重探
    /// 会让一次会话等两次会话的装载。
    pub fn open_choice(
        path: &Path,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<(Self, RuntimeChoice), ComputeError> {
        if scale == 0 {
            return Err(ComputeError::InvalidManifest(
                "model scale must be at least 1".into(),
            ));
        }
        let requested = *platform_preference()
            .first()
            .unwrap_or(&RuntimeId::Cpu);
        let candidate = available_runtimes()
            .into_iter()
            .find(|id| id.is_hardware_accelerated());
        let (used, verdict) = match candidate {
            // 探针自己也要把一块图跑完，所以配置离谱时不做实测（`scale` 不在 1..=4、
            // 最小边大于 256）：直接用谁都能跑的 CPU。
            Some(_) if !(1..=4).contains(&scale) || min_input_edge > 256 => (
                RuntimeId::Cpu,
                ValidationVerdict::Failed {
                    reason: format!(
                        "scale {scale} / 最小边 {min_input_edge} 超出可实测范围（1..=4 且 ≤256）"
                    ),
                },
            ),
            Some(runtime) => match validate_runtime_cached(path, runtime, scale, min_input_edge) {
                ValidationVerdict::Passed => (runtime, ValidationVerdict::Passed),
                verdict => {
                    eprintln!(
                        "yomika: ONNX {} provider={} 实测不通过（{verdict:?}）；改用 CPU 参照",
                        path.display(),
                        runtime.as_str()
                    );
                    (RuntimeId::Cpu, verdict)
                }
            },
            // 这份构建/这台机器连一条硬件运行库都没有：没得问，也就没得测。
            None => (RuntimeId::Cpu, ValidationVerdict::NotTested),
        };
        let engine = Self::open_with_runtime(path, used, scale, max_pixels, min_input_edge)?;
        Ok((
            engine,
            RuntimeChoice {
                requested,
                used,
                verdict,
            },
        ))
    }

    /// 只要引擎、不要交代的那条路（宿主里大量既有调用点用它）。
    pub fn open(
        path: &Path,
        scale: u32,
        max_pixels: usize,
        min_input_edge: u32,
    ) -> Result<Self, ComputeError> {
        Self::open_choice(path, scale, max_pixels, min_input_edge).map(|(engine, _)| engine)
    }

    /// 实际用上的运行库。
    pub fn runtime(&self) -> RuntimeId {
        self.runtime
    }

    pub fn max_pixels(&self) -> usize {
        self.max_pixels
    }
}

/// 让一小块梯度图同时过 `runtime` 与 CPU，比较两者的输出。
///
/// 为什么要探针而不是只看「注册成功、跑得出数」：实测里 Real-CUGAN 在 DirectML 上
/// 运行库可用、设备可用、`run` 也不报错，但负垫边 `Pad` 被算错，输出 mean 0.2705
/// ——形状合法、数值错误。所以「能跑」不算证据，「与 CPU 参照一致」才算。
///
/// 点 `RuntimeId::Cpu` 时返回 [`ValidationVerdict::Passed`]：它**就是**参照实现，
/// 没有第二条可以对照的路。真正需要证明的是硬件那几条。
pub fn validate_runtime(
    path: &Path,
    runtime: RuntimeId,
    scale: u32,
    min_input_edge: u32,
) -> ValidationVerdict {
    if runtime == RuntimeId::Cpu {
        return ValidationVerdict::Passed;
    }
    if scale == 0 || !(1..=4).contains(&scale) {
        return ValidationVerdict::Failed {
            reason: format!("scale {scale} is outside the probe range 1..=4"),
        };
    }
    let width = PROBE_WIDTH.max(min_input_edge as usize);
    let height = PROBE_HEIGHT.max(min_input_edge as usize);
    let mut input = vec![0.0_f32; width * height * 3];
    for y in 0..height {
        for x in 0..width {
            input[y * width + x] = x as f32 / (width - 1).max(1) as f32;
            input[width * height + y * width + x] = y as f32 / (height - 1).max(1) as f32;
            input[2 * width * height + y * width + x] = 0.5;
        }
    }
    let expected_shape = [
        1_i64,
        3,
        (height * scale as usize) as i64,
        (width * scale as usize) as i64,
    ];
    let probe = |runtime: RuntimeId| -> Result<Vec<f32>, String> {
        // 计数代表「真的试过」：开不出来也算这次探过了（否则「每次都在失败重试」看起来
        // 像一次都没探）。
        probe::note_probe_opened();
        let mut session = open_session(path, runtime)?;
        let tensor = ort::value::Tensor::from_array(([1_usize, 3, height, width], input.clone()))
            .map_err(|error| error.to_string())?;
        let started = Instant::now();
        let outputs = session
            .run(ort::inputs![tensor])
            .map_err(|error| error.to_string())?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| error.to_string())?;
        if shape.as_ref() != expected_shape {
            return Err(format!(
                "{} answered with shape {shape:?}, expected {expected_shape:?}",
                runtime.as_str()
            ));
        }
        eprintln!(
            "yomika: ONNX probe provider={} {:?}",
            runtime.as_str(),
            started.elapsed()
        );
        Ok(values.to_vec())
    };
    let actual = match probe(runtime) {
        Ok(values) => values,
        Err(reason) => return ValidationVerdict::Failed { reason },
    };
    let expected = match probe(RuntimeId::Cpu) {
        Ok(values) => values,
        Err(reason) => {
            return ValidationVerdict::Failed {
                reason: format!("CPU reference failed: {reason}"),
            }
        }
    };
    if outputs_agree(&actual, &expected) {
        return ValidationVerdict::Passed;
    }
    let mean = actual
        .iter()
        .zip(&expected)
        .map(|(a, b)| f64::from((a - b).abs()))
        .sum::<f64>()
        / actual.len().max(1) as f64;
    ValidationVerdict::Failed {
        reason: format!(
            "mean {mean:.9} > {} over {} values",
            crate::engine::PROBE_MEAN_ABS_TOLERANCE,
            actual.len()
        ),
    }
}

/// 带记账的 [`validate_runtime`]：同一份字节、同一条运行库、同一组参数只真探一次。
///
/// 指纹读不出来（路径不存在、权限不够）就不记账——没有内容可以指认，硬记一条只会把
/// 「这个路径当时的样子」当成「这份模型的样子」，而下次拿到的可能是另一份文件。
pub fn validate_runtime_cached(
    path: &Path,
    runtime: RuntimeId,
    scale: u32,
    min_input_edge: u32,
) -> ValidationVerdict {
    if runtime == RuntimeId::Cpu {
        // 它就是参照实现，没什么可测的（与 `validate_runtime` 同一条判据）。
        return ValidationVerdict::Passed;
    }
    let Ok((byte_length, content_hash)) = file_fingerprint(path) else {
        return validate_runtime(path, runtime, scale, min_input_edge);
    };
    let key = ProbeKey {
        content_hash,
        byte_length,
        kind: ProbeKind::Upscale,
        runtime,
        scale,
        min_input_edge,
    };
    if let Some(record) = probe::recall(&key) {
        return record.verdict;
    }
    let before = probe::probes_opened();
    let verdict = validate_runtime(path, runtime, scale, min_input_edge);
    probe::remember(key, verdict.clone(), probe::probes_opened() - before);
    verdict
}

/// 瓦片长度必须与声明的宽高一致。拦在模型之前：不然它拿到的是一段撕裂的缓冲区，
/// 而 ONNX 只会照着声明的形状去读，越界读出来的东西不会有任何报错。
fn check_tile_shape(rgba: &[u8], width: u32, height: u32) -> Result<(), ComputeError> {
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(ComputeError::InvalidInput(
            "RGBA tile dimensions do not match".into(),
        ));
    }
    Ok(())
}

impl UpscaleEngine for OnnxEngine {
    fn scale(&self) -> u32 {
        self.scale
    }

    fn upscale_tile(
        &self,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, ComputeError> {
        check_tile_shape(rgba, width, height)?;
        // 最近邻结果既是 alpha 载体、也是调用方期待的形状，所以模型答了一个错尺寸
        // 也造不出对不上的缓冲区。
        let mut output = cpu_scale_rgba(rgba, width, height, self.scale, self.max_pixels)?.rgba;

        let (input_width, input_height) = (
            width.max(self.min_input_edge),
            height.max(self.min_input_edge),
        );
        let grown;
        let source = if (input_width, input_height) == (width, height) {
            rgba
        } else {
            grown = pad_rgba_edges(rgba, width, height, input_width, input_height);
            &grown[..]
        };

        let input = ort::value::Tensor::from_array((
            vec![
                1_i64,
                3,
                i64::from(input_height),
                i64::from(input_width),
            ],
            rgba_to_nchw(source, input_width, input_height),
        ))
        .map_err(|error| ComputeError::InvalidInput(format!("ONNX input failed: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| ComputeError::InvalidInput("ONNX session lock poisoned".into()))?;
        let outputs = session
            .run(ort::inputs![input])
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX run failed: {error}")))?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| ComputeError::InvalidInput(format!("ONNX output failed: {error}")))?;

        let expected = [
            1_i64,
            3,
            i64::from(input_height) * i64::from(self.scale),
            i64::from(input_width) * i64::from(self.scale),
        ];
        if shape.as_ref() != expected {
            // 几乎总是清单里的 `scale` 与图对不上，或者图不保持它拿到的尺寸。
            return Err(ComputeError::InvalidManifest(format!(
                "ONNX output shape {shape:?} does not match the declared x{} scale",
                self.scale
            )));
        }
        if values.iter().any(|value| !value.is_finite()) {
            return Err(ComputeError::InvalidInput("ONNX returned non-finite pixels".into()));
        }
        nchw_over_rgba(
            values,
            (input_width * self.scale) as usize,
            (input_height * self.scale) as usize,
            (width * self.scale) as usize,
            (height * self.scale) as usize,
            &mut output,
        );
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CPU 就是参照，所以「对 CPU 做实测」只能有一个结论：通过。这条看着像废话，但它
    /// 挡住的是「探针在 CPU 上也硬要比一次、比完还可能判失败」那种自相矛盾。
    #[test]
    fn the_reference_runtime_is_always_a_pass() {
        let verdict = validate_runtime(Path::new("does-not-exist.onnx"), RuntimeId::Cpu, 2, 20);
        assert_eq!(verdict, ValidationVerdict::Passed);
    }

    /// 一个声明就错了的 `scale` 不许去开探针（探针要按 `scale` 算期望形状）。
    #[test]
    fn a_scale_outside_the_probe_range_fails_before_any_session_opens() {
        let verdict = validate_runtime(Path::new("does-not-exist.onnx"), RuntimeId::DirectMl, 9, 1);
        assert!(matches!(verdict, ValidationVerdict::Failed { .. }), "{verdict:?}");
        assert!(!outputs_agree(&[0.0], &[0.27]), "阈值不许被放宽");
    }

    #[test]
    fn a_zero_scale_is_refused_before_the_model_is_opened() {
        // 路径不存在也要先因为 scale 被拒：开一次会话要几百毫秒 + 一笔显存。
        let error = match OnnxEngine::open_with_runtime(
            Path::new("does-not-exist.onnx"),
            RuntimeId::Cpu,
            0,
            1_000,
            1,
        ) {
            Ok(_) => panic!("零倍放大不许开会话"),
            Err(error) => error,
        };
        assert!(matches!(error, ComputeError::InvalidManifest(_)), "{error:?}");
    }

    /// 尺寸对不上的瓦片在碰模型之前就被拒（不然模型会拿到一个撕裂的缓冲区）。
    #[test]
    fn a_tile_whose_length_disagrees_with_its_shape_is_refused() {
        let error = check_tile_shape(&[0, 0, 0, 255], 4, 4).expect_err("长度对不上");
        assert!(matches!(error, ComputeError::InvalidInput(_)), "{error:?}");
        assert!(check_tile_shape(&vec![0_u8; 4 * 4 * 4], 4, 4).is_ok());
    }

    fn bundled_model() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/models/waifu2x-upconv7/model.onnx")
    }

    /// 「没得问」也要说出来：这份构建/这台机器没有硬件运行库时，交代里不许出现一条
    /// 没人测过却说「用了显卡」的结论——`NotTested` 的意思正是「不等于通过」。
    #[cfg(not(all(windows, feature = "directml")))]
    #[test]
    fn a_choice_nobody_could_test_is_reported_as_untested() {
        let _guard = crate::probe::test_lock();
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        let (engine, choice) = OnnxEngine::open_choice(&path, 2, 64_000_000, 1).expect("engine");
        // 报告与实际用上的那条必须一致：报告撒谎比回退更糟。
        assert_eq!(engine.runtime(), choice.used);
        assert_eq!(choice.used, RuntimeId::Cpu);
        // 这条构建里没有硬件运行库 ⇒ 平台偏好（Windows 上是 directml）没给上。
        assert_eq!(choice.verdict, ValidationVerdict::NotTested);
        #[cfg(windows)]
        {
            assert_eq!(choice.requested, RuntimeId::DirectMl);
            assert!(choice.fell_back(), "想要 directml 却只能给 cpu，就是回退了");
            let reason = choice.fallback_reason().expect("回退必须有原因");
            assert!(reason.contains("不可用"), "{reason}");
        }
        // 没回退就没有原因可说（苹果/安卓构建里 requested 本来就是 cpu）。
        #[cfg(not(windows))]
        assert!(!choice.fell_back() && choice.fallback_reason().is_none());
    }

    /// 有显卡可问时：同一份模型问第二遍不许再开会话——docs/71 对这条的要求是
    /// 「GPU probe 只在冷 model/新环境执行」，而每页重探会让一次任务的等待翻倍。
    /// 这条要真的 DML：不带 `directml` 的构建里它编译不进来（也就没证据）。
    #[cfg(all(windows, feature = "directml"))]
    #[test]
    fn the_same_question_is_not_probed_twice_and_a_new_one_is() {
        let _guard = crate::probe::test_lock();
        let path = bundled_model();
        if !path.is_file() {
            eprintln!("skipping: {} is not present", path.display());
            return;
        }
        crate::probe::forget_all();
        let before = crate::probe::probes_opened();
        let first = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 1);
        let after_first = crate::probe::probes_opened();
        assert!(
            after_first > before,
            "第一次必须真的探过（不然这条测试什么都没证明）"
        );

        let second = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 1);
        assert_eq!(second, first, "同一个问题必须给同一个结论");
        assert_eq!(
            crate::probe::probes_opened(),
            after_first,
            "同一份字节问第二遍不该再开会话"
        );

        // 换一个参数就是另一个问题：必须重新实测（否则「测过」会被错用到别的配置上）。
        let _ = validate_runtime_cached(&path, RuntimeId::DirectMl, 2, 33);
        assert!(crate::probe::probes_opened() > after_first);

        // 走完公开路径时，交代与实际会话仍然一致。
        let (engine, choice) = OnnxEngine::open_choice(&path, 2, 64_000_000, 1).expect("engine");
        assert_eq!(engine.runtime(), choice.used);
        match choice.verdict {
            ValidationVerdict::Passed => {
                assert_eq!(choice.used, RuntimeId::DirectMl);
                assert!(!choice.fell_back(), "探针过了就没有回退可言");
            }
            _ => {
                assert_eq!(choice.used, RuntimeId::Cpu);
                assert!(choice.fell_back());
                assert!(choice.fallback_reason().is_some(), "回退必须给原因");
            }
        }
    }
}
