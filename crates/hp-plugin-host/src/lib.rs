//! hp-plugin-host：插件包发现、安装、信任与能力校验、宿主生命周期骨架（RFC 0004）。
//!
//! 宿主只做校验与编排，不直接操作数据库或文件系统业务；插件运行形态由 manifest 声明。

mod channel;
mod host;
mod install;
mod manifest;
mod supervision;
mod trust;

pub use channel::{
    CONTROL_EVENT_METHOD_PREFIX, ExternalProcessQuery, PANEL_QUERY_REQUEST, PANEL_SCHEMA_REQUEST,
    PanelQueryParams, PanelQuerySpec, PanelSchemaCache, PanelSchemaKey, PanelSchemaParams,
    PanelSelectionContext, QUERY_MAX_BYTES, QUERY_TIMEOUT, SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT,
    control_event_method,
};
pub use host::{
    LoadOutcome, PanelCatalogEntry, PanelCatalogPanel, PanelOwner, PluginHost, RepoContribution,
    SettingsSectionDecl,
};
pub use install::{InstallSource, InstalledPackage, PluginInstaller};
pub use manifest::{MANIFEST_FILE, PluginPackage, discover_packages, parse_manifest, read_package};
pub use supervision::{
    MAX_CONSECUTIVE_FAILURES, ProcessSupervisor, SupervisionRegistry, SupervisionStatus,
};
pub use trust::{HostSourceKind, can_elevate, effective_trust};
