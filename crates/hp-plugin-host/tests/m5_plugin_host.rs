//! M5 验收测试：插件注册、按仓库启用与能力授权、越权拒绝、生命周期加载。
//! 对应 RFC 0004 与路线图 M5 验证线「示例插件不能直接访问数据库」。

use std::path::PathBuf;

use hp_core::{Capability, PluginId, PluginRegistryRow, RuntimeKind, SourceKind, TrustLevel};
use hp_plugin_host::PluginHost;
use hp_store::GlobalDb;

const REPO: &str = "repo-1";

fn temp_global_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-global.sqlite3"))
}

fn manifest_json(id: &str, runtime: &str, caps: &[&str], trust: &str) -> String {
    let caps_json = caps
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"{{
            "id": "{id}",
            "name": "测试插件",
            "version": "0.1.0",
            "min_host_version": 1,
            "source": {{ "kind": "local-path" }},
            "runtime": {{ "kind": "{runtime}" }},
            "entry": "bin/test.exe",
            "capabilities": [{caps_json}],
            "contributions": [],
            "trust": {{ "requested": "{trust}" }}
        }}"#
    )
}

fn registry_row(id: &str, runtime: &str, caps: &[&str], trust: TrustLevel) -> PluginRegistryRow {
    PluginRegistryRow {
        id: PluginId::from_raw(id),
        name: "测试插件".into(),
        version: "0.1.0".into(),
        trust_level: trust,
        source_kind: SourceKind::LocalPath,
        source_ref: None,
        runtime_kind: RuntimeKind::from_str(runtime).unwrap(),
        installed_at: "2026-01-01T00:00:00Z".into(),
        manifest_json: manifest_json(id, runtime, caps, trust.as_str()),
    }
}

#[test]
fn register_rejects_manifest_id_mismatch() {
    let path = temp_global_path("reg-mismatch");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let mut row = registry_row(
        "dev.hamsterpouch.hello",
        "external-process",
        &["ui.panel"],
        TrustLevel::LocalDev,
    );
    row.manifest_json = manifest_json(
        "dev.hamsterpouch.other",
        "external-process",
        &["ui.panel"],
        "local-dev",
    );
    let err = PluginHost.register(&mut db, &row).expect_err("ID 不一致应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
}

#[test]
fn enable_grants_readonly_panel_and_requested_caps() {
    let path = temp_global_path("enable");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let id = "dev.hamsterpouch.hello";
    PluginHost
        .register(
            &mut db,
            &registry_row(id, "external-process", &["ui.panel", "repo.read"], TrustLevel::LocalDev),
        )
        .expect("注册失败");

    let state = PluginHost
        .enable_for_repo(&mut db, id, REPO, &[Capability::RepoRead])
        .expect("启用失败");
    assert!(state.enabled);
    // 只读面板默认授予 + 请求的 repo.read。
    assert!(state.grants.contains(&Capability::UiPanel));
    assert!(state.grants.contains(&Capability::RepoRead));
    // 未请求的写能力不应被授予。
    assert!(!state.grants.contains(&Capability::RepoWrite));
}

#[test]
fn enable_rejects_undeclared_capability() {
    let path = temp_global_path("undeclared");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let id = "dev.hamsterpouch.hello";
    PluginHost
        .register(
            &mut db,
            &registry_row(id, "external-process", &["ui.panel"], TrustLevel::LocalDev),
        )
        .expect("注册失败");

    let err = PluginHost
        .enable_for_repo(&mut db, id, REPO, &[Capability::FsWrite])
        .expect_err("未声明能力应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
}

#[test]
fn enable_rejects_native_code_for_untrusted_plugin() {
    let path = temp_global_path("native");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let id = "dev.hamsterpouch.native";
    // 声明 native.code 但信任等级为 community：注册可过（非动态库形态），授权时应被拒绝。
    PluginHost
        .register(
            &mut db,
            &registry_row(
                id,
                "external-process",
                &["ui.panel", "native.code"],
                TrustLevel::Community,
            ),
        )
        .expect("注册失败");

    let err = PluginHost
        .enable_for_repo(&mut db, id, REPO, &[Capability::NativeCode])
        .expect_err("非受信插件不应获 native.code");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
}

#[test]
fn register_rejects_community_dynamic_library() {
    let path = temp_global_path("dynlib");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let err = PluginHost
        .register(
            &mut db,
            &registry_row(
                "dev.hamsterpouch.dynlib",
                "dynamic-library",
                &["native.code"],
                TrustLevel::Community,
            ),
        )
        .expect_err("community 动态库应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
}

#[test]
fn capability_check_enforces_enable_and_grants() {
    let path = temp_global_path("check");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let id = "dev.hamsterpouch.hello";
    PluginHost
        .register(
            &mut db,
            &registry_row(id, "external-process", &["ui.panel", "repo.read"], TrustLevel::LocalDev),
        )
        .expect("注册失败");

    // 未启用 → 权限不足。
    let err = PluginHost
        .check_capability(&db, id, REPO, Capability::UiPanel)
        .expect_err("未启用应拒绝");
    assert!(matches!(err, hp_core::HpError::Permission(_)));

    PluginHost
        .enable_for_repo(&mut db, id, REPO, &[Capability::RepoRead])
        .expect("启用失败");

    // 已授权 → 通过。
    PluginHost
        .check_capability(&db, id, REPO, Capability::RepoRead)
        .expect("已授权能力应通过");
    // 未授权 → 权限不足（示例插件无法绕过宿主直连数据库，对应 M5 验证线）。
    let err = PluginHost
        .check_capability(&db, id, REPO, Capability::RepoWrite)
        .expect_err("未授权能力应拒绝");
    assert!(matches!(err, hp_core::HpError::Permission(_)));
}

#[test]
fn disable_clears_grants_and_load_requires_enabled() {
    let path = temp_global_path("load");
    let mut db = GlobalDb::open(&path).expect("打开全局库失败");
    let id = "dev.hamsterpouch.hello";
    PluginHost
        .register(
            &mut db,
            &registry_row(id, "external-process", &["ui.panel"], TrustLevel::LocalDev),
        )
        .expect("注册失败");

    // 未启用时加载失败。
    assert!(PluginHost.load(&db, id, REPO).is_err());

    PluginHost
        .enable_for_repo(&mut db, id, REPO, &[])
        .expect("启用失败");
    let outcome = PluginHost.load(&db, id, REPO).expect("加载失败");
    assert_eq!(outcome.runtime_kind, RuntimeKind::ExternalProcess);
    assert_eq!(outcome.api_version, hp_core::HOST_API_VERSION);
    assert!(outcome.grants.contains(&Capability::UiPanel));

    PluginHost
        .disable_for_repo(&mut db, id, REPO)
        .expect("禁用失败");
    assert!(PluginHost.load(&db, id, REPO).is_err());
    assert!(!db.is_plugin_enabled(id, REPO).expect("查询启用失败"));
}
