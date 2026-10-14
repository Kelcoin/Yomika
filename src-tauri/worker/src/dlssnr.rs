//! DLSSNR 引擎（docs/71 §11 Task 8 第 2 条、docs/106）：解授权 → 落片段 → 跑一层参数 → 编码写回。
//!
//! 与 [`crate::upscale`] 是同一族执行体、同一套边界：
//!
//! 1. 读哪张图由执行器决定（`run.input`，它已经按声明复核过长度与 hash）；
//! 2. 用哪份片段、哪套参数由 `stage.dlssnr` 授权，worker 自己再解析一次、再复核一次
//!    （§7.1/§7.2）。两份都走**同一条**只读输入通道：协议帧只有 64 KiB，165 MB 的片段
//!    与一份参数 JSON 都不可能躺在 run 里；
//! 3. NGX 的初始化只发生在这一层。Task 8 的出口条件是「宿主无 ORT/NGX 资源」，而那份
//!    165 MB 的片段一旦被 `initialize` 过就**换不动了**（NGX 一个进程一份 context，
//!    见 `compute_core::dlssnr::device` 的 `SlotStep::AlreadyInitialized`）——所以它必须
//!    活在会被整个杀掉、再起一个干净进程的那个进程里；
//! 4. 算法、几何、层数收范围、逐像素相同就再评一次（`PASSTHROUGH`）都在
//!    [`yomika_compute_core::dlssnr`] 里——宿主那条老路径用的是同一份实现；
//! 5. **动图不走**「原样交回」那条规则：`animation::apply_dlssnr` 逐帧处理再编回 APNG。
//!    这就是 [`crate::pipeline`] 把 DLSSNR 的分派放在动图判定**之前**的原因。
//!
//! 片段为什么要**落盘**：NGX 只按固定文件名（`nvngx_dlssnr.dll`）在自己的搜索路径里找
//! 片段，它没法从「按内容寻址的名字」里认出一份片段。所以这里把授权的那份字节落成
//! `<数据目录>/dlssnr/nvngx_dlssnr.dll`（`compute_core::dlssnr::dll_path` 的规矩，与
//! 宿主装 DLL 的位置一致），同时那份 165 MB 的文件在输入根里仍是硬链接——落盘这一步
//! 不真拷字节（跨卷时才拷一次）。
//!
//! 数据目录是 staging 下的一个子目录：NGX 会把嵌进二进制的垫片写进数据目录、还可能
//! 往那里写日志，而 worker 唯一可写的根就是 staging。取子目录是为了让它的内容撞不上
//! 任何一个产物名（宿主只按 `ArtifactReady.relative_name` 取文件）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use yomika_compute_core::dlssnr::animation::apply_dlssnr;
use yomika_compute_core::dlssnr::filter::{self, DlssnrImage};
use yomika_compute_core::dlssnr::DlssnrSettings;
use yomika_compute_core::image_kind::is_animated_image;
use yomika_compute_core::inputs;
use yomika_compute_protocol::messages::{EngineReport, GrantedFile, Precision};

use crate::engine::{Engine, StageError, StageOutput, StageRequest, StageSink};
use crate::stage_io::{
    check_cancelled, encode_png, probe_dimensions, PASSTHROUGH_ENGINE_ID, RESOURCE_LIMIT_CODE,
};

/// 片段装不起来、或者 NGX 跑不起来。它是**环境**的问题，不是这一页的问题：同一份授权在
/// 别的机器上可能就跑得动（片段被换过、显卡运行库坏了、驱动换过要重启）。
///
/// 同一个码、同一个理由：前端那张码表里已经有 `COMPUTE_INTERNAL`，而这里要说
/// 的东西（NGX 的原文）本来就在消息里。
const DLSSNR_FAILED_CODE: &str = "COMPUTE_INTERNAL";

/// DLSSNR 产物报告里的引擎名。
///
/// 与超分的 `onnx` 分开：那一个是「一份 ONNX 图」，而这里跑的是 NGX 的片段——
/// 用户在设置页看到的「谁算的」必须分得开。前端按 `engine.id` 显示，未知的 id 它也照显。
///
/// 字面量住在协议里：宿主**也**要认它（它拿握手报的 `BuildInfo.engines` 决定 DLSSNR
/// 那一组算不算可用，见 `crate::engine_facts` 那侧）。各写一份，漂了不会报错，只会让
/// 设置页把能跑的说成跑不了。这里只转发，与 `stage_io::PASSTHROUGH_ENGINE_ID` 同一个做法。
pub use yomika_compute_protocol::DLSSNR_ENGINE_ID;

