//! 宿主侧的计算编排（`docs/71` §5.1、§8）。
//!
//! 这里**只有编排**：谁先算、最多算几件、取消怎么结算、结果怎么回收。算法在 worker
//! 进程里（`src-tauri/worker`），宿主不碰模型，也不在 UI 线程上等计算。
//!
//! Task 4 落 [scheduler]（纯状态，可单测）、[resource_policy]（纯算术）、[job_object]
//! （收族）、[manager]（supervisor 线程）与 [commands]（只入队 / 只读小状态）。

use std::path::PathBuf;
use std::sync::Arc;

pub mod artifacts;
pub mod asset_protocol;
pub mod commands;
pub mod decensor;
pub mod inputs;
pub mod job_object;
pub mod leases;
pub mod manager;
pub mod models;
pub mod page_budget;
pub mod proxy;
pub mod reader;
pub mod renditions;
pub mod resource_policy;
pub mod scheduler;

use leases::LeaseStore;
use manager::{ComputeManager, SupervisorConfig};
use renditions::RenditionIndex;
// `try_state` 挂在 `Manager` 这个 trait 上（`AppHandle` 自己也实现它）。
use tauri::Manager;

/// 进程内的一份计算编排句柄。
///
/// 里面装 `Option`：极端情况下连控制线程都起不来时，命令必须能**回答**「现在算不了」。
/// 让 `State` 取不到会 panic，而命令里 panic 会跨 FFI 边界中止整个进程——用户看到的是
/// 闪退，不是一条错误提示。
pub struct ComputeHandle {
    manager: Option<Arc<ComputeManager>>,
    /// 产物租借表。它和编排能不能起来无关：编排没起来时表照样在，于是「这张图现在取
    /// 不了」能答成一条明确的错误，而不是一个取不到 `State` 的 panic。
    leases: Arc<LeaseStore>,
    /// 「这件任务会产出页面的哪几版」。命令层在提交时记下、取产物时用它把内容寻址的
    /// 产物挂成索引里那一行（[renditions]）。
    ///
    /// 与租借表同理：编排没起来时它照样在（只是永远是空的），所以命令不必为一个取不到的
    /// `State` 做特判。
    renditions: Arc<RenditionIndex>,
}

impl ComputeHandle {
    pub fn get(&self) -> Option<&Arc<ComputeManager>> {
        self.manager.as_ref()
    }

    pub fn leases(&self) -> &Arc<LeaseStore> {
        &self.leases
    }

    pub fn renditions(&self) -> &Arc<RenditionIndex> {
        &self.renditions
    }
}

/// 从壳里取出编排把手（`AppHandle` → `ComputeHandle` → worker 的 supervisor）。
///
/// 取不到不是错误：测试里直接起算力中心的那种用法没有 `AppHandle`，启动早期编排也还
/// 没起来；真要 worker 的那一档会在自己那一层给出明确的说法。三处调用点
/// （`compute_center` 的 HTTP 处理、`dlssnr` 的命令、DeepLink 之后的能力清单）走的是
/// **同一条**取法，省得各写一份「取不到就 None」的分支。
pub fn manager_from_app(app: &tauri::AppHandle) -> Option<Arc<ComputeManager>> {
    app.try_state::<ComputeHandle>()
        .and_then(|handle| handle.get().cloned())
}

/// 起计算编排：准备好工作目录、装上 supervisor 线程。
///
/// **不 spawn worker**——worker 要等到真有任务排队才起（§8.1），所以启动界面不为计算
/// 付任何代价；GPU 探测与模型加载也都在 worker 里（§11 Task 4 ⑤）。
pub fn start(app: &tauri::AppHandle) -> Result<ComputeHandle, String> {
    let data_root = crate::data_paths::data_dir(app)
        .map_err(|error| format!("拿不到数据目录：{error}"))?;
    let staging_root = data_root.join("compute").join("staging");
    std::fs::create_dir_all(&staging_root)
        .map_err(|error| format!("建计算工作目录 {} 失败：{error}", staging_root.display()))?;
    // 输入根与 staging 是兄弟目录：worker 只被允许在 staging 根下平铺写产物，输入
    // 必须另占一层（docs/71 §7.1）。这里先建出来，是为了启动时就发现权限问题，而不是
    // 等到第一次真的算图才报错。
    let inputs_root = inputs::inputs_root_for(&staging_root);
    std::fs::create_dir_all(&inputs_root)
        .map_err(|error| format!("建计算输入目录 {} 失败：{error}", inputs_root.display()))?;
    let mut config = SupervisorConfig::new(worker_binary_path(), &staging_root);
    // 模型和页面走**同一条**只读输入根（`models` 的模块注释）：worker 因此只保留一条
    // 能被允许读用户数据的路，而不是「页面一条、模型一条」。
    config.models = Some(models::ModelCatalog::new(&data_root));
    // 生产 worker 跑真的 ONNX；回声引擎只在测试里出现（见 `WorkerEngine` 的注释）。
    config.worker_engine = manager::WorkerEngine::Onnx;
    // 产物的正式落点是数据根：内容寻址路径（`cache/images/...`）从根算起，
    // 与既有图片缓存同一套布局，于是「算出来的图」和「读出来的缓存」是同一份东西。
    config.publish_root = Some(data_root);
    let manager = ComputeManager::start(config, app_job_changed_sink(app.clone()))
        .map_err(|error| format!("起计算编排线程失败：{error}"))?;
    Ok(ComputeHandle {
        manager: Some(manager),
        leases: Arc::new(LeaseStore::new()),
        renditions: Arc::new(RenditionIndex::new()),
    })
}

