//! 去码那道门：把「这一页 + 哪个去码包」铸成一份提交计划。
//!
//! 为什么这件活不能交给渲染进程：调用方手里只有一段 JSON，而这一层要**算身份**——
//! `settings_id` 是 `decensored_revision`（模型包指纹 + 声明的后端 + 运行时库版本 + 管线
//! 口径）算出来的，还要在模型目录与缓存索引里各查一次。这些渲染进程都做不到，也不该做到。
//!
//! 摆盘不在 [`into_request`] 里做，而在派发前那一侧（`manager::prepare_run`）——与模型授权
//! 同一条规矩：调用方不许指名输入根里的任何文件。任务带上的是 [`InpaintPreparation`]，
//! 也就是**三份模型的磁盘路径**（检测器与两份修补图）；宿主自己在派发前读它、核它、摆进根里，
//! 再换成协议层的 `DecensorGrant`。这样「这一页用的是这一套模型」与「磁盘上真的是这一套」会在
//! 同一个地方对账，跟页面源图完全一样。
//!
//! **检测不再在这里发生**（docs/94）：8-c 让宿主先检测、把掩膜当文件交给 worker，可 Task 8 的
//! 出口条件是「宿主里没有 ORT 资源」，而那份 254 MB 的 Mask R-CNN 会话就是宿主里最重的一项。
//! 于是检测整段搬进 worker——掩膜由这一页的像素算出来，算它的就是那一步，中间没有第二个人
//! 需要看见它。这一层因此只剩「查包、查位置、铸身份、点三份模型」。

use std::path::{Path, PathBuf};

use yomika_compute_protocol::messages::{DecensorGrant, GrantedFile, PipelineStage, RunInput};

use super::artifacts::hash_file;
use super::inputs::stage;
use super::manager::{SourceFile, SubmitRequest};
use super::models::MODEL_UNAVAILABLE_CODE;
use super::reader::{
    engine_policy, engine_policy_label, resolve_worker_upscaler, UPSCALE_STAGE_ID,
};
use super::scheduler::{JobKey, Priority};
use crate::cache::CacheImageIdentity;
use crate::inference::decensor::DecensorBundle;
use crate::inference::{
    decensored_revision, enhanced_revision, resolve_installed_bundle, source_identity, ModelManifest,
    ENHANCED_OUTPUT_SCALE,
};

/// 去码那一步在管线里的名字。与旧命令、代理、前端过滤器共用同一个：同一件事只有一个名字。
pub const DECENSOR_STAGE_ID: &str = "decensor";

/// 产物落盘许可的来路标签。它只用来记账「是谁让它落的盘」，不参与任务身份。
pub const DECENSOR_PAGE_GRANT_ID: &str = "decensor-page";

/// 这条来路的起点：**原始页面**。
///
/// 与阅读器那份 [`super::reader::UPSCALE_STAGE_ID`] 的起点同名不是巧合：去码补的就是这一页
/// 本身，所以它与原图同一次身份（`rendition = "reader-page"`、不带修订号），而超分那条路
/// 拿到的才是 `decensored:<修订号>` 这一版。
const DECENSOR_PAGE_RENDITION: &str = "reader-page";

/// 这一页 + 这套配置 → 一份任务身份。字段与阅读器那份一一对应，少的是倍率与输出缩放
/// （修补不改尺寸：进多少像素出多少像素），多的是模型包本身。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecensorPageRequest {
    pub scope_id: String,
    pub archive_id: String,
    pub page_index: i64,
    /// 标明用哪个去码包。一个包 = 四份文件整装整卸（`inference::decensor::bundle_in`）。
    pub model_id: String,
    /// 补完这一页之后接着放大的那个超分模型（不指名就是只去码）。
    ///
    /// 为什么写在这一条请求里、而不是让阅读器再提一件超分任务：两步必须是**同一件任务**的
    /// 相邻两阶段。compute 的产物只有内容寻址的落点、没有缓存行，出了这件任务之后没有任何人
    /// 能按身份把它找回来（docs/94 欠账②），而链上第二阶段的输入正是第一阶段那份被逐件核验
    /// 过的产物（`StageInput::Previous`）——同一次提交里，它就在共享的 staging 目录里。
    pub upscale_model_id: Option<String>,
    pub generation: u64,
    pub priority: Priority,
    pub deadline_ms: u64,
}

/// 铸好的身份。它与阅读器那条路**同源**：`settings_id` 走 `decensored_revision`（只去码）
/// 或 `enhanced_revision`（接上超分），所以旧命令算出来的缓存行与这里算出来的是同一行。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecensorPageJob {
    pub input_id: String,
    /// **最后交出去的那一版**的缓存修订号：接上超分就是 `enhanced` 那一版，否则是 `decensored`。
    pub settings_id: String,
    /// **去码那一版**的缓存修订号（第一步的产物，`inference::decensored_revision(包指纹)`）。
    ///
    /// 接上超分时它与 `settings_id` 不同：一件任务会产出**两版**，而每一版在缓存索引里都得有
    /// 自己的身份才找得回来，所以两个串都要留在计划里（见 [`super::renditions`]）。
    pub decensored_revision: String,
    pub source_revision: String,
    pub backend: String,
    pub source_identity: CacheImageIdentity,
    pub model_spec_id: String,
    /// 链上的第二步（没指名超分模型就是 `None`）。
    pub upscale: Option<UpscaleStage>,
    /// 四份模型的位置（检测器、两份修补图、ESRGAN）。派发时前三份会被摆进只读输入根；
    /// ESRGAN 只是整装的一份，产品路径没有用到它。
    pub bundle: DecensorBundle,
    pub generation: u64,
    pub priority: Priority,
    pub deadline_ms: u64,
}

