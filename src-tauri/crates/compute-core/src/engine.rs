//! 引擎选择：把「这台机器现在能用什么」翻译成「这次该用哪条运行库」。
//!
//! 为什么要在纯核心里做这件事、而不是让每个调用点自己 if：**三个事实必须分开**。
//! 「运行库存在」「设备存在」「这个模型在这条运行库上算得对」是三件不同的事，
//! 而本项目已经吃过把它们当成一件事的亏——Real-CUGAN 在 DirectML 上运行库可用、
//! 设备可用、跑起来也不报错，但输出是错的（负垫边 `Pad`，实测 mean 0.2705）。
//! 一旦把「库在」当成「能用」，用户就会在毫不知情的情况下得到错误的结果，
//! 或者以为在用显卡而实际在等 CPU。
//!
//! 于是这里的规则是：
//!
//! * 验证结论按 `(model_spec_id, runtime_id)` 记，**不按 backend**——DirectML 与
//!   CUDA 都是 `Backend::Gpu`，但同一个模型在两者上的结论可以相反。
//! * `EnginePolicy::Gpu` 拿不到证据就返回错误，**绝不**返回一个 `Backend::Cpu`
//!   的成功结果（docs/71 §5.1/§12.1 的强制项）。
//! * `EnginePolicy::Auto` 可以回退 CPU，但必须置 `fell_back_to_cpu` 并把原因写进
//!   `notes`，让宿主/前端能显示「这次没用上显卡」。
//! * 没测过的 `(模型, 运行库)` 一律不许跑（Real-CUGAN 的教训：默认认为能用就是
//!   错的），只有显式验证通过才算证据。

use yomika_compute_protocol::messages::{EnginePolicy, EngineReport, Precision};

/// 计算发生在哪一类后端上。粒度刻意粗：具体是哪条运行库由 `runtime_id` 表达。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Cpu,
    Gpu,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Cpu => "cpu",
            Backend::Gpu => "gpu",
        }
    }
}

/// 事实一：构建里有哪些运行库，以及它自己是否可用（例如 DirectML 在
/// `ort::ep::DirectML::is_available()` 为假时就该报 `available: false`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeFact {
    pub id: String,
    pub version: String,
    pub backend: Backend,
    pub precision: Precision,
    pub available: bool,
}

/// 事实二：运行库上看得见的设备。设备属于运行库，不属于 backend。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFact {
    pub id: String,
    pub runtime_id: String,
    pub available: bool,
}

/// 事实三：某个模型在某条运行库上的实测结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationVerdict {
    /// 实测通过（本项目就是 `open_upscaler` 的对照守卫）。
    Passed,
    /// 实测不通过，`reason` 要能显示给用户（例如 "mean 0.270531894 > 1e-3"）。
    Failed { reason: String },
    /// 有记录但没测过：**不等于通过**。
    NotTested,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelValidation {
    pub model_spec_id: String,
    pub runtime_id: String,
    pub verdict: ValidationVerdict,
}

