//! hp-core：仓鼠颊领域模型（仓库、图像源、虚拟相册、图像、tag、评分）。
//! 本 crate 保持纯净，不依赖 Tauri/SQLite/文件系统。

pub mod ai;
pub mod album;
pub mod color;
pub mod error;
pub mod file;
pub mod plugin;
pub mod rating;
pub mod repo;
pub mod source;
pub mod tag;
pub mod tag_dict;

pub use ai::{
    should_overwrite_user_tag, AiProviderConfig, AiProviderConfigId, AiTagCandidate, AiTagUndo,
    AiTaggingInput, AiTaggingOutput, DEFAULT_OVERWRITE_THRESHOLD,
};
pub use album::{
    AddedBy, Album, AlbumId, AlbumKind, AlbumMediaType, AlbumMember, AlbumSyncRule, AlbumSyncState,
    SyncMode,
};
pub use color::ColorRef;
pub use error::{HpError, HpResult};
pub use file::{FileId, FileIndexRow, ThumbStatus, VerifyStatus};
pub use plugin::{
    Capability, HostApiVersion, PluginId, PluginManifest, PluginRegistryRow, PluginRepoState,
    RuntimeKind, SourceKind, TrustLevel, HOST_API_VERSION,
};
pub use rating::{validate_rating, Rating, RATING_MAX, RATING_MIN};
pub use repo::RepoId;
pub use source::{MediaType, Source, SourceId};
pub use tag::{FileAutoTag, FileTag, Tag, TagId, TagRelation, TagRelationKind, TagSource};
pub use tag_dict::{
    DictCategory, DictLang, DictSource, TagDictAlias, TagDictEntry, TagDictLookup,
    TagDictSuggestion, TagDictTranslation, TranslationKind,
};
