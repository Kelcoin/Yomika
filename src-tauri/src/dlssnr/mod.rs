//! DLSSNR（NVIDIA 的 `nvngx_dlssnr.dll`）滤镜——宿主这一层只剩**壳**。
//!
//! 引擎（NGX 核心、D3D12 设备与工作区缓存、滤镜本体、动图、设置、探针）在
//! `yomika_compute_core::dlssnr`。为什么搬走：`docs/71` Task 8 的出口是「宿主无 ORT/NGX
//! 资源」，而 NGX 只能在**计算进程**里初始化（同文 §11 Task 8 第 2 条），worker 又不许
//! 依赖 Tauri（§5.2）——所以引擎住在核心那一层，宿主与 worker 共用同一份实现。谁编了
//! `compute-core/dlssnr`，NGX 垫片就在谁的二进制里（见那个 crate 的 `build.rs`）。
//!
//! 留在这里的是真正属于宿主的两件：命令壳（设置页要的那几条），以及 `release`（用户
//! 手上的 DLL 与目录里那三份社区包怎么进数据目录：下载、校验、认变体）。再加一串再导出
//! ——核心的名字在宿主这边仍然叫 `crate::dlssnr::…`，调用点与测试都不用换路。
//!
//! 只做 Windows：这条路径建立在 DXGI / D3D12 / NGX 上，其它平台上 `commands` 是一组
//! 只会回「不可用」的壳（命令名与参数要和 Windows 那份一致，前端只按名字调）。

#[cfg(windows)]
pub mod commands;

/// 非 Windows 上的同名命令：设置页在这些平台上根本不显示 DLSSNR，但
///  要求命令在所有平台上都存在，所以留一组只会回「不可用」的
/// 壳。（命令名与参数要和 Windows 那份一致，前端只按名字调。）
#[cfg(not(windows))]
pub mod commands {
    use crate::domain::result::CommandResult;

    fn unavailable() -> CommandResult<serde_json::Value> {
        CommandResult::failure(
            "PLATFORM_UNAVAILABLE",
            "DLSSNR 只在 Windows 桌面端可用",
            false,
        )
    }

