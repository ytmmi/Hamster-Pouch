//! AI 打标提供方抽象（D6 / D17）。
//!
//! 宿主不内置具体厂商 SDK；提供方以 trait 注入，第一期仅处理图片。

use std::path::Path;

use hp_core::{AiTaggingInput, AiTaggingOutput, HpResult};

/// AI 打标提供方：给定图像访问句柄，返回候选 tag、置信度、来源模型与生成时间。
pub trait AiTaggingProvider: Send + Sync {
    /// 提供方名称（如 `local-http`）。
    fn name(&self) -> &str;

    /// 来源模型标识（写入 tag 关联的 `source_model`）。
    fn model(&self) -> &str;

    /// 对单张图片打标。`image_path` 为宿主解析出的本地绝对路径。
    fn tag_image(&self, input: &AiTaggingInput, image_path: &Path) -> HpResult<AiTaggingOutput>;
}