/// 链上第二步（超分）需要的身份：模型 id、它这一版的修订号、倍数与输出口径。
///
/// 单独一个结构而不是把三个字段平铺进 [`DecensorPageJob`]：它们只在「要接着放大」时才存在，
/// 而那个修订号必须与 [`super::reader`] 那道门算出**逐字相同**的串（`enhanced_revision` 的
/// doc 说的就是这件事）——单独放一个结构，就没机会把它与去码那一版混起来。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpscaleStage {
    pub model_spec_id: String,
    pub settings_id: String,
    pub scale: u32,
    pub output_scale: Option<u32>,
}

/// 派发前要摆进输入根的东西：三份模型的磁盘路径。
///
/// 这一层存在的理由是**位置**：它只在宿主进程内传递（命令层 → `manager::prepare_run`），
/// 不会进协议、不会进 Run。渲染进程看不见它，也就没有机会指名任何文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InpaintPreparation {
    pub detector: PathBuf,
    pub bar: PathBuf,
    pub mosaic: PathBuf,
}

/// 摆盘失败。码用 `COMPUTE_*` 词汇，与 `SubmitRequest` 那条失败通道同一个出口。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InpaintStageError {
    pub code: &'static str,
    pub message: String,
}

impl InpaintStageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// 把三份模型摆进只读输入根，交回协议层那份三件套授权。
///
/// 三份都**必须**齐：检测器缺了就是「不知道补哪里」，一份修补模型缺了就是「有一类框补不了」，
/// 而一个补不了的框不许沉默地跳过去——那是把去码开着的页面交回一张仍然被遮的图。
pub fn stage_inpaint(
    inputs_root: &Path,
    preparation: &InpaintPreparation,
) -> Result<DecensorGrant, InpaintStageError> {
    Ok(DecensorGrant {
        detector: stage_model(inputs_root, &preparation.detector)?,
        bar: stage_model(inputs_root, &preparation.bar)?,
        mosaic: stage_model(inputs_root, &preparation.mosaic)?,
    })
}

/// 磁盘上的一个模型文件 → 输入根里的一份内容寻址文件。
///
/// 长度与哈希都是**当场从磁盘读出来的事实**，不是清单说的：模型包装好之后被人换过文件，
/// 症状是「同一份设置这次算出来不太一样」，最难查的那一类。
fn stage_model(inputs_root: &Path, path: &Path) -> Result<GrantedFile, InpaintStageError> {
    let (byte_length, content_hash) = hash_file(path).map_err(|error| {
        InpaintStageError::new(
            MODEL_UNAVAILABLE_CODE,
            format!("读不出修补模型 {}：{error}", path.display()),
        )
    })?;
    let relative_path = stage(inputs_root, path, &content_hash)
        .map_err(|error| InpaintStageError::new(error.code(), error.message()))?;
    Ok(GrantedFile {
        relative_path,
        content_hash,
        byte_length,
    })
}

/// 铸不出来的时候：码 + 给用户看的一句话 + 值不值得重试。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecensorPlanError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl DecensorPlanError {
    /// 请求本身说不通：页码是负的，或者根本没指名哪个去码包。
    fn bad(message: impl Into<String>) -> Self {
        Self {
            code: "COMPUTE_BAD_REQUEST",
            message: message.into(),
            retryable: false,
        }
    }

    /// 要算的东西这台机器上没有。不可重试：再试一次还是同一个答案。
    fn no_model(message: impl Into<String>) -> Self {
        Self {
            code: MODEL_UNAVAILABLE_CODE,
            message: message.into(),
            retryable: false,
        }
    }

    /// 这一页本身有问题：读不出来，或者盘上的字节不是索引里说的那一份。
    ///
    /// 可重试——与阅读器那条门对「这一页还没有落在缓存里」说的是同一句话：这一页会被人
    /// 重新拉一遍，那时字节就对了。
    fn input_invalid(message: impl Into<String>) -> Self {
        Self {
            code: "COMPUTE_INPUT_INVALID",
            message: message.into(),
            retryable: true,
        }
    }
}

/// 指名的那一份去码包：包本身、它的 id、以及它的清单（修订号要的是清单里那个指纹）。
///
/// `plan_decensor_page` 与 [`detect_page_regions`] 都要它——检测与铸身份必须看**同一个包**，
/// 各查一遍会让「检测器是 A 的、修补模型是 B 的」变成可能。查不到与没指名都在这里说清楚，
/// 两处也就说着同一句话。
struct InstalledBundle {
    /// 用户指名的那个 id，原样（只是去过两端空白）。
    id: String,
    bundle: DecensorBundle,
    manifest: ModelManifest,
}

fn installed_bundle(
    models_data: &Path,
    request: &DecensorPageRequest,
) -> Result<InstalledBundle, DecensorPlanError> {
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err(DecensorPlanError::bad(
            "这一页要指名一个去码模型包（去码没有「随便挑一个」这回事）",
        ));
    }
    let (bundle, manifest) = resolve_installed_bundle(models_data, model_id).ok_or_else(|| {
        DecensorPlanError::no_model(format!(
            "这台机器上还没有这个去码模型包:{model_id}（先去设置里装上它）"
        ))
    })?;
    Ok(InstalledBundle {
        id: model_id.to_string(),
        bundle,
        manifest,
    })
}

