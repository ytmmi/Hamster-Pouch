//! tag 与文件关联领域模型（RFC 0001 / database-schema.md 第 4.4 节）。

use std::fmt;

use uuid::Uuid;

use crate::file::FileId;
use crate::repo::RepoId;

/// tag 稳定 ID（UUID v4 文本）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TagId(String);

impl TagId {
    /// 生成新的 tag ID。
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// 从已有文本构造（用于从仓库库读回）。
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TagId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// tag 来源：用户手动或 AI 打标（D6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    /// 用户手动添加。
    User,
    /// AI 打标结果。
    Ai,
}

impl TagSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TagSource::User => "user",
            TagSource::Ai => "ai",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(TagSource::User),
            "ai" => Some(TagSource::Ai),
            _ => None,
        }
    }
}

impl fmt::Display for TagSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 仓库内 tag（跨仓库隔离）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub id: TagId,
    pub repo_id: RepoId,
    pub name: String,
    pub color: Option<String>,
}

/// 文件与 tag 的关联（含 AI 来源标记，D6）。
#[derive(Debug, Clone, PartialEq)]
pub struct FileTag {
    pub file_id: FileId,
    pub tag_id: TagId,
    pub source: TagSource,
    /// AI 结果的置信度；用户手动添加为 `None`。
    pub confidence: Option<f64>,
    /// AI 来源模型；用户手动添加为 `None`。
    pub source_model: Option<String>,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_source_roundtrip() {
        for v in [TagSource::User, TagSource::Ai] {
            assert_eq!(TagSource::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TagSource::from_str("unknown"), None);
    }

    #[test]
    fn tag_id_generate_is_unique() {
        assert_ne!(TagId::generate(), TagId::generate());
    }
}