/// 起不来时用的句柄：命令照常能回答，只是答案都是「算不了」。
pub fn unavailable() -> ComputeHandle {
    ComputeHandle {
        manager: None,
        leases: Arc::new(LeaseStore::new()),
        renditions: Arc::new(RenditionIndex::new()),
    }
}

/// worker 可执行文件的位置：和主程序同一个目录。
///
/// 打包（Task 10）要把它放在这儿；开发时 `cargo build -p yomika` **不会**顺手编它
/// （它不是 `yomika` 的依赖），所以开发机上可能整条计算链暂时报「找不到 worker
/// 可执行文件」——那是实话，不是故障。
pub fn worker_binary_path() -> PathBuf {
    let name = if cfg!(windows) {
        "yomika-compute-worker.exe"
    } else {
        "yomika-compute-worker"
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// 前端监听的事件名。与 `src/domain/compute.ts` 的 `COMPUTE_JOB_CHANGED_EVENT` 是同一根
/// 绳子：改一边就必须改另一边（Rust 这侧唯一能帮忙的就是本文件里的那条测试）。
pub const COMPUTE_JOB_CHANGED_EVENT: &str = "compute-job-changed";

/// 「任务变了」的送出动作。
///
/// 抽成一个收闭包的函数是为了**能在单测里看见它**：真的 `emit` 需要一个 `AppHandle`，
/// 而单测里没有（也不该有）一个跑起来的 WebView。事件名与载荷形状因此可以被钉住。
pub fn job_changed_sink<F>(emit: F) -> manager::EventSink
where
    F: Fn(&str, &scheduler::JobSnapshot) + Send + Sync + 'static,
{
    Arc::new(move |snapshot| emit(COMPUTE_JOB_CHANGED_EVENT, snapshot))
}

/// 生产用的那个出口：把快照 `emit` 给前端。
///
/// 发不出去只意味着前端看不到实时进度（重进阅读器/重查还能拿到终态），编排本身照常跑，
/// 所以这里只记一行，不把错误往上抛——一个没人听的事件不该让一件正在算的任务失败。
pub fn app_job_changed_sink(app: tauri::AppHandle) -> manager::EventSink {
    use tauri::Emitter;
    job_changed_sink(move |event, snapshot| {
        if let Err(error) = app.emit(event, snapshot.clone()) {
            eprintln!("yomika: 计算事件发不出去：{error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::scheduler::{JobKey, JobSnapshot, JobState, Priority};
    use std::sync::Mutex;

    fn snapshot() -> JobSnapshot {
        JobSnapshot {
            job_id: "job-1".to_string(),
            key: JobKey {
                input_id: "archive-a:12".to_string(),
                settings_id: "settings-1".to_string(),
                source_revision: "rev-1".to_string(),
                backend: "directml".to_string(),
                generation: 1,
            },
            priority: Priority::Foreground,
            state: JobState::Running {
                stage: "upscale".to_string(),
                index: 0,
            },
            subscribers: 1,
            sequence: 7,
            created_ms: 0,
            settled_ms: None,
        }
    }

    /// 前端 `ComputeJobSnapshotSchema` 认的就是这个形状。Rust 这侧只能靠钉住 JSON 来保证
    /// 两边对齐——编译期一点忙都帮不上，字段名写错了要到浏览器里才发现。
    #[test]
    fn the_job_changed_event_carries_the_snapshot_the_frontend_parses() {
        let value = serde_json::to_value(snapshot()).expect("快照要能变成 JSON");
        assert_eq!(value["jobId"], "job-1");
        assert_eq!(value["key"]["inputId"], "archive-a:12");
        assert_eq!(value["key"]["settingsId"], "settings-1");
        assert_eq!(value["key"]["sourceRevision"], "rev-1");
        assert_eq!(value["key"]["backend"], "directml");
        assert_eq!(value["key"]["generation"], 1);
        assert_eq!(value["priority"], "foreground");
        // `JobState` 没挂 `tag`：单位变体就是字符串，带数据的变体是外部标签。
        assert_eq!(value["state"]["running"]["stage"], "upscale");
        assert_eq!(value["state"]["running"]["index"], 0);
        assert_eq!(value["subscribers"], 1);
        assert_eq!(value["sequence"], 7);
        assert_eq!(value["createdMs"], 0);
        assert_eq!(value["settledMs"], serde_json::Value::Null);
    }

    #[test]
    fn the_job_changed_sink_names_the_event_the_frontend_listens_to() {
        let seen: Arc<Mutex<Vec<(String, JobSnapshot)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = job_changed_sink({
            let seen = Arc::clone(&seen);
            move |event: &str, snapshot: &JobSnapshot| {
                seen.lock()
                    .expect("记事本锁没中毒")
                    .push((event.to_string(), snapshot.clone()));
            }
        });

        sink(&snapshot());

        let seen = seen.lock().expect("记事本锁没中毒");
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, COMPUTE_JOB_CHANGED_EVENT);
        // 前端在 `src/domain/compute.ts` 里按这个名字订阅；改了要一起改。
        assert_eq!(seen[0].0, "compute-job-changed");
        assert_eq!(seen[0].1.job_id, "job-1");
        assert_eq!(seen[0].1.sequence, 7);
    }
}
