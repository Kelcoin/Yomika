//! 阅读器那道门：把「这一页是谁 + 现在选的是哪个模型」铸成一份提交计划。
//!
//! 为什么不把这件活交给渲染进程：任务身份里的 `settings_id` 就是缓存修订号，而它由宿主的
//! [`enhanced_revision`] 算出——模型包指纹、声明的后端、运行时库版本与管线口径全拼在那
//! 一个串里（`inference::derived_cache_revision`）。渲染进程手上没有这些东西，自己拼一个
//! 串只会得到两种结果：永远命中不了缓存，或者同一份设置被当成两件任务各算一遍。
//! 所以这一层只做渲染进程做不了的事：**算身份**。
//!
//! 它不读字节、不算哈希、不发模型授权。`into_request` 交出去的 `input` 里那份哈希与长度
//! 是**索引说的**（`cache::cached_blob_location` 读的主键行），真读、真核、真摆进只读输入
//! 根都在派发前那一侧（`manager::prepare_run`，docs/71 §7.1、§11 Task 7）。

use std::path::Path;

use yomika_compute_core::runtime::{platform_preference, RuntimeId};
use yomika_compute_protocol::messages::{EnginePolicy, PipelineStage, RunInput};

use super::manager::{SourceFile, SubmitRequest};
use super::scheduler::{JobKey, Priority};
use crate::cache::CacheImageIdentity;
use crate::inference::{
    enhanced_revision, resolve_upscaler, source_identity, ResolvedUpscaler, ENHANCED_OUTPUT_SCALE,
};

/// 超分那一步在管线里的名字。旧命令、代理、这里都用同一个：同一件事只有一个名字。
pub const UPSCALE_STAGE_ID: &str = "upscale";

/// 产物落盘许可的来路标签。它只用来记账「是谁让它落的盘」，不参与任务身份。
pub const READER_UPSCALE_GRANT_ID: &str = "reader-upscale";

/// 这条路上跑的引擎政策：**本构建能问到的第一条硬件运行库**，问不到就是 `Cpu`。
///
/// 为什么不写死 `Cpu`：写死等于替用户回答「这台机器只能用 CPU」，报告里也就永远没有
/// 「想要谁 / 用了谁」那一栏——显卡到底跑没跑，界面无从知道（docs/71:126「强制 GPU 不得
/// 静默变成 CPU；auto 可显式回退并展示原因」）。`platform_preference` 只说「想用哪个」，
/// 能不能用由 worker 那一侧的实测探针决定：探针不过就退 CPU，并把原因写进
/// `EngineReport::fallback`。所以这里问 `Auto` 是**问**，不是承诺。
/// `pub(crate)` 而不是私有：宿主里别的算路（`super::proxy`、字节桥 `compute_center`）问的是
/// 同一件事——这台机器想用哪个运行库。远端处理计划的身份里也要带上它，所以它得从 `compute`
/// 里露出来。
pub(crate) fn engine_policy() -> EnginePolicy {
    let preferred = platform_preference()
        .first()
        .copied()
        .unwrap_or(RuntimeId::Cpu);
    if preferred.is_hardware_accelerated() {
        EnginePolicy::Auto
    } else {
        EnginePolicy::Cpu
    }
}

/// 键上那个后端标签：与引擎政策是同一件事的两种写法，所以由政策派生，不另写一份。
pub(crate) fn engine_policy_label() -> &'static str {
    engine_policy().as_str()
}

/// 这一版的提交只认这一个起点：`reader-page`。
///
const READER_PAGE_RENDITION: &str = "reader-page";

/// 阅读器这一页要算的是什么。全是**渲染进程知道、宿主算不出**的东西。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderPageRequest {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 超分模型的 id（不是路径，也不是文件名）。
    pub model_id: String,
    /// 阅读器世代（§9.1）：翻页换代，旧一代整批丢掉。
    pub generation: u64,
    pub priority: Priority,
    /// 0 = 用调度器的默认期限。
    pub deadline_ms: u64,
}

/// 铸好的身份：全是**宿主才知道**的值。
///
/// 字段一个都不能少：`settings_id` 与 `source_revision` 决定「这是什么任务」，`source_identity`
/// 决定「起点读哪一行」，`model_spec_id`/`scale`/`output_scale` 决定怎么算。
#[derive(Clone, Debug, PartialEq)]
pub struct ReaderPageJob {
    pub input_id: String,
    pub settings_id: String,
    pub source_revision: String,
    pub backend: String,
    /// 起点那一版在缓存里的身份。宿主拿它查这一页的位置（`cache::cached_blob_location`）。
    pub source_identity: CacheImageIdentity,
    pub model_spec_id: String,
    pub scale: u32,
    /// 交出去的尺寸由宿主的产品策略定：模型原生倍率更大时，worker 在编码之前缩下来。
    pub output_scale: Option<u32>,
    pub generation: u64,
    pub priority: Priority,
    pub deadline_ms: u64,
}

