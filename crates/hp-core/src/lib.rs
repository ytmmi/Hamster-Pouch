//! hp-core：仓鼠颊领域模型（仓库、媒体源、虚拟相册、图像、tag、评分）。
//! 本 crate 保持纯净，不依赖 Tauri/SQLite/文件系统。

pub mod ai;
pub mod album;
pub mod annotation;
pub mod blueprint;
mod blueprint_builtin_nodes;
pub mod blueprint_migrate;
mod blueprint_node;
mod blueprint_node_decl;
mod blueprint_node_decl_validate;
pub mod blueprint_registry;
mod blueprint_row;
mod blueprint_types;
mod blueprint_validate;
mod blueprint_warnings;
pub mod color;
pub mod control;
mod control_types;
pub mod cover;
pub mod error;
pub mod file;
pub mod namespace;
pub mod panel_types;
pub mod plugin;
pub mod plugin_contribution;
mod plugin_row;
mod plugin_types;
mod plugin_validate;
pub mod rating;
pub mod repo;
pub mod setting_registry;
pub mod setting_types;
pub mod source;
pub mod tag;
pub mod tag_dict;
pub mod tag_lib;

pub use ai::{
    AiProviderConfig, AiProviderConfigId, AiTagCandidate, AiTagUndo, AiTaggingInput,
    AiTaggingOutput, DEFAULT_OVERWRITE_THRESHOLD, should_overwrite_user_tag,
};
pub use album::{
    AddedBy, Album, AlbumId, AlbumKind, AlbumMediaType, AlbumMember, AlbumSyncRule, AlbumSyncState,
    SyncMode,
};
pub use annotation::{
    ANNOTATION_PROGRESS_MAX, ANNOTATION_TEXT_MAX_CHARS, AnnotationKind, ReaderAnnotation,
    progress_to_stored, validate_annotation_content,
};
pub use blueprint::{
    ActionOp, AnchorAxis, BLUEPRINT_SCHEMA_VERSION, BOOK_MARK, BUILTIN_MARKS, BlueprintEdge,
    BlueprintGraph, BlueprintLayer, BlueprintNode, BlueprintPosition, BlueprintRow,
    BlueprintTemplateRow, CLASS_MEDIA_TYPES, EdgeKind, GroupMode, HideDirection, MANGA_MARK,
    NodeIssue, NodeType, OVERLAY_HEIGHT_MAX, OVERLAY_HEIGHT_MIN, OVERLAY_MAX_SIZE,
    OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH, OverlayAnchor, OverlaySize, SUBCLASS_FORMATS_TEXT,
    TokenLevel, Trigger, is_valid_class_media_type, media_type_has_subclass, subclass_formats_for,
};
pub use blueprint_migrate::{
    MigratedDocument, migrate_document, migrate_graph, normalize_document,
};
pub use blueprint_registry::{
    BUILTIN_NODE_SPECS, BUILTIN_PANEL_FACTS, BlueprintNodeDecl, BuiltinNodeSpec, EvaluationRole,
    NODE_EVENT_NAMES, NODE_FIELD_TYPES, NodeDeclCtx, NodeFieldDecl, NodePortDecl, NodeRegistry,
    NodeRole, NodeSeverity, NodeSeverityDecl, NodeSpecView, PanelFact, PortSide, RULE_EDGE_SOURCES,
    RULE_EDGE_TARGETS, RegisteredPluginNode, SeverityLevel, derive_ports, validate_node_decl,
};
pub use color::ColorRef;
pub use control::{
    ControlBind, ControlNode, ControlPredicate, ControlSchema, ControlValidateCtx,
    ControlValidateResult, is_valid_id,
};
pub use control_types::{
    AlignToken, CONTROL_API_VERSION, CONTROL_EVENTS, CONTROL_KINDS, CONTROL_NODE_SOFT_LIMIT,
    CONTROL_REGISTRY, ControlCategory, ControlEvent, ControlKind, ControlKindSpec, ControlProp,
    GapToken, PropType, TABLE_COLUMN_MAX, control_spec,
};
pub use cover::{CoverKind, FileCover, is_safe_cover_file_name, normalize_cover_color};
pub use error::{HpError, HpResult};
pub use file::{
    FileId, FileIndexRow, FileMark, ThumbStatus, VerifyStatus, default_book_mark_for_ext,
};
pub use namespace::{
    is_bare_id, is_id_in_plugin_namespace, is_plugin_namespaced_id, is_valid_namespaced_id,
    is_valid_plugin_id,
};
pub use panel_types::{
    PANEL_ICON_WHITELIST, PANEL_MAX_SIZE, PanelCategory, PanelDecl, PanelDeclCtx, PanelDefaultSize,
    PanelMount, PanelSettingDecl, PanelSettingKind, PanelSettingScope, is_bare_panel_id,
    is_valid_panel_id, validate_panel_decl,
};
pub use plugin::{
    Capability, HOST_API_VERSION, HostApiVersion, PluginId, PluginManifest, PluginRegistryRow,
    PluginRepoState, RuntimeKind, SourceKind, TrustLevel,
};
pub use plugin_contribution::{
    Contribution, ContributionKind, DataQueryReturns, PluginDataQueryDecl, PluginEventDecl,
    is_valid_contribution_id,
};
pub use rating::{RATING_MAX, RATING_MIN, Rating, validate_rating};
pub use repo::RepoId;
pub use setting_registry::{
    PANEL_SETTING_DECLS, SETTING_INPUT_KINDS, SYSTEM_SETTING_DECLS, SettingDeclFact,
    registry_decl_for_storage_key, scoped_storage_key, validate_setting_value,
};
pub use setting_types::{
    SettingCategory, SettingDecl, SettingDeclCtx, SettingInputKind, SettingOwnerKind, SettingScope,
    validate_setting_decl,
};
pub use source::{MediaType, Source, SourceId};
pub use tag::{FileAutoTag, FileTag, Tag, TagId, TagRelation, TagRelationKind, TagSource};
pub use tag_dict::{
    DictCategory, DictLang, DictSource, TagDictAlias, TagDictEntry, TagDictLookup,
    TagDictSuggestion, TagDictTranslation, TranslationKind,
};
pub use tag_lib::{
    ArtistKind, LibLayer, LibRelation, LibRelationKind, LibTagSource, TagArtist, TagCharacter,
    TagConcept, TagConceptDetail, TagKind, TagName, TagNameKind, TagRelationNode, TagWork,
};
