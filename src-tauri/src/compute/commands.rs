//! `compute_*` 命令：**只入队、只读小状态**（§11 Task 4 ⑤）。
//!
//! 这一层的存在意义就是「让界面能问，但绝不让界面等」。命令体全是 `pub async fn`：
//! 它们挂在 WebView2 的消息循环上跑，任何一次几百毫秒的等待都是窗口拖不动
//! （见 `src/command_dispatch.rs` 里那条不变量）。这里没有一条会等计算——起 worker、
//! 握手、写帧、等进程退出、算产物哈希全在 supervisor 线程里；命令只往队列里放东西，
//! 或者读一份已经算好的快照。
//!
//! 返回形状统一走 [`CommandResult`]：错误码是稳定的字符串，前端按码决定「重试还是提示」，
//! 不靠消息文本。外层那个 `Result<_, String>` 是 tauri 对「带引用参数的 async 命令」的
//! 要求（`State<'_, _>` 就是一个引用），`Err` 那一侧永远不用——失败都走
//! `CommandResult::failure` 的 `ok:false`，前端只需要认一种形状。

use serde::Deserialize;
use std::time::Instant;
use tauri::{Manager, State};

use super::decensor::{self, DecensorPageRequest};
use super::leases::{self, ComputedImageLease, LeaseSpec, LeaseView};
use super::manager::{
    ArtifactRecord, ComputeManager, JobProgress, SourceFile, SubmitRequest, WorkerStatus,
};
use super::reader::{self, ReaderPageRequest};
use super::renditions;
use super::scheduler::{
    CancelOutcome, DroppedGeneration, JobKey, JobSnapshot, Priority, PromoteOutcome, SubmitError,
    Submitted,
};
use super::ComputeHandle;
use crate::domain::result::CommandResult;

/// 协议 crate 里的同名边界没有导出来，所以这里各留一份。**改了要一起改**：
/// 这里只是为了在起 worker 之前把明显不合法的请求挡回去，真正的守门人还是
/// `yomika_compute_protocol::validate_message`（worker 收到 `run` 会再查一遍）。
const MAX_ID_BYTES: usize = 128;
const MAX_HASH_BYTES: usize = 128;
const MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_DEADLINE_MS: u64 = 600_000;
const MAX_PIPELINE_STAGES: usize = 8;

/// 一次提交的前端载荷。
///
/// `jobId` / `workerEpoch` / `budgets` 都不在这里：它们由 manager 在派发那一刻决定
/// （取决于排到谁、哪一代 worker），调用方猜不出来也不该猜。
///
/// `input` 与 `source` **二选一**，因为「输入是什么」有两种诚实的说法：
/// - `input`：字节已经在手上，哈希我也知道（宿主会拿它去核对，见 `manager::prepare_run`）；
/// - `source`：我只知道「这是哪一页」，位置与哈希请宿主自己去查。
///
/// 阅读器走的是后者：渲染进程手上没有这一页的字节，也不该为了提交去把几十 MB 读一遍
/// 再算一次 blake3（docs/71 §9.3）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitPayload {
    pub input_id: String,
    /// 设置/参数指纹：换了设置就是另一件任务。
    pub settings_id: String,
    /// 源文件修订号：文件变了，旧结果不能复用。
    pub source_revision: String,
    /// `cpu` / `directml` / `cuda` / `ncnn-vulkan` / `remote`。
    pub backend: String,
    /// 阅读器世代（§9.1）。
    pub generation: u64,
    /// `foreground` / `background`。
    pub priority: String,
    /// 输入声明：字节已经在这一侧手上时用它。
    #[serde(default)]
    pub input: Option<yomika_compute_protocol::messages::RunInput>,
    /// 「这一页是谁」：宿主去缓存里查它的位置与哈希（本文件 `compute_submit`）。
    #[serde(default)]
    pub source: Option<SourcePage>,
    pub pipeline: Vec<yomika_compute_protocol::messages::PipelineStage>,
    /// 产物落盘许可（Task 5 的引用计数入口）。
    pub output_grant_id: String,
    /// 0 = 用默认 deadline（§8.2 的 120 秒）。
    pub deadline_ms: u64,
}

/// 一页的**身份**，不是它的路径、也不是它的哈希。
///
/// 渲染进程给不出路径与哈希（那是宿主的账），但它知道用户在看哪一页。宿主拿这四个
/// 字段去查一次缓存主键，就能把这一页还原成一份可核对的位置。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePage {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 哪一版。目前只认 `reader-page`（缺省也是它）：`enhanced` 是产物不是输入；`decensored`
    /// 现在**也不是**输入——去码本身已经搬进 worker 了（8-b/8-c），缺的是产物怎么被读回来：
    /// compute 的产物只落内容寻址的 blob（`compute::artifacts::publish_blob`，它不写
    /// `cache_entries` 行），而按修订号取起点的那一侧查的是 SQLite。两条路接上之前，这道门
    /// 取不到 `decensored` 这一版（详见 `docs/92`）。
    #[serde(default)]
    pub rendition: Option<String>,
}

fn bad<T>(message: impl Into<String>) -> CommandResult<T> {
    CommandResult::failure("COMPUTE_BAD_REQUEST", message, false)
}

/// 编排根本没起来（控制线程都没建成）：这是这台进程的问题，不是请求的问题。
/// 返回可重试，让界面给一句「重开应用再试」而不是把它当成用户的错。
fn unavailable<T>() -> CommandResult<T> {
    CommandResult::failure(
        "COMPUTE_UNAVAILABLE",
        "计算编排没能启动（详见日志）",
        true,
    )
}

fn check_text(what: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{what} 不能为空"));
    }
    if value.len() > limit {
        return Err(format!("{what} 太长：{} 字节，上限 {limit}", value.len()));
    }
    Ok(())
}

fn parse_priority(raw: &str) -> Result<Priority, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "foreground" => Ok(Priority::Foreground),
        "background" => Ok(Priority::Background),
        other => Err(format!(
            "priority 只能是 foreground / background，收到 {other:?}"
        )),
    }
}

