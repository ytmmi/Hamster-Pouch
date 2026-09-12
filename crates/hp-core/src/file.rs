//! 文件索引领域模型（RFC 0001 / database-schema.md 第 4.3 节）。

use std::fmt;

use uuid::Uuid;

use crate::source::{MediaType, SourceId};

/// 文件稳定 ID（UUID v4 文本）。
///
/// 文件身份由内容哈希决定（RFC 0001），本 ID 仅作为仓库内索引行的稳定主键。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FileId(String);

impl FileId {
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for FileId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 文件校验状态（RFC 0001 失效与校对）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyStatus {
    /// 内容哈希与索引一致。
    Ok,
    /// size/mtime 或内容哈希已变化，需重建元数据与缩略图。
    Changed,
    /// 文件无法定位。
    Missing,
    /// 文件存在但无法读取。
    Unreadable,
    /// 音频占位行（D11）：无哈希/缩略图。
    Placeholder,
}

impl VerifyStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            VerifyStatus::Ok => "ok",
            VerifyStatus::Changed => "changed",
            VerifyStatus::Missing => "missing",
            VerifyStatus::Unreadable => "unreadable",
            VerifyStatus::Placeholder => "placeholder",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "ok" => Some(VerifyStatus::Ok),
            "changed" => Some(VerifyStatus::Changed),
            "missing" => Some(VerifyStatus::Missing),
            "unreadable" => Some(VerifyStatus::Unreadable),
            "placeholder" => Some(VerifyStatus::Placeholder),
            _ => None,
        }
    }
}

impl fmt::Display for VerifyStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 缩略图生成状态（D16）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbStatus {
    /// 0：未生成。
    NotGenerated,
    /// 1：已生成。
    Generated,
    /// -1：生成失败。
    Failed,
}

impl ThumbStatus {
    pub fn as_i64(&self) -> i64 {
        match self {
            ThumbStatus::NotGenerated => 0,
            ThumbStatus::Generated => 1,
            ThumbStatus::Failed => -1,
        }
    }

    pub fn from_i64(v: i64) -> Option<Self> {
        match v {
            0 => Some(ThumbStatus::NotGenerated),
            1 => Some(ThumbStatus::Generated),
            -1 => Some(ThumbStatus::Failed),
            _ => None,
        }
    }
}

/// 文件索引行：与 `files` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileIndexRow {
    pub id: FileId,
    pub source_id: SourceId,
    pub relative_path: String,
    pub media_type: MediaType,
    pub content_hash: Option<String>,
    pub content_hash_algo: Option<String>,
    pub content_hash_algo_version: Option<i64>,
    pub perceptual_hash: Option<String>,
    pub perceptual_hash_algo: Option<String>,
    pub perceptual_hash_algo_version: Option<i64>,
    pub size: i64,
    pub mtime: String,
    pub scan_time: String,
    pub verify_status: VerifyStatus,
    pub thumb_status: ThumbStatus,
    pub missing_status: i64,
    /// 视频全量媒体信息缓存（D15），JSON 文本。
    pub media_info_json: Option<String>,
}
