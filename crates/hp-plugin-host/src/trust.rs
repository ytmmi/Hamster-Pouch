//! 插件信任等级推导与提升规则（RFC 0004「信任与安装」）。

use hp_core::{SourceKind, TrustLevel};

/// 按来源与请求推导插件生效信任等级。
///
/// - 系统插件：始终 `system`。
/// - 本地路径插件：始终 `local-dev`（不允许自请求更高）。
/// - git 插件：默认 `community`；请求 `trusted` 时经用户显式提升为 `trusted`。
pub fn effective_trust(source: SourceKind, requested: TrustLevel) -> TrustLevel {
    match source {
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

    #[test]
    fn system_source_is_always_system() {
        assert_eq!(
            effective_trust(SourceKind::System, TrustLevel::Community),
            TrustLevel::System
        );
    }

    #[test]
    fn local_path_is_always_local_dev() {
        assert_eq!(
            effective_trust(SourceKind::LocalPath, TrustLevel::System),
            TrustLevel::LocalDev
        );
    }

    #[test]
    fn git_defaults_to_community_but_allows_trusted_request() {
        assert_eq!(
            effective_trust(SourceKind::Git, TrustLevel::Community),
            TrustLevel::Community
        );
        assert_eq!(
            effective_trust(SourceKind::Git, TrustLevel::Trusted),
            TrustLevel::Trusted
        );
        assert_eq!(
            effective_trust(SourceKind::Git, TrustLevel::LocalDev),
            TrustLevel::Community
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
