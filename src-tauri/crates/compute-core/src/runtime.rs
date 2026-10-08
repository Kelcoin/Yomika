//! 运行库（执行提供器）策略：这份构建里有哪些能开、开会话时要什么参数。
//!
//! 为什么这份策略归核心所有：宿主与 worker **必须做出同一个选择**。同一个模型在
//! 两边选了不同的运行库，结果会不一样、缓存键也会分叉，而「哪条运行库算得对」这件
//! 事只有实测能回答（见 [`crate::engine`] 开头那段）。两份实现一定会漂，所以只留一份。
//!
//! 这里**不**认识 Tauri、数据库、凭据；`ort` 是可选依赖，所以没有 `ort` feature 时
//! 本模块仍然提供 [`RuntimeId`]、[`platform_preference`] 与 [`cpu_threads`]，只是开不了
//! 会话（`cargo test -p yomika-compute-core` 不带 feature 走的正是这条路）。

use crate::engine::Backend;

/// 我们认识、并且会去注册的执行提供器。粒度比 [`Backend`] 细：DirectML 与 CUDA 都是
/// `Backend::Gpu`，但同一个模型在两者上的实测结论可以相反，所以验证结论按运行库记。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeId {
    DirectMl,
    CoreMl,
    Nnapi,
    Cpu,
}

impl RuntimeId {
    /// 给用户看、也给协议与缓存键用的稳定名字。**不许改名**：缓存键里含它。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectMl => "directml",
            Self::CoreMl => "coreml",
            Self::Nnapi => "nnapi",
            Self::Cpu => "cpu",
        }
    }

    pub fn is_hardware_accelerated(self) -> bool {
        !matches!(self, Self::Cpu)
    }

    /// 这条运行库算哪一类后端。`engine::resolve` 用粗粒度决定「能不能回退」，
    /// 用本类型决定「用哪一份实测结论」。
    pub fn backend(self) -> Backend {
        match self {
            Self::Cpu => Backend::Cpu,
            Self::DirectMl | Self::CoreMl | Self::Nnapi => Backend::Gpu,
        }
    }
}

/// 平台偏好顺序：Windows 先 DirectML，苹果先 CoreML，Android 先 NNAPI，CPU 永远
/// 排在最后。这只表达「想用哪个」，不代表真的能用——能不能用要看
/// `available_runtimes()` 与实测结论。
pub fn platform_preference() -> Vec<RuntimeId> {
    let mut order = Vec::new();
    if cfg!(target_os = "windows") {
        order.push(RuntimeId::DirectMl);
    }
    if cfg!(any(target_os = "macos", target_os = "ios")) {
        order.push(RuntimeId::CoreMl);
    }
    if cfg!(target_os = "android") {
        order.push(RuntimeId::Nnapi);
    }
    order.push(RuntimeId::Cpu);
    order
}

/// 给界面与 WebView 留核。
///
/// 一个图一份线程池、而且 ORT 默认会把所有核都拉进来 spinning，结果就是「翻页时界面
/// 卡住」——把重算搬出 UI 进程是为了解决这个，但宿主自己那份回退路径也照同样规矩来。
/// 上限 2 而不是「核数-1」：这台机器上模型推理是显存/带宽瓶颈，核多了只是更吵。
pub fn cpu_threads(available: usize) -> usize {
    available.saturating_sub(1).clamp(1, 2)
}

/// 这份构建里**真的注册得上**的运行库，顺序即优先顺序。CPU 永远在里面、永远是最后
/// 一个：其它运行库都要有证据才敢用，而 CPU 是那份证据的参照。
#[cfg(feature = "ort")]
pub fn available_runtimes() -> Vec<RuntimeId> {
    let mut runtimes = Vec::new();
    #[cfg(all(windows, feature = "directml"))]
    {
        use ort::ep::ExecutionProvider;
        if ort::ep::DirectML::default().is_available().unwrap_or(false) {
            runtimes.push(RuntimeId::DirectMl);
        }
    }
    // 其余平台保持诚实：EP 没有随构建一起发出去、也没有注册，就一个字都不许说。
    runtimes.push(RuntimeId::Cpu);
    runtimes
}

