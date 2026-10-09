//! M5 验收测试：插件注册表 / 按仓库启用授权 / AI 提供方配置 / AI 覆盖撤销记录。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M5 验证线与 RFC 0004 / D6。

use std::path::PathBuf;

use hp_core::{
    AiTagUndo, Capability, FileId, PluginId, PluginRegistryRow, PluginRepoState, RepoId,
    RuntimeKind, SourceKind, TagId, TagSource, TrustLevel,
};
use hp_store::{GlobalDb, RepoDb};

fn temp_global_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-global.sqlite3"))
}

fn temp_repo_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-repo.sqlite3"))
}

fn sample_plugin(id: &str) -> PluginRegistryRow {
    PluginRegistryRow {
        id: PluginId::from_raw(id),
        name: "示例插件".into(),
        version: "0.1.0".into(),
        trust_level: TrustLevel::LocalDev,
        source_kind: SourceKind::LocalPath,
        source_ref: Some("plugins/examples/hello".into()),
        runtime_kind: RuntimeKind::ExternalProcess,
        installed_at: "2026-01-01T00:00:00Z".into(),
        manifest_json: "{}".into(),
    }
}

#[test]
fn plugin_registry_roundtrip_and_remove() {
    let path = temp_global_path("plugin-registry");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    let row = sample_plugin("dev.hamsterpouch.hello");
    g.upsert_plugin(&row).expect("写入插件失败");

    let got = g
        .get_plugin("dev.hamsterpouch.hello")
        .expect("查询插件失败")
        .expect("插件应存在");
    assert_eq!(got.name, "示例插件");
    assert_eq!(got.trust_level, TrustLevel::LocalDev);
    assert_eq!(got.runtime_kind, RuntimeKind::ExternalProcess);
    assert_eq!(g.list_plugins().expect("列出插件失败").len(), 1);

    // UPSERT 不产生重复行。
    let mut updated = row.clone();
    updated.version = "0.2.0".into();
    g.upsert_plugin(&updated).expect("更新插件失败");
    assert_eq!(g.list_plugins().expect("列出插件失败").len(), 1);

    g.remove_plugin("dev.hamsterpouch.hello").expect("删除插件失败");
    assert!(g
        .get_plugin("dev.hamsterpouch.hello")
        .expect("查询插件失败")
        .is_none());
}

#[test]
fn plugin_repo_state_enable_and_isolation() {
    let path = temp_global_path("plugin-state");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    let plugin = PluginId::from_raw("dev.hamsterpouch.hello");
    g.upsert_plugin(&sample_plugin(plugin.as_str()))
        .expect("写入插件失败");

    // repo-a 启用并授予只读面板 + 仓库读能力。
    g.upsert_plugin_repo_state(&PluginRepoState {
        plugin_id: plugin.clone(),
        repo_id: RepoId::from_raw("repo-a"),
        enabled: true,
        grants: vec![Capability::UiPanel, Capability::RepoRead],
    })
    .expect("写入仓库状态失败");

    // repo-b 未启用。
    assert!(g
        .is_plugin_enabled(plugin.as_str(), "repo-a")
        .expect("查询启用状态失败"));
    assert!(!g
        .is_plugin_enabled(plugin.as_str(), "repo-b")
        .expect("查询启用状态失败"));

    let state = g
        .get_plugin_repo_state(plugin.as_str(), "repo-a")
        .expect("查询仓库状态失败")
        .expect("状态应存在");
    assert!(state.enabled);
    assert_eq!(state.grants, vec![Capability::UiPanel, Capability::RepoRead]);

    assert_eq!(
        g.list_plugin_repo_states("repo-a")
            .expect("列出仓库状态失败")
            .len(),
        1
    );
    assert_eq!(
        g.list_plugin_repo_states("repo-b")
            .expect("列出仓库状态失败")
            .len(),
        0,
        "仓库状态必须按仓库隔离"
    );
}

#[test]
fn plugin_grants_roundtrip_preserves_high_risk() {
    let path = temp_global_path("plugin-grants");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");
    let plugin = PluginId::from_raw("dev.hamsterpouch.native");

    g.upsert_plugin(&sample_plugin(plugin.as_str()))
        .expect("写入插件失败");
    g.upsert_plugin_repo_state(&PluginRepoState {
        plugin_id: plugin.clone(),
        repo_id: RepoId::from_raw("repo-a"),
        enabled: true,
        grants: vec![Capability::FsWrite, Capability::Network, Capability::NativeCode],
    })
    .expect("写入仓库状态失败");

    let state = g
        .get_plugin_repo_state(plugin.as_str(), "repo-a")
        .expect("查询失败")
        .expect("状态应存在");
    assert!(state.grants.contains(&Capability::FsWrite));
    assert!(state.grants.contains(&Capability::Network));
    assert!(state.grants.contains(&Capability::NativeCode));
    assert!(state.grants.iter().any(|c| c.is_high_risk()));
}

