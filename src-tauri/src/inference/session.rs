//! 宿主侧的 ONNX 运行库适配层。
//!
//! 策略本体（这份构建能开哪几条运行库、会话的线程与显存规矩、GPU 实测探针）在
//! `yomika_compute_core::runtime`：同一份代码 worker 也要用，留在宿主就会出现两份实现，
//! 而两份实现一定会漂移。8-g③-iv 之后宿主一条会话都不开了，这里只剩两件事——把核心的
//! [`RuntimeId`] 翻成宿主对外的 [`BackendId`]（前端与缓存身份吃的词汇保持不变），以及
//! 留下「节点真的跑在 GPU 上」这几条只在本仓库资源路径下才有意义的证据测试。

use super::BackendId;
use yomika_compute_core::runtime::RuntimeId;

/// 宿主对外的词汇 → 核心的运行库。穷举匹配：核心哪天多一条运行库，这段就编译不过，
/// 不会静默地把一条新运行库当成 CPU 用。
///
/// 只有测试用得上：产品代码里「要开哪条运行库」这件事已经不在宿主了（要它就得反着翻）。
#[cfg(test)]
fn core_runtime(backend: BackendId) -> RuntimeId {
    match backend {
        BackendId::DirectMl => RuntimeId::DirectMl,
        BackendId::CoreMl => RuntimeId::CoreMl,
        BackendId::Nnapi => RuntimeId::Nnapi,
        BackendId::Cpu => RuntimeId::Cpu,
    }
}

/// 核心的运行库 → 宿主对外的词汇。
pub(super) fn backend_of(runtime: RuntimeId) -> BackendId {
    match runtime {
        RuntimeId::DirectMl => BackendId::DirectMl,
        RuntimeId::CoreMl => BackendId::CoreMl,
        RuntimeId::Nnapi => BackendId::Nnapi,
        RuntimeId::Cpu => BackendId::Cpu,
    }
}

// 「这台机器真的能开哪几条运行库」与「首选运行库开会话、失败退 CPU」这两条入口都已经
// 不在宿主了：前者要开一次会话才答得准（`runtime::available_runtimes` 现在只进 worker
// 的依赖图），后者随修补执行体搬进核心之后宿主再也没有调用点。宿主对外的两条命令
// （`inference_probe`、`declared_backend_label`）改问平台偏好——那是**声明**，实测在
// worker 每次交回的 `EngineReport` 里。少两个入口就是少两条以后绕开 worker 的路。

#[cfg(test)]
mod tests {
    use super::*;
    use ort::session::Session;
    use std::path::Path;
    use yomika_compute_core::engine::outputs_agree;
    use yomika_compute_core::runtime;

    /// 两套词汇的翻译必须是一双互逆的映射，而且标签逐字相同（缓存键与前端回显都
    /// 吃这个字符串）。纯翻译，不需要机器上真有这条运行库；打错一条就会红。
    #[test]
    fn the_two_vocabularies_round_trip() {
        for runtime in [
            RuntimeId::DirectMl,
            RuntimeId::CoreMl,
            RuntimeId::Nnapi,
            RuntimeId::Cpu,
        ] {
            let backend = backend_of(runtime);
            assert_eq!(core_runtime(backend), runtime);
            assert_eq!(backend.as_str(), runtime.as_str());
        }
        assert_eq!(
            crate::inference::platform_backend_preference().len(),
            runtime::platform_preference().len(),
            "平台偏好顺序也必须来自核心那一份"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_actually_contains_the_gpu_provider() {
        use ort::ep::ExecutionProvider;
        assert!(
            ort::ep::DirectML::default()
                .is_available()
                .expect("provider inventory"),
            "Windows runtime must ship DirectML, not just advertise a platform preference"
        );
    }

    /// 注册成功不算证据：必须有节点真的跑在 GPU 上。这条只能写在宿主——它读的是本仓库
    /// 的捆绑模型路径，而且验证的正是核心 `runtime::builder` 真的把工作交给了 DirectML。
    #[cfg(windows)]
    #[test]
    fn bundled_upscaler_really_executes_operators_on_directml() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/models/waifu2x-upconv7/model.onnx");
        let dir = tempfile::tempdir().unwrap();
        let mut session = runtime::builder(RuntimeId::DirectMl)
            .expect("register DirectML")
            .with_profiling(dir.path().join("gpu"))
            .unwrap()
            .commit_from_file(&path)
            .expect("bundled graph on DirectML");
        let input =
            ort::value::Tensor::from_array(([1usize, 3, 32, 32], vec![0.5f32; 3 * 32 * 32]))
                .unwrap();
        {
            let output = session
                .run(ort::inputs![input])
                .expect("real GPU inference");
            let (_, values) = output[0].try_extract_tensor::<f32>().unwrap();
            assert!(values.iter().all(|v| v.is_finite()));
        }
        let profile = session.end_profiling().unwrap();
        let events: serde_json::Value =
            serde_json::from_slice(&std::fs::read(profile).unwrap()).unwrap();
        assert!(
            events
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["args"]["provider"] == "DmlExecutionProvider"),
            "registration alone is not evidence: a node must run on GPU"
        );
    }
}