/// 校验并翻译成 manager 的派发请求。
///
/// `source` 是调用方（`compute_submit`）先从缓存里查出来的位置；`payload.source` 在场时
/// 它必须也在场——「这一页不在缓存里」不该伪装成「请求不合法」，所以那种情况在命令体里
/// 就已经带着 `COMPUTE_INPUT_INVALID` 返回了，走不到这里。
///
/// 在这里挡住的都是**一眼就不合法**的请求（空 id、超长、阶段太多、deadline 超上限）：
/// 早一步说清楚，就不必为一个必然失败的 run 起一次 worker。
fn plan(payload: SubmitPayload, source: Option<SourceFile>) -> Result<SubmitRequest, String> {
    check_text("inputId", &payload.input_id, MAX_ID_BYTES)?;
    check_text("settingsId", &payload.settings_id, MAX_ID_BYTES)?;
    check_text("sourceRevision", &payload.source_revision, MAX_ID_BYTES)?;
    check_text("backend", &payload.backend, MAX_ID_BYTES)?;
    check_text("outputGrantId", &payload.output_grant_id, MAX_ID_BYTES)?;
    if payload.pipeline.is_empty() {
        return Err("pipeline 至少要有一个阶段".to_string());
    }
    if payload.pipeline.len() > MAX_PIPELINE_STAGES {
        return Err(format!(
            "pipeline 最多 {MAX_PIPELINE_STAGES} 个阶段，收到 {}",
            payload.pipeline.len()
        ));
    }
    if payload.deadline_ms > MAX_DEADLINE_MS {
        return Err(format!(
            "deadlineMs 上限 {MAX_DEADLINE_MS}，收到 {}",
            payload.deadline_ms
        ));
    }
    let priority = parse_priority(&payload.priority)?;
    let (input, source) = match (payload.input, payload.source) {
        (Some(input), None) => {
            check_text("input.contentHash", &input.content_hash, MAX_HASH_BYTES)?;
            if input.byte_length == 0 || input.byte_length > MAX_INPUT_BYTES {
                return Err(format!(
                    "input.byteLength 要在 1..={MAX_INPUT_BYTES} 之间，收到 {}",
                    input.byte_length
                ));
            }
            // 只读输入在哪，**由宿主说了算**（docs/71 §7.1/§7.2）：前端连路径都传不上来，
            // 这里发现就当场拒掉，免得「谁的路径」变成一条可以从渲染进程注入的输入。
            if input.relative_path.is_some() {
                return Err("input.relativePath 由宿主决定，调用方不许自带".to_string());
            }
            (input, None)
        }
        (None, Some(_)) => {
            let located = source.ok_or_else(|| {
                // 命令体已经在缓存里查过一遍了。查不到而请求又只给了 identity，
                // 那就是「这一页还没落盘」——那是可重试的输入问题，不是请求不合法。
                "这一页还没有落在缓存里，先在阅读器里打开它".to_string()
            })?;
            (
                yomika_compute_protocol::messages::RunInput {
                    input_id: payload.input_id.clone(),
                    content_hash: located.content_hash.clone(),
                    byte_length: located.byte_length,
                    relative_path: None,
                },
                // 位置与哈希都由宿主的索引说了算，调用方连碰都碰不到。
                Some(located),
            )
        }
        (Some(_), Some(_)) => {
            return Err("input 与 source 只能给一个：字节声明和「这一页是谁」是两种说法".to_string())
        }
        (None, None) => {
            return Err(
                "要么给 input（这一份字节的哈希与长度），要么给 source（这一页是谁）".to_string(),
            )
        }
    };
    Ok(SubmitRequest {
        key: JobKey {
            input_id: payload.input_id,
            settings_id: payload.settings_id,
            source_revision: payload.source_revision,
            backend: payload.backend,
            generation: payload.generation,
        },
        priority,
        input,
        pipeline: payload.pipeline,
        output_grant_id: payload.output_grant_id,
        deadline_ms: payload.deadline_ms,
        // 源图不在提交里：`compute_submit` 只入队，它挂在 WebView2 的消息循环上，
        // 解析源文件与模型授权要算哈希、可能复制几十 MB（`manager::prepare_run`）。
        // 这里只带位置：真读字节、真算哈希都留给派发前那一侧。
        source,
        // 去码的三件套（掩膜 + 两份模型）**故意**不在这条通用入口上：它是宿主自己规划的
        // 任务，不是渲染进程填一份 JSON 就能提交的东西（`compute::decensor`）。前端要是
        // 能在这里塞一段掩膜，协议帧上限与「谁指名输入根文件」两条就同时被绕开了。
        inpaint: None,
    })
}

fn enqueue(manager: &ComputeManager, request: SubmitRequest) -> CommandResult<Submitted> {
    match manager.submit(request) {
        Ok(submitted) => CommandResult::success(submitted),
        // 队列满不是错误状态，是「现在没位置」：前端该退让或等，不该报故障。
        Err(SubmitError::ForegroundFull) => CommandResult::failure(
            "COMPUTE_QUEUE_FULL",
            "前台队列已满，且没有可替换的后台占位",
            true,
        ),
        Err(SubmitError::BackgroundFull) => CommandResult::failure(
            "COMPUTE_QUEUE_FULL",
            "后台预扫槽位已满，等一件跑完再来",
            true,
        ),
        // 压力档位拒收（§8.1/§8.4）：同样不是故障，是「现在这台机器不算这一版」。
        // 用 COMPUTE_UNAVAILABLE 而不是新码：前端把它算作**可以再问一次**（第 43 轮的名单），
        // 正好是这里要的语义——原图还在，压力过去再看同一页会自动重试。
        Err(SubmitError::Pressure) => CommandResult::failure(
            "COMPUTE_UNAVAILABLE",
            "这台机器现在内存/显存吃紧，先不算这一版（原图还在，等会儿再看会自动重试）",
            true,
        ),
    }
}

/// 入队，并且记下「这件任务会产出页面的哪几版」（8-g①）。
///
/// 只记**收下了**的任务：被队列拒回去的那件根本没跑，不会有任何产物，记一行空账只让索引白占位。
/// 记的是计划已经算好的身份（`settings_id`），不是这里另算一份——两处各算一份，迟早会分家。
fn enqueue_recorded(
    manager: &ComputeManager,
    renditions: &renditions::RenditionIndex,
    request: SubmitRequest,
    entries: Vec<renditions::StageRendition>,
) -> CommandResult<Submitted> {
    let answer = enqueue(manager, request);
    if let CommandResult::Success { value, .. } = &answer {
        renditions.record(&value.job_id, entries);
        // 被这次提交换掉的那个后台占位再也不会产出：它连保留窗口都出了，取产物那一侧也
        // 找不到它。留着只是白占一格。
        if let Some(evicted) = &value.evicted {
            renditions.forget(evicted);
        }
    }
    answer
}

