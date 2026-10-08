//! 引擎选择的不变量（docs/71 §11 Task 2 ④）。
//!
//! 三条最容易写错、也最容易把「GPU 坏了」变成「静默慢十倍」的规则：
//!
//! 1. **可用运行库、设备、模型验证是三个独立事实**：库在、卡也在，不等于这个
//!    模型在这张卡上算得对（Real-CUGAN 在 DirectML 上就是反例）。
//! 2. **强制 GPU 失败必须失败**：绝不回报一个 CPU 的「成功」，否则用户以为自己在
//!    用显卡，实际在等 CPU。
//! 3. **没验证过 = 不能用**：`Auto` 也不许把未验证的 (模型, 运行库) 拿来跑；
//!    没有证据的后端只能被显式要求。

use yomika_compute_core::engine::{
    resolve, Backend, DeviceFact, EngineError, EngineFacts, ModelValidation, RuntimeFact,
    ValidationVerdict,
};
use yomika_compute_protocol::messages::{EnginePolicy, Precision};

fn runtime(id: &str, backend: Backend) -> RuntimeFact {
    RuntimeFact {
        id: id.into(),
        version: "1.0".into(),
        backend,
        precision: Precision::Fp32,
        available: true,
    }
}

fn device(id: &str, runtime_id: &str) -> DeviceFact {
    DeviceFact {
        id: id.into(),
        runtime_id: runtime_id.into(),
        available: true,
    }
}

fn passed(model: &str, runtime_id: &str) -> ModelValidation {
    ModelValidation {
        model_spec_id: model.into(),
        runtime_id: runtime_id.into(),
        verdict: ValidationVerdict::Passed,
    }
}

fn failed(model: &str, runtime_id: &str, reason: &str) -> ModelValidation {
    ModelValidation {
        model_spec_id: model.into(),
        runtime_id: runtime_id.into(),
        verdict: ValidationVerdict::Failed {
            reason: reason.into(),
        },
    }
}

/// 一台「什么都有、而且验证过」的机器。每条测试只改它的一处。
fn facts() -> EngineFacts {
    EngineFacts {
        runtimes: vec![runtime("directml", Backend::Gpu), runtime("cpu", Backend::Cpu)],
        devices: vec![device("gpu-0", "directml")],
        model_validation: vec![passed("realcugan-2x", "directml")],
    }
}

#[test]
fn a_cpu_request_resolves_to_cpu() {
    let resolution = resolve(&facts(), EnginePolicy::Cpu, "realcugan-2x").expect("cpu");
    assert_eq!(resolution.backend, Backend::Cpu);
    assert_eq!(resolution.runtime_id, "cpu");
    assert!(!resolution.fell_back_to_cpu, "用户要的就是 CPU，不是回退");
    assert_eq!(resolution.report.id, "cpu");
    assert_eq!(resolution.report.device_id, "cpu");
}

#[test]
fn a_fully_available_gpu_request_resolves_to_gpu() {
    let resolution = resolve(&facts(), EnginePolicy::Gpu, "realcugan-2x").expect("gpu");
    assert_eq!(resolution.backend, Backend::Gpu);
    assert_eq!(resolution.runtime_id, "directml");
    assert_eq!(resolution.device_id.as_deref(), Some("gpu-0"));
    assert!(!resolution.fell_back_to_cpu);
    assert_eq!(resolution.report.device_id, "gpu-0");
    assert_eq!(resolution.report.precision, Precision::Fp32);
}

#[test]
fn a_forced_gpu_request_fails_instead_of_quietly_using_the_cpu() {
    // 没有 GPU 运行库：强制 GPU 必须是错误，而不是一个 backend == Cpu 的 Ok。
    let mut machine = facts();
    machine.runtimes.retain(|item| item.backend == Backend::Cpu);
    machine.devices.clear();
    let error = resolve(&machine, EnginePolicy::Gpu, "realcugan-2x").expect_err("no gpu runtime");
    let EngineError::GpuUnavailable { reason } = &error else {
        panic!("expected GpuUnavailable, got {error:?}");
    };
    assert!(reason.contains("runtime"), "{reason}");

    // 库在、设备没了：同样是失败。
    let mut machine = facts();
    machine.devices.clear();
    assert!(matches!(
        resolve(&machine, EnginePolicy::Gpu, "realcugan-2x"),
        Err(EngineError::GpuUnavailable { .. })
    ));

    // 库和设备都在，但这个模型没在这条运行库上验证过：还是失败。
    let mut machine = facts();
    machine.model_validation.clear();
    assert!(matches!(
        resolve(&machine, EnginePolicy::Gpu, "realcugan-2x"),
        Err(EngineError::GpuUnavailable { .. })
    ));
}

#[test]
fn an_auto_request_may_fall_back_to_the_cpu_but_must_say_so() {
    let mut machine = facts();
    machine.runtimes.retain(|item| item.backend == Backend::Cpu);
    machine.devices.clear();
    let resolution = resolve(&machine, EnginePolicy::Auto, "realcugan-2x").expect("auto");
    assert_eq!(resolution.backend, Backend::Cpu);
    assert!(resolution.fell_back_to_cpu, "回退必须被记下来，否则 UI 会谎报在用显卡");
    assert!(!resolution.notes.is_empty(), "回退的原因要能显示给用户");
}