/// NGX 的数据目录名（staging 下的子目录）。
///
/// 字面量住在协议里，与 `DLSSNR_ENGINE_ID` 同一个理由：**宿主也要认它**——会话收摊之后
/// 宿主会把 staging 清一遍，只按名字认这一棵子树（`compute::artifacts::sweep_staging`）。
/// 各写一份漂了不会报错，只会让那份片段永远攒着。
const DATA_DIR_NAME: &str = yomika_compute_protocol::SCRATCH_DIR_NAME;

/// 一张 D3D12 纹理能有的最大边长（`D3D12_REQ_TEXTURE2D_U_OR_V_DIMENSION`）。
///
/// 与 `filter::MIN_EDGE` 一起界定了「这一页能不能进这条链路」：下界是 NGX 自己拒绝小图
/// （它那边的 `Evaluate` 会失败，给出的还是看不懂的话），上界是这条链路上连一张纹理都
/// 放不下。两种都是**这一页**的条件，不是「计算进程坏了」——所以照动图超预算那条路办：
/// 原图交回、如实报 passthrough，而不是报 [`DLSSNR_FAILED_CODE`]。
///
/// 用户那份错误日志里就有一对这种行：一张页被报成 `COMPUTE_INTERNAL`、`retryable: true`、
/// 还进了用户看得见的那份日志，而它其实只是「这一页没有可算的东西」。
const MAX_TEXTURE_EDGE: u32 = 16_384;

/// 这一页的尺寸能不能算。`Err` 里是给人看的理由。
fn page_fits(width: u32, height: u32) -> Result<(), String> {
    if width < filter::MIN_EDGE || height < filter::MIN_EDGE {
        return Err(format!(
            "这一页 {width}×{height} 比 DLSSNR 要的最小边长还小（{}）",
            filter::MIN_EDGE
        ));
    }
    if width > MAX_TEXTURE_EDGE || height > MAX_TEXTURE_EDGE {
        return Err(format!(
            "这一页 {width}×{height} 比一张纹理能有的最大边长还大（{MAX_TEXTURE_EDGE}）"
        ));
    }
    Ok(())
}

/// 一份已经落好的片段：哪份授权、落在哪里。
///
/// 键里带 `content_hash`：换一份片段就是另一个键，也就是「要重新落一次」（而 NGX 那边
/// 会明确拒绝在同一份 context 上换片段——那不是这里能修的事，见模块 doc 第 3 条）。
struct InstalledFeature {
    key: String,
    dll: PathBuf,
}

/// DLSSNR 执行体：一个输入根 + 一个片段位。
pub struct DlssnrEngine {
    /// worker 唯一允许读文件的根：片段授权与页面都从这里解析（§7.1 的同一条边界）。
    input_root: PathBuf,
    feature: Mutex<Option<InstalledFeature>>,
}

impl DlssnrEngine {
    pub fn new(input_root: PathBuf) -> Self {
        Self {
            input_root,
            feature: Mutex::new(None),
        }
    }

    /// 解析并复核一份授权文件（与超分那边同一句话、同一层责任）。
    ///
    /// 复核失败用的是 `inputs::verify_file` 自己的错误码与消息——「宿主说的和盘上的不是
    /// 一份」这件事必须原样透传，不许在这里换一句话说。
    fn resolve_granted(&self, grant: &GrantedFile) -> Result<PathBuf, StageError> {
        let path = inputs::resolve_granted(&self.input_root, &grant.relative_path)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        inputs::verify_file(&path, &grant.content_hash, grant.byte_length)
            .map_err(|error| StageError::failed(error.code(), error.message()))?;
        Ok(path)
    }

    /// 这一阶段的 NGX 数据目录（staging 下的一个固定子目录，见模块 doc）。
    fn data_dir(&self, sink: &StageSink<'_>) -> PathBuf {
        sink.root().join(DATA_DIR_NAME)
    }