/// 入队一件重计算，**立刻**返回。
///
/// 返回的 `state` 是 `queued`：真正「有没有 worker、什么时候跑完」要订阅事件或回来
/// `compute_job_get`。同身份（同输入 + 同设置 + 同修订 + 同后端 + 同世代）的提交会合并
/// 成一件，各自拿一个 `subscriptionId` 用来取消。
///
/// `source` 那只手在**这里**解析：渲染进程里它只表现为「这一页是谁」，宿主拿它查一次
/// 缓存主键（不读字节、不算哈希，见 `cache::cached_blob_location`），把位置与索引里说的
/// 哈希装进提交。真读字节、真核哈希在 `manager::prepare_run`（supervisor 线程）。
#[tauri::command]
pub async fn compute_submit(
    app: tauri::AppHandle,
    state: State<'_, ComputeHandle>,
    payload: SubmitPayload,
) -> Result<CommandResult<Submitted>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    let source = match payload.source.as_ref() {
        None => None,
        Some(page) => {
            let identity = match source_identity(page) {
                Ok(identity) => identity,
                Err(message) => return Ok(bad(message)),
            };
            let data_dir = match crate::data_paths::data_dir(&app) {
                Ok(path) => path,
                // 数据目录找不到是这台进程的问题，不是请求的问题：别让界面以为
                // 「用户填错了什么」而去改设置。
                Err(error) => {
                    return Ok(CommandResult::failure(
                        "COMPUTE_INTERNAL",
                        format!("找不到数据目录：{error}"),
                        true,
                    ))
                }
            };
            match resolve_cached_blob(&app, &data_dir, &identity) {
                Ok(Some(located)) => Some(SourceFile::from(located)),
                Ok(None) => {
                    return Ok(CommandResult::failure(
                        "COMPUTE_INPUT_INVALID",
                        "这一页还没有落在缓存里，先在阅读器里打开它",
                        true,
                    ))
                }
                Err(message) => return Ok(bad(message)),
            }
        }
    };
    Ok(match plan(payload, source) {
        Ok(request) => enqueue(manager, request),
        Err(message) => bad(message),
    })
}

/// 阅读器说得出的话：**哪一页**、**选了哪个模型**、这一代是第几代、多急、期限多久。
///
/// 它说不出 `settingsId`、`sourceRevision`、管线，也说不出这一页的路径与哈希——那些都是
/// 宿主的账（本文件顶部 `SubmitPayload` 的 doc、`compute::reader` 的模块文档）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderPagePayload {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 超分模型的 id（设置页里看到的那个），不是路径、不是文件名。
    pub model_id: String,
    /// 阅读器世代（§9.1）：翻页换代，旧一代整批丢掉。
    pub generation: u64,
    /// `foreground` / `background`。
    pub priority: String,
    /// 0 = 用调度器的默认期限。
    pub deadline_ms: u64,
}

impl ReaderPagePayload {
    /// 只挡**一眼就不合法**的请求（空 id、超长、优先级拼错、期限超上限）。
    ///
    /// 身份算不算得出来要读模型包，这一页在不在缓存里要查索引——两件事都在下面做，都不
    /// 属于「请求写错了」，各有各的码。
    fn into_request(self) -> Result<ReaderPageRequest, String> {
        check_text("scopeId", &self.scope_id, MAX_ID_BYTES)?;
        check_text("archiveId", &self.archive_id, MAX_ID_BYTES)?;
        check_text("modelId", &self.model_id, MAX_ID_BYTES)?;
        if self.deadline_ms > MAX_DEADLINE_MS {
            return Err(format!(
                "deadlineMs 上限 {MAX_DEADLINE_MS}，收到 {}",
                self.deadline_ms
            ));
        }
        Ok(ReaderPageRequest {
            scope_id: self.scope_id,
            archive_id: self.archive_id,
            page_index: self.page_index,
            model_id: self.model_id,
            generation: self.generation,
            priority: parse_priority(&self.priority)?,
            deadline_ms: self.deadline_ms,
        })
    }
}

/// 阅读器按「这一页 + 当前配置」提交：前端只说得出这两样，身份由宿主铸。
///
/// 与 [`compute_submit`] 的区别只有**谁来铸计划**。那条路要调用方给出 `settingsId`、
/// `sourceRevision` 与整条管线，而前两个是宿主的修订号（模型包指纹 + 声明的后端 + 运行时
/// 库版本 + 管线口径，见 `inference::derived_cache_revision`）——渲染进程编不出来；编一个
/// 出来只会永远命中不了缓存，或者把同一份设置当成两件任务各算一遍。这里收下「哪一页、哪个
/// 模型」，身份交给 [`reader::plan_reader_page`]。
///
/// 返回的形状与 `compute_submit` 完全一样：前端那一套订阅 / 取产物 / 租借的机件不必为阅读器
/// 再写一遍。换的是来路，不是协议。
///
/// 这一页还没落盘 ⇒ `COMPUTE_INPUT_INVALID`（**可重试**）：用户回到阅读器把那页缓存好再试，
/// 不是请求写错了，也不该在界面上留成一件失败的活。
#[tauri::command]
pub async fn compute_submit_reader_page(
    app: tauri::AppHandle,
    state: State<'_, ComputeHandle>,
    payload: ReaderPagePayload,
) -> Result<CommandResult<Submitted>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    let request = match payload.into_request() {
        Ok(request) => request,
        Err(message) => return Ok(bad(message)),
    };
    // 模型包与缓存同住一个数据根（`inference::model_data_dir` 就是 `data_paths::data_dir`）：
    // 取一次就够，两个名字说的是同一处。
    let data_dir = match crate::data_paths::data_dir(&app) {
        Ok(path) => path,
        Err(error) => {
            return Ok(CommandResult::failure(
                "COMPUTE_INTERNAL",
                format!("找不到数据目录：{error}"),
                true,
            ))
        }
    };
    let job = match reader::plan_reader_page(&data_dir, &request) {
        Ok(job) => job,
        Err(error) => {
            return Ok(CommandResult::failure(
                error.code,
                error.message,
                error.retryable,
            ))
        }
    };
    let located = match resolve_cached_blob(&app, &data_dir, &job.source_identity) {
        Ok(Some(located)) => SourceFile::from(located),
        Ok(None) => {
            return Ok(CommandResult::failure(
                "COMPUTE_INPUT_INVALID",
                "这一页还没有落在缓存里，先在阅读器里打开它",
                true,
            ))
        }
        Err(message) => return Ok(bad(message)),
    };
    // 计划已经把身份算好了（`settings_id` 就是这一版的修订号），所以在 `into_request`
    // **消费**它之前先记下来：取产物时要用同一份身份把内容寻址的产物挂成索引里那一行。
    let renditions = renditions::reader_renditions(&job);
    Ok(enqueue_recorded(
        manager,
        state.renditions(),
        reader::into_request(job, located),
        renditions,
    ))
}

/// 提交的源图目前只认这一版：`enhanced` 是产物不是输入；`decensored` 也不是——去码已经搬进
/// worker，但 compute 的产物没有按修订号登记的缓存行，这道门还取不到它（`docs/92`）。
const READER_PAGE_RENDITION: &str = "reader-page";

/// 一份缓存身份换成宿主解析出来的位置。
///
/// 只查一次主键索引，**不读字节**：读、算哈希、硬链接/复制都留给派发前那一侧。
/// 返回 `Ok(None)` = 这一页还没落盘，调用方要把它报成**可重试的输入问题**（用户回到
/// 阅读器等那一页缓存好再试），而不是「请求不合法」。
///
/// 收身份而不是 `SourcePage`：阅读器那道门（`compute_submit_reader_page`）的身份是宿主
/// 自己铸出来的（`compute::reader::ReaderPageJob::source_identity`），没有一份
/// `SourcePage` 可以传。
fn resolve_cached_blob(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
    identity: &crate::cache::CacheImageIdentity,
) -> Result<Option<crate::cache::CachedBlobLocation>, String> {
    let database = app.state::<crate::db::Database>();
    crate::cache::cached_blob_location(&database, data_dir, identity)
}

