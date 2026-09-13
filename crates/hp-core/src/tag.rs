//! tag 与文件关联领域模型（RFC 0001 / database-schema.md 第 4.4 节 / D21）。
//!
//! 决策 D21：tag **实体共用** `tags` 表；人工 tag 与自动 tag 的**关联**使用互相独立的表：
//! - 人工关联：`file_tags`
//! - 自动关联：`file_auto_tags`
//!
//! 两组同名 tag 可共存，互不影响；人工组在上、自动组在下分开展示。

use std::fmt;

use uuid::Uuid;

use crate::file::FileId;
use crate::repo::RepoId;

/// tag 稳定 ID（UUID v4 文本）。人工 tag 与自动 tag 复用该 ID 类型。
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
///
/// 存储层已拆分为独立表（D21）；本枚举用于 AI 撤销记录等跨组接口。
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

/// tag 实体（仓库内，跨仓库隔离）：`tags` 表一一对应。
///
/// 人工 tag 与自动 tag 共用该实体表（D21）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub id: TagId,
    pub repo_id: RepoId,
    pub name: String,
    pub color: Option<String>,
}

/// 文件与人工 tag 的关联：`file_tags` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTag {
    pub file_id: FileId,
    pub tag_id: TagId,
    pub created_at: String,
}

/// 文件与自动 tag 的关联：`file_auto_tags` 表一一对应（与人工关联表独立，D21）。
#[derive(Debug, Clone, PartialEq)]
pub struct FileAutoTag {
    pub file_id: FileId,
    pub tag_id: TagId,
    /// AI 结果置信度。
    pub confidence: Option<f64>,
    /// AI 来源模型。
    pub source_model: Option<String>,
    pub created_at: String,
}

/// tag 关系类型（D22：层级 / 关联，关系图谱数据源）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagRelationKind {
    /// 层级：`from` 是 `to` 的上级（`from` 包含 `to`）。
    Hierarchy,
    /// 一般关联。
    Related,
}

impl TagRelationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TagRelationKind::Hierarchy => "hierarchy",
            TagRelationKind::Related => "related",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "hierarchy" => Some(TagRelationKind::Hierarchy),
            "related" => Some(TagRelationKind::Related),
            _ => None,
        }
    }
}

impl fmt::Display for TagRelationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// tag 关系：`tag_relations` 表一一对应（D22）。
///
/// tag 之间为多对多关系，支持多父级（DAG）；例如「游戏截图」可同时是
/// 「截图」与「游戏」的下级。层级与关联用 [`TagRelationKind`] 区分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRelation {
    pub id: String,
    pub repo_id: RepoId,
    /// 关系起点（层级语义下为上级）。
    pub from_tag_id: TagId,
    /// 关系终点（层级语义下为下级）。
    pub to_tag_id: TagId,
    pub relation_kind: TagRelationKind,
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

    #[test]
    fn tag_relation_kind_roundtrip() {
        for v in [TagRelationKind::Hierarchy, TagRelationKind::Related] {
            assert_eq!(TagRelationKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(TagRelationKind::from_str("unknown"), None);
    }
}