#[test]
fn ai_provider_config_crud() {
    let path = temp_global_path("ai-config");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    let cfg = g
        .create_ai_provider_config("local-http", Some("clip-vit"), r#"{"endpoint":"http://127.0.0.1"}"#)
        .expect("创建 AI 配置失败");
    assert_eq!(cfg.provider, "local-http");
    assert_eq!(cfg.model.as_deref(), Some("clip-vit"));

    let got = g
        .get_ai_provider_config(cfg.id.as_str())
        .expect("查询失败")
        .expect("配置应存在");
    assert_eq!(got.config_json, r#"{"endpoint":"http://127.0.0.1"}"#);
    assert_eq!(g.list_ai_provider_configs().expect("列出失败").len(), 1);

    g.remove_ai_provider_config(cfg.id.as_str())
        .expect("删除失败");
    assert!(g
        .get_ai_provider_config(cfg.id.as_str())
        .expect("查询失败")
        .is_none());
}

#[test]
fn ai_tag_undo_records_and_latest() {
    let path = temp_repo_path("ai-undo");
    let mut db = RepoDb::create(&path, "AI 仓库").expect("创建仓库失败");
    assert_eq!(db.schema_version().expect("读版本失败"), 10);

    let undo = AiTagUndo {
        id: "undo-1".into(),
        repo_id: RepoId::from_raw("repo-1"),
        file_id: FileId::from_raw("file-1"),
        tag_id: TagId::from_raw("tag-1"),
        prev_source: TagSource::User,
        prev_confidence: None,
        prev_source_model: None,
        created_at: "2026-01-01T00:00:00Z".into(),
    };
    db.insert_ai_tag_undo(&undo).expect("写入撤销记录失败");

    let undo2 = AiTagUndo {
        id: "undo-2".into(),
        prev_source: TagSource::Ai,
        prev_confidence: Some(0.5),
        prev_source_model: Some("clip-vit".into()),
        created_at: "2026-01-02T00:00:00Z".into(),
        ..undo.clone()
    };
    db.insert_ai_tag_undo(&undo2).expect("写入第二条失败");

    let for_file = db
        .list_ai_tag_undo_for_file("file-1")
        .expect("按文件查询失败");
    assert_eq!(for_file.len(), 2);
    assert_eq!(db.count_ai_tag_undo("repo-1").expect("统计失败"), 2);

    let latest = db
        .latest_ai_tag_undo("file-1", "tag-1")
        .expect("查询最近失败")
        .expect("应有最近记录");
    assert_eq!(latest.id, "undo-2");
    assert_eq!(latest.prev_confidence, Some(0.5));

    db.delete_ai_tag_undo("undo-1").expect("删除失败");
    assert_eq!(db.count_ai_tag_undo("repo-1").expect("统计失败"), 1);
    db.close().expect("关闭失败");
}

#[test]
fn ops_history_write_list_and_get() {
    let path = temp_repo_path("ops");
    let mut db = RepoDb::create(&path, "操作仓库").expect("创建仓库失败");

    let id = db
        .insert_ops_history("repo-1", "copy", r#"{"src":"a","dst":"b"}"#, None)
        .expect("写入操作历史失败");
    assert!(!id.is_empty());

    let got = db
        .get_ops_history(&id)
        .expect("查询失败")
        .expect("记录应存在");
    assert_eq!(got.op_type, "copy");
    assert_eq!(got.payload_json, r#"{"src":"a","dst":"b"}"#);

    db.insert_ops_history("repo-1", "move", r#"{"src":"c","dst":"d"}"#, Some(r#"{}"#))
        .expect("写入第二条失败");
    let list = db.list_ops_history("repo-1", 10).expect("列出失败");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].op_type, "move", "最新记录应在前");

    db.delete_ops_history(&id).expect("删除失败");
    assert!(db.get_ops_history(&id).expect("查询失败").is_none());
    db.close().expect("关闭失败");
}