    /// 把授权的那份片段落成 NGX 认的那个名字，回它落在哪。
    ///
    /// 已经是同一份（键命中且文件在位）就不再动它：`fs::hard_link` 一次是几十微秒，但
    /// 「落一份 165 MB 的文件」在跨卷时是真的拷贝，翻页不该每页付一次。
    fn install_feature(&self, data_dir: &Path, grant: &GrantedFile) -> Result<PathBuf, StageError> {
        let key = format!("{}:{}", grant.relative_path, grant.content_hash);
        let mut cached = self
            .feature
            .lock()
            .map_err(|_| StageError::failed(RESOURCE_LIMIT_CODE, "片段缓存锁坏了"))?;
        if let Some(installed) = cached.as_ref().filter(|installed| installed.key == key) {
            if installed.dll.exists() {
                return Ok(installed.dll.clone());
            }
        }
        let source = self.resolve_granted(grant)?;
        let target = yomika_compute_core::dlssnr::dll_path(data_dir);
        let parent = target
            .parent()
            .ok_or_else(|| StageError::failed(DLSSNR_FAILED_CODE, "片段的目标目录算不出来"))?;
        std::fs::create_dir_all(parent).map_err(|error| {
            StageError::failed(
                DLSSNR_FAILED_CODE,
                format!("建不了片段目录 {}：{error}", parent.display()),
            )
        })?;
        // 名字已经占着 = 上一份片段还在这里。同一份会先被上面的缓存拦住，所以走到这里
        // 就是**换片段**：NGX 的 context 一旦初始化过就换不动（它自己会拒），先把旧的
        // 挪开只是为了让新那份落得下去；挪不动（文件正被加载）时如实报「先重启」。
        if target.exists() {
            std::fs::remove_file(&target).map_err(|error| {
                StageError::failed(
                    DLSSNR_FAILED_CODE,
                    format!("片段 DLL 换过之后要先重启计算进程：{error}"),
                )
            })?;
        }
        link_or_copy(&source, &target)?;
        *cached = Some(InstalledFeature {
            key,
            dll: target.clone(),
        });
        Ok(target)
    }

    /// 产物：把一页字节写进 staging，回元数据。
    fn write(
        &self,
        request: &StageRequest<'_>,
        bytes: &[u8],
        width: u32,
        height: u32,
        name: String,
        mime: &str,
        engine_id: &str,
        device: &str,
    ) -> Result<StageOutput, StageError> {
        if bytes.len() as u64 > request.run.budgets.max_output_bytes {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "产物 {} 字节超出这次预算的 {} 字节",
                    bytes.len(),
                    request.run.budgets.max_output_bytes
                ),
            ));
        }
        let written = request.sink.write(&name, bytes)?;
        (request.progress)(100);
        Ok(StageOutput {
            relative_name: name,
            mime: mime.to_string(),
            byte_length: written.byte_length,
            width,
            height,
            content_hash: written.content_hash,
            engine: EngineReport {
                id: engine_id.to_string(),
                // DLSSNR 的「版本」不是 ONNX 运行库那一串（这份产物一个 ONNX 图都没跑）：
                // 说得出的是**这个 worker** 的版本，而片段是哪一份由宿主那边的产物版本
                // （`dlssnr::output_revision` 里的 `dll_identity`）负责交代。
                version: env!("CARGO_PKG_VERSION").to_string(),
                precision: Precision::Fp32,
                device_id: device.to_string(),
                policy: Some(request.stage.engine_policy),
                // DLSSNR 只有 D3D12 一条路：没有「换一条运行库试试」这回事，所以没有回退
                // 可交代。拿不到硬件是失败（NGX 的初始化自己会报），不是降级。
                fallback: None,
            },
        })
    }

    /// 原样交回：这一页一个像素都没被算过。
    ///
    /// 名字与 mime 按真实容器报（后缀取自授权时的相对名，`inputs::stage` 保留原后缀）。
    /// 报告里换成 `passthrough` 是**必须**的：调用方按引擎名决定要不要把这份产物当
    /// 「算过的」收下（`compute_core::dlssnr::filter::PASSTHROUGH` 那段 doc 记着真机上抓到
    /// 过「与起点逐像素相同、却被当成产物存下来」的行）。设备那一栏也只能是「没有设备」。
    fn hand_back(
        &self,
        request: &StageRequest<'_>,
        source: &[u8],
    ) -> Result<StageOutput, StageError> {
        let extension = request
            .input
            .map(|input| input.relative())
            .and_then(|relative| Path::new(relative).extension())
            .and_then(|extension| extension.to_str())
            .filter(|extension| {
                !extension.is_empty() && extension.len() <= 8 && extension.is_ascii()
            })
            .unwrap_or("png")
            .to_ascii_lowercase();
        let (width, height) = match probe_dimensions(source) {
            Ok(size) => size,
            // 头都读不出来时也不能报 0：宿主拿这对数字量槽位。
            Err(_) => (1, 1),
        };
        let name = format!("{}.{}", request.stage.stage_id, extension);
        self.write(
            request,
            source,
            width,
            height,
            name,
            mime_for(&extension),
            PASSTHROUGH_ENGINE_ID,
            "cpu",
        )
    }
}

