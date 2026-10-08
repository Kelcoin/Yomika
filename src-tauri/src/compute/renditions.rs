//! 「这份产物是页面的**哪一版**」——compute 与缓存索引之间的那道桥。
//!
//! compute 的产物只落在**内容寻址**的位置上（`cache/images/xx/<hash>.bin`），路径里没有
//! 「哪一页、哪一版」；而宿主里按修订号取起点的那些消费者（DLSSNR、旧超分、远端代理的
//! `cached_derived`）查的是 SQLite 里那一行。两条路各说各话的时候，产物就算已经躺在盘上，
//! 别人也永远查不到它——用户那边表现为一直「这一页还没算好」（docs/94 欠账②）。
//!
//! 这个模块补的就是那一步：**把计划里已经算好的修订号，变成索引里那一行的身份**。
//!
//! 三件事分得很清楚：
//! ① [`decensored_identity`] / [`enhanced_identity`]：身份怎么铸（口径与旧命令同一份算法）；
//! ② [`RenditionIndex`]：这件任务会产出哪几版（提交时记下，取产物时按 `stage_id` 认领）；
//! ③ [`adopt_artifact`]：把一份**已经核验过**的产物挂成它在索引里的那一行。
//!
//! 身份为什么走宿主内存、而不是塞进 [`ArtifactRecord`](super::manager::ArtifactRecord)：
//! 那份记录会原样序列化给渲染进程（`compute_job_artifacts`）。往里加两个字段等于把宿主的
//! 缓存账（scope/修订号）交给界面读，而界面一个字都不需要知道——它要的是那个 URL。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::cache::{self, CacheImageIdentity};

use super::decensor::{DecensorPageJob, DECENSOR_STAGE_ID};
use super::manager::ArtifactRecord;
use super::reader::{ReaderPageJob, UPSCALE_STAGE_ID};

/// 去码那一版在缓存里的名字。与 `cache::IMAGE_RENDITIONS` 里那一档**逐字相同**。
pub const DECENSORED_RENDITION: &str = "decensored";

/// 放大那一版在缓存里的名字。旧命令、前端过滤器与这里用的是同一个串。
pub const ENHANCED_RENDITION: &str = "enhanced";

/// 最多替多少件任务记着身份。
///
/// 与调度器的保留窗口（最近 128 件）同一个数：能把「保留窗口里还能取产物的任务」全覆盖住。
/// 超了就按**入账顺序**忘掉最早的——不是 LRU：这里没有「最近用过」这个信号，而记错顺序的
/// 代价只是「一件早就该被淘汰的任务少挂一行」，不值得为它加时间戳。
pub const MAX_INDEXED_JOBS: usize = 128;

/// 一个阶段会产出页面的哪一版。
///
/// `stage_id` 是认领时的钥匙：链上两个阶段各交一件产物，靠它把「这一件」对到「哪一版」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageRendition {
    pub stage_id: String,
    pub identity: CacheImageIdentity,
}

/// 去码那一版的身份。
///
/// `revision` 是 [`super::decensor::DecensorPageJob::decensored_revision`]：计划里用
/// `inference::decensored_revision(包指纹)` 算出来的那一串。这里**不重算**——重算就得再要一份
/// 包指纹，而那份指纹只活在计划里；口径与旧命令同出一处才不会有第二份说法。
pub fn decensored_identity(source: &CacheImageIdentity, revision: &str) -> CacheImageIdentity {
    page_rendition(source, DECENSORED_RENDITION, revision.to_string())
}

/// 放大那一版的身份：`revision` 必须是 `enhanced_revision` 算出来的那串（[`DecensorPageJob`]
/// 与 [`ReaderPageJob`] 都已经把它算好放在 `settings_id` 里）。
///
/// 这里不重算：重算就有第二份入参（模型解析结果），两份口径迟早会分家；调用方手上那个串
/// 就是它准备交给缓存的那一版，身份与它逐字一致才不会有「交出去的图」与「登记的版」错位。
pub fn enhanced_identity(source: &CacheImageIdentity, revision: &str) -> CacheImageIdentity {
    page_rendition(source, ENHANCED_RENDITION, revision.to_string())
}