/// 铸不出来的时候：码 + 给用户看的一句话 + 值不值得重试。
///
/// 码用 `COMPUTE_*` 词汇而不是旧命令那套 `INFERENCE_*`：这是一条新来路，没有要兼容的旧
/// 调用方；翻译旧词汇是 `proxy.rs` 为**旧命令**做的事（docs/71 §11 Task 7）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReaderPlanError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ReaderPlanError {
    /// 请求本身说不通：前端送来一个不认识的起点，或者根本没指名模型。
    fn bad(message: impl Into<String>) -> Self {
        Self {
            code: "COMPUTE_BAD_REQUEST",
            message: message.into(),
            retryable: false,
        }
    }

    /// 要算的东西这台机器上没有（模型没装、这一档只活在宿主里）。
    ///
    /// 不可重试：再试一次还是同一个答案，用户得去装模型或者换一个选择。把它报成故障会
    /// 让阅读器反复重跑同一页。
    fn no_model(message: impl Into<String>) -> Self {
        Self {
            code: "COMPUTE_MODEL_UNAVAILABLE",
            message: message.into(),
            retryable: false,
        }
    }
}

/// 指名一个**能在 worker 里跑**的超分模型：查得到就交回（模型, 倍数），查不到就说清为什么。
///
/// 抽成函数是因为有不止一个调用点：`super::proxy` 那条来路也要按**同一把尺子**判
/// 「这个模型能不能进 worker」。两处各写一份，就会出现两条路各有一套判据这种没人下过的决定。
pub(super) fn resolve_worker_upscaler(
    models_data: &Path,
    model_id: &str,
) -> Result<(ResolvedUpscaler, u32), ReaderPlanError> {
    // 没选模型就等于「用最近邻」——那条路在宿主进程里，不到 worker 里来。这不是用户填错
    // 了什么，而是这条来路只服务「指名了某个引擎的页面」，所以说清楚它要什么。
    if model_id.is_empty() {
        return Err(ReaderPlanError::bad(
            "这一页要指名一个超分引擎（模型，或者内置的 Anime4K 链）",
        ));
    }
    // 模型是**指名**的：查不到就得当场说「没装」，不许悄悄换成就近邻——那会让一个装丢了
    // 的模型看起来像一个很差的模型。
    let Some(resolved) = resolve_upscaler(models_data, model_id) else {
        return Err(ReaderPlanError::no_model(format!(
            "这台机器上还没有这个超分模型：{model_id}（先去设置里下载它）"
        )));
    };
    let scale = match &resolved {
        ResolvedUpscaler::Onnx(_, manifest) => manifest.scale.clamp(1, 4),
        // 内置的 shader 链也走这一条来路：解析器与两个执行体（CPU 解释器、WGSL 计算
        // 管道）都在 `yomika-compute-core` 里，worker 那一份构建同样编着它，所以这里
        // 它和「模型目录里的一份 ONNX」一样是**能交给 worker 的东西**——区别只在交过去
        // 的是文件还是一句身份（`compute::models::StagedModel`）。
        ResolvedUpscaler::Anime4k(preset) => preset.scale,
    };
    Ok((resolved, scale))
}

