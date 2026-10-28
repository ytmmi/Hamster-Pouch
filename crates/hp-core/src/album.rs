//! 虚拟相册领域模型（RFC 0002 / database-schema.md 第 4.6 节）。

use std::fmt;

use uuid::Uuid;

use crate::file::FileId;
use crate::repo::RepoId;
use crate::source::{MediaType, SourceId};

/// 相册稳定 ID（UUID v4 文本）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AlbumId(String);

impl AlbumId {
    /// 生成新的相册 ID。
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

impl fmt::Display for AlbumId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 相册类型（RFC 0002）：固定型只维护显式成员；跟随源型额外维护同步规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlbumKind {
    /// 固定型：创建时登记成员，之后不自动跟随源变化。
    Fixed,
    /// 跟随源型：按同步规则维护成员关系。
    FollowSource,
}

impl AlbumKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            AlbumKind::Fixed => "fixed",
            AlbumKind::FollowSource => "follow_source",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "fixed" => Some(AlbumKind::Fixed),
            "follow_source" => Some(AlbumKind::FollowSource),
            _ => None,
        }
    }
}

impl fmt::Display for AlbumKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 相册媒体属性（D10）。与文件媒体类型 [`MediaType`] 不同，额外包含 `multimedia`。
///
/// 相册只显示属性包含类型的文件；`multimedia` 包含 image + video + audio。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlbumMediaType {
    Image,
    Video,
    Audio,
    Multimedia,
}

impl AlbumMediaType {
    /// 存储层字符串表示。
    pub fn as_str(&self) -> &'static str {
        match self {
            AlbumMediaType::Image => "image",
            AlbumMediaType::Video => "video",
            AlbumMediaType::Audio => "audio",
            AlbumMediaType::Multimedia => "multimedia",
        }
    }

    /// 从存储层字符串解析；未知值返回 `None`。
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "image" => Some(AlbumMediaType::Image),
            "video" => Some(AlbumMediaType::Video),
            "audio" => Some(AlbumMediaType::Audio),
            "multimedia" => Some(AlbumMediaType::Multimedia),
            _ => None,
        }
    }

    /// 本相册属性是否包含给定文件媒体类型（D10）。
    ///
    /// **相册一律不含"书"**（2026-10-08 用户口径「媒体预览不包含 text 类型，text 类型在
    /// 图书预览显示」；2026-10-11 PDF 沿同一条口径）：`Multimedia` 的含义是
    /// "图像 + 视频 + 音频"，不是"索引里的一切"。这一条必须与
    /// `query_album_members_page`（只认三个媒体字面量）保持一致——
    /// 否则 `multimedia` 的跟随源相册会把文本 / PDF 文件**写成成员**，
    /// 而成员分页永远列不出它们，表现为"有成员但看不见"，卸载源的影响评估也会多算。
    ///
    /// 判据用 [`MediaType::is_book`] 而不是逐个列 `Text | Pdf`：相册的排除集
    /// 就是"图书预览的那些"，两处必须是同一件事。
    pub fn contains(&self, file_type: MediaType) -> bool {
        if file_type.is_book() {
            return false;
        }
        match self {
            AlbumMediaType::Multimedia => true,
            AlbumMediaType::Image => file_type == MediaType::Image,
            AlbumMediaType::Video => file_type == MediaType::Video,
            AlbumMediaType::Audio => file_type == MediaType::Audio,
        }
    }
}

impl fmt::Display for AlbumMediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 相册成员加入来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddedBy {
    /// 用户手动加入。
    User,
    /// 跟随源同步规则加入。
    SyncRule,
}

impl AddedBy {
    pub fn as_str(&self) -> &'static str {
        match self {
            AddedBy::User => "user",
            AddedBy::SyncRule => "sync_rule",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(AddedBy::User),
            "sync_rule" => Some(AddedBy::SyncRule),
            _ => None,
        }
    }
}

impl fmt::Display for AddedBy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 跟随源同步模式（RFC 0002）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    /// 只增量加入，不移除已有成员。
    AddOnly,
    /// 镜像源：移除非 pinned 成员。
    Mirror,
}

impl SyncMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SyncMode::AddOnly => "add_only",
            SyncMode::Mirror => "mirror",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "add_only" => Some(SyncMode::AddOnly),
            "mirror" => Some(SyncMode::Mirror),
            _ => None,
        }
    }
}

