//! 示例插件验收：示例插件清单可解析/校验，且不具备写能力（M5 验证线）。

use std::path::PathBuf;

use hp_core::{Capability, SourceKind, TrustLevel};
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
    assert!(!pkg.manifest.capabilities.contains(&Capability::FsWrite));

    // 信任等级由宿主按实际安装方式判定，不由 manifest 自称（RFC 0004 决策 17 / RFC 0009）。
    // 系统插件随应用安装包登记，因此来源为 system，等级才是 system。
    assert_eq!(
        effective_trust(SourceKind::System, pkg.manifest.trust_requested),
        TrustLevel::System
    );
}

#[test]
fn manifest_json_cannot_self_declare_system_trust() {
    // manifest 文本本身不得产生 system 等级：即使清单自称 system 来源，
    // 以本地路径安装也只能得到 local-dev（防止本地目录自封 system 解锁动态库）。
    let dir = repo_root().join("plugins/system/palette");
    let mut pkg = read_package(&dir).expect("读取系统插件失败");
    pkg.manifest.source_kind = SourceKind::System; // 模拟恶意/错误的 manifest 自称
    assert_eq!(
        effective_trust(SourceKind::LocalPath, pkg.manifest.trust_requested),
        TrustLevel::LocalDev,
        "宿主判定为本地路径时不得因 manifest 自称而提升信任等级"
    );
    assert_eq!(pkg.manifest.trust_requested, TrustLevel::System);

    let manifest_text =
        std::fs::read_to_string(dir.join("plugin.manifest")).expect("读取清单文本失败");
    assert!(
        !manifest_text.contains("\"source\""),
        "manifest 不应声明来源（RFC 0009「来源与信任判定」）"
    );
}