/// 「这一页是谁」→ 缓存索引键。渲染进程给的三样东西（scope/archive/page）在这里被翻译成
/// 宿主自己认的身份，多一样都不接受——路径与哈希是宿主的账，不是渲染进程能报的。
fn source_identity(page: &SourcePage) -> Result<crate::cache::CacheImageIdentity, String> {
    let rendition = page.rendition.as_deref().unwrap_or(READER_PAGE_RENDITION);
    if rendition != READER_PAGE_RENDITION {
        return Err(format!(
            "提交的源图目前只支持 {READER_PAGE_RENDITION}，收到 {rendition:?}"
        ));
    }
    Ok(crate::cache::CacheImageIdentity::new(
        &page.scope_id,
        &page.archive_id,
        rendition,
        page.page_index,
    ))
}

/// 阅读器开着去码时提交「这一页」用的输入：与超分那道门**同一份字段**。
///
/// 少的是倍率与输出缩放（修补不改尺寸：进多少像素出多少像素），一处都不多——尤其是
/// **没有**掩膜或者框这类字段。补哪里不是渲染进程说得出的东西，也不是宿主说得出的东西：
/// 那一页要补的框由 worker 拿这一页的像素自己算（docs/94）。渲染进程手里只有一份 JSON，
/// 而一页的掩膜是几十万字节，它连传都传不进来。
///
/// `upscaleModelId` 是唯一一个多出来的字段，形状与超分那道门的 `modelId` 相同：补完这一页
/// 之后接着放大的那个模型。它必须写在**同一条请求**里，因为链的第二阶段吃的是第一阶段的
/// 产物——那份产物只有内容寻址的落点、没有按修订号登记的缓存行，出了这件任务就没人能按身份
/// 把它找回来（docs/94 欠账②）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecensorPagePayload {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 去码包的 id（设置页里看到的那个），不是路径。
    pub model_id: String,
    /// 补完之后接着放大的超分模型 id；不写就是只去码。
    #[serde(default)]
    pub upscale_model_id: Option<String>,
    pub generation: u64,
    pub priority: String,
    pub deadline_ms: u64,
}

impl DecensorPagePayload {
    fn into_request(self) -> Result<DecensorPageRequest, String> {
        check_text("scopeId", &self.scope_id, MAX_ID_BYTES)?;
        check_text("archiveId", &self.archive_id, MAX_ID_BYTES)?;
        check_text("modelId", &self.model_id, MAX_ID_BYTES)?;
        // 只写空白由规划器当成「没指名」（它自己会 trim），这里只管长度这一条上限。
        if let Some(model_id) = &self.upscale_model_id {
            check_text("upscaleModelId", model_id, MAX_ID_BYTES)?;
        }
        if self.deadline_ms > MAX_DEADLINE_MS {
            return Err(format!(
                "deadlineMs 上限 {MAX_DEADLINE_MS}，收到 {}",
                self.deadline_ms
            ));
        }
        Ok(DecensorPageRequest {
            scope_id: self.scope_id,
            archive_id: self.archive_id,
            page_index: self.page_index,
            model_id: self.model_id,
            upscale_model_id: self.upscale_model_id,
            generation: self.generation,
            priority: parse_priority(&self.priority)?,
            deadline_ms: self.deadline_ms,
        })
    }
}

/// 去码那条门：**检测与修补都在 worker**（docs/94）。
///
/// 与 `compute_submit_reader_page` 唯一的形状差别已经没有了：两条门现在都只查包、查位置、
/// 铸身份，然后派发一件任务。8-c 那一版在提交前先看这一页的像素（检测器那时还住宿主），于是
/// 失败面多出一类「读不出来 / 字节不是索引说的那一份」，还能给出 `success(null)` 这个
/// 「原页就是答案」的答案——检测搬走之后这两样都跟着走了：掩膜是 worker 拿这一页算的，
/// 「有没有要补的框」只有它知道，命令层无从提前回答。
#[tauri::command]
pub async fn compute_submit_decensor_page(
    app: tauri::AppHandle,
    state: State<'_, ComputeHandle>,
    payload: DecensorPagePayload,
) -> Result<CommandResult<Submitted>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    let request = match payload.into_request() {
        Ok(request) => request,
        Err(message) => return Ok(bad(message)),
    };
    let data_dir = match crate::data_paths::data_dir(&app) {
        Ok(dir) => dir,
        Err(error) => {
            return Ok(CommandResult::failure(
                "COMPUTE_INTERNAL",
                format!("找不到数据目录：{error}"),
                true,
            ))
        }
    };
    let database = app.state::<crate::db::Database>();
    match decensor::prepare_decensor_page(database.inner(), &data_dir, &request) {
        Ok((job, source)) => {
            // 去码那条路的身份也是计划算的：第一步 `decensored_revision(包指纹)`，接上超分
            // 才有第二步 `enhanced_revision(...)`。`into_request` 同样要消费 `job`。
            let renditions = renditions::decensor_renditions(&job);
            Ok(enqueue_recorded(
                manager,
                state.renditions(),
                decensor::into_request(job, source),
                renditions,
            ))
        }
        Err(error) => Ok(CommandResult::failure(
            error.code,
            error.message,
            error.retryable,
        )),
    }
}

/// 按 id 取一件任务的快照。
///
/// **断订阅之后也能查**：前端重新挂载时拿 jobId 问一次就知道它到哪儿了（§11 Task 4 ⑥）。
/// 返回 `null` 表示这件已经超出保留窗口（最近 128 件 / 10 分钟）——那是「不知道」，
/// 不是「失败」。
#[tauri::command]
pub async fn compute_job_get(
    state: State<'_, ComputeHandle>,
    job_id: String,
) -> Result<CommandResult<Option<JobSnapshot>>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.job(&job_id)))
}

/// 还留着的全部快照（含终态，按提交顺序）。worker 换代之后界面靠它把状态对齐。
#[tauri::command]
pub async fn compute_jobs(
    state: State<'_, ComputeHandle>,
) -> Result<CommandResult<Vec<JobSnapshot>>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.all_jobs()))
}

/// worker 现在的样子。
///
/// 分开报「没起来」「起来了但 Job Object 没套上」「熔断了」，就是不为了让界面拿一句
/// 模糊的「GPU 启动成功」糊过去（§8.3）。
#[tauri::command]
pub async fn compute_worker_status(
    state: State<'_, ComputeHandle>,
) -> Result<CommandResult<WorkerStatus>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.worker_status()))
}

/// 一件任务已经核验过的产物（宿主自己重算过哈希与长度）。
#[tauri::command]
pub async fn compute_job_artifacts(
    state: State<'_, ComputeHandle>,
    job_id: String,
) -> Result<CommandResult<Vec<ArtifactRecord>>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.job_artifacts(&job_id)))
}

