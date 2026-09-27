//! 插件信任等级推导与提升规则（RFC 0004「信任与安装」）。

use hp_core::{SourceKind, TrustLevel};

use crate::install::InstallSource;

/// **宿主判定的插件来源**（RFC 0009「来源与信任判定」，缺陷 0008）。
///
/// 来源与信任等级只能来自**宿主按实际安装方式**做出的判定；manifest 自称的
/// `source.kind` 一律不参与。本类型是这条规则的**类型级**保证：
///
/// - 公开构造入口只有 [`HostSourceKind::from_install_source`]（按 [`InstallSource`]）
///   与 [`HostSourceKind::bundled`]（随应用分发的内置包）；
/// - [`effective_trust`] 只接受本类型，因此把 manifest 解析出的 [`SourceKind`] 直接
///   送进信任推导会**编译失败**，而不是悄悄把本地目录提升成 `system`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostSourceKind(SourceKind);

impl HostSourceKind {
    /// 随应用分发的内置插件包（`plugins/system/*`）→ `system`。
    pub const fn bundled() -> Self {
        Self(SourceKind::System)
    }

    /// 按宿主实际走的安装入口判定来源。
    pub fn from_install_source(source: &InstallSource) -> Self {
        Self(match source {
            InstallSource::Bundled(_) => SourceKind::System,
            InstallSource::Git { .. } => SourceKind::Git,
            InstallSource::LocalPath(_) => SourceKind::LocalPath,
        })
    }

    /// 注册表 `source_kind` 列与界面的取值（诊断/展示用）。
    pub const fn as_source_kind(self) -> SourceKind {
        self.0
    }
}

/// 按**宿主判定的来源**与 manifest 请求推导插件生效信任等级。
///
/// - 系统插件（随包分发）：始终 `system`。
/// - 本地路径插件：始终 `local-dev`（不允许自请求更高）。
/// - git 插件：默认 `community`；请求 `trusted` 时经用户显式提升为 `trusted`。
///
/// 入参是 [`HostSourceKind`] 而非裸 [`SourceKind`]：调用方**无法**把 manifest 自称的
/// 来源传进来（缺陷 0008）。
pub fn effective_trust(source: HostSourceKind, requested: TrustLevel) -> TrustLevel {
    match source.as_source_kind() {
        SourceKind::System => TrustLevel::System,
        SourceKind::LocalPath => TrustLevel::LocalDev,
        SourceKind::Git => match requested {
            TrustLevel::Trusted => TrustLevel::Trusted,
            _ => TrustLevel::Community,
        },
    }
}

/// 是否允许把信任等级从 `from` 提升到 `to`（仅 `community` -> `trusted`，且需记录）。
pub fn can_elevate(from: TrustLevel, to: TrustLevel) -> bool {
    from == TrustLevel::Community && to == TrustLevel::Trusted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn system_source_is_always_system() {
        assert_eq!(
            effective_trust(HostSourceKind::bundled(), TrustLevel::Community),
            TrustLevel::System
        );
    }

    #[test]
    fn local_path_is_always_local_dev() {
        // 本地路径安装：即使 manifest 请求 `system`，宿主判定仍是 `local-dev`。
        let source = InstallSource::LocalPath(PathBuf::from("."));
        assert_eq!(
            effective_trust(
                HostSourceKind::from_install_source(&source),
                TrustLevel::System
            ),
            TrustLevel::LocalDev
        );
    }

    #[test]
    fn git_defaults_to_community_but_allows_trusted_request() {
        let source = InstallSource::Git {
            dir: PathBuf::from("."),
            url: "https://example.com/p.git".into(),
            rev: "abc123".into(),
        };
        let host = HostSourceKind::from_install_source(&source);
        assert_eq!(
            effective_trust(host, TrustLevel::Community),
            TrustLevel::Community
        );
        assert_eq!(
            effective_trust(host, TrustLevel::Trusted),
            TrustLevel::Trusted
        );
        assert_eq!(
            effective_trust(host, TrustLevel::LocalDev),
            TrustLevel::Community
        );
    }

    #[test]
    fn install_source_maps_to_host_source_kind() {
        assert_eq!(
            HostSourceKind::from_install_source(&InstallSource::Bundled(PathBuf::from(".")))
                .as_source_kind(),
            SourceKind::System
        );
        assert_eq!(
            HostSourceKind::from_install_source(&InstallSource::LocalPath(PathBuf::from(".")))
                .as_source_kind(),
            SourceKind::LocalPath
        );
    }

    #[test]
    fn only_community_can_be_elevated_to_trusted() {
        assert!(can_elevate(TrustLevel::Community, TrustLevel::Trusted));
        assert!(!can_elevate(TrustLevel::LocalDev, TrustLevel::Trusted));
        assert!(!can_elevate(TrustLevel::Trusted, TrustLevel::Trusted));
        assert!(!can_elevate(TrustLevel::Community, TrustLevel::System));
    }
}