impl fmt::Display for SyncMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 相册：成员关系容器，不拥有真实文件（RFC 0002）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Album {
    pub id: AlbumId,
    pub repo_id: RepoId,
    /// 父相册；可空表示顶层相册。
    pub parent_album_id: Option<AlbumId>,
    pub name: String,
    pub kind: AlbumKind,
    /// 媒体属性；`None` 表示继承父相册（D10）。顶层空值视作 `multimedia`。
    pub media_type: Option<AlbumMediaType>,
    /// 所属**同步根相册**；同步根自己指向自己，非镜像相册为 `None`（D128）。
    pub sync_root_album_id: Option<AlbumId>,
    /// 本相册镜像的源内相对目录（已归一化为 `/`、无首尾斜杠，`""` 表示源根）（D128）。
    pub sync_dir_path: Option<String>,
    /// 同一父级内的展示顺序，0 起递增（D132）。
    ///
    /// 只在兄弟之间有意义：不同父级的序号互不比较，因此移动到别的父级时
    /// 只需重排目标父级的序号。读侧用 `(sort_order, created_at)` 兜底，
    /// 迁移民的老数据全为 0 时仍按创建时间排序。
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 相册成员关系行：`album_member` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumMember {
    pub album_id: AlbumId,
    pub file_id: FileId,
    pub added_at: String,
    pub added_by: AddedBy,
    /// 跟随型中用户手动固定成员，防止被同步移除。
    pub pinned: bool,
}

/// 跟随源同步规则：`album_sync_rule` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncRule {
    pub album_id: AlbumId,
    pub source_id: SourceId,
    /// 是否包含嵌套子源。
    pub include_subsources: bool,
    /// 独立媒体过滤字段，与相册属性联动（D13）。
    pub media_type: AlbumMediaType,
    /// 附加筛选 DSL；具体格式属于实现期开放点。
    pub filter_json: Option<String>,
    pub sync_mode: SyncMode,
    pub enabled: bool,
}

/// 跟随源同步状态：`album_sync_state` 表一一对应。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumSyncState {
    pub album_id: AlbumId,
    pub source_id: SourceId,
    pub last_synced_at: Option<String>,
    pub last_scan_cursor: Option<String>,
    pub status: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn album_media_type_contains_matches_spec() {
        assert!(AlbumMediaType::Multimedia.contains(MediaType::Image));
        assert!(AlbumMediaType::Multimedia.contains(MediaType::Video));
        assert!(AlbumMediaType::Multimedia.contains(MediaType::Audio));
        assert!(AlbumMediaType::Image.contains(MediaType::Image));
        assert!(!AlbumMediaType::Image.contains(MediaType::Video));
        assert!(!AlbumMediaType::Image.contains(MediaType::Audio));

        assert!(AlbumMediaType::Video.contains(MediaType::Video));
        assert!(!AlbumMediaType::Video.contains(MediaType::Image));
        assert!(!AlbumMediaType::Video.contains(MediaType::Audio));

        assert!(AlbumMediaType::Audio.contains(MediaType::Audio));
        assert!(!AlbumMediaType::Audio.contains(MediaType::Image));
        assert!(!AlbumMediaType::Audio.contains(MediaType::Video));
    }

    /// **相册不含"书"**（D95；PDF 于 2026-10-11 沿同一条口径）：
    /// `Multimedia` 是"图像 + 视频 + 音频"，不是"索引里的一切"。
    /// 这条与 `query_album_members_page` 的三个媒体字面量必须一致——否则 `multimedia`
    /// 的跟随源相册会把文本 / PDF 文件写成成员，而成员分页永远列不出它们
    /// （"有成员但看不见"）。
    #[test]
    fn album_media_type_never_contains_books() {
        for album_type in [
            AlbumMediaType::Image,
            AlbumMediaType::Video,
            AlbumMediaType::Audio,
            AlbumMediaType::Multimedia,
        ] {
            for book in [MediaType::Text, MediaType::Pdf] {
                assert!(
                    !album_type.contains(book),
                    "{album_type:?} 不应包含 {book:?}（图书预览才是它的落点）"
                );
            }
        }
    }

    /// 相册的排除集**就是**图书预览的收录集：两者必须是同一件事
    /// （`MediaType::is_book` 是唯一判据，见它的文档）。
    #[test]
    fn album_exclusion_matches_the_book_category() {
        assert!(MediaType::Text.is_book());
        assert!(MediaType::Pdf.is_book());
        // 反向：媒体预览的三个类型不是"书"（相册收它们）。
        for media in [MediaType::Image, MediaType::Video, MediaType::Audio] {
            assert!(!media.is_book(), "{media:?} 不是书，相册应当收它");
            assert!(AlbumMediaType::Multimedia.contains(media));
        }
    }

    #[test]
    fn album_media_type_roundtrip() {
        for v in [
            AlbumMediaType::Image,
            AlbumMediaType::Video,
            AlbumMediaType::Audio,
            AlbumMediaType::Multimedia,
        ] {
            assert_eq!(AlbumMediaType::from_str(v.as_str()), Some(v));
        }
        assert_eq!(AlbumMediaType::from_str("unknown"), None);
    }

    #[test]
    fn album_kind_roundtrip() {
        for v in [AlbumKind::Fixed, AlbumKind::FollowSource] {
            assert_eq!(AlbumKind::from_str(v.as_str()), Some(v));
        }
        assert_eq!(AlbumKind::from_str("unknown"), None);
    }

    #[test]
    fn added_by_roundtrip() {
        for v in [AddedBy::User, AddedBy::SyncRule] {
            assert_eq!(AddedBy::from_str(v.as_str()), Some(v));
        }
        assert_eq!(AddedBy::from_str("unknown"), None);
    }

    #[test]
    fn sync_mode_roundtrip() {
        for v in [SyncMode::AddOnly, SyncMode::Mirror] {
            assert_eq!(SyncMode::from_str(v.as_str()), Some(v));
        }
        assert_eq!(SyncMode::from_str("unknown"), None);
    }

    #[test]
    fn album_id_generate_is_unique_and_displayable() {
        let a = AlbumId::generate();
        let b = AlbumId::generate();
        assert_ne!(a, b);
        assert_eq!(a.to_string(), a.as_str());
    }
}
