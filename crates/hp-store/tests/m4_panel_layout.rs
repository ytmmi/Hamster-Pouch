//! M4 验收测试：布局预设与仓库绑定（RFC 0011）。
//!
//! 语义基线：一份布局 = 一行应用级预设（各层装在 `layers_json` 内）；仓库覆盖是
//! 可选的 `layout_bindings` 行；读取顺序为「当前层 → `""` → 沿解析链下移」。
//! 旧 `panel_layouts`（按仓库 × 层 × 名字）已由 `global/0005` 折算，不再有写入路径。

use std::collections::BTreeMap;
use std::path::PathBuf;

use hp_store::GlobalDb;

fn temp_global_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-global.sqlite3"))
}

fn open(tag: &str) -> GlobalDb {
    GlobalDb::open(temp_global_path(tag)).expect("打开全局库失败")
}

/// 断言错误码（`HpError::code()`：validation / not_found / conflict / io …）。
fn assert_code(result: Result<impl std::fmt::Debug, hp_store::HpError>, code: &str) {
    let err = result.expect_err("应返回错误");
    assert_eq!(err.code(), code, "错误码不符：{err}");
}

#[test]
fn save_and_get_roundtrip() {
    let mut g = open("layout-roundtrip");
    let saved = g
        .save_layout_layer("我的布局", "", r#"{"panels":{}}"#)
        .expect("保存布局失败");
    assert!(!saved.id.is_empty(), "新预设应有 ID");
    assert_eq!(saved.origin, "user");
    assert_eq!(saved.layer_keys(), vec![String::new()]);

    let loaded = g
        .get_layout_layer("我的布局", "")
        .expect("读取布局失败")
        .expect("布局应存在");
    assert_eq!(loaded, r#"{"panels":{}}"#);
    assert_eq!(
        g.get_layout_preset("我的布局")
            .expect("读取预设失败")
            .unwrap()
            .id,
        saved.id
    );
}

#[test]
fn same_layer_overwrites_without_duplicate() {
    let mut g = open("layout-overwrite");
    let first = g
        .save_layout_layer("布局A", "l_main", r#"{"v":1}"#)
        .expect("首次保存失败");
    let second = g
        .save_layout_layer("布局A", "l_main", r#"{"v":2}"#)
        .expect("覆盖保存失败");
    assert_eq!(first.id, second.id, "覆盖应复用同一预设");
    assert_eq!(g.list_layout_presets().expect("列出预设失败").len(), 1);
    assert_eq!(
        g.get_layout_layer("布局A", "l_main").unwrap().unwrap(),
        r#"{"v":2}"#
    );
}

#[test]
fn layers_live_in_one_record_without_cross_preset_borrowing() {
    let mut g = open("layout-layers");
    g.save_layout_layer("布局A", "l_main", r#"{"layer":"main"}"#)
        .expect("保存 l_main 失败");
    g.save_layout_layer("布局A", "l_2", r#"{"layer":"two"}"#)
        .expect("保存 l_2 失败");
    g.save_layout_layer("布局B", "", r#"{"layer":"legacy"}"#)
        .expect("保存层无关布局失败");

    // 一份布局 = 一行：两层都在同一预设内。
    let a = g.get_layout_preset("布局A").unwrap().unwrap();
    assert_eq!(
        a.layer_keys(),
        vec!["l_2".to_string(), "l_main".to_string()]
    );
    assert_eq!(
        g.get_layout_layer("布局A", "l_2").unwrap().unwrap(),
        r#"{"layer":"two"}"#
    );

    // 预设内该层缺失时回退到自己的 ""，绝不跨预设借旧行。
    assert_eq!(g.get_layout_layer("布局A", "l_missing").unwrap(), None);
    assert_eq!(
        g.get_layout_layer("布局B", "l_main").unwrap().unwrap(),
        r#"{"layer":"legacy"}"#
    );
}

#[test]
fn list_returns_newest_first() {
    let mut g = open("layout-list");
    g.save_layout_layer("先存", "", r#"{"v":1}"#)
        .expect("保存失败");
    std::thread::sleep(std::time::Duration::from_millis(5));
    g.save_layout_layer("后存", "", r#"{"v":2}"#)
        .expect("保存失败");
    let names: Vec<String> = g
        .list_layout_presets()
        .expect("列出预设失败")
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(names, vec!["后存".to_string(), "先存".to_string()]);
}

#[test]
fn empty_name_is_rejected() {
    let mut g = open("layout-empty-name");
    assert_code(g.save_layout_layer("  ", "", r#"{"v":1}"#), "validation");
    assert_code(g.save_layout_layer("布局", "", "not json"), "validation");
    assert_code(g.save_layout_layer("布局", "", r#"[1,2]"#), "validation");
}

#[test]
fn default_pointer_follows_rename_and_blocks_delete() {
    let mut g = open("layout-default");
    g.save_layout_layer("布局A", "", r#"{"v":1}"#)
        .expect("保存失败");
    g.save_layout_layer("布局B", "", r#"{"v":2}"#)
        .expect("保存失败");
    g.set_default_layout("布局A").expect("设默认失败");
    assert_eq!(g.default_layout_name().unwrap().as_deref(), Some("布局A"));

    g.rename_layout_preset("布局A", "布局A2")
        .expect("重命名失败");
    assert_eq!(g.default_layout_name().unwrap().as_deref(), Some("布局A2"));

    // 默认预设拒绝删除（决策 11）；换成非默认后可删。
    assert_code(g.delete_layout_preset("布局A2"), "validation");
    g.set_default_layout("布局B").expect("改默认失败");
    g.delete_layout_preset("布局A2").expect("删除失败");
    assert!(g.get_layout_preset("布局A2").unwrap().is_none());

    // 重名 → conflict；同名（no-op）允许。
    g.save_layout_layer("布局C", "", r#"{"v":3}"#)
        .expect("保存失败");
    assert_code(g.rename_layout_preset("布局C", "布局B"), "conflict");
    g.rename_layout_preset("布局C", "布局C")
        .expect("同名重命名应通过");
}

#[test]
fn binding_overrides_default_and_blocks_delete() {
    let mut g = open("layout-binding");
    g.save_layout_layer("默认布局", "", r#"{"v":"default"}"#)
        .expect("保存默认失败");
    g.save_layout_layer("仓库布局", "", r#"{"v":"repo"}"#)
        .expect("保存仓库布局失败");
    g.set_default_layout("默认布局").expect("设默认失败");

    g.bind_layout_repo("repo-1", Some("仓库布局"))
        .expect("绑定失败");
    assert_eq!(
        g.layout_binding_name("repo-1").unwrap().as_deref(),
        Some("仓库布局")
    );

    // 被绑定的预设拒绝删除；解绑后删除成功，应用级默认不受影响。
    assert_code(g.delete_layout_preset("仓库布局"), "validation");
    g.bind_layout_repo("repo-1", None).expect("解绑失败");
    assert_eq!(g.layout_binding_name("repo-1").unwrap(), None);
    g.delete_layout_preset("仓库布局").expect("删除失败");
    assert_eq!(
        g.default_layout_name().unwrap().as_deref(),
        Some("默认布局")
    );
    assert_code(g.bind_layout_repo("repo-2", Some("不存在")), "not_found");
}

#[test]
fn renamed_preset_keeps_binding_by_id() {
    let mut g = open("layout-rename-binding");
    g.save_layout_layer("旧名", "", r#"{"v":1}"#)
        .expect("保存失败");
    g.bind_layout_repo("repo-1", Some("旧名"))
        .expect("绑定失败");
    g.rename_layout_preset("旧名", "新名").expect("重命名失败");
    assert_eq!(
        g.layout_binding_name("repo-1").unwrap().as_deref(),
        Some("新名")
    );
}

#[test]
fn seed_is_created_once_and_only_unmodified_seed_is_replaced() {
    let mut g = open("layout-seed");
    let first = g
        .ensure_seeded_layout("默认布局", r#"{"":{"v":1}}"#, &[])
        .expect("首次播种失败");
    assert!(first.seeded && !first.replaced);
    assert_eq!(
        g.default_layout_name().unwrap().as_deref(),
        Some("默认布局")
    );

    // 内容一致：不重复播种、不替换。
    let same = g
        .ensure_seeded_layout("默认布局", r#"{"":{"v":1}}"#, &[])
        .expect("再次播种失败");
    assert!(!same.seeded && !same.replaced);

    // 未被用户改动：用新形状替换。
    let replaced = g
        .ensure_seeded_layout("默认布局", r#"{"":{"v":2}}"#, &[])
        .expect("替换播种失败");
    assert!(!replaced.seeded && replaced.replaced);
    assert_eq!(
        g.get_layout_layer("默认布局", "").unwrap().unwrap(),
        r#"{"v":2}"#
    );

    // 用户保存后 origin 转为 user，不再被新版本覆盖。
    g.save_layout_layer("默认布局", "", r#"{"v":"user"}"#)
        .expect("用户保存失败");
    let untouched = g
        .ensure_seeded_layout("默认布局", r#"{"":{"v":3}}"#, &[])
        .expect("播种检查失败");
    assert!(!untouched.replaced);
    assert_eq!(
        g.get_layout_layer("默认布局", "").unwrap().unwrap(),
        r#"{"v":"user"}"#
    );
}

#[test]
fn existing_presets_disable_seeding() {
    let mut g = open("layout-no-seed");
    g.save_layout_layer("用户布局", "", r#"{"v":1}"#)
        .expect("保存失败");
    let outcome = g
        .ensure_seeded_layout("默认布局", r#"{"":{"v":9}}"#, &[])
        .expect("播种检查失败");
    assert!(!outcome.seeded && !outcome.replaced);
    assert!(g.get_layout_layer("默认布局", "").unwrap().is_none());
}

#[test]
fn delete_repo_only_clears_binding() {
    let mut g = open("layout-delete-repo");
    let repo = g
        .register_repo("测试仓库", "repo.sqlite3")
        .expect("注册仓库失败");
    g.save_layout_layer("预设", "", r#"{"v":1}"#)
        .expect("保存失败");
    g.set_default_layout("预设").expect("设默认失败");
    g.bind_layout_repo(&repo.id, Some("预设"))
        .expect("绑定失败");

    g.delete_repo(&repo.id).expect("删除仓库失败");
    assert!(
        g.get_layout_preset("预设").unwrap().is_some(),
        "预设是应用级的"
    );
    assert_eq!(g.default_layout_name().unwrap().as_deref(), Some("预设"));
}

#[test]
fn imported_preset_layers_roundtrip_byte_for_byte() {
    let mut g = open("layout-import");
    let mut layers: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    layers.insert(
        "l_main".into(),
        serde_json::json!({"panels":{"a":{"id":"a"}}}),
    );
    layers.insert("l_2".into(), serde_json::json!({"panels":{}}));
    let imported = g
        .import_layout_preset("导入布局", layers.clone(), &["bp-1".to_string()])
        .expect("导入失败");
    assert_eq!(imported.origin, "user");
    assert_eq!(
        imported.layer_keys(),
        vec!["l_2".to_string(), "l_main".to_string()]
    );

    let stored = g.get_layout_preset("导入布局").unwrap().unwrap();
    assert_eq!(stored.layers, layers);
    assert_eq!(stored.blueprint_ids, vec!["bp-1".to_string()]);
    assert_eq!(
        g.get_layout_layer("导入布局", "l_2").unwrap().unwrap(),
        r#"{"panels":{}}"#
    );
}