/// 一件产物记录该登记成页面的哪一版。
fn page_rendition(
    source: &CacheImageIdentity,
    rendition: &str,
    revision: String,
) -> CacheImageIdentity {
    let mut identity = CacheImageIdentity::new(
        &source.scope_id,
        &source.archive_id,
        rendition,
        source.page_index,
    );
    identity.revision = Some(revision);
    identity
}

/// 去码那条路会产出哪几版，**按管线顺序**：第一步是 `decensored`，接上超分才有第二步
/// `enhanced`。
pub fn decensor_renditions(job: &DecensorPageJob) -> Vec<StageRendition> {
    let mut renditions = vec![StageRendition {
        stage_id: DECENSOR_STAGE_ID.to_string(),
        identity: decensored_identity(&job.source_identity, &job.decensored_revision),
    }];
    if let Some(upscale) = &job.upscale {
        renditions.push(StageRendition {
            stage_id: UPSCALE_STAGE_ID.to_string(),
            identity: enhanced_identity(&job.source_identity, &upscale.settings_id),
        });
    }
    renditions
}

/// 阅读器那条超分路会产出哪一版：一件产物，就是 `enhanced` 那一版。
pub fn reader_renditions(job: &ReaderPageJob) -> Vec<StageRendition> {
    vec![StageRendition {
        stage_id: UPSCALE_STAGE_ID.to_string(),
        identity: enhanced_identity(&job.source_identity, &job.settings_id),
    }]
}

/// 一件任务的入账顺序（用于有界淘汰）。
#[derive(Debug, Default)]
struct Indexed {
    jobs: HashMap<String, Vec<StageRendition>>,
    order: std::collections::VecDeque<String>,
}

/// 任务 → 它会产出哪几版。
///
/// 跟着 [`ComputeHandle`](super::ComputeHandle) 走，所以它与调度器同一寿命：worker 换代、
/// 应用重启都不会留下一份「上一代的账」。
#[derive(Debug, Default)]
pub struct RenditionIndex {
    indexed: Mutex<Indexed>,
}

impl RenditionIndex {
    pub fn new() -> Self {
        Self {
            indexed: Mutex::new(Indexed {
                jobs: HashMap::new(),
                order: std::collections::VecDeque::new(),
            }),
        }
    }

    /// 记下一件任务会产出哪几版。同一个 `job_id` 再记一次是覆盖——调度器合并同一件任务时
    /// 身份是一样的（同一份输入 + 同一份设置 ⇒ 同一个修订号）。
    pub fn record(&self, job_id: &str, renditions: Vec<StageRendition>) {
        let mut indexed = self.lock();
        if indexed.jobs.insert(job_id.to_string(), renditions).is_none() {
            indexed.order.push_back(job_id.to_string());
        }
        while indexed.order.len() > MAX_INDEXED_JOBS {
            if let Some(oldest) = indexed.order.pop_front() {
                indexed.jobs.remove(&oldest);
            }
        }
    }

    /// 这件任务的这个阶段产的是哪一版。没有记过（通用那道门、或者已经不是同一个应用生命周期）
    /// 就是 `None`。
    pub fn find(&self, job_id: &str, stage_id: &str) -> Option<CacheImageIdentity> {
        self.lock()
            .jobs
            .get(job_id)?
            .iter()
            .find(|entry| entry.stage_id == stage_id)
            .map(|entry| entry.identity.clone())
    }

    /// 忘掉一件任务。只有**已经确定不会再产出**的任务才该忘：提交时被挤掉的那个后台占位
    /// （`Submitted::evicted`）就是这样的信号。
    ///
    /// 取消却**已经算完**的任务不许忘——它手上那份产物还能取，界面回头去取的时候得认出
    /// 「这是页面的哪一版」。
    pub fn forget(&self, job_id: &str) -> bool {
        let mut indexed = self.lock();
        if indexed.jobs.remove(job_id).is_some() {
            indexed.order.retain(|entry| entry != job_id);
            true
        } else {
            false
        }
    }

