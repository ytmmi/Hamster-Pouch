//! AI 打标领域模型（D6 / D17 / database-schema.md 第 3.6 节）。
//!
//! 第一期 AI 打标仅图片（D17）；结果直接写入仓库 tag，但必须标记来源、
//! 置信度与生成时间；高置信覆盖用户已有 tag 时必须保留撤销记录（D6）。

use std::fmt;

use uuid::Uuid;

use crate::file::FileId;
use crate::repo::RepoId;
use crate::source::MediaType;
use crate::tag::{TagId, TagSource};

/// AI 提供方配置 ID（UUID v4 文本）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AiProviderConfigId(String);

impl AiProviderConfigId {
    /// 生成新的提供方配置 ID。
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// 从已有文本构造（用于从全局库读回）。
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AiProviderConfigId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// AI 提供方配置：与全局库 `ai_provider_config` 表一一对应。
///
/// 只保存非敏感配置引用，不保存密钥明文（RFC 0003）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiProviderConfig {
    pub id: AiProviderConfigId,
    pub provider: String,
    pub model: Option<String>,
    /// 引用凭据句柄/端点等非敏感配置，JSON 文本。
    pub config_json: String,
    pub created_at: String,
}

/// AI 打标候选 tag：名称 + 置信度。
#[derive(Debug, Clone, PartialEq)]
pub struct AiTagCandidate {
    pub name: String,
    pub confidence: f64,
}

/// AI 打标任务输入（D6：文件 ID、图像访问句柄、模型/提供方配置、任务选项）。
///
/// 第一期仅图片（D17）。
#[derive(Debug, Clone, PartialEq)]
pub struct AiTaggingInput {
    pub file_id: FileId,
    pub provider_config_id: AiProviderConfigId,
    /// 任务选项 JSON。
    pub options_json: String,
}

impl AiTaggingInput {
    /// 第一期支持的媒体类型（仅图片，D17）。
    pub const SUPPORTED_MEDIA_TYPE: MediaType = MediaType::Image;
}

/// AI 打标任务输出（D6：候选 tag、置信度、来源模型、生成时间）。
#[derive(Debug, Clone, PartialEq)]
pub struct AiTaggingOutput {
    pub tags: Vec<AiTagCandidate>,
    pub source_model: String,
    pub generated_at: String,
}

/// AI 高置信覆盖用户 tag 的撤销记录（D6：必须保留撤销记录）。
#[derive(Debug, Clone, PartialEq)]
pub struct AiTagUndo {
    pub id: String,
    pub repo_id: RepoId,
    pub file_id: FileId,
    pub tag_id: TagId,
    /// 覆盖前该 tag 的来源。
    pub prev_source: TagSource,
    /// 覆盖前该 tag 的置信度。
    pub prev_confidence: Option<f64>,
    /// 覆盖前该 tag 的来源模型。
    pub prev_source_model: Option<String>,
    pub created_at: String,
}

/// 默认的高置信覆盖阈值（D6：高置信结果可覆盖用户已有 tag）。
pub const DEFAULT_OVERWRITE_THRESHOLD: f64 = 0.9;

/// 置信度是否达到覆盖用户 tag 的阈值（含端点）。
pub fn should_overwrite_user_tag(confidence: f64, threshold: f64) -> bool {
    confidence >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_config_id_generate_is_unique() {
        assert_ne!(AiProviderConfigId::generate(), AiProviderConfigId::generate());
    }

    #[test]
    fn provider_config_id_displayable() {
        let id = AiProviderConfigId::from_raw("cfg-1");
        assert_eq!(id.to_string(), "cfg-1");
        assert_eq!(id.as_str(), "cfg-1");
    }

    #[test]
    fn supported_media_type_is_image_only() {
        assert_eq!(AiTaggingInput::SUPPORTED_MEDIA_TYPE, MediaType::Image);
    }

    #[test]
    fn overwrite_threshold_boundary() {
        assert!(should_overwrite_user_tag(0.9, DEFAULT_OVERWRITE_THRESHOLD));
        assert!(should_overwrite_user_tag(0.95, DEFAULT_OVERWRITE_THRESHOLD));
        assert!(!should_overwrite_user_tag(0.89, DEFAULT_OVERWRITE_THRESHOLD));
        assert!(!should_overwrite_user_tag(0.0, DEFAULT_OVERWRITE_THRESHOLD));
    }

    #[test]
    fn undo_records_previous_state() {
        let undo = AiTagUndo {
            id: "u-1".into(),
            repo_id: RepoId::from_raw("repo-1"),
            file_id: FileId::from_raw("file-1"),
            tag_id: TagId::from_raw("tag-1"),
            prev_source: TagSource::User,
            prev_confidence: None,
            prev_source_model: None,
            created_at: "2026-01-01T00:00:00Z".into(),
        };
        assert_eq!(undo.prev_source, TagSource::User);
        assert!(undo.prev_confidence.is_none());
    }
}