/// 这份构建里**有没有把 DirectML 执行提供器编进来**——与设备在不在**无关**。
///
/// `available_runtimes()` 把「EP 编进来了」与「这台机器上有一块能用的 DML 设备」合并成
/// 一条答案：对用户只有「能不能用」有意义，所以那里就该合并。可一旦要断言**构建配置**
/// 本身，那条合并过的答案就什么都证明不了——没有显卡的机器上，缺 feature 与缺设备长得
/// 一模一样。
///
/// 所以单独留这一条：它问的是「我这份二进制带没带 GPU 这条路」，答案由 compute-core 被
/// **编译时**的 feature 决定（`cfg!` 在这里展开，而不是在调用方）。worker 需要它，是因为
/// 「算力进程能不能上显卡」正是 docs/71 §5.1 把重算搬出去的理由之一；一条 `cpu` 的构建
/// 会让 `Auto` 与 `Cpu` 变成同一条路，症状却是「一切照常、只是慢」。
///
/// 不做成 `#[cfg(feature = "ort")]`：没有 ORT 的构建（Android 的 no-ort）答案是 `false`，
/// 这个答案同样是实话，不需要调用方先证明自己开了 feature。
pub const fn directml_is_compiled_in() -> bool {
    cfg!(all(windows, feature = "directml"))
}

/// 这份运行库构建的标签：`ort-api` + 它自己的 API 版本号。
///
/// 宿主把它写进缓存修订（`inference::ort_runtime_label`），worker 把它写进
/// `EngineReport.version`。**必须是同一个串**：同一份模型在不同 API 版本的 ORT 上
/// 给出的数不保证位级一致，宿主据此作废旧产物，所以这个串从一处出、两处用。
#[cfg(feature = "ort")]
pub fn runtime_label() -> String {
    format!("ort-api{}", ort::MINOR_VERSION)
}

/// 没有 `ort` 的构建：一份会话都开不出来，所以没有版本可说——但也必须说点什么，
/// 好让「谁在跑」在产物元数据里永远不是空白。
#[cfg(not(feature = "ort"))]
pub fn runtime_label() -> String {
    "no-runtime".to_string()
}

/// 这份构建**链着**的运行库，与协议承诺给宿主的那个串是不是同一个；不是就给出原因。
///
/// 宿主不再链 ONNX Runtime（docs/71 §11 Task 8），它写派生缓存身份时只能引用
/// `yomika_compute_protocol::WORKER_RUNTIME_LABEL`，而这一栏必须说出**真正算它的**那条
/// 运行库。所以那个常量必须真的是这份 worker 算东西时用的运行库：同一个模型在不同 API
/// 版本的 ORT 上给出的数不保证位级一致，号错了就会把新旧产物当成同一版。worker 启动时
/// 比对一次，不一致就拒跑——宿主看到的是「worker 起不来」，而不是一份看着正常的错账。
pub fn runtime_label_mismatch(promised: &str) -> Option<String> {
    let linked = runtime_label();
    (linked != promised).then(|| {
        format!(
            "这份 worker 链着 {linked}，协议承诺的是 {promised}：宿主会按 {promised} 写派生\
             产物的缓存身份，算出来的却是 {linked} 的产物。改了运行库版本却没改 \
             compute-protocol 的 WORKER_RUNTIME_LABEL，就是现在这个样子。"
        )
    })
}

/// 按运行库开一个 `SessionBuilder`：线程、内存与并行策略在这里统一。
#[cfg(feature = "ort")]
pub fn builder(runtime: RuntimeId) -> Result<ort::session::builder::SessionBuilder, String> {
    use ort::session::Session;

    let threads = cpu_threads(
        std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
    );
    let builder = Session::builder()
        .map_err(|error| error.to_string())?
        .with_intra_threads(threads)
        .map_err(|error| error.to_string())?
        .with_inter_threads(1)
        .map_err(|error| error.to_string())?
        .with_intra_op_spinning(false)
        .map_err(|error| error.to_string())?
        .with_inter_op_spinning(false)
        .map_err(|error| error.to_string())?
        // DirectML 要求它关掉；CPU 上它也只是让显存/内存曲线不可预测。
        .with_parallel_execution(false)
        .map_err(|error| error.to_string())?
        .with_memory_pattern(false)
        .map_err(|error| error.to_string())?;
    let cpu = ort::ep::CPU::default().with_arena_allocator(false).build();
    match runtime {
        #[cfg(all(windows, feature = "directml"))]
        RuntimeId::DirectMl => builder
            .with_execution_providers([
                ort::ep::DirectML::default()
                    .with_performance_preference(
                        ort::ep::directml::PerformancePreference::HighPerformance,
                    )
                    .build()
                    .error_on_failure(),
                cpu,
            ])
            .map_err(|error| error.to_string()),
        RuntimeId::Cpu => builder
            .with_execution_providers([cpu])
            .map_err(|error| error.to_string()),
        other => Err(format!(
            "{} is not shipped by this runtime",
            other.as_str()
        )),
    }
}