/// 这一页 + 这套配置 → 一份任务身份。
///
/// `models_data` 是模型包所在的数据目录（`data_paths::model_data_dir`）——指纹要从那儿
/// 算出来，所以这一步只能在这一侧做。
///
/// 只算身份，**不查这一页在不在缓存里**：那是 `cache::cached_blob_location` 的活，调用方
/// 拿 [`ReaderPageJob::source_identity`] 去查。分成两步是为了让这一步没有数据库、没有文件
/// 系统也能测（见本文件的测试），而「查不到」是**可重试的输入问题**，不是身份算不出来。
pub fn plan_reader_page(
    models_data: &Path,
    request: &ReaderPageRequest,
) -> Result<ReaderPageJob, ReaderPlanError> {
    if request.page_index < 0 {
        return Err(ReaderPlanError::bad(format!(
            "页码不能是负数：{}",
            request.page_index
        )));
    }
    // 没选模型就等于「用最近邻」——那条路在宿主进程里，不到 worker 里来（判定与那句提示
    // 都在 `resolve_worker_upscaler` 里，链上第二步问的是同一个问题）。
    let model_id = request.model_id.trim();
    let (resolved, scale) = resolve_worker_upscaler(models_data, model_id)?;

    Ok(ReaderPageJob {
        // 与旧命令同一个形状：`{scope}:{archive}:{page}`。阅读器按这一页记账，两条来路
        // 必须认得出「这是同一页」，否则切过来之后每一页都会被当成新的一页。
        input_id: format!(
            "{}:{}:{}",
            request.scope_id, request.archive_id, request.page_index
        ),
        settings_id: enhanced_revision(&Some(resolved)),
        source_revision: READER_PAGE_RENDITION.to_string(),
        backend: engine_policy_label().to_string(),
        source_identity: source_identity(
            &request.scope_id,
            &request.archive_id,
            request.page_index,
            READER_PAGE_RENDITION,
        ),
        model_spec_id: model_id.to_string(),
        scale,
        output_scale: Some(ENHANCED_OUTPUT_SCALE),
        generation: request.generation,
        priority: request.priority,
        deadline_ms: request.deadline_ms,
    })
}