    // 锁中毒不当回事：这份表是纯账目，没有「一半写完」的中间态（与租借表同一条规矩）。
    fn lock(&self) -> MutexGuard<'_, Indexed> {
        self.indexed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

/// 把一份**已经核验过**的产物挂成它在索引里那一版。
///
/// `Ok(None)` = 这件产物没有「页面的哪一版」这回事（通用那道门提交的任务、或者没有发布根），
/// **不是失败**：租借走的是内容寻址的位置，与索引那一行无关。
pub fn adopt_artifact(
    database: &crate::db::Database,
    app_data: &Path,
    renditions: &RenditionIndex,
    record: &ArtifactRecord,
    mime: &str,
) -> Result<Option<CacheImageIdentity>, String> {
    if !record.verified {
        return Err("Unverified artifact cannot be registered as a page rendition".into());
    }
    let Some(identity) = renditions.find(&record.job_id, &record.stage_id) else {
        return Ok(None);
    };
    let Some(relative) = record.cache_relative.as_deref() else {
        return Ok(None);
    };
    cache::adopt_published_blob(
        database,
        app_data,
        &identity,
        mime,
        relative,
        &record.content_hash,
        record.byte_length,
    )?;
    Ok(Some(identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::scheduler::Priority;
    use crate::compute::reader::ReaderPageJob;
    use std::path::PathBuf;

    fn source() -> CacheImageIdentity {
        CacheImageIdentity::new("scope-a", "archive-a", "reader-page", 11)
    }

    /// 一份已经核验过的产物记录。字段值本身不重要——这个模块只读 `verified` /
    /// `job_id` / `stage_id` / `cache_relative` / 摘要与长度。
    fn record(relative: Option<&str>, verified: bool) -> ArtifactRecord {
        ArtifactRecord {
            job_id: "job-1".to_string(),
            stage_id: DECENSOR_STAGE_ID.to_string(),
            artifact_id: "artifact-1".to_string(),
            staging_name: "staged.png".to_string(),
            path: PathBuf::from("C:/staging/staged.png"),
            cache_relative: relative.map(str::to_string),
            byte_length: 4096,
            content_hash: "a".repeat(64),
            width: 320,
            height: 240,
            engine_id: "onnx".to_string(),
            engine_precision: "fp32".to_string(),
            engine_policy: None,
            engine_fallback: None,
            pipeline_revision: "worker-v1:test".to_string(),
            verified,
        }
    }

    fn reader_job(settings_id: &str) -> ReaderPageJob {
        ReaderPageJob {
            input_id: "scope-a:archive-a:11".to_string(),
            settings_id: settings_id.to_string(),
            source_revision: "reader-page".to_string(),
            backend: "cpu".to_string(),
            source_identity: source(),
            model_spec_id: "realesr".to_string(),
            scale: 2,
            output_scale: Some(2),
            generation: 1,
            priority: Priority::Background,
            deadline_ms: 0,
        }
    }

    /// 阅读器那条超分路的产物就是 `enhanced` 那一版：修订号**逐字**用手上这个 `settings_id`，
    /// 不重算——重算就得再要一份「超分模型解析结果」，两份口径迟早会分家。
    #[test]
    fn a_reader_stage_names_the_enhanced_rendition() {
        let renditions = reader_renditions(&reader_job("enhanced-rev-1"));

        assert_eq!(renditions.len(), 1);
        assert_eq!(renditions[0].stage_id, UPSCALE_STAGE_ID);
        assert_eq!(renditions[0].identity.rendition, ENHANCED_RENDITION);
        assert_eq!(
            renditions[0].identity.revision.as_deref(),
            Some("enhanced-rev-1")
        );
        // 其余字段必须还是「这一页」那一份：换错页就是把别人的图挂到这一页上。
        assert_eq!(renditions[0].identity.scope_id, "scope-a");
        assert_eq!(renditions[0].identity.archive_id, "archive-a");
        assert_eq!(renditions[0].identity.page_index, 11);
    }

    /// 记满了按**入账顺序**忘最早的。不是 LRU：这里没有「最近用过」这个信号。
    #[test]
    fn the_index_forgets_the_oldest_task_beyond_its_bound() {
        let index = RenditionIndex::new();
        let entry = |stage_id: &str| StageRendition {
            stage_id: stage_id.to_string(),
            identity: decensored_identity(&source(), "rev-1"),
        };
        for number in 0..=MAX_INDEXED_JOBS {
            index.record(&format!("job-{number}"), vec![entry(DECENSOR_STAGE_ID)]);
        }

        assert!(
            index.find("job-0", DECENSOR_STAGE_ID).is_none(),
            "第 {MAX_INDEXED_JOBS} 件之后，最早那件就该被忘掉"
        );
        assert!(
            index
                .find(&format!("job-{MAX_INDEXED_JOBS}"), DECENSOR_STAGE_ID)
                .is_some(),
            "刚记下的那件还在"
        );

        // 同一个 job_id 再记一次是覆盖，不是又占一格（调度器合并同一件任务时身份是一样的）。
        index.record("job-1", vec![entry(UPSCALE_STAGE_ID)]);
        assert!(index.find("job-1", UPSCALE_STAGE_ID).is_some());
        assert!(
            index.find("job-1", DECENSOR_STAGE_ID).is_none(),
            "覆盖之后旧的那一版不该还留着"
        );
    }

    #[test]
    fn forgetting_a_task_removes_it_from_both_the_map_and_the_order() {
        let index = RenditionIndex::new();
        index.record(
            "job-1",
            vec![StageRendition {
                stage_id: DECENSOR_STAGE_ID.to_string(),
                identity: decensored_identity(&source(), "rev-1"),
            }],
        );

        assert!(index.forget("job-1"));
        assert!(!index.forget("job-1"), "忘两次只有第一次算数");
        assert!(index.find("job-1", DECENSOR_STAGE_ID).is_none());
    }

    /// 没核验过的产物**绝不**能挂成页面的某一版：登记等于告诉全宿主「这一版算好了」，
    /// 而核验没过的字节连是不是图都不知道。
    #[test]
    fn an_unverified_artifact_is_never_registered() {
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");
        let index = RenditionIndex::new();
        index.record(
            "job-1",
            vec![StageRendition {
                stage_id: DECENSOR_STAGE_ID.to_string(),
                identity: decensored_identity(&source(), "rev-1"),
            }],
        );

        let error = adopt_artifact(
            &database,
            Path::new("C:/nowhere"),
            &index,
            &record(Some("cache/images/aa/aa.bin"), false),
            "image/png",
        )
        .expect_err("没核验过的产物不该挂行");
        assert!(error.contains("Unverified"), "{error}");
    }

    /// 通用那道门提交的任务没有「页面的哪一版」这回事：`Ok(None)` 是正常答案，不是失败
    /// （租借走的是内容寻址的位置，与索引那一行无关）。
    #[test]
    fn a_task_nobody_indexed_is_left_alone() {
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");
        let index = RenditionIndex::new();

        assert_eq!(
            adopt_artifact(
                &database,
                Path::new("C:/nowhere"),
                &index,
                &record(Some("cache/images/aa/aa.bin"), true),
                "image/png",
            )
            .expect("没有索引不是错误"),
            None
        );
    }

    /// 没有发布根的产物（宿主没配发布根）同样只是 `Ok(None)`：它压根没落到正式目录。
    #[test]
    fn an_artifact_without_a_published_path_is_left_alone() {
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");
        let index = RenditionIndex::new();
        index.record(
            "job-1",
            vec![StageRendition {
                stage_id: DECENSOR_STAGE_ID.to_string(),
                identity: decensored_identity(&source(), "rev-1"),
            }],
        );

        assert_eq!(
            adopt_artifact(
                &database,
                Path::new("C:/nowhere"),
                &index,
                &record(None, true),
                "image/png",
            )
            .expect("没有发布根不是错误"),
            None
        );
    }
}
