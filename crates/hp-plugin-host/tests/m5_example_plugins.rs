//! 示例插件验收：示例插件清单可解析/校验，且不具备写能力（M5 验证线）。

use std::path::PathBuf;

use hp_core::{Capability, TrustLevel};
use hp_plugin_host::{effective_trust, read_package};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn example_plugin_is_valid_and_read_only() {
    let dir = repo_root().join("plugins/examples/hello");
    let pkg = read_package(&dir).expect("读取示例插件失败");
    pkg.manifest.validate().expect("示例插件应通过宿主校验");

    // 示例插件只有只读能力，不能直接访问数据库/文件系统（M5 验证线）。
    assert!(pkg.manifest.capabilities.contains(&Capability::UiPanel));
    assert!(pkg.manifest.capabilities.contains(&Capability::RepoRead));
    assert!(!pkg.manifest.capabilities.contains(&Capability::RepoWrite));
    assert!(!pkg.manifest.capabilities.contains(&Capability::FsWrite));
    assert!(!pkg.manifest.capabilities.contains(&Capability::NativeCode));

    assert_eq!(
        effective_trust(pkg.manifest.source_kind, pkg.manifest.trust_requested),
        TrustLevel::LocalDev
    );
}

#[test]
fn system_plugin_is_valid_and_effective_trust_is_system() {
    let dir = repo_root().join("plugins/system/palette");
    let pkg = read_package(&dir).expect("读取系统插件失败");
    pkg.manifest.validate().expect("系统插件应通过宿主校验");
    assert_eq!(
        effective_trust(pkg.manifest.source_kind, pkg.manifest.trust_requested),
        TrustLevel::System
    );
    assert!(!pkg.manifest.capabilities.contains(&Capability::FsWrite));
}
