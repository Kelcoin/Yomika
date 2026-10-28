//! Yomika 的计算核心：**只**做算法与引擎选择，不认识 Tauri、数据库、凭据。
//!
//! docs/71 §5.1 给这个 crate 的职责是：把「已经准备好的输入 + 已验证的模型规格 +
//! 设置 + 取消令牌」变成产物，并且能独立 `cargo test`。它不知道是谁调用的、也不
//! 能反过来问宿主问题——这条边界就是「重算可以搬出 UI 进程」的前提。
//!
//! 目前还在搬（Task 2）：`packages` 里的算法按 docs/71 §11 的 Task 2 分步迁移，
//! 每步都保持宿主可构建，最后才删宿主的兼容调用。
//!
//! 已搬完： [`cancel`]（取消牌，纯逻辑，宿主只留一层错误映射）、[`engine`]
//! （引擎选择，输入是平台层采到的事实，输出是「这次用哪条运行库 + 为什么」）、
//! [`error`]（计算的错误词汇）、[`cpu_scale`]（最近邻兜底）、[`upscale`]（分块
//! 放大管道：规划、裁剪、回贴、预算、取消点，执行器由调用方实现 trait 提供）、
//! [`tensor`]（RGBA ↔ NCHW 与边缘复制，所有运行库共用同一份换算）、
//! [`inputs`]（宿主授权输入的路径安全与内容复核，跨进程来的字符串一律不可信）、
//! [`runtime`]（运行库策略：这份构建能开哪几条、开会话的线程/内存规矩）、
//! [`onnx`]（ONNX 超分执行体 + 实测探针——**同一个模型只开一次会话**）、
//! [`probe`]（实测结论的记账：同一个问题只真跑一次，键是内容指纹而不是路径）、
//! [`fit`]（把模型输出缩到「交出去」的尺寸：宿主与 worker 共用这一份）、
//! [`image_kind`]（这是哪一类容器、动不动、
//! 画布多大——只看头几个字节。宿主与 worker 共用这一份判定，否则同一张图会在一边是动图、
//! 在另一边成了静态首帧）、[`anime4k`]（Anime4K 的内置 shader 链：解析器把钉住的 GLSL 解成
//! 一条 pass 链，CPU 解释器是任何目标都能跑的参照执行体，GPU 那条路门在 feature 后面
//! ——宿主与 worker 解的是同一份 GLSL，才不会一边是 Anime4K 一边是别的）。
//!
//! 8-g④ 起又搬来一件：[`dlssnr`]（NGX + D3D12 的滤镜引擎与它的设置/探针）。`docs/71`
//! Task 8 的出口要求宿主不再持有 NGX 资源，而 NGX 只能在计算进程里初始化、worker 又不许
//! 依赖 Tauri（§5.2）——所以引擎住在这里，宿主只留一层壳（命令 + DLL 的下载策略）。
//!
//! 这个模块**只在目标上**门着（Windows），不在 feature 上门：它里面并排住着两半——纯
//! 元数据（设置长什么样、装的是哪一份 DLL、这一页的产物身份、探针结论还算不算数）和
//! 引擎（NGX 垫片、D3D12 设备、滤镜、工作区、动图逐帧）。宿主摘掉 `dlssnr` feature 之后
//! 仍然要回答前面那一半，所以元数据那一半**必须不门 feature**（细节见 `dlssnr/mod.rs`
//! 的抬头）；门错一层，宿主就只能整份依赖一起留着，那就是 8-g④-b 要解决的事。

// Anime4K 的内置 shader 链。解析器与 CPU 解释器不门 feature：没有显卡的机器、Android
// 目标、以及探针的参照实现都要用它，而且它是 GPU 那条路的比对基准——「GPU 算得对不对」
// 只有拿它当答案才问得出来。
pub mod anime4k;
pub mod cancel;
pub mod cpu_scale;
// DLSSNR：引擎那一半门在 `dlssnr` feature 后面（没有垫片就没有那条路），元数据那一半
// 不门——宿主只摘 feature、不摘答案。
#[cfg(windows)]
pub mod dlssnr;
pub mod engine;
pub mod error;
pub mod fit;
pub mod image_kind;
pub mod inputs;
// 只有真的要把一次计算跑起来时才需要 ORT；没有这个 feature 时核心的其余部分照样
// 编译（宿主默认构建与 Android 目标走的就是那条路，docs/71 §5.2）。
#[cfg(feature = "ort")]
pub mod onnx;
// 记账不依赖 ORT：容量与键的策略要能独立测。
pub mod probe;
pub mod runtime;
pub mod resources;
pub mod tensor;
pub mod upscale;
pub mod ncnn;

#[cfg(all(target_os = "android", feature = "ncnn-vulkan"))]
pub mod mobile_npu;