#[test]
fn a_model_that_was_never_validated_on_the_gpu_is_not_used_even_by_auto() {
    // 这就是 Real-CUGAN 那条教训的固化：没有实测证据的 (模型, 运行库) 不许跑，
    // 哪怕运行库和设备都齐。
    let machine = EngineFacts {
        runtimes: facts().runtimes,
        devices: facts().devices,
        model_validation: vec![ModelValidation {
            model_spec_id: "realcugan-2x".into(),
            runtime_id: "directml".into(),
            verdict: ValidationVerdict::NotTested,
        }],
    };
    let resolution = resolve(&machine, EnginePolicy::Auto, "realcugan-2x").expect("auto");
    assert_eq!(resolution.backend, Backend::Cpu);
    assert!(resolution.fell_back_to_cpu);
}

#[test]
fn a_failed_validation_carries_its_reason_into_the_fallback_note() {
    let machine = EngineFacts {
        runtimes: facts().runtimes,
        devices: facts().devices,
        model_validation: vec![failed(
            "realcugan-2x",
            "directml",
            "mean 0.270531894 > 1e-3",
        )],
    };
    let resolution = resolve(&machine, EnginePolicy::Auto, "realcugan-2x").expect("auto");
    assert_eq!(resolution.backend, Backend::Cpu);
    let notes = resolution.notes.join(" | ");
    assert!(notes.contains("mean 0.270531894"), "{notes}");
}

#[test]
fn a_broken_gpu_runtime_is_skipped_for_the_next_usable_one() {
    // 这条直接对应实测结论：Real-CUGAN 在 DirectML 上算错、在 CUDA 上通过。
    // 事实的顺序是优先顺序，但坏掉的那条必须被跳过，而不是让整次解析失败。
    let machine = EngineFacts {
        runtimes: vec![
            runtime("directml", Backend::Gpu),
            runtime("cuda", Backend::Gpu),
            runtime("cpu", Backend::Cpu),
        ],
        devices: vec![device("gpu-0", "directml"), device("nvidia-0", "cuda")],
        model_validation: vec![
            failed("realcugan-2x", "directml", "mean 0.270531894 > 1e-3"),
            passed("realcugan-2x", "cuda"),
        ],
    };
    let resolution = resolve(&machine, EnginePolicy::Gpu, "realcugan-2x").expect("cuda");
    assert_eq!(resolution.runtime_id, "cuda");
    assert_eq!(resolution.device_id.as_deref(), Some("nvidia-0"));
    let notes = resolution.notes.join(" | ");
    assert!(notes.contains("directml"), "被跳过的原因要留在 notes 里：{notes}");

    // 两条都能用时，顺序决定优先：平台层把偏好的放前面（宿主今天就是 DirectML 优先）。
    let machine = EngineFacts {
        runtimes: vec![
            runtime("cuda", Backend::Gpu),
            runtime("directml", Backend::Gpu),
            runtime("cpu", Backend::Cpu),
        ],
        devices: vec![device("gpu-0", "directml"), device("nvidia-0", "cuda")],
        model_validation: vec![passed("realcugan-2x", "cuda"), passed("realcugan-2x", "directml")],
    };
    let resolution = resolve(&machine, EnginePolicy::Auto, "realcugan-2x").expect("cuda first");
    assert_eq!(resolution.runtime_id, "cuda");
    assert!(!resolution.fell_back_to_cpu);
}

#[test]
fn a_machine_with_no_usable_backend_at_all_is_an_error() {
    let machine = EngineFacts {
        runtimes: vec![RuntimeFact {
            available: false,
            ..runtime("cpu", Backend::Cpu)
        }],
        devices: Vec::new(),
        model_validation: Vec::new(),
    };
    for policy in [EnginePolicy::Auto, EnginePolicy::Cpu] {
        let error = resolve(&machine, policy, "realcugan-2x").expect_err("nothing usable");
        assert!(
            matches!(
                error,
                EngineError::CpuUnavailable { .. } | EngineError::NoUsableBackend { .. }
            ),
            "{error:?}"
        );
    }
}

#[test]
fn the_resolution_never_claims_gpu_while_running_on_cpu() {
    // 把「谎报在用显卡」这件事变成可枚举的：任何一次 Ok 的 CPU 解析，都必须
    // 要么是用户明确要 CPU，要么被标记成回退。
    let mut machine = facts();
    machine.model_validation.clear();
    machine.devices.clear();
    for policy in [EnginePolicy::Auto, EnginePolicy::Cpu] {
        let resolution = resolve(&machine, policy, "realcugan-2x").expect("cpu");
        assert_eq!(resolution.backend, Backend::Cpu);
        let explicit = policy == EnginePolicy::Cpu;
        assert_eq!(
            resolution.fell_back_to_cpu, !explicit,
            "CPU 解析在 policy={policy:?} 时的回退标记不对"
        );
        assert_eq!(resolution.report.precision, Precision::Fp32);
    }
}

#[test]
fn an_unavailable_runtime_and_an_unavailable_device_are_both_honored() {
    let mut machine = facts();
    machine.runtimes[0].available = false; // directml 被标成不可用
    assert!(matches!(
        resolve(&machine, EnginePolicy::Gpu, "realcugan-2x"),
        Err(EngineError::GpuUnavailable { .. })
    ));

    let mut machine = facts();
    machine.devices[0].available = false; // 库在，卡被标成不可用
    assert!(matches!(
        resolve(&machine, EnginePolicy::Gpu, "realcugan-2x"),
        Err(EngineError::GpuUnavailable { .. })
    ));
}
