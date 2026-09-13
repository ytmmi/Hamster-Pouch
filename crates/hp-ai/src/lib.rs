//! hp-ai：AI 打标提供方抽象、任务队列与结果回写边界（D6 / D17）。
//!
//! 第一期仅图片；结果直接写入仓库 tag，但必须标记来源、置信度与生成时间；
//! 高置信覆盖用户 tag 时生成撤销记录。

mod provider;
mod service;
mod task;
mod writeback;

pub use provider::AiTaggingProvider;
pub use service::{AiRunOutcome, AiTaggingService};
pub use task::{AiTask, AiTaskQueue, AiTaskStatus};
pub use writeback::{writeback, WritebackOutcome};
