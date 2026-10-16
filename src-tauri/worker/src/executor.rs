//! 串行执行器（docs/71 §5.1、§6.5）。
//!
//! 一个独立线程，**一次只跑一个重任务**：控制面（读帧、ping、cancel、shutdown）
//! 留在会话主线程，所以哪怕引擎正卡在 3 秒的一次推理里，ping 与取消也照样立刻有
//! 回应（§11 Task 3 第 ⑤ 条）。这里不排队：第二个任务在会话层就被 `busy` 挡掉了。

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use yomika_compute_core::inputs::{resolve_granted, verify_file, InputError};
use yomika_compute_protocol::messages::{
    ArtifactReady, Failed, JobRef, Message, Run, StageProgress, StageStarted, PROTOCOL_MAJOR,
};

use crate::engine::{Engine, StageInput, StageRequest, StageSink, ARTIFACT_INVALID_CODE};
use crate::protocol::{JobEnvelope, Log, SlotDecision, Waiters, Writer};

/// 宿主核对了 hash/大小之后才认这份产物；对不上就是这一条。
const ARTIFACT_REJECTED_CODE: &str = "COMPUTE_ARTIFACT_REJECTED";

/// 进度帧的最小间隔：合并是允许的（§6.2），但别把一条长推理灌成几千帧。
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(10);

/// 起执行器线程。句柄是丢掉的（分离）：重任务没法被安全打断，宿主按 §6.5
/// 超时杀进程，而不是等 worker 自己体面收尾。
pub(crate) fn spawn<E, W>(
    engine: Arc<E>,
    writer: Arc<Writer<W>>,
    waiters: Arc<Waiters>,
    staging_root: PathBuf,
    input_root: PathBuf,
    epoch: String,
    receiver: Receiver<JobEnvelope>,
    log: Log,
) -> thread::JoinHandle<()>
where
    E: Engine,
    W: std::io::Write + Send + 'static,
{
    thread::Builder::new()
        .name("yomika-compute-executor".to_string())
        .spawn(move || {
            while let Ok(job) = receiver.recv() {
                log.line(&format!("开始任务 {}", job.run.job_id));
                execute_job(
                    engine.as_ref(),
                    &writer,
                    &waiters,
                    &staging_root,
                    &input_root,
                    &epoch,
                    &job,
                    &log,
                );
                job.finished.store(true, Ordering::SeqCst);
            }
            log.line("执行器收摊");
        })
        .expect("起执行器线程失败")
}