/// 用指定运行库打开一个模型。**不换**：点名哪条就是哪条（换掉会让「测的是显卡、
/// 跑的是 CPU」这种谎话重新长出来）。
#[cfg(feature = "ort")]
pub fn open_session(path: &std::path::Path, runtime: RuntimeId) -> Result<ort::session::Session, String> {
    builder(runtime)?
        .commit_from_file(path)
        .map_err(|error| error.to_string())
}

/// 首选运行库开会话，注册或图装载失败时退 CPU（只退一次，且留一条日志）。
#[cfg(feature = "ort")]
pub fn open_preferred(path: &std::path::Path) -> Result<ort::session::Session, String> {
    let preferred = *available_runtimes()
        .first()
        .unwrap_or(&RuntimeId::Cpu);
    match open_session(path, preferred) {
        Ok(session) => {
            eprintln!(
                "yomika: ONNX {} provider={} (partial CPU operator fallback is allowed)",
                path.display(),
                preferred.as_str()
            );
            Ok(session)
        }
        Err(error) if preferred != RuntimeId::Cpu => {
            eprintln!(
                "yomika: ONNX GPU session failed for {}: {error}; retrying on CPU",
                path.display()
            );
            open_session(path, RuntimeId::Cpu)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_pools_are_bounded_and_leave_room_for_ui() {
        assert_eq!([1, 2, 4, 64].map(cpu_threads), [1, 1, 2, 2]);
    }

    #[test]
    fn runtime_labels_are_stable() {
        assert_eq!(RuntimeId::DirectMl.as_str(), "directml");
        assert_eq!(RuntimeId::CoreMl.as_str(), "coreml");
        assert_eq!(RuntimeId::Nnapi.as_str(), "nnapi");
        assert_eq!(RuntimeId::Cpu.as_str(), "cpu");
        assert!(!RuntimeId::Cpu.is_hardware_accelerated());
        assert!(RuntimeId::DirectMl.is_hardware_accelerated());
    }

    #[test]
    fn backend_granularity_is_coarser_than_the_runtime() {
        assert_eq!(RuntimeId::Cpu.backend(), Backend::Cpu);
        assert_eq!(RuntimeId::DirectMl.backend(), Backend::Gpu);
        assert_eq!(RuntimeId::CoreMl.backend(), Backend::Gpu);
    }

    #[test]
    fn the_platform_preference_always_ends_with_cpu() {
        let order = platform_preference();
        assert_eq!(order.last(), Some(&RuntimeId::Cpu));
        assert_eq!(
            order.contains(&RuntimeId::DirectMl),
            cfg!(target_os = "windows")
        );
        assert!(!order[..order.len() - 1].contains(&RuntimeId::Cpu), "CPU 只许出现一次");
    }

    /// 「注册得上」不等于「偏好里有」：没有 feature 就没有这条运行库，一个字都不许报。
    #[cfg(feature = "ort")]
    #[test]
    fn available_runtimes_only_reports_what_this_build_can_open() {
        let runtimes = available_runtimes();
        assert_eq!(runtimes.last(), Some(&RuntimeId::Cpu));
        #[cfg(all(windows, feature = "directml"))]
        {
            use ort::ep::ExecutionProvider;
            assert_eq!(
                runtimes.contains(&RuntimeId::DirectMl),
                ort::ep::DirectML::default().is_available().unwrap_or(false)
            );
        }
        #[cfg(not(all(windows, feature = "directml")))]
        assert_eq!(runtimes, vec![RuntimeId::Cpu]);
    }

    /// 协议里的那个串是**宿主**写派生缓存身份的依据：宿主不再链 ONNX Runtime
    /// （docs/71 §11 Task 8），它问不了运行库自己。所以那个串必须与 worker 真正链着的
    /// 运行库对得上——对不上要说清是哪两个串，好让启动检查的那句日志直接能读。
    /// 这条与「本构建有没有 ort」无关：真假都由 `runtime_label_mismatch` 说实话。
    #[test]
    fn a_promised_runtime_label_that_is_not_this_builds_is_reported() {
        let message =
            runtime_label_mismatch("ort-api0").expect("与这份构建不一致的承诺必须被报出来");
        assert!(message.contains("ort-api0"), "{message}");
        assert!(message.contains(&runtime_label()), "{message}");
        assert_eq!(runtime_label_mismatch(&runtime_label()), None);
    }

    /// 这份构建真的链着的那条运行库，就是协议承诺给宿主的那个串。**这是「手写的号
    /// 忘记跟着升」唯一会红的地方**：升级 `ort` 之后不改协议常量，宿主的缓存身份会按
    /// 旧号写（旧产物被当成同一版），而且 worker 会在启动时拒跑（`worker/src/main.rs`）。
    #[cfg(feature = "ort")]
    #[test]
    fn the_protocol_promise_is_the_runtime_this_build_links() {
        assert_eq!(
            runtime_label_mismatch(yomika_compute_protocol::WORKER_RUNTIME_LABEL),
            None,
            "协议常量 {} 与这份构建链着的 {} 不一致",
            yomika_compute_protocol::WORKER_RUNTIME_LABEL,
            runtime_label()
        );
    }

    /// 点了一条这份构建没发的运行库必须报错，而不是悄悄换成 CPU。CoreML 与 NNAPI
    /// 目前都没有注册代码（docs/71 §11 Task 7-b：先 Windows/DirectML，其余随后），
    /// 所以点名它们在任何平台上都该被拒。
    #[cfg(feature = "ort")]
    #[test]
    fn a_runtime_this_build_does_not_ship_is_refused() {
        for runtime in [RuntimeId::CoreMl, RuntimeId::Nnapi] {
            let error = match builder(runtime) {
                Ok(_) => panic!("{} 没有注册代码，不该开得起来", runtime.as_str()),
                Err(error) => error,
            };
            assert!(
                error.contains("is not shipped"),
                "{}: {error}",
                runtime.as_str()
            );
        }
    }

    /// CUDA 与 Vulkan 只在 `Cargo.toml` 里留了名字（`cuda` / `ncnn-vulkan` 两条 feature
    /// 的注释写着「留着名字，但不许假装可用」）。这条用例钉的是**产品侧的词汇表**：
    /// `RuntimeId` 只认四个名字，偏好顺序里也只有它们——于是「这台机器装过 CUDA」「这台
    /// 机器有 Vulkan」在本产品里根本不是一条可用的运行库，更不会被报成一条。
    ///
    /// 它挡不住谁把 `Cuda` 加进枚举（那是要单独决定的一件事），挡得住的是「悄悄报一个
    /// 没接的名字」——交付包自检里那两条「包里没有 CUDA/Vulkan 运行库」是它的包面对应物。
    #[test]
    fn the_runtime_vocabulary_has_no_cuda_and_no_vulkan() {
        let shipped = [
            RuntimeId::CoreMl.as_str(),
            RuntimeId::Cpu.as_str(),
            RuntimeId::DirectMl.as_str(),
            RuntimeId::Nnapi.as_str(),
        ];
        assert_eq!(
            shipped,
            ["coreml", "cpu", "directml", "nnapi"],
            "运行库词汇表只认这四个名字：多一个就说明产品里多了一条「装了才能跑」的运行库"
        );
        for runtime in platform_preference() {
            let name = runtime.as_str();
            assert!(
                !matches!(name, "cuda" | "vulkan" | "ncnn-vulkan" | "ort-cuda"),
                "偏好里出现了没接的运行库：{name}"
            );
        }
    }
}
