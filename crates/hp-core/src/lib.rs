//! hp-core：仓鼠颊领域模型（仓库、媒体源、虚拟相册、图像、tag、评分）。
//! 本 crate 保持纯净，不依赖 Tauri/SQLite/文件系统。

pub mod ai;
pub mod album;
pub mod blueprint;
pub mod blueprint_migrate;
mod blueprint_node;
mod blueprint_row;
mod blueprint_types;
mod blueprint_validate;
mod blueprint_warnings;
pub mod color;
pub mod control;
mod control_types;
pub mod error;
pub mod file;
pub mod plugin;
pub mod plugin_contribution;
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
pub use blueprint::{
    ActionOp, AnchorAxis, BlueprintEdge, BlueprintGraph, BlueprintLayer, BlueprintNode,
    BlueprintPosition, BlueprintRow, BlueprintTemplateRow, EdgeKind, GroupMode, HideDirection,
    NodeType, OverlayAnchor, OverlaySize, TokenLevel, Trigger, BLUEPRINT_SCHEMA_VERSION,
    OVERLAY_HEIGHT_MAX, OVERLAY_HEIGHT_MIN, OVERLAY_MAX_SIZE, OVERLAY_MIN_HEIGHT,
    OVERLAY_MIN_WIDTH,
};
pub use blueprint_migrate::{
    migrate_document, migrate_graph, normalize_document, MigratedDocument,
};
pub use color::ColorRef;
pub use control::{
    is_valid_id, ControlBind, ControlNode, ControlPredicate, ControlSchema, ControlValidateCtx,
    ControlValidateResult,
};
pub use control_types::{
    control_spec, AlignToken, ControlCategory, ControlEvent, ControlKind, ControlKindSpec,
    ControlProp, GapToken, PropType, CONTROL_API_VERSION, CONTROL_EVENTS, CONTROL_KINDS,
    CONTROL_NODE_SOFT_LIMIT, CONTROL_REGISTRY, TABLE_COLUMN_MAX,
};
pub use error::{HpError, HpResult};
pub use file::{FileId, FileIndexRow, ThumbStatus, VerifyStatus};
pub use plugin::{
    Capability, HostApiVersion, PluginId, PluginManifest, PluginRegistryRow, PluginRepoState,
    RuntimeKind, SourceKind, TrustLevel, HOST_API_VERSION,
};
pub use plugin_contribution::{
    is_valid_contribution_id, Contribution, ContributionKind, DataQueryReturns,
    PluginDataQueryDecl, PluginEventDecl,
};
pub use rating::{validate_rating, Rating, RATING_MAX, RATING_MIN};
pub use repo::RepoId;
pub use source::{MediaType, Source, SourceId};
pub use tag::{FileAutoTag, FileTag, Tag, TagId, TagRelation, TagRelationKind, TagSource};
pub use tag_dict::{
    DictCategory, DictLang, DictSource, TagDictAlias, TagDictEntry, TagDictLookup,
    TagDictSuggestion, TagDictTranslation, TranslationKind,
};