/// 这条来路读的是哪一版**起点**：原图那一版，不带修订号。
///
/// 铸身份与查缓存行必须是同一次计算：`plan_decensor_page` 交给 worker 的 `source_identity`
/// 与命令层拿去查索引的那一个，只差「谁先算」。
pub fn source_page_identity(request: &DecensorPageRequest) -> CacheImageIdentity {
    source_identity(
        &request.scope_id,
        &request.archive_id,
        request.page_index,
        DECENSOR_PAGE_RENDITION,
        None,
    )
}

/// 从「这一页 + 哪个包」到「可以派发的任务」，中间的活都在这里：查包、查位置、铸身份。
///
/// 放在这一层而不是命令体里，是因为它有一条**测得出来**的边界：命令体要一个 `AppHandle`
/// 才走得动（数据目录与数据库状态），而这三步只认 `&Database` + 数据目录。于是「这一页还
/// 没落在缓存里时说哪句话」这种判断可以在单元测试里真跑一遍，不必起一个 worker。
///
/// 位置只查索引（`cached_blob_location` 不读文件、不算哈希）：真读字节、真核哈希、真摆进
/// 只读输入根都在 `manager::prepare_run` 那一侧，与页面源图、模型授权完全同一条路。8-c 曾在
/// 这里当场复读一次页面字节并核哈希，理由是「检测结果是照着这一页的像素算出来的」；检测搬进
/// worker 之后那条理由由 worker 与输入根自己保证（`inputs::verify_file`），这里就不再读第二遍。
///
/// 返回的 `SourceFile` 是这一页**在缓存里的位置**，交给派发那一侧去摆盘。
pub fn prepare_decensor_page(
    database: &crate::db::Database,
    data_dir: &Path,
    request: &DecensorPageRequest,
) -> Result<(DecensorPageJob, SourceFile), DecensorPlanError> {
    let job = plan_decensor_page(data_dir, request)?;
    let identity = source_page_identity(request);
    let Some(located) = crate::cache::cached_blob_location(database, data_dir, &identity)
        .map_err(DecensorPlanError::bad)?
    else {
        return Err(DecensorPlanError::input_invalid(
            "这一页还没有落在缓存里，先在阅读器里打开它",
        ));
    };
    Ok((job, SourceFile::from(located)))
}

/// 这一页 + 这个去码包 → 一份任务身份。
///
/// `models_data` 是模型包所在的数据目录（`data_paths::model_data_dir`）：指纹要从那儿算出来，
/// 所以这一步只能在这一侧做。**「要补哪些框」不在这里决定**：那是这一页像素的函数，由 worker
/// 在补之前自己算（docs/94）——所以这一层一个掩膜字节都不经手，也就没有「空检测集」这种
/// 只有宿主才知道的状态可言。
pub fn plan_decensor_page(
    models_data: &Path,
    request: &DecensorPageRequest,
) -> Result<DecensorPageJob, DecensorPlanError> {
    if request.page_index < 0 {
        return Err(DecensorPlanError::bad(format!(
            "页码不能是负数：{}",
            request.page_index
        )));
    }
    // 包是**指名**的：查不到就得当场说「没装」，不许悄悄换成别的包——四份文件是一套，
    // 拿另一套的权重补这一套的框，产出的图没人能说它错在哪。
    let installed = installed_bundle(models_data, request)?;
    // 链上第二步（要接着放大的话）。没指名、或者只写了空白，就是「只去码」——不是错误：
    // 阅读器可以只开去码，那时它就是这条链的全部。
    let upscale = match request.upscale_model_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(model_id) => Some(upscale_stage(
            models_data,
            model_id,
            &installed.manifest.sha256,
        )?),
    };

    // 去码那一版的修订号：不接超分时它就是任务身份，接上超分时它退成第二步的起点。
    let decensored = decensored_revision(&installed.manifest.sha256);

    Ok(DecensorPageJob {
        // 与旧命令同一个形状：`{scope}:{archive}:{page}`。
        input_id: format!(
            "{}:{}:{}",
            request.scope_id, request.archive_id, request.page_index
        ),
        // 任务身份说的是最后交出去的那一版：接上超分之后就是 `enhanced` 那一版（它的起点
        // 正是这一次算出来的 `decensored` 修订号），否则是 `decensored` 那一版。
        settings_id: match &upscale {
            Some(stage) => stage.settings_id.clone(),
            None => decensored.clone(),
        },
        decensored_revision: decensored,
        source_revision: DECENSOR_PAGE_RENDITION.to_string(),
        backend: engine_policy_label().to_string(),
        // 与命令层查索引时用的是同一次计算（`source_page_identity`）：两处只差「谁先算」。
        source_identity: source_page_identity(request),
        model_spec_id: installed.id,
        upscale,
        bundle: installed.bundle,
        generation: request.generation,
        priority: request.priority,
        deadline_ms: request.deadline_ms,
    })
}

/// 链上第二步的身份。判据与 [`super::reader::plan_reader_page`] 共用同一个函数
/// （[`resolve_worker_upscaler`]），修订号也共用 [`enhanced_revision`]——同一份设置只有一条
/// 来路能算，所以「去码 + 超分」与「只有超分」不会变成两件任务。
fn upscale_stage(
    models_data: &Path,
    model_id: &str,
    decensor_fingerprint: &str,
) -> Result<UpscaleStage, DecensorPlanError> {
    let (resolved, scale) = resolve_worker_upscaler(models_data, model_id).map_err(|error| {
        DecensorPlanError {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
        }
    })?;
    Ok(UpscaleStage {
        model_spec_id: model_id.to_string(),
        settings_id: enhanced_revision(
            &Some(resolved),
            Some(&decensored_revision(decensor_fingerprint)),
        ),
        scale,
        output_scale: Some(ENHANCED_OUTPUT_SCALE),
    })
}

