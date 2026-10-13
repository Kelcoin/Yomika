//! Yomika 计算 worker 的协议 crate。
//!
//! 两个硬约束（docs/71 §5.1）：**不依赖 ORT/NGX/tauri**，只依赖 serde；宿主与
//! worker 引用**同一份**类型，所以「两边类型一致」是编译期事实，不是约定。
//!
//! - [`frame`]：`u32` 小端长度 + JSON 正文的读写与边界。
//! - [`messages`]：消息类型、版本、范围校验与 epoch 过滤。

pub mod frame;
pub mod messages;

pub use frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES};
pub use messages::{
    encode, parse, validate_message, ANIME4K_ENGINE_ID, ArtifactReady, ArtifactRef, Budgets,
    BuildInfo, DecensorGrant, DlssnrGrant, DLSSNR_ENGINE_ID, EngineFallback, EnginePolicy,
    EngineReport, EpochOnly, Failed, GrantedFile, Hello, HelloAck, JobRef, Message, PipelineStage,
    Precision, Priority, ProtocolError, Run, RunInput, StageProgress, StageStarted,
    PASSTHROUGH_ENGINE_ID, PROTOCOL_MAJOR, SCRATCH_DIR_NAME, WORKER_RUNTIME_LABEL,
    WorkspacesReleased,
};
