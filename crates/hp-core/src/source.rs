//! 媒体源领域模型（RFC 0003 / database-schema.md 第 4.2 节）。

use std::fmt;

use uuid::Uuid;

use crate::repo::RepoId;

/// 媒体源稳定 ID（UUID v4 文本）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceId(String);

impl SourceId {
    /// 生成新的媒体源 ID。
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

impl fmt::Display for SourceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 文件媒体类型。`files` 表仅存 `image`/`video`/`audio`（D11）。
///
/// `multimedia` 是相册属性概念（M3），不属于文件媒体类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Image,
    Video,
    Audio,
}

impl MediaType {
    /// 存储层字符串表示。
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaType::Image => "image",
            MediaType::Video => "video",
            MediaType::Audio => "audio",
        }
    }

    /// 从存储层字符串解析；未知值返回 `None`。
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "image" => Some(MediaType::Image),
            "video" => Some(MediaType::Video),
            "audio" => Some(MediaType::Audio),
            _ => None,
        }
    }
}

impl fmt::Display for MediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 媒体源：仓库挂载的真实本地文件夹，可嵌套（RFC 0003）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub id: SourceId,
    pub repo_id: RepoId,
    pub local_path: String,
    pub alias: Option<String>,
    pub parent_source_id: Option<SourceId>,
    pub mounted: bool,
    pub mounted_at: String,
}
