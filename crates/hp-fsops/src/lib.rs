//! hp-fsops：源间复制/剪切/移动等真实文件操作（RFC 0001 / commands-events.md §3.6）。
//!
//! 所有硬盘变更必须生成操作记录；内容哈希一致时仓库内 tag、评分、相册成员关系不丢失。

mod copy;
mod move_ops;
mod service;
mod util;

pub use service::{FsOpsService, TransferOutcome};