/// 身份 + 宿主查到的这一页位置 → 一份派发请求。
///
/// 与阅读器那份一样：这里**不读字节、不算哈希**。`input` 里那份哈希与长度是索引说的那一份，
/// 真读、真核、真摆进只读输入根都在派发前那一侧。`inpaint` 只是把「要摆什么」交过去
/// （[`InpaintPreparation`]），阶段上的 `decensor` 那一栏留给 `prepare_run` 补。
///
/// 指名了超分模型时交出去的是**两个阶段**：链上没有「输入是哪一份」这一栏，第 N 阶段的输入
/// 就是第 N-1 阶段那份被宿主逐件核验过、且已经 Ack 回去的产物（`worker/src/executor.rs` 的
/// `StageInput::Previous`，路径就是共享 staging 目录里的 `{stage_id}.png`）。
pub fn into_request(job: DecensorPageJob, source: SourceFile) -> SubmitRequest {
    let mut pipeline = vec![PipelineStage {
        stage_id: DECENSOR_STAGE_ID.to_string(),
        model_spec_id: job.model_spec_id,
        // 三件套授权由宿主在派发前补齐（`manager::prepare_run`）——与模型授权同一条
        // 规矩：调用方不许指名输入根里的文件。
        model: None,
        decensor: None,
        dlssnr: None,
        // 修补不改尺寸，这两栏对它没有意义：真实的最小边长是**图自己**要的 256×256，
        // 那是修补图的内在几何，不是每份模型自己声明的一句偏好。
        min_input_edge: None,
        output_scale: None,
        engine_policy: engine_policy(),
        // 也没有倍率：进多少像素出多少像素（`InpaintEngine::inpaint` 缩进 256、缩回原尺寸）。
        scale: None,
        tile: None,
        layers: None,
        settings_id: None,
    }];
    if let Some(upscale) = job.upscale {
        // 第二步与 [`super::reader`] 那一步**逐字同一份形状**：同样的阶段名、同样的两栏
        // （模型授权与最小边长由派发前补齐）、同样的输出口径。它是同一件事的第二次出现，
        // 差别只在它的输入：这里没有 `source`，输入来自上一步那份产物。
        pipeline.push(PipelineStage {
            stage_id: UPSCALE_STAGE_ID.to_string(),
            model_spec_id: upscale.model_spec_id,
            model: None,
            decensor: None,
            dlssnr: None,
            min_input_edge: None,
            output_scale: upscale.output_scale,
            engine_policy: engine_policy(),
            scale: Some(upscale.scale),
            tile: None,
            layers: None,
            settings_id: None,
        });
    }
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
            relative_path: None,
        },
        pipeline,
        inpaint: Some(InpaintPreparation {
            detector: job.bundle.detector,
            bar: job.bundle.bar,
            mosaic: job.bundle.mosaic,
        }),
        output_grant_id: DECENSOR_PAGE_GRANT_ID.to_string(),
        deadline_ms: job.deadline_ms,
        source: Some(source),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::decensor::bundle_in;
    use crate::inference::resolve_upscaler;
    use sha2::{Digest, Sha256};

    /// 临时数据根。名字带进程号：同一个 crate 的测试并行跑，几个用例互不相干。
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yomika-decensor-plan-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 一份装好的去码包，长得像 `installed_models_in` 要的样子：`models/<id>/` 下四份文件
    /// 齐活（它认的就是这个形状，不认清单）。
    ///
    /// `filling` 决定两份修补模型的字节：两个包要是字节相同，指纹就会相同，那正好把
    /// 「换了包是不是另一件任务」这条测试变成永远通过的假绿。两份模型之间也必须不同——
    /// 真实包里是两个不同的图，而且输入根按内容寻址，同一个哈希只会有一份文件。
    fn install_bundle(root: &Path, id: &str, filling: &[u8]) {
        let install = root.join("models").join(id);
        let mosaic = [filling, b"-mosaic".as_slice()].concat();
        for (relative, bytes) in [
            ("mrcnn/weights.onnx", b"detector".as_slice()),
            ("deepcreampy/bar.onnx", filling),
            ("deepcreampy/mosaic.onnx", mosaic.as_slice()),
            ("esrgan/4x-Fatal-Pixels.onnx", b"esrgan".as_slice()),
        ] {
            let path = install.join(relative);
            std::fs::create_dir_all(path.parent().expect("有父目录")).expect("建模型子目录");
            std::fs::write(&path, bytes).expect("写模型文件");
        }
        assert!(
            bundle_in(&install).is_some(),
            "夹具自己都不像一份完整的包，后面的断言就都在测空气"
        );
    }

    /// 一张编得出来的小 PNG。这里只用来当「缓存里存的是编码过的图」的一份真样本。
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .expect("编得出一张 PNG");
        bytes
    }

    /// 这一页按产品同一条写入口落进缓存（不是手搓 SQL）：索引行与磁盘上的位置都由它定。
    fn cache_page(root: &Path, bytes: &[u8]) -> crate::db::Database {
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");
        let identity = source_page_identity(&request("aletheia-lens"));
        crate::cache::write_cached_image(&database, root, &identity, "image/png", bytes)
            .expect("这一页写进缓存");
        database
    }

    fn request(model_id: &str) -> DecensorPageRequest {
        DecensorPageRequest {
            scope_id: "scope-a".to_string(),
            archive_id: "archive-a".to_string(),
            page_index: 11,
            model_id: model_id.to_string(),
            upscale_model_id: None,
            generation: 3,
            priority: Priority::Foreground,
            deadline_ms: 0,
        }
    }

    /// 指名了超分模型的请求：链上第二步（补完这一页接着放大）。
    fn chained(decensor_id: &str, upscale_id: &str) -> DecensorPageRequest {
        DecensorPageRequest {
            upscale_model_id: Some(upscale_id.to_string()),
            ..request(decensor_id)
        }
    }

    /// 造一份「装在盘上的超分模型」：`models/<id>/<version>/` 里一份清单 + 一份 ONNX。
    ///
    /// 与 `tests/compute_model_chain.rs` 里那份同一形状——也是产品下载/解压最后留下的形状。
    /// 字节是编的：这条测试问的是「这个 id 能不能被解析成 worker 里跑得动的模型」，
    /// 真模型的端到端那一遍在 `tests/compute_decensor_chain.rs`。
    fn install_upscaler(root: &Path, id: &str, version: &str, min_input_edge: u32) {
        let install = root.join("models").join(id).join(version);
        std::fs::create_dir_all(&install).expect("建模型安装目录");
        let bytes = format!("{id}-weights").into_bytes();
        std::fs::write(install.join("model.onnx"), &bytes).expect("写模型");
        let manifest = serde_json::json!({
            "id": id,
            "version": version,
            "format": "onnx",
            "scale": 2,
            "maxPixels": 64_000_000u64,
            "sha256": format!("{:x}", Sha256::digest(&bytes)),
            "supportedBackends": ["cpu"],
            "minInputEdge": min_input_edge,
        });
        std::fs::write(
            install.join("yomika-model.json"),
            serde_json::to_vec_pretty(&manifest).expect("清单能序列化"),
        )
        .expect("写清单");
    }

    /// 索引里查到的那一行，走产品里同样那一步转换（`From`）。
    fn located() -> SourceFile {
        SourceFile::from(crate::cache::CachedBlobLocation {
            path: PathBuf::from("C:/data/cache/images/ab/ab.bin"),
            content_hash: "c".repeat(64),
            byte_length: 4096,
        })
    }

    /// 这一页 + 这个包要算成哪件任务：身份必须与旧命令（`inference_decensor_page`）那条路
    /// **同源**。断言 `settings_id` 等于 `decensored_revision(包指纹)`，是在钉「身份只有一份
    /// 算法」：谁在这里另写一套修订号，这条测试当场红。
    #[test]
    fn a_page_and_a_bundle_become_the_identity_the_old_command_would_use() {
        let root = scratch("identity");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let fingerprint = resolve_installed_bundle(&root, "aletheia-lens")
            .expect("包装好了")
            .1
            .sha256;

        let job = plan_decensor_page(&root, &request("aletheia-lens"))
            .expect("包装好了，身份铸得出来");

        assert_eq!(job.input_id, "scope-a:archive-a:11");
        assert_eq!(
            job.settings_id,
            decensored_revision(&fingerprint),
            "任务身份与旧命令那条路必须是同一个串"
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
        assert_eq!(job.source_identity.rendition, DECENSOR_PAGE_RENDITION);
        assert!(
            job.source_identity.revision.is_none(),
            "原图那一版不挂修订号：它属于归档，不属于哪个模型"
        );
        assert_eq!(job.model_spec_id, "aletheia-lens");
        assert_eq!(job.generation, 3);
        assert_eq!(job.priority, Priority::Foreground);
        assert_eq!(job.deadline_ms, 0);
        assert_eq!(
            job.bundle.detector,
            root.join("models/aletheia-lens/mrcnn/weights.onnx"),
            "四份模型整装整卸：任务带的是这一套的四个位置"
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 同一个问题问两次要是同一个答案；换了包就必须是另一件任务。
    #[test]
    fn the_identity_is_stable_and_the_bundle_is_part_of_it() {
        let root = scratch("stable");
        install_bundle(&root, "aletheia-lens", b"first-filling");
        install_bundle(&root, "other-lens", b"second-filling");

        let first = plan_decensor_page(&root, &request("aletheia-lens"));
        let again = plan_decensor_page(&root, &request("aletheia-lens"));
        let other = plan_decensor_page(&root, &request("other-lens"));

        let first = first.expect("第一件");
        let again = again.expect("同一个问题");
        let other = other.expect("换一个包");
        assert_eq!(first, again, "同一页 + 同一份设置 = 同一件任务");
        assert_ne!(
            first.settings_id, other.settings_id,
            "换了去码包就是另一件任务：否则新包会吃到旧包的产物"
        );
        assert_eq!(first.bundle.bar, root.join("models/aletheia-lens/deepcreampy/bar.onnx"));
        assert_eq!(
            other.bundle.bar,
            root.join("models/other-lens/deepcreampy/bar.onnx")
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 一个框都要补的活，凭什么在**宿主**这一层就没有「没有要补的框」这条答案？
    ///
    /// 因为「要补哪些框」不再是宿主知道的事（docs/94）：检测搬进了 worker，一页干干净净
    /// 也是**一件真的派发出去的任务**——worker 算完发现 0 个框，原样把这一页交回来。宿主
    /// 若能提前宣布「不用补」，那宣布的只能是猜。
    #[test]
    fn a_clean_page_is_still_a_job_because_the_host_no_longer_looks_at_the_pixels() {
        let root = scratch("clean-page");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");

        let job = plan_decensor_page(&root, &request("aletheia-lens"))
            .expect("干净的一页也是一件任务：宿主不再有资格替它说「不用补」");

        assert_eq!(job.model_spec_id, "aletheia-lens");

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 没装的包要说「没装」而且要指名是哪一个：悄悄换另一个包补这一页，是最糟的答案。
    #[test]
    fn a_bundle_that_is_not_installed_says_so_and_names_it() {
        let root = scratch("missing");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");

        let error = plan_decensor_page(&root, &request("nope-lens"))
            .expect_err("没装的包铸不出身份");

        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(error.message.contains("nope-lens"), "{}", error.message);
        assert!(!error.retryable);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    #[test]
    fn a_negative_page_index_is_refused() {
        let root = scratch("negative");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let mut request = request("aletheia-lens");
        request.page_index = -1;

        let error = plan_decensor_page(&root, &request)
            .expect_err("负页码就该拒");

        assert_eq!(error.code, "COMPUTE_BAD_REQUEST");

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 阶段长什么样：一条去码阶段、没有模型授权（派发前补）、没有倍率、没有最小边长，
    /// 三份模型走 `inpaint` 那只手（检测器在里面——它现在也要摆进输入根）。
    #[test]
    fn the_request_asks_for_one_decensor_stage_and_carries_what_to_stage() {
        let root = scratch("request");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let job = plan_decensor_page(&root, &request("aletheia-lens")).expect("身份");

        let submitted = into_request(job, located());

        assert_eq!(submitted.pipeline.len(), 1, "去码是一步");
        let stage = &submitted.pipeline[0];
        assert_eq!(stage.stage_id, DECENSOR_STAGE_ID);
        assert_eq!(stage.model_spec_id, "aletheia-lens");
        assert!(stage.model.is_none(), "模型授权由派发前那一侧补");
        assert!(stage.decensor.is_none(), "三件套授权也由派发前那一侧补");
        assert!(stage.scale.is_none(), "修补没有倍率");
        assert!(stage.output_scale.is_none());
        assert!(stage.min_input_edge.is_none());
        assert_eq!(stage.engine_policy, engine_policy());
        assert_eq!(submitted.output_grant_id, DECENSOR_PAGE_GRANT_ID);
        assert_eq!(
            submitted.input.content_hash,
            "c".repeat(64),
            "输入里那份哈希是索引说的那一份，真核在派发前"
        );
        assert!(submitted.input.relative_path.is_none());
        assert_eq!(submitted.source.as_ref().map(|s| s.byte_length), Some(4096));
        let preparation = submitted.inpaint.expect("要摆什么必须交过去");
        assert_eq!(
            preparation.detector,
            root.join("models/aletheia-lens/mrcnn/weights.onnx")
        );
        assert_eq!(
            preparation.bar,
            root.join("models/aletheia-lens/deepcreampy/bar.onnx")
        );
        assert_eq!(
            preparation.mosaic,
            root.join("models/aletheia-lens/deepcreampy/mosaic.onnx")
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 摆盘：三份都进内容寻址的输入根，名字是各自哈希，读回来还是同一份东西。
    ///
    /// 这一条用的是小文件：它要钉的是**摆盘这条路径**，不是模型本身。真模型端到端那一遍在
    /// `tests/compute_decensor_chain.rs`（真进程、真 `bar.onnx`）。
    #[test]
    fn staging_puts_all_three_files_in_the_input_root_by_their_hash() {
        let root = scratch("staging");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let inputs_root = root.join("inputs");
        std::fs::create_dir_all(&inputs_root).expect("建输入根");
        let preparation = InpaintPreparation {
            detector: root.join("models/aletheia-lens/mrcnn/weights.onnx"),
            bar: root.join("models/aletheia-lens/deepcreampy/bar.onnx"),
            mosaic: root.join("models/aletheia-lens/deepcreampy/mosaic.onnx"),
        };

        let grant = stage_inpaint(&inputs_root, &preparation).expect("三份都摆得下");

        for file in [&grant.detector, &grant.bar, &grant.mosaic] {
            let path = inputs_root.join(&file.relative_path);
            let bytes = std::fs::read(&path).expect("摆好的文件读得回来");
            assert_eq!(bytes.len() as u64, file.byte_length);
            assert_eq!(
                blake3::hash(&bytes).to_hex().to_string(),
                file.content_hash,
                "授权里的哈希必须与摆进去的字节对得上"
            );
        }
        assert_ne!(
            grant.bar.relative_path, grant.mosaic.relative_path,
            "两份模型是两份不同的图：内容寻址下它们必须落在两个位置"
        );
        assert_ne!(grant.detector.relative_path, grant.bar.relative_path);
        assert_ne!(
            grant.bar.content_hash, grant.mosaic.content_hash,
            "同一个哈希只会有一份文件——两份模型共用一个哈希就是把它们当成同一个了"
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 缺一份模型的授权不许悄悄降级：`stage_inpaint` 的输入是「三份都在」，
    /// 而这条测试钉住的是**读不出来就报错**——一个不存在的路径不许变成一份空授权。
    #[test]
    fn a_model_that_cannot_be_read_refuses_the_whole_grant() {
        let root = scratch("unreadable");
        let inputs_root = root.join("inputs");
        std::fs::create_dir_all(&inputs_root).expect("建输入根");
        // 检测器摆得下，横条模型不存在：拒的理由必须指名**缺的那一份**，不是先摆好的那份。
        let detector = root.join("models/nowhere/mrcnn/weights.onnx");
        std::fs::create_dir_all(detector.parent().expect("有父目录")).expect("建子目录");
        std::fs::write(&detector, b"staged-fine").expect("写检测器");
        let preparation = InpaintPreparation {
            detector,
            bar: root.join("models/nowhere/deepcreampy/bar.onnx"),
            mosaic: root.join("models/nowhere/deepcreampy/mosaic.onnx"),
        };

        let error = stage_inpaint(&inputs_root, &preparation).expect_err("读不出来就该拒");

        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(error.message.contains("bar.onnx"), "{}", error.message);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 这一页还没落进缓存：**可重试的输入问题**，不是请求说错了。
    ///
    /// 与阅读器那条门对同一件事说同一句话（`COMPUTE_INPUT_INVALID` + retryable）：用户回到
    /// 阅读器等这一页缓存好再翻，那时它就在了。报成「请求不合法」会把一个会自愈的状态说成
    /// 用户的错。
    #[test]
    fn a_page_that_is_not_in_the_cache_is_an_input_problem() {
        let root = scratch("prepare-not-cached");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let database = crate::db::Database::open_path(":memory:").expect("开内存库");

        let error = prepare_decensor_page(&database, &root, &request("aletheia-lens"))
            .expect_err("这一页还没有进缓存");

        assert_eq!(error.code, "COMPUTE_INPUT_INVALID");
        assert!(error.retryable, "等这一页缓存好再试，是可重试的");
        assert!(
            error.message.contains("还没有落在缓存里"),
            "{}",
            error.message
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 没装包要在**查这一页的位置之前**就说：白翻一次缓存是小事，白派一件任务不是。
    #[test]
    fn a_bundle_that_is_not_installed_is_named_before_the_page_is_looked_up() {
        let root = scratch("prepare-missing-bundle");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let database = cache_page(&root, &png_bytes(8, 8));

        let error = prepare_decensor_page(&database, &root, &request("nope-lens"))
            .expect_err("没装的包");

        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(error.message.contains("nope-lens"), "{}", error.message);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 缓存里在、盘上不在：这一页的位置是索引说的，而「它到底在不在」由派发前那一侧当场核。
    ///
    /// 这一条钉的是**分工**：宿主这层只查索引（不读盘、不算哈希），真读字节在 worker 的输入
    /// 根里发生。所以索引行还在时，这一层照样铸得出任务——它不是校验层，校验只有一份。
    #[test]
    fn the_host_believes_the_index_and_leaves_the_bytes_to_the_input_root() {
        let root = scratch("prepare-index-only");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let database = cache_page(&root, &png_bytes(8, 8));
        let identity = source_page_identity(&request("aletheia-lens"));
        let located = crate::cache::cached_blob_location(&database, &root, &identity)
            .expect("查得动")
            .expect("索引里有这一页");
        std::fs::remove_file(&located.path).expect("把盘上那一份搬走");

        let (job, source) = prepare_decensor_page(&database, &root, &request("aletheia-lens"))
            .expect("索引说在，宿主就照索引铸身份");

        assert_eq!(job.model_spec_id, "aletheia-lens");
        assert_eq!(
            source.content_hash, located.content_hash,
            "交给派发那一侧的哈希是索引说的那一份，不是这里现算的"
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 指名了超分模型时：**一件任务里两个阶段**，而且任务身份是最后交出去的那一版。
    ///
    /// 这是链式这一步的核心断言。两件事必须同时成立：① 两阶段在同一件任务里——链的第二
    /// 阶段吃的是第一阶段那份产物，而 compute 的产物只有内容寻址的落点、没有缓存行，
    /// 出了这件任务没人能按身份把它找回来；② `settings_id` 与超分那道门
    /// （`compute::reader::plan_reader_page`）算出**逐字相同**的串——否则同一页、同一份
    /// 设置会被当成两件任务各算一遍，缓存也永远命中不了。
    #[test]
    fn naming_an_upscaler_makes_it_one_job_with_two_stages() {
        let root = scratch("chain-two-stages");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        install_upscaler(&root, "realcugan-2x", "1", 256);
        let fingerprint = resolve_installed_bundle(&root, "aletheia-lens")
            .expect("包装好了")
            .1
            .sha256;
        let resolved = resolve_upscaler(&root, "realcugan-2x").expect("超分模型装好了");

        let job = plan_decensor_page(&root, &chained("aletheia-lens", "realcugan-2x"))
            .expect("两阶段铸得出身份");

        let upscale = job.upscale.as_ref().expect("要接着放大");
        assert_eq!(upscale.model_spec_id, "realcugan-2x");
        assert_eq!(upscale.scale, 2, "倍数来自那份模型自己的清单");
        assert_eq!(upscale.output_scale, Some(ENHANCED_OUTPUT_SCALE));
        assert_eq!(
            upscale.settings_id,
            enhanced_revision(&Some(resolved), Some(&decensored_revision(&fingerprint))),
            "第二个阶段的修订号必须与超分那道门算出同一个串"
        );
        assert_eq!(
            job.settings_id, upscale.settings_id,
            "任务身份说的是最后交出去的那一版：end 是 enhanced，不是 decensored"
        );

        let submitted = into_request(job, located());
        assert_eq!(submitted.pipeline.len(), 2, "去码 → 超分");
        assert_eq!(submitted.pipeline[0].stage_id, DECENSOR_STAGE_ID);
        let second = &submitted.pipeline[1];
        assert_eq!(second.stage_id, UPSCALE_STAGE_ID);
        assert_eq!(second.model_spec_id, "realcugan-2x");
        assert_eq!(second.scale, Some(2));
        assert_eq!(second.output_scale, Some(ENHANCED_OUTPUT_SCALE));
        assert!(
            second.model.is_none() && second.decensor.is_none(),
            "第二步的模型授权与最小边长同样由派发前那一侧补"
        );
        assert!(second.min_input_edge.is_none());
        assert_eq!(
            submitted
                .inpaint
                .expect("第一步的三件套仍在同一份请求里")
                .bar,
            root.join("models/aletheia-lens/deepcreampy/bar.onnx")
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 8-g①：一件链式任务产出**两版**，两版都得能被按修订号找回来。
    ///
    /// 断言的是「计划铸的身份」与「旧命令那套身份算法」**逐字相同**：去码那一版走
    /// `inference::decensored_revision(包指纹)`，放大那一版走
    /// `enhanced_revision(超分, Some(去码修订号))`。算法分家就等于换了缓存键，DLSSNR / 旧超分 /
    /// 远端代理那边会永远以为「这一版还没算」。
    #[test]
    fn a_chained_job_produces_both_renditions_the_old_command_would_look_up() {
        let root = scratch("chain-renditions");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        install_upscaler(&root, "realcugan-2x", "1", 256);
        let fingerprint = resolve_installed_bundle(&root, "aletheia-lens")
            .expect("包装好了")
            .1
            .sha256;
        let resolved = resolve_upscaler(&root, "realcugan-2x").expect("超分模型装好了");

        let job = plan_decensor_page(&root, &chained("aletheia-lens", "realcugan-2x"))
            .expect("链上两阶段铸得出身份");
        let renditions = crate::compute::renditions::decensor_renditions(&job);

        assert_eq!(renditions.len(), 2, "一件任务两版");
        assert_eq!(renditions[0].stage_id, DECENSOR_STAGE_ID);
        assert_eq!(renditions[0].identity.rendition, "decensored");
        assert_eq!(
            renditions[0].identity.revision.as_deref(),
            Some(decensored_revision(&fingerprint).as_str()),
            "去码那一版必须与旧命令算出同一行"
        );
        assert_eq!(renditions[1].stage_id, UPSCALE_STAGE_ID);
        assert_eq!(renditions[1].identity.rendition, "enhanced");
        assert_eq!(
            renditions[1].identity.revision.as_deref(),
            Some(
                enhanced_revision(&Some(resolved), Some(&decensored_revision(&fingerprint)))
                    .as_str()
            ),
            "放大那一版的起点正是这一次算出来的去码修订号"
        );
        assert_eq!(
            renditions[1].identity.revision,
            job.upscale.as_ref().map(|stage| stage.settings_id.clone()),
            "任务身份说的就是最后交出去的那一版"
        );
        // 两版都挂在**同一页**上：挂错页就是把别人的图登记成这一页。
        for one in &renditions {
            assert_eq!(one.identity.scope_id, job.source_identity.scope_id);
            assert_eq!(one.identity.archive_id, job.source_identity.archive_id);
            assert_eq!(one.identity.page_index, job.source_identity.page_index);
        }

        // 只去码时只有一版，那一版就是任务身份。
        let solo = plan_decensor_page(&root, &request("aletheia-lens")).expect("只去码也铸得出身份");
        let solo_renditions = crate::compute::renditions::decensor_renditions(&solo);
        assert_eq!(solo_renditions.len(), 1, "没接超分就只有去码那一版");
        assert_eq!(
            solo_renditions[0].identity.revision,
            Some(solo.settings_id.clone())
        );

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 只写空白与压根不写是同一件事：都没指名超分模型，就是只去码。
    #[test]
    fn a_blank_upscale_model_id_is_the_same_as_naming_nothing() {
        let root = scratch("blank-upscale");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");
        let fingerprint = resolve_installed_bundle(&root, "aletheia-lens")
            .expect("包装好了")
            .1
            .sha256;
        let mut request = request("aletheia-lens");
        request.upscale_model_id = Some("   ".to_string());

        let job = plan_decensor_page(&root, &request).expect("只写空白不是错误");

        assert!(job.upscale.is_none(), "空白超分模型 = 只去码");
        assert_eq!(job.settings_id, decensored_revision(&fingerprint));
        assert_eq!(into_request(job, located()).pipeline.len(), 1);

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 超分模型只活在宿主里（Anime4K 是编进宿主的 shader 链，worker 的构建里没有它）：
    /// **整件任务当场拒绝**。
    ///
    /// 为什么不悄悄退成「只去码」：那会让用户在设置里选了 Anime4K、拿到的却是一张没放大的
    /// 图，而且没有任何一处报错——比拒了更难查。退一步是**前端**在失败路径上做的决定
    /// （它能把已经算好的那一版先显示出来），不是后端替它猜。
    #[test]
    fn an_upscaler_that_only_lives_in_the_host_refuses_the_whole_job() {
        let root = scratch("host-only-upscale");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");

        let error = plan_decensor_page(&root, &chained("aletheia-lens", "anime4k-hq"))
            .expect_err("shader 链进不了 worker");

        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(error.message.contains("anime4k-hq"), "{}", error.message);
        assert!(!error.retryable, "这不是「等一会儿再试」能好的");

        std::fs::remove_dir_all(root).expect("收摊");
    }

    /// 指名了、但这台机器上没装：也要当场拒绝，理由里必须有那个名字。
    #[test]
    fn an_upscaler_that_is_not_installed_is_refused_too() {
        let root = scratch("missing-upscale");
        install_bundle(&root, "aletheia-lens", b"bar-and-mosaic");

        let error = plan_decensor_page(&root, &chained("aletheia-lens", "realcugan-2x"))
            .expect_err("没装就是没装");

        assert_eq!(error.code, MODEL_UNAVAILABLE_CODE);
        assert!(error.message.contains("realcugan-2x"), "{}", error.message);
        assert!(!error.retryable);

        std::fs::remove_dir_all(root).expect("收摊");
    }
}