    #[tauri::command]
    pub fn dlssnr_status(_app: tauri::AppHandle) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_probe(
        _app: tauri::AppHandle,
        _force: Option<bool>,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub fn dlssnr_import_dll(
        _app: tauri::AppHandle,
        _path: String,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub fn dlssnr_catalog() -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_download_variant(
        _app: tauri::AppHandle,
        _variant_id: String,
    ) -> CommandResult<serde_json::Value> {
        unavailable()
    }

    #[tauri::command]
    pub async fn dlssnr_apply_page(
        _input: serde_json::Value,
        _app: tauri::AppHandle,
    ) -> Result<tauri::ipc::Response, String> {
        Ok(crate::domain::result::into_binary_response(
            CommandResult::<Vec<u8>>::failure(
                "PLATFORM_UNAVAILABLE",
                "DLSSNR 只在 Windows 桌面端可用",
                false,
            ),
        ))
    }

    /// 非 Windows 上没有任何工作区可交回，报 0 份（形状与 Windows 那份一致：
    /// 同样收一个 `AppHandle`，虽然这里用不上）。
    #[tauri::command]
    pub fn dlssnr_release_workspaces(_app: tauri::AppHandle) -> CommandResult<u32> {
        CommandResult::success(0)
    }
}

#[cfg(windows)]
mod release;

/// 引擎的名字一律从核心再导出一遍：`crate::dlssnr::status` / `…::filter::CANCELLED`
/// 这些写法在搬之前之后都得成立（`commands.rs` 与 `compute_center.rs` 都按它写）。
#[cfg(windows)]
pub use yomika_compute_core::dlssnr::*;

/// 「这份产品里的引擎在哪一侧」——**装配事实**，不是这台机器的现状。
///
/// 宿主这一份二进制没有 NGX 垫片：垫片由 `compute-core` 的 `build.rs` 编出来、跟着 worker
/// 走，而宿主开哪些 feature **不会**传播给独立 `-p` 构建的 worker
/// （`src-tauri/worker/Cargo.toml` 的 windows 段自己写着 `features = ["directml", "dlssnr"]`，
/// 契约测试 `native-config.test.ts` 钉着那一行）。等 worker 握过手，它自己报的
/// `build.engines` 就是更权威的答案——那时以它为准。
///
/// 为什么写成一个有名字的常量而不是就地写 `true`：这是一条**依赖**，不是一句判断。
/// 哪天 worker 不再带 DLSSNR（或者宿主改成不装 worker），这句话就得跟着改，而名字会让
/// 改的人看见「这里还有一句话依赖着那个事实」。
pub const ENGINE_IS_SHIPPED_IN_THE_WORKER: bool = true;

/// 把「引擎那一侧有没有 NGX」与「这台机器有什么卡」拼成 [`EngineFacts`]：`status_with`
/// 与 [`runtime_gate_with`] 要的就是这两条。
///
/// 没有握手记录时**不能**答「没有引擎」：那段窗口里 `status_with` 会因为
/// `core_available = false` 而整组藏起来（用户在设置页看到的是「这台机器不支持」），
/// 那是一句假话——宿主只是还没问过 worker 而已。装配事实（引擎在 worker 里）才是那段
/// 窗口里如实的样子。
///
/// 卡的枚举留在这里（`gpu::detect_gpu` 只调 DXGI，不碰 D3D12/NGX）：它是「这台机器」的
/// 事实，只有这一侧的进程看得见那台机器的显示器。
#[cfg(windows)]
pub fn engine_facts(build: Option<&yomika_compute_protocol::BuildInfo>) -> EngineFacts {
    EngineFacts {
        core_available: build
            .map(|build| {
                build
                    .engines
                    .iter()
                    .any(|engine| engine == yomika_compute_protocol::DLSSNR_ENGINE_ID)
            })
            .unwrap_or(ENGINE_IS_SHIPPED_IN_THE_WORKER),
        gpu: yomika_compute_core::dlssnr::gpu::detect_gpu().ok().flatten(),
    }
}

/// 把宿主的错误日志接到引擎那一层（`lib.rs` 启动时调一次）。
///
/// 引擎那边只装一次（`OnceLock`），而且不认识宿主的日志目录策略：动图跳过要留一行
/// 「为什么跳过」，而**落到哪个文件**是这一层的事——界面里那个错误日志面板读的就是
/// `<data>/logs/error.log`。没人装时引擎退回 stderr（worker、纯核心测试就是那样）。
#[cfg(windows)]
pub fn install_skip_logger() {
    yomika_compute_core::dlssnr::set_skip_logger(|data_dir, message, detail| {
        crate::error_log::record_at_data_dir(data_dir, "warn", "dlssnr/animation", message, detail)
    });
}

// 这里原来还有一个非 Windows 的 `release_cached_workspaces() -> usize` 壳（恒 0）。
// 8-g④-b2c 把两个调用点（`lib.rs` 关窗进托盘、`dlssnr_release_workspaces`）都改成了
// 问 manager —— 工作区本来就在 worker 进程里，宿主这一侧没有东西可以「交回」。
// 留一个恒 0 的壳，下一个人迟早会把它当成「宿主也能交回」的证据。

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// 引擎只交出一行诊断（`animation::note_skip`），**落到哪个文件**是这一层的事：这条
    /// 把整条链走一遍——超预算的动图 → 注入的日志口 → `<data>/logs/error.log`。
    ///
    /// 超预算那份夹具不用真造上百 MB 像素：`shape()` 只读 GIF 固定头部那 4 个字节，把
    /// 逻辑屏幕尺寸改大就能把「超预算」那道门推开（引擎那半也这么做，见
    /// `compute-core/src/dlssnr/animation.rs` 的 `gif_with_patched_canvas`）。
    #[test]
    fn the_engines_skip_notes_land_in_the_error_log() {
        let dir = tempfile::tempdir().expect("temp dir");
        install_skip_logger();
        let mut source = include_bytes!("testdata/animated.gif").to_vec();
        source[6..8].copy_from_slice(&60_000u16.to_le_bytes());
        source[8..10].copy_from_slice(&60_000u16.to_le_bytes());

        let out = apply_dlssnr(
            dir.path(),
            &source,
            &DlssnrSettings::default(),
            &crate::inference::cancel::CancelToken::none(),
        )
        .expect("超预算不是错误");
        assert_eq!(out, None, "超预算应当原样交回");

        let log = std::fs::read_to_string(dir.path().join("logs").join("error.log"))
            .expect("跳过要写进错误日志");
        assert!(
            log.contains("dlssnr/animation"),
            "日志要带上来源，否则查不下去：{log}"
        );
        assert!(log.contains("总像素"), "日志要说清是被像素预算挡下的：{log}");
        assert!(
            log.contains("60000×60000"),
            "日志要带上画布与帧数，否则查不下去：{log}"
        );
    }

    fn build_info(engines: &[&str]) -> yomika_compute_protocol::BuildInfo {
        yomika_compute_protocol::BuildInfo {
            version: "0.0.0-test".to_string(),
            runtimes: Vec::new(),
            engines: engines.iter().map(|engine| engine.to_string()).collect(),
            model_formats: vec!["onnx".to_string()],
            // 这一处是**宿主自己**手里捏的引擎事实，不是 worker 报的——构建戳对不上
            // 与它无关，所以留空，别让「没报戳」在这里被当成一条情报。
            commit: String::new(),
        }
    }

    /// 宿主问不出「我这份二进制有没有 NGX 核心」——那是一句永远是「没有」的假话。引擎
    /// 在哪一侧是**装配事实**，所以还没握过手时也要答「在 worker 里」。
    #[test]
    fn without_a_handshake_the_engine_is_still_where_it_ships() {
        let facts = engine_facts(None);
        assert!(
            facts.core_available,
            "还没问过 worker 时不能答「没有引擎」：设置页会因此整组藏起来"
        );
        assert!(ENGINE_IS_SHIPPED_IN_THE_WORKER, "这条装配事实是上面那句的依据");
    }

    /// 握过手就以 worker 自己报的为准：它在 `BuildInfo.engines` 里说自己认得哪些授权形状。
    #[test]
    fn a_handshake_that_claims_dlssnr_is_believed() {
        let facts = engine_facts(Some(&build_info(&["onnx", "dlssnr"])));
        assert!(facts.core_available);
    }

    /// 反过来也成立：worker 说自己没有，宿主不能替它硬说「有」——哪怕这句话在今天的
    /// 构建图里不该出现（Windows 的 worker 一定带着 DLSSNR 那一半）。
    #[test]
    fn a_handshake_that_denies_dlssnr_is_believed_too() {
        let facts = engine_facts(Some(&build_info(&["echo"])));
        assert!(
            !facts.core_available,
            "引擎那一侧的话压过装配事实，否则宿主就是在替别人猜"
        );
    }
}