/// 身份 + 宿主查到的这一页位置 → 一份派发请求。
///
/// 收的是一份 [`SourceFile`]（路径 + 索引说的哈希与长度），不是缓存行本身：这一层不必知道
/// 索引长什么样，也不必知道路径是怎么查出来的。命令层把 `cache::cached_blob_location` 的
/// 结果交给它（`From<CachedBlobLocation> for SourceFile`）。
///
/// 这里**不读字节、不算哈希**：`input` 里那份哈希与长度是索引说的那一份，真读、真核、
/// 真摆进只读输入根都在派发前那一侧（`manager::prepare_run`）。`source` 那只手把位置
/// 原样带上，于是「索引说的」与「磁盘上的」会在派发前对一次（不一致就当场停）。
pub fn into_request(job: ReaderPageJob, source: SourceFile) -> SubmitRequest {
    SubmitRequest {
        key: JobKey {
            input_id: job.input_id.clone(),
            settings_id: job.settings_id,
            source_revision: job.source_revision,
            backend: job.backend,
            generation: job.generation,
        },
        priority: job.priority,
        input: RunInput {
            input_id: job.input_id,
            content_hash: source.content_hash.clone(),
            byte_length: source.byte_length,
            // 路径由宿主的 `source` 那只手带：调用方在这一层已经没有任何话要说。
            relative_path: None,
        },
        pipeline: vec![PipelineStage {
            stage_id: UPSCALE_STAGE_ID.to_string(),
            model_spec_id: job.model_spec_id,
            // 模型授权与最小边长由宿主在派发前补齐（`manager::prepare_run`）——调用方
            // 不许指名模型文件，这条在协议层就定了（docs/71 §7.2）。内置链的授权
            // （`builtin`）同样在那一侧填：这一层只说「要哪一档」。
            model: None,
            builtin: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: job.output_scale,
            engine_policy: engine_policy(),
            scale: Some(job.scale),
            tile: None,
            layers: None,
            settings_id: None,
        }],
        output_grant_id: READER_UPSCALE_GRANT_ID.to_string(),
        deadline_ms: job.deadline_ms,
        source: Some(source),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::CachedBlobLocation;
    use crate::inference::{resolve_upscaler, MODEL_MANIFEST_FILE};

    /// 临时数据根。名字带进程号：同一个 crate 的测试并行跑，几个用例互不相干。
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yomika-reader-plan-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 一份装好的模型包，长得像 `resolve_installed_model` 要的样子：
    /// `models/<id>/<version>/{yomika-model.json, model.onnx}`，正好一个 ONNX 文件。
    ///
    /// 不把真的 5 MB 模型搬进来：这里要钉的是**身份**，而身份只用到清单里的 scale。
    fn install_model(root: &Path, id: &str, scale: u32) {
        let install = root.join("models").join(id).join("1");
        std::fs::create_dir_all(&install).expect("建模型目录");
        std::fs::write(install.join("model.onnx"), b"onnx").expect("写模型文件");
        let manifest = serde_json::json!({
            "id": id,
            "version": "1",
            "format": "onnx",
            "scale": scale,
            "maxPixels": 64_000_000u64,
            "sha256": "b".repeat(64),
            "supportedBackends": ["cpu"],
            "minInputEdge": 20,
        });
        std::fs::write(
            install.join(MODEL_MANIFEST_FILE),
            serde_json::to_vec(&manifest).expect("清单要能变成 JSON"),
        )
        .expect("写清单");
    }

    fn request(model_id: &str) -> ReaderPageRequest {
        ReaderPageRequest {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 11,
            model_id: model_id.to_string(),
            generation: 3,
            priority: Priority::Foreground,
            deadline_ms: 0,
        }
    }

    /// 索引里查到的那一行，走产品里同样那一步转换（`From`）：测试要钉的正是
    /// 「查到的位置原样变成提交要带的那份源图」。
    fn located() -> SourceFile {
        SourceFile::from(CachedBlobLocation {
            path: std::path::PathBuf::from("C:/data/cache/images/ab/ab.bin"),
            content_hash: "c".repeat(64),
            byte_length: 4096,
        })
    }

    /// 这一页 + 这个模型要算成哪件任务：身份必须与旧命令那条路**同源**。
    ///
    /// 断言 `settings_id` 等于 `enhanced_revision` 算出来的那一个，是在钉「身份只有一份
    /// 算法」：谁要是在这里另写一套修订号，这条测试当场红。
    #[test]
    fn a_page_and_a_model_become_the_identity_the_old_command_would_use() {
        let root = scratch("identity");
        install_model(&root, "realesr", 2);

        let job = plan_reader_page(&root, &request("realesr")).expect("模型装好了，身份铸得出来");

        assert_eq!(job.input_id, "scope-a:archive-a:11");
        assert_eq!(
            job.settings_id,
            enhanced_revision(&resolve_upscaler(&root, "realesr")),
            "任务身份与旧命令（inference_upscale_page）必须是同一个串"
        );
        assert_eq!(job.source_revision, "reader-page");
        assert_eq!(
            job.backend,
            engine_policy_label(),
            "身份里的后端标签就是这条路上跑的引擎政策"
        );
        assert_eq!(job.source_identity.scope_id, "scope-a");
        assert_eq!(job.source_identity.archive_id, "archive-a");
        assert_eq!(job.source_identity.page_index, 11);
        assert_eq!(job.source_identity.rendition, READER_PAGE_RENDITION);
        assert!(
            job.source_identity.revision.is_none(),
            "原图那一版不挂修订号：它属于归档，不属于哪个模型"
        );
        assert_eq!(job.model_spec_id, "realesr");
        assert_eq!(job.scale, 2, "倍率由模型自己的清单说了算");
        assert_eq!(job.output_scale, Some(ENHANCED_OUTPUT_SCALE));
        assert_eq!(job.generation, 3);
        assert_eq!(job.priority, Priority::Foreground);
        assert_eq!(job.deadline_ms, 0);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 同一个问题问两次要是同一个答案；换了模型就必须是另一件任务。
    ///
    /// 前一半是「同身份的提交会合并」的前提，后一半是「换了模型不能吃旧产物」的前提。
    #[test]
    fn the_identity_is_stable_and_the_model_is_part_of_it() {
        let root = scratch("stable");
        install_model(&root, "realesr", 2);
        install_model(&root, "othernets", 3);

        let first = plan_reader_page(&root, &request("realesr")).expect("第一件");
        let again = plan_reader_page(&root, &request("realesr")).expect("同一个问题");
        let other = plan_reader_page(&root, &request("othernets")).expect("换一个模型");

        assert_eq!(first, again, "同一页 + 同一份设置 = 同一件任务");
        assert_ne!(
            first.settings_id, other.settings_id,
            "换了模型就是另一件任务：否则新模型会吃到旧模型的产物"
        );
        assert_ne!(first.scale, other.scale);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 没装的模型要说「没装」，而且要指名是哪一个。悄悄换成就近邻是最糟的答案：
    /// 用户看到一张模糊的图，只会以为模型很差。
    #[test]
    fn a_model_this_machine_does_not_have_is_named() {
        let root = scratch("missing");
        let error = plan_reader_page(&root, &request("realesr")).expect_err("这台机器上没有它");

        assert_eq!(error.code, "COMPUTE_MODEL_UNAVAILABLE");
        assert!(!error.retryable, "没装模型不是重试能好起来的事");
        assert!(
            error.message.contains("realesr"),
            "要说清楚是哪一个模型：{}",
            error.message
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 宿主内置的那一档（Anime4K）在这一层与模型**同一条来路**：解析器与执行体都搬进了
    /// `yomika-compute-core`，worker 那一份构建同样编着它，所以它不是「装不了」，而是
    /// 一件正常的、可以派给 worker 的任务。
    ///
    /// 这条以前反向断言「送不过去」（COMPUTE_MODEL_UNAVAILABLE）。改成断言它**铸得出身份**
    /// 之后，判据的方向也跟着换了：谁要是把 Anime4k 分支退回成拒绝，这里当场红。
    #[test]
    fn a_builtin_chain_plans_like_a_model_and_keeps_its_own_identity() {
        let root = scratch("builtin-chain");
        let job = plan_reader_page(&root, &request("anime4k-hq")).expect("内置链也派得出去");

        assert_eq!(job.model_spec_id, "anime4k-hq");
        assert_eq!(job.scale, 2, "倍率由预设自己说了算");
        assert_eq!(
            job.settings_id,
            enhanced_revision(&resolve_upscaler(&root, "anime4k-hq")),
            "身份仍旧只有一份算法：内置链也不例外"
        );

        // 与同一档的另一个预设必须是**两件任务**，否则换了链会吃到旧链的产物。
        let small = plan_reader_page(&root, &request("anime4k")).expect("小链");
        assert_ne!(job.settings_id, small.settings_id, "不同链 = 不同身份");

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 一个模型都没指名：这条来路只服务「要在 worker 里跑的模型」。
    #[test]
    fn an_unnamed_model_is_refused_before_anything_is_resolved() {
        let root = scratch("unnamed");
        let error = plan_reader_page(&root, &request("   ")).expect_err("没指名模型");

        assert_eq!(error.code, "COMPUTE_BAD_REQUEST");
        assert!(!error.retryable);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 负数页码与其它明显的胡说一样：在起 worker 之前就该挡下来。
    #[test]
    fn a_negative_page_index_is_refused() {
        let root = scratch("negative");
        install_model(&root, "realesr", 2);
        let mut negative = request("realesr");
        negative.page_index = -1;

        let error = plan_reader_page(&root, &negative).expect_err("页码不能是负数");
        assert_eq!(error.code, "COMPUTE_BAD_REQUEST");

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 身份 + 位置 → 派发请求：这一层不许再往里塞别的话。
    ///
    /// 尤其 `relative_path` 必须是空的——路径由 `source` 那只手带，一个来源，一份说法。
    #[test]
    fn the_location_becomes_the_subject_the_supervisor_verifies() {
        let root = scratch("request");
        install_model(&root, "realesr", 2);
        let job = plan_reader_page(&root, &request("realesr")).expect("身份");
        let located = located();
        let expected_hash = located.content_hash.clone();
        let request = into_request(job, located);

        assert_eq!(request.key.input_id, "scope-a:archive-a:11");
        assert_eq!(request.key.source_revision, "reader-page");
        assert_eq!(
            request.key.backend,
            engine_policy_label(),
            "键上的后端标签由引擎政策派生"
        );
        assert_eq!(request.priority, Priority::Foreground);
        assert_eq!(request.input.input_id, "scope-a:archive-a:11");
        assert!(request.input.relative_path.is_none());
        assert_eq!(request.input.content_hash, expected_hash);
        assert_eq!(request.input.byte_length, 4096);
        let source = request.source.expect("这一手必须带位置");
        assert_eq!(source.content_hash, expected_hash);
        assert_eq!(source.byte_length, 4096);
        assert_eq!(request.output_grant_id, READER_UPSCALE_GRANT_ID);
        assert_eq!(request.pipeline.len(), 1);
        let stage = &request.pipeline[0];
        assert_eq!(stage.stage_id, UPSCALE_STAGE_ID);
        assert_eq!(stage.model_spec_id, "realesr");
        assert_eq!(stage.scale, Some(2));
        assert_eq!(stage.output_scale, Some(ENHANCED_OUTPUT_SCALE));
        assert!(stage.model.is_none(), "模型授权由宿主在派发前补齐");
        assert!(stage.min_input_edge.is_none());

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 引擎与键上那个标签是同一件事的两种写法：换了一个没换另一个，调度器就会把两个不同
    /// 的引擎当成同一件事去合并。这条同时钉住「政策不再是写死的 `Cpu`」。
    #[test]
    fn the_engine_and_the_key_label_say_the_same_thing() {
        assert_eq!(
            engine_policy_label(),
            engine_policy().as_str(),
            "改了这一对里的一个就要改另一个"
        );
        // Windows 上平台偏好第一条就是硬件运行库，所以这条路上必须去**问**它，而不是
        // 直接宣布用 CPU。探针不过时核心会退回来，并把原因写进报告。
        #[cfg(windows)]
        assert_eq!(
            engine_policy(),
            EnginePolicy::Auto,
            "有硬件候选就该问，不能替用户宣布只有 CPU"
        );
    }
}