/// 最新的进度（已经节流到 5 Hz）。
#[tauri::command]
pub async fn compute_job_progress(
    state: State<'_, ComputeHandle>,
    job_id: String,
) -> Result<CommandResult<Option<JobProgress>>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.job_progress(&job_id)))
}

/// 某个界面放手了。`subscriptionId` 是提交时拿到的那一个。
///
/// 只有**所有**订阅者都放手才真的去打扰 worker；`outcome` 告诉界面是哪一种
/// （还有别人在等 / 已经转取消并开始算 2 秒宽限 / 早就结束了 / 这个订阅号不认识）。
/// 取消是幂等的：重复调用拿到 `unknown` 或 `alreadyTerminal` 都不算错。
#[tauri::command]
pub async fn compute_cancel(
    state: State<'_, ComputeHandle>,
    job_id: String,
    subscription_id: u64,
) -> Result<CommandResult<CancelOutcome>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(
        manager.cancel(&job_id, subscription_id),
    ))
}

/// 后台任务提升为前台（正在看的那一页）：换队，不重算（§8.1）。
#[tauri::command]
pub async fn compute_promote(
    state: State<'_, ComputeHandle>,
    job_id: String,
) -> Result<CommandResult<PromoteOutcome>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(manager.promote(&job_id)))
}

/// 阅读器换代：这个输入的旧排队任务作废。已经在跑的那件不动（§8.1）。
#[tauri::command]
pub async fn compute_drop_generation(
    state: State<'_, ComputeHandle>,
    input_id: String,
    generation: u64,
) -> Result<CommandResult<DroppedGeneration>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    Ok(CommandResult::success(
        manager.drop_generation(&input_id, generation),
    ))
}

/// 熔断之后用户手动重试一次（§8.3）。
#[tauri::command]
pub async fn compute_retry_worker(
    state: State<'_, ComputeHandle>,
) -> Result<CommandResult<()>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    manager.retry_worker();
    Ok(CommandResult::success(()))
}

/// 界面要一张算好的图：开一张租借，换回一个只对本窗口有效的 URL（§6.6、§9.2）。
///
/// 窗口不由前端说了算——`webview` 是宿主从这次调用本身取的（§6.6：跨窗口身份由宿主
/// context 决定）。前端就算伪造一个 label 也没用，它连这个参数都传不上来。
///
/// 这里顺手做两件「钉住」的事：它的意义是**让这份内容在配额回收里不被删**。没有这一步，
/// 一张正在显示的图可能在下一批淘汰里消失，界面上就是一张破图。
#[tauri::command]
pub async fn compute_artifact_acquire(
    app: tauri::AppHandle,
    state: State<'_, ComputeHandle>,
    database: State<'_, crate::db::Database>,
    webview: tauri::WebviewWindow,
    job_id: String,
    artifact_id: String,
) -> Result<CommandResult<ComputedImageLease>, String> {
    let Some(manager) = state.get() else {
        return Ok(unavailable());
    };
    let Some(record) = manager
        .job_artifacts(&job_id)
        .into_iter()
        .find(|artifact| artifact.artifact_id == artifact_id)
    else {
        return Ok(CommandResult::failure(
            leases::ARTIFACT_INVALID_CODE,
            format!("这件任务没有这个产物：{artifact_id}"),
            false,
        ));
    };
    if !record.verified {
        return Ok(CommandResult::failure(
            leases::ARTIFACT_INVALID_CODE,
            "产物还没通过核验，不能交给界面",
            false,
        ));
    }
    // 类型由**文件自己的字节**决定。worker 自报的字段一律不作数：它是另一个进程，
    // 而且跨进程传上来的东西只该当数据看。
    let Some(mime) = sniff_artifact_mime(&record.path) else {
        return Ok(CommandResult::failure(
            leases::ARTIFACT_INVALID_CODE,
            "产物开头不是能识别的图片",
            false,
        ));
    };
    if !leases::is_allowed_image_mime(&mime) {
        return Ok(CommandResult::failure(
            leases::ARTIFACT_INVALID_CODE,
            format!("产物类型 {mime} 不在可交给渲染器的白名单里"),
            false,
        ));
    }
    let Some(cache_relative) = record.cache_relative.clone() else {
        return Ok(CommandResult::failure(
            leases::ARTIFACT_INVALID_CODE,
            "产物还没落到正式目录（宿主没配发布根？）",
            false,
        ));
    };
    // 取产物是**唯一**能把「一份算好的图」变成「页面的这一版」的时刻（8-g①）：文件早就
    // 在内容寻址的位置上了，缺的是索引里那一行——没有行，按修订号取起点的那几条路
    // （DLSSNR、旧超分、远端代理）永远查不到它。挂行与钉住在同一段里做：先挂行、再钉住，
    // `pin` 于是从「找不到条目」变成真的钉上了一条。
    let app_data = match crate::data_paths::data_dir(&app) {
        Ok(path) => path,
        Err(error) => {
            return Ok(CommandResult::failure(
                "COMPUTE_INTERNAL",
                format!("找不到数据目录：{error}"),
                true,
            ))
        }
    };
    let pinned = attach_to_page(
        &database,
        &app_data,
        state.renditions(),
        &record,
        &mime,
        &cache_relative,
    );
    if pinned == 0 {
        // 没有对应的缓存条目。不是错误——没有行就没有人拿它当淘汰候选，这份文件本来也
        // 删不掉。但**顺手留下一行痕迹**：产物挂着发布根却没有索引行，值得能查。
        eprintln!(
            "yomika: 取产物 {} 时没有可钉住的缓存条目（{}）",
            record.artifact_id, cache_relative
        );
    }
    let spec = LeaseSpec {
        artifact_id: record.artifact_id.clone(),
        job_id: record.job_id.clone(),
        path: record.path.clone(),
        cache_relative: Some(cache_relative.clone()),
        mime,
        byte_length: record.byte_length,
        width: record.width,
        height: record.height,
        pipeline_revision: record.pipeline_revision.clone(),
        webview_label: webview.label().to_string(),
    };
    match state.leases().acquire(spec, Instant::now()) {
        Ok(acquired) => {
            // 开租借时顺手清掉的过期租借要在这里放开，否则过期只是「读不到」，
            // 配额却一直被它们占着。
            unpin_leases(&database, &acquired.expired);
            Ok(CommandResult::success(acquired.lease))
        }
        Err(error) => {
            unpin_all(&database, &cache_relative);
            Ok(CommandResult::failure(
                error.code(),
                error.message(),
                error.retryable(),
            ))
        }
    }
}

/// 界面放手了（换版本、翻页、离开阅读器、出错回退）。
///
/// **幂等**：放过一次的再放、或者放一个从来不认识的号，都不是错误——前端的卸载路径与
/// 错误路径本来就会重叠，把它们变成报错只会让人不敢放。
#[tauri::command]
pub async fn compute_artifact_release(
    state: State<'_, ComputeHandle>,
    database: State<'_, crate::db::Database>,
    lease_id: String,
) -> Result<CommandResult<()>, String> {
    if let Some(view) = state.leases().release(&lease_id) {
        unpin_all(&database, &view.cache_relative);
    }
    Ok(CommandResult::success(()))
}