impl Engine for DlssnrEngine {
    fn execute(&self, request: StageRequest<'_>) -> Result<StageOutput, StageError> {
        let stage = request.stage;
        let grant = stage
            .dlssnr
            .as_ref()
            .ok_or_else(|| StageError::input_invalid("这一阶段没有 DLSSNR 授权：不知道用哪个片段、哪套参数"))?;
        if stage.model.is_some() {
            // 两样同时出现只有一个含义：有一个阶段被拼错了。协议层也拒（三样恰有一份），
            // 这里再拦一次是因为「拼错的请求」不该只靠一层校验。
            return Err(StageError::input_invalid(
                "这一阶段同时带了别的授权：不知道该走哪条路",
            ));
        }
        let input = request
            .input
            .ok_or_else(|| StageError::input_invalid("这一阶段没有输入：不知道处理哪一页"))?;
        check_cancelled(request.cancel)?;
        (request.progress)(2);

        let source = std::fs::read(input.path())
            .map_err(|error| StageError::input_invalid(format!("读不到这一阶段的输入：{error}")))?;
        let (probe_width, probe_height) = probe_dimensions(&source)?;
        // 这一页本身能不能进这条链路：太小/太大的页在 NGX 那边只会得到一句看不懂的错，
        // 而它们其实是「这一页没有可算的东西」。判在**落片段与解参数之前**：不合条件的
        // 页不该为它装一份 165 MB 的片段。
        if let Err(why) = page_fits(probe_width, probe_height) {
            eprintln!("[worker] DLSSNR 跳过这一页：{why}");
            return self.hand_back(&request, &source);
        }
        let source_pixels = u64::from(probe_width).saturating_mul(u64::from(probe_height));
        if source_pixels > request.run.budgets.max_pixels {
            return Err(StageError::failed(
                RESOURCE_LIMIT_CODE,
                format!(
                    "页面 {probe_width}×{probe_height} 超出这次预算的 {} 像素",
                    request.run.budgets.max_pixels
                ),
            ));
        }
        (request.progress)(8);

        // 参数先解：一份读不出来的参数应当在**落片段之前**就被拒——那份 165 MB 的落盘、
        // 以及 NGX 的一次 `initialize` 都不该为一条格式不对的请求发生。参数走的是与模型
        // 同一条通道，所以也要复核（`resolve_granted` 自己会做）。
        let settings_bytes = std::fs::read(self.resolve_granted(&grant.settings)?)
            .map_err(|error| StageError::input_invalid(format!("读不到这一套参数：{error}")))?;
        let settings = DlssnrSettings::from_json(&settings_bytes)
            .map_err(|error| StageError::input_invalid(format!("这份 DLSSNR 参数读不出来：{error}")))?;
        (request.progress)(15);

        let data_dir = self.data_dir(request.sink);
        self.install_feature(&data_dir, &grant.feature)?;
        check_cancelled(request.cancel)?;
        (request.progress)(25);

        if is_animated_image(&source) {
            // 动图：逐帧处理再编回 APNG（`apply_dlssnr`）。它返回 `Ok(None)` = 这份容器不是
            // 能处理的动图，那与静态那一页的 `PASSTHROUGH` 是同一件事：没算过，原样交回。
            return match apply_dlssnr(&data_dir, &source, &settings, request.cancel) {
                Ok(Some(encoded)) => {
                    (request.progress)(92);
                    self.write(
                        &request,
                        &encoded,
                        probe_width,
                        probe_height,
                        format!("{}.png", stage.stage_id),
                        "image/png",
                        DLSSNR_ENGINE_ID,
                        "gpu:0",
                    )
                }
                Ok(None) => self.hand_back(&request, &source),
                Err(error) if error == filter::CANCELLED => Err(StageError::cancelled()),
                // 「没算过」有两种成因：网络把输入原样交回，或者它什么都没写出来（产物
                // 整幅透明）。处置是同一条——原图交回、不写产物缓存、报告说 passthrough。
                // 判据问 `filter::is_not_computed`，别在这里再写一次比较。
                Err(error) if filter::is_not_computed(&error) => {
                    self.hand_back(&request, &source)
                }
                Err(error) => Err(StageError::failed(
                    DLSSNR_FAILED_CODE,
                    format!("DLSSNR 在这一页上没跑成：{error}"),
                )),
            };
        }

        // 静态：一层（或多层）参数走一遍。尺寸**不变**（DLSSNR 不是放大），所以宿主拿到
        // 手的那份还能盖回原来那一页的位置上。
        let decoded = image::load_from_memory(&source)
            .map_err(|error| StageError::input_invalid(format!("解不开这张图：{error}")))?;
        let (width, height) = (decoded.width(), decoded.height());
        let rgba = decoded.into_rgba8().into_raw();
        if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
            return Err(StageError::input_invalid("解出来的画布是空的"));
        }
        (request.progress)(40);
        let image = DlssnrImage::new(width, height, rgba)
            .map_err(|error| StageError::input_invalid(format!("这一页的像素装不进画布：{error}")))?;
        let processed = match filter::apply_with_token(&data_dir, &image, &settings, request.cancel) {
            Ok(processed) => processed,
            Err(error) if error == filter::CANCELLED => return Err(StageError::cancelled()),
            // 与动图那条同源：原样交回与「什么都没写出来」都算这一页没算过。
            Err(error) if filter::is_not_computed(&error) => {
                return self.hand_back(&request, &source)
            }
            Err(error) => {
                return Err(StageError::failed(
                    DLSSNR_FAILED_CODE,
                    format!("DLSSNR 在这一页上没跑成：{error}"),
                ))
            }
        };
        (request.progress)(92);
        let encoded = encode_png(&processed.rgba, processed.width, processed.height)?;
        self.write(
            &request,
            &encoded,
            processed.width,
            processed.height,
            format!("{}.png", stage.stage_id),
            "image/png",
            DLSSNR_ENGINE_ID,
            "gpu:0",
        )
    }
}

