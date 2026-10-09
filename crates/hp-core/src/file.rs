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

/// 文件的**标记**（原「子类型」，2026-10-09 更名；2026-10-10 / D102 变更为**可多值**）。
///
/// **性质（用户口径）**："text 为类目，md、txt、epub 为子类，**book 为标记**，
/// 标记可以交叉，例子：漫画.zip 文件的类目为压缩包，可以标记为 manga（漫画）。"
///
/// 因此标记是**与类目正交、可交叉**的一维：
/// - 与**类目**正交——类目由 `media_type` 给出（内容判定），标记是用户的选择；
/// - **可多值**——一个文件可以同时带多个标记（一本 epub 可以既是 `book` 又是 `manga`），
///   因此存储上是 `file_marks` **一对多表**，不是一个列。
///
/// 取值是**可注册清单**的 id（`book` / `manga` …，见 `blueprint_types::BUILTIN_MARKS`）；
/// 扫描只在"一个标记都没有"时补默认值（`epub` → `book`），**绝不覆盖**用户已有标记
/// （与调色板 `locked` 同口径：用户的判定权不被重扫打回）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMark(String);

impl FileMark {
    /// 从存储层字符串构造（调用方负责校验取值域 / 命名规则）。
    pub fn from_raw(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    /// 存储层字符串表示。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 是否为 **book 标记**（`epub` 的默认标记；蓝图里 `mark = book` 的匹配依据）。
    pub fn is_book(&self) -> bool {
        self.0 == crate::blueprint_types::BOOK_MARK
    }
}

/// 扫描期的**默认标记**：`epub` → `book`，其余文本 → **无标记**。
///
/// 唯一来源就是这里（与 `hp-scanner` 的扩展名表放在一起调用），避免两处口径漂移。
pub fn default_book_mark_for_ext(ext: &str) -> Option<FileMark> {
    if ext.eq_ignore_ascii_case("epub") {
        Some(FileMark::from_raw(crate::blueprint_types::BOOK_MARK))
    } else {
        None
    }
}

impl fmt::Display for FileMark {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 文件索引行：与 `files` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileIndexRow {
    pub id: FileId,
    pub source_id: SourceId,
    pub relative_path: String,
    pub media_type: MediaType,
    /// 该文件的**标记集合**（2026-10-10 / D102：可多值、与类目正交）。
    ///
    /// 由 `file_marks` 表装载（`hp-store` 的 `list_files_*` 会一并带出）；
    /// **不是** `files` 上的列（`files.subtype` 已废弃、新代码不读不写）。
    pub marks: Vec<FileMark>,
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
