//! hp-plugin-host：插件包发现、安装、信任与能力校验、宿主生命周期骨架（RFC 0004）。
//!
//! 宿主只做校验与编排，不直接操作数据库或文件系统业务；插件运行形态由 manifest 声明。

mod host;
mod install;
mod manifest;
mod trust;

pub use host::{
    LoadOutcome, PluginHost, RepoContribution, SettingsSectionDecl,
};
pub use install::{InstallSource, InstalledPackage, PluginInstaller};
pub use manifest::{discover_packages, parse_manifest, read_package, PluginPackage, MANIFEST_FILE};
pub use trust::{can_elevate, effective_trust, HostSourceKind};