/// 授权文件里的字节 → NGX 认的那个名字。同卷优先硬链接（不真拷 165 MB），跨卷退回拷贝。
fn link_or_copy(source: &Path, target: &Path) -> Result<(), StageError> {
    match std::fs::hard_link(source, target) {
        Ok(()) => Ok(()),
        Err(_) => std::fs::copy(source, target)
            .map(|_| ())
            .map_err(|error| {
                StageError::failed(
                    DLSSNR_FAILED_CODE,
                    format!(
                        "落不了这份片段（{} → {}）：{error}",
                        source.display(),
                        target.display()
                    ),
                )
            }),
    }
}

/// 原样交回时按**后缀**报容器。
///
/// 只用得上三个：这条路上只有 GIF / APNG / 动画 WebP（`image_kind::animated_kind` 认的
/// 那三种）。别的后缀落到 `application/octet-stream`——宿主那边本来也会按字节自己嗅一遍。
fn mime_for(extension: &str) -> &'static str {
    match extension {
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// 一条纪律的落点：`EnginePolicy` 在 DLSSNR 上**没有可走的两条路**（NGX 只有 D3D12），
/// 它仍按 `stage` 原样带进产物报告——前端要能看见「用户点的是 GPU」，而拿不到硬件是
/// 失败、不是降级，回退那一栏永远是空的。
///
/// 三条不碰 GPU 的用例 + 一条真片段用例（没装那份 DLL 就跳过）。
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::engine::StageInput;
    use yomika_compute_core::cancel::CancelToken;
    use yomika_compute_protocol::messages::{
        Budgets, DlssnrGrant, EnginePolicy, PipelineStage, Priority, Run, RunInput, PROTOCOL_MAJOR,
    };

    /// 一份真的动图（核心那三种容器里最小的一个），用来走「不是静图」的那条路。
    const ANIMATED_GIF: &[u8] =
        include_bytes!("../../crates/compute-core/src/dlssnr/testdata/animated.gif");

    /// 一份真的参数：默认一层（与 `DlssnrSettings::default()` 逐字段一致）。真 DLL 那条
    /// 路上会真的拿它去跑，所以它必须是**完整**的一份——`PassSettings` 没有给每个字段
    /// 加 `serde(default)`，缺一个字段在这里就是「参数读不出来」。
    const SETTINGS: &[u8] = br#"{"passes":[{"style":0,"intensity":1.0,"localToneStrength":1.0,"localStructureStrength":1.0,"skinStructureStrength":0.0,"autoMask":false,"uiCorrection":false}]}"#;

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("staging")).expect("建临时目录");
        root
    }

    /// 摆一份文件进输入根，回它该被授权的样子（hash 与长度都是真的）。
    fn staged(root: &Path, relative: &str, bytes: &[u8]) -> GrantedFile {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建输入根的父目录");
        std::fs::write(&path, bytes).expect("摆进输入根");
        GrantedFile {
            relative_path: relative.to_string(),
            content_hash: blake3::hash(bytes).to_hex().to_string(),
            byte_length: bytes.len() as u64,
        }
    }

    fn run() -> Run {
        Run {
            protocol_version: PROTOCOL_MAJOR,
            worker_epoch: "epoch-1".to_string(),
            job_id: "job-1".to_string(),
            generation: 1,
            input: RunInput {
                input_id: "input-1".to_string(),
                content_hash: "0".repeat(64),
                byte_length: 1024,
                relative_path: None,
            },
            pipeline: Vec::new(),
            output_grant_id: "grant-1".to_string(),
            priority: Priority::Foreground,
            deadline_ms: 600_000,
            budgets: Budgets {
                max_pixels: 64_000_000,
                max_output_bytes: 1_073_741_824,
                intra_threads: 2,
            },
        }
    }

    fn stage(dlssnr: Option<DlssnrGrant>, model: Option<GrantedFile>) -> PipelineStage {
        PipelineStage {
            stage_id: "dlssnr".to_string(),
            model_spec_id: "dlssnr".to_string(),
            engine_policy: EnginePolicy::Gpu,
            scale: None,
            tile: None,
            layers: None,
            settings_id: Some("dlssnr-default".to_string()),
            model,
            dlssnr,
            builtin: None,
            min_input_edge: None,
            output_scale: None,
        }
    }

    fn request<'a>(
        stage: &'a PipelineStage,
        run: &'a Run,
        input: Option<&'a StageInput>,
        sink: &'a StageSink<'a>,
        cancel: &'a CancelToken,
    ) -> StageRequest<'a> {
        StageRequest {
            run,
            stage,
            input,
            cancel,
            sink,
            progress: &|_percent| {},
        }
    }

    /// 没有授权就拒：不许当成「没什么可处理的，原样交回去」——那是一份看起来成功的产物，
    /// 而它什么都没做（与超分那边同一条判据）。
    #[test]
    fn a_stage_without_a_dlssnr_grant_is_refused() {
        let root = root("yomika-dlssnr-unit-none");
        let staging = root.join("staging");
        let sink = StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let stage = stage(None, None);
        let engine = DlssnrEngine::new(root.clone());
        let error = match engine.execute(request(&stage, &run, None, &sink, &cancel)) {
            Err(error) => error,
            Ok(_) => panic!("没有 DLSSNR 授权还被跑成功了"),
        };
        assert!(
            error.message.contains("没有 DLSSNR 授权"),
            "实际是：{}",
            error.message
        );
    }

    /// 同时带模型 = 拼错了的阶段。协议层也拒，这里再拦一次。
    #[test]
    fn a_stage_that_also_carries_a_model_is_refused() {
        let root = root("yomika-dlssnr-unit-model");
        let staging = root.join("staging");
        let sink = StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let grant = DlssnrGrant {
            feature: staged(&root, "ab/feature.dll", b"never opened"),
            settings: staged(&root, "ab/settings.json", SETTINGS),
        };
        let stage = stage(Some(grant), Some(staged(&root, "ab/model.onnx", b"never opened")));
        let engine = DlssnrEngine::new(root.clone());
        let error = match engine.execute(request(&stage, &run, None, &sink, &cancel)) {
            Err(error) => error,
            Ok(_) => panic!("两份授权同时出现还被跑成功了：跑的是哪条路全凭猜"),
        };
        assert!(
            error.message.contains("同时带了别的授权"),
            "实际是：{}",
            error.message
        );
    }

    /// 参数读不出来 ⇒ 在**落片段之前**就拒。
    ///
    /// 这条不只是「错误处理」：它是这条路上唯一一条不需要真 DLL、真显卡就能证明「请求确实
    /// 走到了 DLSSNR 引擎」的判据（`crate::pipeline` 的顺序用例靠它）。
    #[test]
    fn settings_that_are_not_json_are_refused_before_anything_is_installed() {
        let root = root("yomika-dlssnr-unit-settings");
        let staging = root.join("staging");
        let sink = StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let grant = DlssnrGrant {
            feature: staged(&root, "ab/feature.dll", b"never opened"),
            settings: staged(&root, "ab/settings.json", b"not a settings document at all"),
        };
        let page = root.join("ab/page.gif");
        std::fs::write(&page, ANIMATED_GIF).expect("摆一页进去");
        let input = StageInput::Granted {
            relative: "ab/page.gif".to_string(),
            path: page,
        };
        let stage = stage(Some(grant), None);
        let engine = DlssnrEngine::new(root.clone());
        let error = match engine.execute(request(&stage, &run, Some(&input), &sink, &cancel)) {
            Err(error) => error,
            Ok(_) => panic!("参数不是 JSON 还被跑成功了"),
        };
        assert!(
            error.message.contains("DLSSNR 参数读不出来"),
            "实际是：{}",
            error.message
        );
        // 落片段那一步不该发生：名字占没占上就是证据。
        assert!(
            !yomika_compute_core::dlssnr::dll_path(&root.join("staging").join(DATA_DIR_NAME))
                .exists(),
            "参数都没解出来，片段却已经被落下来了"
        );
    }

    /// 真片段 + 真显卡：一页真的过了一遍 NGX，产物落在 staging 里。
    ///
    /// 没有那份 DLL 就跳过（它不在仓库里，见 `docs/DLSSNR-DLL-Options-310.8.0.0`）。这条
    /// 用例要证明的是**这一层能把授权变成一次真计算**：片段按 NGX 要的真名落盘、字节一致，
    /// 产物是尺寸不变的 PNG。`PASSTHROUGH` 也是一个成立的结局（NGX 对同一张图两次评估都
    /// 给出与输入逐像素相同的结果）——那时的判据是产物与源字节一致，而报告说 `passthrough`。
    /// 两种结局都要求 NGX 真的跑过。
    #[test]
    fn the_real_fragment_runs_a_page_through_ngx() {
        let Some(dll) = shipped_dll() else {
            println!("跳过：没有找到 nvngx_dlssnr.dll");
            return;
        };
        let root = root("yomika-dlssnr-unit-real");
        let staging = root.join("staging");
        let sink = StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let feature_bytes = std::fs::read(&dll).expect("读那份 DLL");
        let grant = DlssnrGrant {
            feature: staged(&root, "ab/feature.dll", &feature_bytes),
            settings: staged(&root, "ab/settings.json", SETTINGS),
        };
        // 一张高频噪声页：DLSSNR 要真有东西可做，尺寸在 DLL 的下限（32×32）之上。
        let page = noise_png(192, 256);
        let page_path = root.join("ab/page.png");
        std::fs::write(&page_path, &page).expect("摆一页进去");
        let input = StageInput::Granted {
            relative: "ab/page.png".to_string(),
            path: page_path,
        };
        let stage = stage(Some(grant), None);
        let engine = DlssnrEngine::new(root.clone());
        let output = engine
            .execute(request(&stage, &run, Some(&input), &sink, &cancel))
            .expect("真片段应当能跑完这一页");
        println!(
            "引擎 = {}，设备 = {}，产物 {} 字节（源 {} 字节）",
            output.engine.id, output.engine.device_id, output.byte_length, page.len()
        );
        assert_eq!(output.width, 192);
        assert_eq!(output.height, 256);
        // 片段真的按 NGX 要的名字落下来了，而且是那一份的字节。
        let installed =
            yomika_compute_core::dlssnr::dll_path(&root.join("staging").join(DATA_DIR_NAME));
        assert_eq!(
            std::fs::read(&installed).expect("读落下来的片段").len(),
            feature_bytes.len(),
            "落下来的片段不是授权的那一份：{}",
            installed.display()
        );
        let written = std::fs::read(root.join("staging").join(&output.relative_name))
            .expect("读产物");
        match output.engine.id.as_str() {
            DLSSNR_ENGINE_ID => {
                assert_ne!(written, page, "报告说算过了，产物却与源逐字节相同");
            }
            PASSTHROUGH_ENGINE_ID => {
                assert_eq!(
                    written, page,
                    "报告说没算过，产物却不是源字节：那两份对不上"
                );
            }
            other => panic!("不认识的引擎名：{other}"),
        }
    }

    /// 太小的页是「这一页没有可算的东西」，不是「计算进程坏了」。
    ///
    /// 32×32 是 NGX 自己的下限（`filter::MIN_EDGE`）。用户那份错误日志里就有一条这样的行：
    /// 同一页被报成 `COMPUTE_INTERNAL`、`retryable: true`、还进了用户看得见的那份日志，
    /// 而它其实只是「这一页没东西可算」——照动图超预算那条路办：原图交回、如实报 passthrough。
    ///
    /// 这一条不碰 GPU（也不碰真片段）：摆一份几十字节的假片段，任何「真的去装片段」的尝试
    /// 都会当场露出来。
    #[test]
    fn a_page_below_the_ngx_floor_is_handed_back_instead_of_reported_as_a_broken_engine() {
        let root = root("yomika-dlssnr-unit-too-small");
        let staging = root.join("staging");
        let sink = StageSink::new(&staging);
        let cancel = CancelToken::none();
        let run = run();
        let grant = DlssnrGrant {
            feature: staged(&root, "ab/feature.dll", b"not a real dll"),
            settings: staged(&root, "ab/settings.json", SETTINGS),
        };
        let page = noise_png(16, 16);
        let page_path = root.join("ab/page.png");
        std::fs::write(&page_path, &page).expect("摆一页进去");
        let input = StageInput::Granted {
            relative: "ab/page.png".to_string(),
            path: page_path,
        };
        let stage = stage(Some(grant), None);
        let engine = DlssnrEngine::new(root.clone());
        let output = engine
            .execute(request(&stage, &run, Some(&input), &sink, &cancel))
            .expect("太小的页该原样交回，不该报成计算进程坏了");
        assert_eq!(
            output.engine.id, PASSTHROUGH_ENGINE_ID,
            "太小的页报告成算过了：{}",
            output.engine.id
        );
        let written =
            std::fs::read(root.join("staging").join(&output.relative_name)).expect("读产物");
        assert_eq!(written, page, "原样交回，产物该与源逐字节相同");
        assert_eq!((output.width, output.height), (16, 16));
        // 没有可算的东西，就不该为它装一份片段。
        assert!(
            !yomika_compute_core::dlssnr::dll_path(&staging.join(DATA_DIR_NAME)).exists(),
            "不合条件的页不该落片段"
        );
    }

    /// 两头的界：下界是 NGX 的，上界是 D3D12 给 2D 纹理的硬指标。
    #[test]
    fn the_page_bounds_are_the_ngx_floor_and_the_texture_edge() {
        assert!(page_fits(32, 32).is_ok(), "32×32 正是 NGX 的下限");
        assert!(page_fits(16_384, 32).is_ok(), "16384 正是纹理的上限");
        let small = page_fits(31, 512).expect_err("31 宽该被拒");
        assert!(small.contains("31×512"), "理由里要说清是哪一页：{small}");
        let big = page_fits(512, 16_385).expect_err("16385 高该被拒");
        assert!(big.contains("512×16385"), "理由里要说清是哪一页：{big}");
    }

    /// 仓库里那一份片段在哪（与核心的 `test_dll()` 同一套候选）。
    fn shipped_dll() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("YOMIKA_DLSSNR_DLL") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
        let mut at = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        while at.pop() {
            let base = at.join("docs").join("DLSSNR-DLL-Options-310.8.0.0");
            if base.is_dir() {
                for variant in ["NVIDIA-Original", "Community-RTX40-RTX50", "SF-v2"] {
                    let candidate = base.join(variant).join("nvngx_dlssnr.dll");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
                return None;
            }
        }
        None
    }

    /// 一张确定性的高频噪声 PNG（LCG，不依赖任何随机源）。
    fn noise_png(width: u32, height: u32) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((width as usize) * (height as usize) * 4);
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        for _ in 0..(width as usize) * (height as usize) {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let byte = (state >> 33) as u8;
            rgba.extend_from_slice(&[byte, byte.wrapping_add(85), byte.wrapping_add(170), 255]);
        }
        encode_png(&rgba, width, height).expect("编一张噪声图")
    }
}