#[allow(clippy::too_many_arguments)]
fn execute_job<E, W>(
    engine: &E,
    writer: &Arc<Writer<W>>,
    waiters: &Waiters,
    staging_root: &Path,
    input_root: &Path,
    epoch: &str,
    job: &JobEnvelope,
    log: &Log,
) where
    E: Engine,
    W: std::io::Write + Send + 'static,
{
    let run = &job.run;
    let reference = JobRef {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch.to_string(),
        job_id: run.job_id.clone(),
        generation: run.generation,
    };
    // 这份 revision 由 worker 从**它收到的 run** 派生，宿主自己也算一份，对不上就说明
    // 中间有人改了意图（§6.4）。两边都用协议 crate 的同一份 `encode`，所以可比。
    let pipeline_revision = revision_of(run);
    let sink = StageSink::new(staging_root);
    let cancel = job.guard.token();

    // 输入交接在第一个 `StageStarted` **之前**做完（§7.1/§7.2）：读不到、或者长度/hash
    // 与 run 里声明的不符，就不该开始算。宿主看到的是「这份输入不能用」，而不是
    // 「算到一半失败」——后者会让一次纯输入问题看起来像算法问题。
    let granted = match resolve_input(input_root, run) {
        Ok(input) => input,
        Err(error) => {
            log.line(&format!("输入不可用：{}", error.message()));
            writer.send_or_log(&failure(
                epoch,
                run,
                yomika_compute_core::inputs::INPUT_INVALID_CODE,
                &error.message(),
            ));
            return;
        }
    };

    // 上一阶段落定的产物名。第一段读宿主授权的输入，之后的段读上一段的产物。
    let mut previous: Option<String> = None;

    for (index, stage) in run.pipeline.iter().enumerate() {
        if job.guard.cancelled() {
            writer.send_or_log(&Message::Cancelled(reference));
            return;
        }
        writer.send_or_log(&Message::StageStarted(StageStarted {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.to_string(),
            job_id: run.job_id.clone(),
            generation: run.generation,
            stage_id: stage.stage_id.clone(),
            stage_index: index as u32,
        }));

        // `previous` 里的名字来自一个已经 `is_safe_name` 过、并且被宿主 Ack 的产物，
        // 所以这里直接拼路径就是安全的（不需要第二遍校验，也就没有一段够不着的代码）。
        let input = match &previous {
            Some(relative) => Some(StageInput::Previous {
                relative: relative.clone(),
                path: staging_root.join(relative),
            }),
            None => granted.clone(),
        };

        let artifact_id = format!("{}:{}:{}", run.job_id, run.generation, stage.stage_id);
        let slot = waiters.insert(artifact_id.clone());

        // 进度回调节流：同值不重复发，最小间隔之外才发一帧。
        let last = Mutex::new((u32::MAX, None::<std::time::Instant>));
        let progress = |percent: u32| {
            if percent > 100 {
                return;
            }
            let now = std::time::Instant::now();
            {
                let mut last = last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                if last.0 == percent {
                    return;
                }
                if let Some(previous) = last.1 {
                    if now.duration_since(previous) < PROGRESS_MIN_INTERVAL {
                        return;
                    }
                }
                *last = (percent, Some(now));
            }
            writer.send_or_log(&Message::Progress(StageProgress {
                protocol_version: PROTOCOL_MAJOR,
                worker_epoch: epoch.to_string(),
                job_id: run.job_id.clone(),
                generation: run.generation,
                stage_id: stage.stage_id.clone(),
                percent: percent as f32,
            }));
        };

        let outcome = engine.execute(StageRequest {
            run,
            stage,
            input: input.as_ref(),
            cancel: &cancel,
            sink: &sink,
            progress: &progress,
        });

        let output = match outcome {
            Ok(output) => output,
            Err(error) if error.is_cancelled() => {
                waiters.remove(&artifact_id);
                writer.send_or_log(&Message::Cancelled(reference));
                return;
            }
            Err(error) => {
                waiters.remove(&artifact_id);
                log.line(&format!("阶段 {} 失败：{}", stage.stage_id, error.code));
                writer.send_or_log(&failure(epoch, run, &error.code, &error.message));
                return;
            }
        };

        // 引擎自报的名字要再过一遍：宿主也会拦，但穿越不该有机会出现在 wire 上。
        if !StageSink::is_safe_name(&output.relative_name) {
            waiters.remove(&artifact_id);
            writer.send_or_log(&failure(
                epoch,
                run,
                ARTIFACT_INVALID_CODE,
                &format!("引擎给的产物名非法：{}", output.relative_name),
            ));
            return;
        }

        let accepted = output.relative_name.clone();
        writer.send_or_log(&Message::ArtifactReady(ArtifactReady {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: epoch.to_string(),
            job_id: run.job_id.clone(),
            generation: run.generation,
            stage_id: stage.stage_id.clone(),
            artifact_id: artifact_id.clone(),
            output_grant_id: run.output_grant_id.clone(),
            relative_name: output.relative_name,
            content_hash: output.content_hash,
            mime: output.mime,
            byte_length: output.byte_length,
            // 协议要求 1..=65536；引擎算出来的尺寸也当不可信输入。
            width: output.width.clamp(1, 65_536),
            height: output.height.clamp(1, 65_536),
            engine: output.engine,
            pipeline_revision: pipeline_revision.clone(),
        }));

        // 等宿主裁决。等的过程里来的取消会直接落在这张牌上（Waiters::cancel_all）。
        let decision = slot.wait();
        waiters.remove(&artifact_id);
        match decision {
            // 只有宿主 Ack 过的产物才是下一段可以读的输入（§7.3 第 1 步）。
            SlotDecision::Ack => previous = Some(accepted),
            SlotDecision::Rejected(reason) => {
                writer.send_or_log(&failure(epoch, run, ARTIFACT_REJECTED_CODE, &reason));
                return;
            }
            SlotDecision::Cancelled => {
                writer.send_or_log(&Message::Cancelled(reference));
                return;
            }
        }
    }

    writer.send_or_log(&Message::Completed(reference));
}

/// 把 run 里声明的输入解析成一条已复核的 [`StageInput`]（`None` = 这次运行没有
/// 授权输入，引擎需要像素就自己回 `COMPUTE_INPUT_INVALID`）。
///
/// 顺序是「先关在授权根里，再复核内容」：任一环节不过就整次运行都不开始算。
fn resolve_input(input_root: &Path, run: &Run) -> Result<Option<StageInput>, InputError> {
    let Some(relative) = run.input.relative_path.as_deref() else {
        return Ok(None);
    };
    let path = resolve_granted(input_root, relative)?;
    verify_file(&path, &run.input.content_hash, run.input.byte_length)?;
    Ok(Some(StageInput::Granted {
        relative: relative.to_string(),
        path,
    }))
}

/// 从收到的 `run` 派生一个可比的 revision：只有「同一份 run」才会得到同一个串。
fn revision_of(run: &Run) -> String {
    let encoded = yomika_compute_protocol::messages::encode(&Message::Run(run.clone()))
        .unwrap_or_default();
    let hash = blake3::hash(encoded.as_bytes()).to_hex().to_string();
    format!("worker-v2-adaptive-input:{}", &hash[..16])
}

fn failure(epoch: &str, run: &Run, code: &str, message: &str) -> Message {
    Message::Failed(Failed {
        protocol_version: PROTOCOL_MAJOR,
        worker_epoch: epoch.to_string(),
        job_id: run.job_id.clone(),
        generation: run.generation,
        code: code.to_string(),
        message: message.to_string(),
    })
}
