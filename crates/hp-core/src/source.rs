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

/// 文件媒体类型。`files` 表存 `image`/`video`/`audio`/`text`/`pdf`。
///
/// `multimedia` 是相册属性概念（M3），不属于文件媒体类型。
///
/// **四类的入库口径各不相同**（这是本节最重要的一件事）：
/// - 音频（`Audio`）是 D11 的**占位行**：无内容哈希、无缩略图、无派生数据；
/// - 文本（`Text`，2026-10）是**完整索引行**（内容哈希照算，用于移动识别与去重），
///   只是不产出感知哈希 / 缩略图 / 调色板；
/// - PDF（`Pdf`，2026-10-11）与文本**同一档**：照算内容哈希、不产出索引期派生数据。
///   它的封面与正文都是**栅格化**出来的，成本高（实测 20–122 ms/页），因此走
///   `book.meta` / `book.content` 的**按内容哈希磁盘缓存**，不进索引（见 `hp-pdf`）。
///
/// **PDF 为什么不是 `Text`**：`pdf` 是二进制容器（`%PDF-` magic bytes），
/// 编码判定与"按字符分页"那一整套对它完全不适用；把它并进 `Text` 会让
/// "文本类"这个类目对 PDF 变成一句谎话，且查看器 / 元数据的文本分支处处要排除它。
/// 它是**自己的类目**（与 `image` / `video` / `audio` / `text` 平级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Image,
    Video,
    Audio,
    /// 文本类（`txt` / `md` / `epub` 等，扩展名判定，无内容兜底）。
    ///
    /// 它是**类目**（蓝图 `class` 节点的 `media_type` 取值之一）；其下的**子类**细分
    /// （`epub` / `txt` / `md`）由蓝图 `subclass` 节点按扩展名表达，
    /// **标记**（`book` / `manga` …）是与类目正交的另一维，见 [`crate::file::FileMark`]。
    Text,
    /// PDF 文档（`pdf`，扩展名判定；**有**内容兜底，见 `hp-scanner` 的
    /// `sniff_media_type` 的 `%PDF-` 分支）。
    ///
    /// 它是**类目**，其下**没有子类**（`subclass_formats_for("pdf")` 为空）：
    /// PDF 只有一种格式，再分一层没有语义。封面（第一页）与逐页正文由 `hp-pdf`
    /// 栅格化，走 `book.meta` / `book.content` 的磁盘缓存。
    Pdf,
}

impl MediaType {
    /// 存储层字符串表示。
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaType::Image => "image",
            MediaType::Video => "video",
            MediaType::Audio => "audio",
            MediaType::Text => "text",
            MediaType::Pdf => "pdf",
        }
    }

    /// 从存储层字符串解析；未知值返回 `None`。
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "image" => Some(MediaType::Image),
            "video" => Some(MediaType::Video),
            "audio" => Some(MediaType::Audio),
            "text" => Some(MediaType::Text),
            "pdf" => Some(MediaType::Pdf),
            _ => None,
        }
    }

    /// 该类型是否是**文本类**（子类型只在文本类上有意义）。
    pub fn is_text(&self) -> bool {
        *self == MediaType::Text
    }

    /// 该类型是否是**"书"**（图书预览面板列出的那些：文本类 + PDF）。
    ///
    /// 这是图书预览**取数口径的唯一来源**：面板请求 `mediaTypes: ['text','pdf']`，
    /// 蓝图侧 `bookpreview` 的类目域也是这两个（外加各自的细分）。
    /// 单列一个谓词是为了让"哪些算书"这件事只有一处定义——
    /// 面板、扫描器、相册三处各写一遍必然漂移。
    pub fn is_book(&self) -> bool {
        matches!(self, MediaType::Text | MediaType::Pdf)
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
