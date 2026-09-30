//! 示例插件验收 + **来源与信任不可自封**的调用方级回归（M5 验证线 / 缺陷 0008）。
//!
//! 本文件的信任断言一律走**安装入口的宿主侧实现**（`PluginInstaller::install_registry_row`，
//! 也就是 `plugin.installLocal` 命令调的那条路径），不再直接对纯函数传字面量：
//! 旧版 `manifest_json_cannot_self_declare_system_trust` 把 `SourceKind::LocalPath` 写成
//! 字面量，**永远不可能失败**，给出的是虚假的安全感（见 `docs/issues/0008`）。

use std::path::{Path, PathBuf};

use hp_core::{Capability, HpError, SourceKind, TrustLevel};
use hp_plugin_host::{
    effective_trust, read_package, HostSourceKind, InstallSource, PluginHost, PluginInstaller,
    MANIFEST_FILE,
};
use hp_store::GlobalDb;

const REPO: &str = "repo-1";
const INSTALLED_AT: &str = "2026-01-01T00:00:00Z";

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn temp_root(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(tag)
}

/// 造一个**本地目录、但在 manifest 里自称 `source.kind = system`** 的插件包。
///
/// 它声明了 `native.code`（高危）并请求 `trust.requested = system`：这正是缺陷 0008
/// 里"本地目录自封 system 即可解锁原生代码"的攻击形态。运行形态取
/// `external-process`，因此结构校验不会先行拦下它——拦截必须发生在**宿主判定的信任**上。
fn self_claimed_system_package(root: &Path) -> PathBuf {
    let dir = root.join("src-self-claimed-system");
    std::fs::create_dir_all(dir.join("bin")).expect("建目录失败");
    std::fs::write(dir.join("bin").join("evil.exe"), b"bin").expect("写入口失败");
    std::fs::write(
        dir.join(MANIFEST_FILE),
        r#"{
            "id": "dev.hamsterpouch.evil.selfclaimed",
            "name": "自称系统来源的本地插件",
            "version": "0.1.0",
            "min_host_version": 1,
            "api_version": 1,
            "source": { "kind": "system" },
            "runtime": { "kind": "external-process" },
            "entry": "bin/evil.exe",
            "capabilities": ["ui.panel", "native.code"],
            "contributions": [],
            "trust": { "requested": "system" }
        }"#,
    )
    .expect("写清单失败");
    dir
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

    // 示例插件按本地路径安装 → 宿主判定为 local-dev。
    let host_source = HostSourceKind::from_install_source(&InstallSource::LocalPath(dir));
    assert_eq!(
        effective_trust(host_source, pkg.manifest.trust_requested),
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
    // 系统插件随应用分发，宿主按 `InstallSource::Bundled` 判定来源为 system。
    assert_eq!(
        effective_trust(HostSourceKind::bundled(), pkg.manifest.trust_requested),
        TrustLevel::System
    );

    // 仓库自带的系统插件清单**不声明**来源（RFC 0009「来源与信任判定」）。
    let manifest_text =
        std::fs::read_to_string(dir.join(MANIFEST_FILE)).expect("读取清单文本失败");
    assert!(
        !manifest_text.contains("\"source\""),
        "manifest 不应声明来源（RFC 0009「来源与信任判定」）"
    );
}

#[test]
fn local_path_install_cannot_self_declare_system_trust() {
    // 缺陷 0008 的调用方级回归：本地路径安装一个自称 `system` 的包，
    // 注册表行必须是**宿主判定**的 `local-path` / `local-dev`，且 `native.code` 授权被拒。
    let root = temp_root("self-claimed");
    let src = self_claimed_system_package(&root);
    let installer = PluginInstaller::new(root.join("store"));

    // 走安装入口的宿主侧实现（`plugin.installLocal` 命令调的就是它）。
    let row = installer
        .install_registry_row(&InstallSource::LocalPath(src), INSTALLED_AT)
        .expect("本地路径安装失败");

    // 夹具必须**真的**自称 system，否则这条测试没有覆盖到出问题的那条路径。
    assert!(
        row.manifest_json.contains("\"kind\": \"system\""),
        "夹具清单必须自称 system 来源"
    );

    assert_ne!(
        row.trust_level,
        TrustLevel::System,
        "本地路径插件不得因 manifest 自称而获得 system 等级"
    );
    assert_eq!(row.trust_level, TrustLevel::LocalDev);
    assert_eq!(row.source_kind, SourceKind::LocalPath);
    assert!(
        !row.trust_level.allows_dynamic_library(),
        "local-dev 不得放行动态库/原生代码"
    );

    // 授权侧：`native.code` 要求 system/trusted，这条路径必须被拒。
    let mut db = GlobalDb::open(&root.join("global.sqlite3")).expect("打开全局库失败");
    PluginHost.register(&mut db, &row).expect("注册失败");
    let err = PluginHost
        .enable_for_repo(&mut db, row.id.as_str(), REPO, &[Capability::NativeCode])
        .expect_err("本地路径插件不应获 native.code");
    assert!(matches!(err, HpError::InvalidArgument(_)));
}

#[test]
fn bundled_system_plugin_gets_system_trust_from_host_decision() {
    // 随包分发的内置插件（`plugins/system/*`）由**宿主**判定为 system——
    // 与 manifest 是否自称无关（palette 清单根本没写 source）。
    // D40：当前 palette 无 SHA256SUMS.sig，trust 降为 Community。
    let root = temp_root("bundled");
    let installer = PluginInstaller::new(root.join("store"));
    let row = installer
        .install_registry_row(
            &InstallSource::Bundled(repo_root().join("plugins/system/palette")),
            INSTALLED_AT,
        )
        .expect("随包安装失败");

    assert_eq!(row.trust_level, TrustLevel::Community);
    assert_eq!(row.source_kind, SourceKind::System);
    assert!(!row.trust_level.allows_dynamic_library());
}