/// 平台层填这张表，核心只读它做决定——所以整套选择逻辑可以完全单测。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EngineFacts {
    /// 顺序就是优先顺序：平台层把偏好的放前面。
    pub runtimes: Vec<RuntimeFact>,
    pub devices: Vec<DeviceFact>,
    pub model_validation: Vec<ModelValidation>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EngineResolution {
    pub backend: Backend,
    pub runtime_id: String,
    /// CPU 没有设备事实，这里就是 `None`；GPU 必须给出真实设备。
    pub device_id: Option<String>,
    pub report: EngineReport,
    /// 只有 `Auto` 回退时才是 `true`。任何 `true` 都意味着「用户要的没给上」。
    pub fell_back_to_cpu: bool,
    /// 给用户看的原因：跳过了什么、为什么回退。
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// 明确要 GPU 但拿不到（库不在 / 没设备 / 没验证过）。**不是**回退信号。
    GpuUnavailable { reason: String },
    CpuUnavailable { reason: String },
    /// 既没有 GPU 也没有 CPU：只能失败。
    NoUsableBackend { reason: String },
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::GpuUnavailable { reason } => write!(formatter, "GPU unavailable: {reason}"),
            EngineError::CpuUnavailable { reason } => write!(formatter, "CPU unavailable: {reason}"),
            EngineError::NoUsableBackend { reason } => write!(formatter, "no usable backend: {reason}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// 按策略选一条运行库。
pub fn resolve(
    facts: &EngineFacts,
    policy: EnginePolicy,
    model_spec_id: &str,
) -> Result<EngineResolution, EngineError> {
    match policy {
        EnginePolicy::Cpu => resolve_cpu(facts).ok_or_else(|| EngineError::CpuUnavailable {
            reason: "this build has no available CPU runtime".into(),
        }),
        EnginePolicy::Gpu => resolve_gpu(facts, model_spec_id).map_err(|reason| {
            // 强制 GPU 只有两种结局：真的用上 GPU，或者失败。没有第三种。
            EngineError::GpuUnavailable { reason }
        }),
        EnginePolicy::Auto => match resolve_gpu(facts, model_spec_id) {
            Ok(resolution) => Ok(resolution),
            Err(gpu_reason) => {
                let mut resolution = resolve_cpu(facts).ok_or_else(|| EngineError::NoUsableBackend {
                    reason: format!("{gpu_reason}; and this build has no available CPU runtime"),
                })?;
                // 回退必须留痕：否则 UI 会显示「GPU 已启用」而实际在跑 CPU。
                resolution.fell_back_to_cpu = true;
                resolution.notes.push(gpu_reason);
                Ok(resolution)
            }
        },
    }
}

fn resolve_cpu(facts: &EngineFacts) -> Option<EngineResolution> {
    let runtime = facts
        .runtimes
        .iter()
        .find(|item| item.backend == Backend::Cpu && item.available)?;
    Some(EngineResolution {
        backend: Backend::Cpu,
        runtime_id: runtime.id.clone(),
        device_id: None,
        report: EngineReport {
            id: runtime.id.clone(),
            version: runtime.version.clone(),
            precision: runtime.precision,
            // CPU 是虚拟设备：用运行库 id，保证同一份输入在宿主与 worker 上算出同一个
            // 缓存键（缓存键里含 report，不能出现进程相关的东西）。
            device_id: runtime.id.clone(),
            // 「被问的是哪条政策」这里说不出来：事实驱动的这条选择（`resolve_*`）用
            // `fell_back_to_cpu` + `notes` 交代自己，与 ONNX 那条实测驱动的路是两套
            // 词汇（docs/71 §12.1 的裁定：不合并）。宁可留空，也不抄一句错的。
            policy: None,
            fallback: None,
        },
        fell_back_to_cpu: false,
        notes: Vec::new(),
    })
}

/// GPU 侧的解析。返回 `Err(reason)` 时 reason 里一定带上了每条被跳过运行库的原因，
/// 因为「为什么没 GPU 可用」是用户最需要看到的信息。
fn resolve_gpu(facts: &EngineFacts, model_spec_id: &str) -> Result<EngineResolution, String> {
    let mut notes: Vec<String> = Vec::new();
    let mut present = false;
    for runtime in facts
        .runtimes
        .iter()
        .filter(|item| item.backend == Backend::Gpu)
    {
        present = true;
        if !runtime.available {
            notes.push(format!(
                "runtime `{}` is not available in this build",
                runtime.id
            ));
            continue;
        }
        let Some(device) = facts
            .devices
            .iter()
            .find(|device| device.runtime_id == runtime.id && device.available)
        else {
            notes.push(format!("runtime `{}` has no available device", runtime.id));
            continue;
        };
        let verdict = facts
            .model_validation
            .iter()
            .find(|entry| entry.model_spec_id == model_spec_id && entry.runtime_id == runtime.id)
            .map(|entry| &entry.verdict);
        match verdict {
            Some(ValidationVerdict::Passed) => {
                return Ok(EngineResolution {
                    backend: Backend::Gpu,
                    runtime_id: runtime.id.clone(),
                    device_id: Some(device.id.clone()),
                    report: EngineReport {
                        id: runtime.id.clone(),
                        version: runtime.version.clone(),
                        precision: runtime.precision,
                        device_id: device.id.clone(),
                        // 同 `resolve_cpu`：这条路的交代在 `EngineResolution` 里，不在
                        // 协议的这两个可选栏里。
                        policy: None,
                        fallback: None,
                    },
                    fell_back_to_cpu: false,
                    notes,
                });
            }
            Some(ValidationVerdict::Failed { reason }) => notes.push(format!(
                "runtime `{}` failed validation for model `{model_spec_id}`: {reason}",
                runtime.id
            )),
            Some(ValidationVerdict::NotTested) => notes.push(format!(
                "runtime `{}` has a record for model `{model_spec_id}` but no measured result",
                runtime.id
            )),
            None => notes.push(format!(
                "runtime `{}` has never been validated for model `{model_spec_id}`",
                runtime.id
            )),
        }
    }
    if !present {
        notes.push("no GPU runtime is present in this build".into());
    }
    Err(format!(
        "no GPU runtime can run model `{model_spec_id}`: {}",
        notes.join(" | ")
    ))
}

/// 探针判定的容差：两份输出的逐元素平均绝对差。同一份权重、同一份输入在两条运行库
/// 上本应几乎相同，差的是浮点累加顺序；而实测 Real-CUGAN 在 DirectML 上的错误是
/// 0.27 量级（负垫边 `Pad` 被算错），与这里差两个数量级。所以这条阈值既能放过
/// 正常的浮点抖动，又能挡住「形状对、值不对」。
pub const PROBE_MEAN_ABS_TOLERANCE: f64 = 0.001;

/// 「这条运行库对这份输入算得对不对」的判读规则：长度必须相同且非空、全部有限、
/// 平均绝对差 ≤ [`PROBE_MEAN_ABS_TOLERANCE`]。
///
/// 放在核心而不是引擎里：它是**事实三**（`ValidationVerdict`）的唯一产地，而事实三
/// 决定用户会不会在毫不知情的情况下拿到错的结果。规则本身要能被单独钉住。
pub fn outputs_agree(actual: &[f32], expected: &[f32]) -> bool {
    !actual.is_empty()
        && actual.len() == expected.len()
        && actual.iter().chain(expected).all(|value| value.is_finite())
        && actual
            .iter()
            .zip(expected)
            .map(|(a, b)| f64::from((a - b).abs()))
            .sum::<f64>()
            / actual.len() as f64
            <= PROBE_MEAN_ABS_TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(runtimes: Vec<RuntimeFact>, devices: Vec<DeviceFact>) -> EngineFacts {
        EngineFacts {
            runtimes,
            devices,
            model_validation: Vec::new(),
        }
    }

    fn runtime(id: &str, backend: Backend, available: bool) -> RuntimeFact {
        RuntimeFact {
            id: id.to_string(),
            version: "1".into(),
            backend,
            precision: Precision::Fp32,
            available,
        }
    }

    fn validated(mut facts: EngineFacts, model: &str, runtime_id: &str, verdict: ValidationVerdict) -> EngineFacts {
        facts.model_validation.push(ModelValidation {
            model_spec_id: model.to_string(),
            runtime_id: runtime_id.to_string(),
            verdict,
        });
        facts
    }

    /// 强制要 GPU 时只有两种结局：真的用上 GPU，或者失败。**没有**第三条路。
    #[test]
    fn a_forced_gpu_never_quietly_answers_on_cpu() {
        let facts = validated(
            facts(
                vec![runtime("directml", Backend::Gpu, true), runtime("cpu", Backend::Cpu, true)],
                vec![DeviceFact { id: "gpu0".into(), runtime_id: "directml".into(), available: true }],
            ),
            "realcugan",
            "directml",
            ValidationVerdict::Failed { reason: "mean 0.270531894 > 1e-3".into() },
        );
        let error = resolve(&facts, EnginePolicy::Gpu, "realcugan").expect_err("必须失败");
        let EngineError::GpuUnavailable { reason } = error else {
            panic!("强制 GPU 失败只该是 GpuUnavailable");
        };
        assert!(reason.contains("0.270531894"), "原因里要带上实测数字：{reason}");
    }

    /// 自动策略可以退 CPU，但必须留痕——否则界面会显示「已启用显卡」而实际在等 CPU。
    #[test]
    fn an_automatic_fallback_says_so() {
        let facts = validated(
            facts(
                vec![runtime("directml", Backend::Gpu, true), runtime("cpu", Backend::Cpu, true)],
                vec![DeviceFact { id: "gpu0".into(), runtime_id: "directml".into(), available: true }],
            ),
            "realcugan",
            "directml",
            ValidationVerdict::Failed { reason: "mean 0.27 > 1e-3".into() },
        );
        let resolution = resolve(&facts, EnginePolicy::Auto, "realcugan").expect("退到 CPU");
        assert_eq!(resolution.backend, Backend::Cpu);
        assert!(resolution.fell_back_to_cpu);
        assert!(!resolution.notes.is_empty(), "回退必须说得出原因");
    }

    /// 没测过 ≠ 通过。Real-CUGAN 的教训：默认认为显卡能用就是错的。
    #[test]
    fn an_unmeasured_model_is_not_good_enough_for_gpu() {
        for facts in [
            validated(
                facts(
                    vec![runtime("directml", Backend::Gpu, true), runtime("cpu", Backend::Cpu, true)],
                    vec![DeviceFact { id: "gpu0".into(), runtime_id: "directml".into(), available: true }],
                ),
                "other-model",
                "directml",
                ValidationVerdict::Passed,
            ),
            validated(
                facts(
                    vec![runtime("directml", Backend::Gpu, true), runtime("cpu", Backend::Cpu, true)],
                    vec![DeviceFact { id: "gpu0".into(), runtime_id: "directml".into(), available: true }],
                ),
                "realcugan",
                "directml",
                ValidationVerdict::NotTested,
            ),
        ] {
            assert!(resolve(&facts, EnginePolicy::Gpu, "realcugan").is_err());
        }
    }

    /// GPU 运行库在但没设备（例如驱动掉了）：这不是「能用」。
    #[test]
    fn a_gpu_runtime_without_a_device_is_not_usable() {
        let facts = validated(
            facts(
                vec![runtime("directml", Backend::Gpu, true), runtime("cpu", Backend::Cpu, true)],
                Vec::new(),
            ),
            "realcugan",
            "directml",
            ValidationVerdict::Passed,
        );
        let error = resolve(&facts, EnginePolicy::Gpu, "realcugan").expect_err("没有设备");
        let EngineError::GpuUnavailable { reason } = error else {
            panic!("没有设备也只该是 GpuUnavailable");
        };
        assert!(reason.contains("no available device"), "{reason}");
    }

    /// CPU 的 `device_id` 刻意用运行库 id：宿主与 worker 必须算出同一个缓存键，
    /// 所以这里不许出现进程/机器相关的东西。
    #[test]
    fn the_cpu_report_is_identical_on_both_sides() {
        let facts = facts(vec![runtime("cpu", Backend::Cpu, true)], Vec::new());
        let resolution = resolve(&facts, EnginePolicy::Cpu, "realcugan").expect("cpu");
        assert_eq!(resolution.report.device_id, "cpu");
        assert_eq!(resolution.runtime_id, "cpu");
        assert!(resolution.device_id.is_none());
    }

    #[test]
    fn the_pixel_rule_accepts_only_matching_pixels() {
        assert!(outputs_agree(&[0.1, 0.5], &[0.1001, 0.5]));
        assert!(!outputs_agree(&[], &[]));
        assert!(!outputs_agree(&[0.1], &[0.1, 0.2]));
        assert!(!outputs_agree(&[f32::INFINITY], &[0.1]));
        assert!(!outputs_agree(&[0.0; 8], &[0.27; 8]));
    }
}
