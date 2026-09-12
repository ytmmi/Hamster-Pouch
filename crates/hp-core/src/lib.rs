//! hp-core：仓鼠颊领域模型（仓库、图像源、虚拟相册、图像、tag、评分）。
//! 本 crate 保持纯净，不依赖 Tauri/SQLite/文件系统。

pub mod album;
pub mod color;
pub mod error;
pub mod file;
pub mod rating;
pub mod repo;
pub mod source;
pub mod tag;

pub use album::{
    AddedBy, Album, AlbumId, AlbumKind, AlbumMediaType, AlbumMember, AlbumSyncRule, AlbumSyncState,
    SyncMode,
};
pub use color::ColorRef;
pub use error::{HpError, HpResult};
pub use file::{FileId, FileIndexRow, ThumbStatus, VerifyStatus};
pub use rating::{validate_rating, Rating, RATING_MAX, RATING_MIN};
pub use repo::RepoId;
pub use source::{MediaType, Source, SourceId};
pub use tag::{FileTag, Tag, TagId, TagSource};