/// 读产物开头的十六个字节，由**内容**判断它是什么格式。
fn sniff_artifact_mime(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut header = [0u8; 16];
    let mut filled = 0;
    while filled < header.len() {
        let read = file.read(&mut header[filled..]).ok()?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    crate::cache::sniff_image_mime("application/octet-stream", &header[..filled])
}

/// 把这份产物**挂成页面的这一版**，再钉住它；返回钉住的行数。
///
/// 两件事写在同一个函数里，是为了让「挂行」这一步**有观测点**：只写一行
/// `let _ = renditions::adopt_artifact(...)` 的话，把它删掉不会有任何一条测试变红，
/// 而这正是本轮要证的东西。挂不上不是「交不出这张图」（租借走的是内容寻址的位置，
/// 与索引那一行无关），所以只留一条痕迹、不拦路。
fn attach_to_page(
    database: &crate::db::Database,
    app_data: &std::path::Path,
    index: &renditions::RenditionIndex,
    record: &ArtifactRecord,
    mime: &str,
    relative: &str,
) -> usize {
    match renditions::adopt_artifact(database, app_data, index, record, mime) {
        // 通用那道门提交的任务没有「页面的哪一版」这回事，`None` 是正常答案。
        Ok(Some(_)) | Ok(None) => {}
        Err(error) => eprintln!(
            "yomika: 产物没能登记成页面的这一版（{}）：{error}",
            record.artifact_id
        ),
    }
    match pin(database, relative) {
        Ok(count) => count,
        Err(error) => {
            eprintln!("yomika: 钉住租借内容失败（{relative}）：{error}");
            0
        }
    }
}

fn pin(database: &crate::db::Database, relative: &str) -> Result<usize, String> {
    let connection = database
        .connection
        .lock()
        .map_err(|_| crate::cache::LOCK_FAILED.to_string())?;
    crate::cache::pin_cache_path(&connection, relative)
}

fn unpin_all(database: &crate::db::Database, relative: &str) {
    match database.connection.lock() {
        Ok(connection) => {
            if let Err(error) = crate::cache::unpin_cache_path(&connection, relative) {
                eprintln!("yomika: 放开租借内容失败（{relative}）：{error}");
            }
        }
        Err(_) => eprintln!("yomika: 放开租借内容时数据库正被占用（{relative}）"),
    }
}

fn unpin_leases(database: &crate::db::Database, expired: &[LeaseView]) {
    if expired.is_empty() {
        return;
    }
    // 一把锁放完一批：这些是同一批过期的东西，没必要各自抢一次锁。
    match database.connection.lock() {
        Ok(connection) => {
            for view in expired {
                if let Err(error) = crate::cache::unpin_cache_path(&connection, &view.cache_relative)
                {
                    eprintln!("yomika: 放开过期租借失败（{}）：{error}", view.cache_relative);
                }
            }
        }
        Err(_) => eprintln!("yomika: 放开 {} 份过期租借时数据库正被占用", expired.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yomika_compute_protocol::messages::{EnginePolicy, PipelineStage, RunInput};

    /// 一份**合法**的载荷：下面每条测试只改它一个字段。
    ///
    /// 给的是 `input` 那一手（字节声明）。阅读器给的 `source` 那一手见 `page_payload`。
    fn payload() -> SubmitPayload {
        SubmitPayload {
            input_id: "book/page-1".to_string(),
            settings_id: "upscale-2x".to_string(),
            source_revision: "src:1".to_string(),
            backend: "cpu".to_string(),
            generation: 3,
            priority: "foreground".to_string(),
            input: Some(RunInput {
                input_id: "input-1".to_string(),
                content_hash: "a".repeat(64),
                byte_length: 4096,
                relative_path: None,
            }),
            source: None,
            pipeline: vec![PipelineStage {
                stage_id: "stage-a".to_string(),
                model_spec_id: "realcugan-2x-conservative".to_string(),
                // 这条测试只走 `plan()`（提交前的本地护栏），到不了 worker：没带模型，
                // 也没声明模型要求的最小边长。
                model: None,
                builtin: None,
                decensor: None,
                dlssnr: None,
                min_input_edge: None,
                output_scale: None,
                engine_policy: EnginePolicy::Auto,
                scale: Some(2),
                tile: Some(256),
                layers: None,
                settings_id: None,
            }],
            output_grant_id: "grant-1".to_string(),
            deadline_ms: 60_000,
        }
    }

    /// 阅读器那种载荷：它只知道「这是哪一页」，位置与哈希是宿主查出来的。
    fn page_payload() -> SubmitPayload {
        let mut reader = payload();
        reader.input = None;
        reader.source = Some(SourcePage {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 4,
            rendition: None,
        });
        reader
    }

    fn located() -> SourceFile {
        SourceFile {
            path: std::path::PathBuf::from("C:/data/cache/images/ab/ab.bin"),
            content_hash: "b".repeat(64),
            byte_length: 4096,
        }
    }

    #[test]
    fn a_legal_submission_plans_out() {
        let planned = plan(payload(), None).expect("这份载荷是合法的");
        assert_eq!(planned.input.input_id, "input-1");
        assert!(planned.input.relative_path.is_none());
        assert!(
            planned.source.is_none(),
            "字节声明那一手不带源图位置：字节已经在调用方手上"
        );
    }

    /// 阅读器那一手：宿主查到的位置与索引里说的那一份，变成提交的输入声明。
    ///
    /// 关键在**哈希与长度来自宿主**：渲染进程一个都编不出来（它没有这一页的字节，
    /// docs/71 §9.3）。而 `relative_path` 仍为空——读字节、算哈希、摆进输入根都留给
    /// 派发前的 supervisor 线程（`manager::prepare_run`）。
    #[test]
    fn a_page_identity_becomes_the_hosts_own_location() {
        let located = located();
        let planned = plan(page_payload(), Some(located.clone())).expect("这一页在缓存里");
        assert_eq!(
            planned.input.input_id, "book/page-1",
            "任务身份仍取载荷里的 inputId（阅读器用它标这一页）"
        );
        assert_eq!(planned.input.content_hash, located.content_hash);
        assert_eq!(planned.input.byte_length, located.byte_length);
        assert!(planned.input.relative_path.is_none());
        assert_eq!(planned.source, Some(located), "位置原样交给派发前那一侧");
    }

    /// 「位置拿到了却没给」是编程错误，不能悄悄退化成「没有源图」——那样真引擎会在派发
    /// 前才报错，而错误原因（这一页没落盘）早就丢了。
    #[test]
    fn a_page_identity_without_a_location_is_refused() {
        let message = plan(page_payload(), None).expect_err("查不到位置就该说清楚");
        assert!(
            message.contains("缓存"),
            "理由要指到「这一页还没落盘」：{message}"
        );
    }

    /// 渲染进程报的三样东西要**原样**落成宿主的缓存身份：多一样都不认，缺一样也不认。
    /// 这条是那只手唯一能被纯函数钉住的部分（另半截要真数据库 + 真文件，见
    /// `cache::cached_blob_location` 的单测与 `tests/compute_manager.rs` 的篡改那条）。
    #[test]
    fn a_page_identity_maps_onto_the_cache_index_key() {
        let identity = source_identity(&SourcePage {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 11,
            rendition: None,
        })
        .expect("缺省就是 reader-page");
        assert_eq!(identity.scope_id, "scope-a");
        assert_eq!(identity.archive_id, "archive-a");
        assert_eq!(identity.page_index, 11);
        assert_eq!(identity.rendition, READER_PAGE_RENDITION);
        assert!(
            identity.revision.is_none() && identity.transform.is_none(),
            "提交页永远是「没加修订、没加变换」的那一版：加了就变成另一个键"
        );

        let explicit = source_identity(&SourcePage {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 11,
            rendition: Some(READER_PAGE_RENDITION.to_string()),
        })
        .expect("写清楚了也是同一个身份");
        assert_eq!(explicit, identity);
    }

    /// `enhanced` 是产物不是输入；`decensored` 是「去码搬进 worker 了，但产物取不回来」
    /// （docs/92）。现在就把它们放进来的话，宿主会去查一个永远不会有人写的键，然后报
    /// 「这一页还没落盘」——把「尚不支持」说成「你还没打开它」，用户会一直等。
    #[test]
    fn only_the_reader_page_rendition_can_be_asked_for() {
        for refused in ["enhanced", "decensored", "dlssnr", "cover"] {
            let message = source_identity(&SourcePage {
                scope_id: "scope-a".to_string(),
                archive_id: "archive-a".to_string(),
                page_index: 0,
                rendition: Some(refused.to_string()),
            })
            .expect_err("这一版还不支持");
            assert!(
                message.contains(READER_PAGE_RENDITION),
                "理由要说出支持的是哪一版：{message}"
            );
        }
    }

    #[test]
    fn two_ways_to_say_what_the_input_is_cannot_both_be_used() {
        let mut both = page_payload();
        both.input = Some(RunInput {
            input_id: "input-1".to_string(),
            content_hash: "a".repeat(64),
            byte_length: 4096,
            relative_path: None,
        });
        let message = plan(both, Some(located())).expect_err("两种说法只能给一个");
        assert!(message.contains("只能给一个"), "{message}");

        let mut neither = payload();
        neither.input = None;
        neither.source = None;
        let message = plan(neither, None).expect_err("什么都不给就没法提交");
        assert!(message.contains("source"), "{message}");
    }

    /// §7.1/§7.2：只读输入在哪**由宿主决定**。渲染进程能往 `relativePath` 里塞东西，
    /// 就等于能把「读哪个文件」交给界面——这条必须在命令层就被挡掉。
    #[test]
    fn a_path_named_by_the_renderer_is_refused() {
        let mut named = payload();
        named
            .input
            .as_mut()
            .expect("这份载荷给的是 input 那一手")
            .relative_path = Some("ab/cd.png".to_string());
        let message = plan(named, None).expect_err("前端不许自带输入路径");
        assert!(
            message.contains("宿主决定"),
            "拒绝理由要指到「路径不是调用方的事」：{message}"
        );
    }

    #[test]
    fn the_obvious_junk_is_refused_before_a_worker_starts() {
        fn refuse(what: &str, edit: impl FnOnce(&mut SubmitPayload)) {
            let mut broken = payload();
            edit(&mut broken);
            match plan(broken, None) {
                Ok(_) => panic!("{what} 应该被挡回去"),
                Err(message) => assert!(!message.trim().is_empty(), "{what} 要给个理由"),
            }
        }

        refuse("空 inputId", |p| p.input_id = "   ".to_string());
        refuse("超长 settingsId", |p| {
            p.settings_id = "x".repeat(MAX_ID_BYTES + 1)
        });
        refuse("byteLength = 0", |p| {
            p.input.as_mut().expect("给的是 input 那一手").byte_length = 0
        });
        refuse("byteLength 超上限", |p| {
            p.input.as_mut().expect("给的是 input 那一手").byte_length = MAX_INPUT_BYTES + 1
        });
        refuse("空 pipeline", |p| p.pipeline.clear());
        refuse("pipeline 阶段过多", |p| {
            let stage = p.pipeline[0].clone();
            p.pipeline = vec![stage; MAX_PIPELINE_STAGES + 1];
        });
        refuse("deadline 超上限", |p| p.deadline_ms = MAX_DEADLINE_MS + 1);
        refuse("不认识的 priority", |p| p.priority = "urgent".to_string());
    }

    /// 阅读器那道来路的一份合法载荷（`ReaderPagePayload`），下面每条测试只改它一个字段。
    fn reader_payload() -> ReaderPagePayload {
        ReaderPagePayload {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 11,
            model_id: "realesr".to_string(),
            generation: 3,
            priority: "foreground".to_string(),
            deadline_ms: 60_000,
        }
    }

    /// 前端会送来的那个形状 → 宿主铸身份时要的那份请求。
    ///
    /// 这里用 JSON 而不是直接构造结构体，是为了把**线的形状**也钉住：camelCase 一旦写错，
    /// 前端送来的字段会变成「不认识的字段」而被整条拒收。
    #[test]
    fn a_reader_page_payload_becomes_the_request_the_host_mints() {
        let payload: ReaderPagePayload = serde_json::from_str(
            r#"{
                "scopeId": "scope-a",
                "archiveId": "archive-a",
                "pageIndex": 11,
                "modelId": "realesr",
                "generation": 3,
                "priority": "Foreground",
                "deadlineMs": 60000
            }"#,
        )
        .expect("这就是前端会送来的形状");

        let request = payload.into_request().expect("这份载荷是合法的");
        assert_eq!(request.scope_id, "scope-a");
        assert_eq!(request.archive_id, "archive-a");
        assert_eq!(request.page_index, 11);
        assert_eq!(request.model_id, "realesr");
        assert_eq!(request.generation, 3);
        assert_eq!(
            request.priority,
            Priority::Foreground,
            "优先级大小写不敏感（与 compute_submit 同一条规则）"
        );
        assert_eq!(request.deadline_ms, 60_000);
    }

    /// 这条来路上，渲染进程**说不出**任务身份，也说不出路径。
    ///
    /// 这正是这道门存在的理由（`compute::reader` 的模块文档）：`settingsId` 是宿主的修订号，
    /// `relativePath` 是宿主的账。多送一个字段就被 serde 挡回去，而不是「收了但忽略」——
    /// 忽略会让前端以为它说的话算数，等它发现自己说的不算数时已经很难查了。
    #[test]
    fn a_reader_page_payload_cannot_carry_a_settings_id_or_a_path() {
        for extra in [
            r#""settingsId": "upscale-2x""#,
            r#""sourceRevision": "reader-page""#,
            r#""backend": "cpu""#,
            r#""relativePath": "ab/cd.png""#,
            r#""pipeline": []"#,
        ] {
            let json = format!(
                r#"{{"scopeId":"scope-a","archiveId":"archive-a","pageIndex":11,
                     "modelId":"realesr","generation":3,"priority":"foreground",
                     "deadlineMs":60000,{extra}}}"#
            );
            let error = serde_json::from_str::<ReaderPagePayload>(&json)
                .expect_err("这条来路不接受这个字段");
            assert!(
                error.to_string().contains("unknown field"),
                "要说清楚是「不认识这个字段」：{error}"
            );
        }
    }

    #[test]
    fn the_obvious_reader_junk_is_refused_before_a_worker_starts() {
        fn refuse(what: &str, edit: impl FnOnce(&mut ReaderPagePayload)) {
            let mut broken = reader_payload();
            edit(&mut broken);
            match broken.into_request() {
                Ok(_) => panic!("{what} 应该被挡回去"),
                Err(message) => assert!(!message.trim().is_empty(), "{what} 要给个理由"),
            }
        }

        refuse("空 scopeId", |p| p.scope_id = "   ".to_string());
        refuse("空 archiveId", |p| p.archive_id = "  \n".to_string());
        refuse("超长 modelId", |p| p.model_id = "x".repeat(MAX_ID_BYTES + 1));
        refuse("deadline 超上限", |p| p.deadline_ms = MAX_DEADLINE_MS + 1);
        refuse("不认识的 priority", |p| p.priority = "urgent".to_string());
    }

    fn temp_root(name: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("时钟在走")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "yomika-commands-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    /// 8-g①：**取产物的那一刻**，这份内容寻址的图才变成「页面的这一版」。
    ///
    /// 这一条测的是两条路接上了没有：登记之后，按修订号取起点的那一侧
    /// （[`crate::cache::cached_blob_location`]，DLSSNR / 旧超分 / 远端代理都走它）查得到这一行，
    /// 而 `pin` 也从「没有条目」变成真钉上了一条。字节一个都没搬——位置就是发布时那个
    /// 内容寻址的位置。
    ///
    /// 把 `attach_to_page` 里那次登记删掉，这一条就红：这正是本轮要证的那件事。
    #[test]
    fn taking_an_artifact_registers_it_as_the_page_rendition() {
        let root = temp_root("take-artifact");
        std::fs::create_dir_all(&root).expect("建临时目录");
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");

        // 像发布那一侧那样真落一份盘：摘要是文件自己的，路径由摘要推出来。
        let staged = root.join("staged.png");
        let bytes = b"a-page-that-was-de-censored".repeat(32);
        std::fs::write(&staged, &bytes).expect("写 staging 文件");
        let expected = crate::compute::artifacts::hash_file(&staged)
            .expect("算得出摘要")
            .1;
        let published = crate::compute::artifacts::publish_blob(&root, &staged, &expected)
            .expect("发布得进内容寻址存储");

        let source = crate::cache::CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 4);
        let identity = renditions::decensored_identity(&source, "decensored-rev-1");
        let index = renditions::RenditionIndex::new();
        index.record(
            "job-1",
            vec![renditions::StageRendition {
                stage_id: decensor::DECENSOR_STAGE_ID.to_string(),
                identity: identity.clone(),
            }],
        );
        let record = ArtifactRecord {
            job_id: "job-1".to_string(),
            stage_id: decensor::DECENSOR_STAGE_ID.to_string(),
            artifact_id: "artifact-1".to_string(),
            staging_name: "staged.png".to_string(),
            path: published.path.clone(),
            cache_relative: Some(published.relative.clone()),
            byte_length: published.byte_length,
            content_hash: published.content_hash.clone(),
            width: 320,
            height: 240,
            engine_id: "onnx".to_string(),
            engine_precision: "fp32".to_string(),
            engine_policy: None,
            engine_fallback: None,
            pipeline_revision: "worker-v1:test".to_string(),
            verified: true,
        };

        let pinned = attach_to_page(
            &database,
            &root,
            &index,
            &record,
            "image/png",
            &published.relative,
        );

        assert_eq!(pinned, 1, "登记之后就该有一条可钉住的缓存条目");
        let found = crate::cache::cached_blob_location(&database, &root, &identity)
            .expect("查缓存不该出错")
            .expect("按修订号取起点的那一侧现在该找得到它");
        assert_eq!(
            found.path, published.path,
            "没有另存一份：位置就是发布时那个内容寻址的位置"
        );
        assert_eq!(found.content_hash, published.content_hash);
        assert_eq!(found.byte_length, published.byte_length);

        // 索引里的键就是计划铸的那份身份（含修订号），不是这里另算的一份。
        let key = crate::cache::image_cache_key(&identity);
        let connection = database.connection.lock().expect("库锁在");
        let rows: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM cache_entries WHERE key = ?1",
                [&key],
                |row| row.get(0),
            )
            .expect("查得到行数");
        drop(connection);
        assert_eq!(rows, 1);

        std::fs::remove_dir_all(&root).expect("收摊");
    }

    /// 8-g①：收下的任务要**记着**它产出哪几版。
    ///
    /// 记在提交这一侧、而不是取产物时再算，是因为「哪一版」只活在计划里：取产物那一侧手上
    /// 只有一份 `ArtifactRecord`，而那份记录会原样序列化给渲染进程，不该往里塞宿主的缓存账。
    /// 队列**没收下**的那件不记：它一步都没跑，不会有任何产物。
    #[test]
    fn an_accepted_submission_records_the_renditions_it_will_produce() {
        let root = temp_root("recorded");
        // worker 可执行文件在这儿并不存在：这条测试只走到「队列收下了它」，
        // 真起进程、握手、写帧都是 supervisor 线程的事（那是集成测试的地盘）。
        let manager = ComputeManager::start(
            crate::compute::manager::SupervisorConfig::new(
                root.join("yomika-compute-worker.exe"),
                root.join("staging"),
            ),
            crate::compute::manager::no_events(),
        )
        .expect("起得了 supervisor");
        let index = renditions::RenditionIndex::new();
        let request = plan(payload(), None).expect("这份载荷是合法的");
        let entries = vec![renditions::StageRendition {
            stage_id: "stage-a".to_string(),
            identity: renditions::enhanced_identity(
                &crate::cache::CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 4),
                "upscale-rev-1",
            ),
        }];

        let answer = enqueue_recorded(&manager, &index, request, entries);

        let CommandResult::Success { value, .. } = &answer else {
            panic!("队列该收下它：{answer:?}");
        };
        assert!(
            index.find(&value.job_id, "stage-a").is_some(),
            "收下的任务必须记着它产出哪一版，否则取产物时没人认得出这是页面的哪一版"
        );

        manager.shutdown();
        // supervisor 收摊时可能已经把 staging 目录收走了，这里只当扫尾。
        let _ = std::fs::remove_dir_all(&root);
    }
}
