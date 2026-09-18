//! M4 验收测试：面板布局持久化（决策 D1：全局配置库 `panel_layouts`，按仓库隔离）。
//! 另含 D53（每层一份布局：`layer_key` 维度）与 D54 相关行为验证。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M4 布局持久化验证线。

use std::path::PathBuf;

use hp_store::GlobalDb;

fn temp_global_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-global.sqlite3"))
}

#[test]
fn save_and_get_roundtrip() {
    let path = temp_global_path("layout-roundtrip");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    let saved = g
        .save_panel_layout("repo-1", "我的布局", "", r#"{"panels":{}}"#)
        .expect("保存布局失败");
    assert_eq!(saved.repo_id, "repo-1");
    assert_eq!(saved.workspace, "我的布局");
    assert!(!saved.id.is_empty(), "新布局应有 ID");
    assert!(!saved.updated_at.is_empty(), "新布局应有更新时间");

    let loaded = g
        .get_panel_layout("repo-1", "我的布局", "")
        .expect("读取布局失败")
        .expect("布局应存在");
    assert_eq!(loaded.layout_json, r#"{"panels":{}}"#);
    assert_eq!(loaded.id, saved.id);
}

#[test]
fn same_key_overwrites_without_duplicate() {
    let path = temp_global_path("layout-overwrite");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    let first = g
        .save_panel_layout("repo-1", "布局A", "", r#"{"v":1}"#)
        .expect("首次保存失败");
    let second = g
        .save_panel_layout("repo-1", "布局A", "", r#"{"v":2}"#)
        .expect("覆盖保存失败");

    assert_eq!(first.id, second.id, "覆盖应复用同一行 ID");
    let list = g.list_panel_layouts("repo-1").expect("列出布局失败");
    assert_eq!(list.len(), 1, "同名覆盖不应产生重复行");
    assert_eq!(list[0].layout_json, r#"{"v":2}"#);
}

#[test]
fn layouts_are_isolated_per_repo() {
    let path = temp_global_path("layout-isolation");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    g.save_panel_layout("repo-a", "共享名", "", r#"{"repo":"a"}"#)
        .expect("保存A失败");
    g.save_panel_layout("repo-b", "共享名", "", r#"{"repo":"b"}"#)
        .expect("保存B失败");

    let a = g.list_panel_layouts("repo-a").expect("列出A失败");
    let b = g.list_panel_layouts("repo-b").expect("列出B失败");
    assert_eq!(a.len(), 1, "A 仓库只应看到自己的布局");
    assert_eq!(b.len(), 1, "B 仓库只应看到自己的布局");
    assert_eq!(a[0].layout_json, r#"{"repo":"a"}"#);
    assert_eq!(b[0].layout_json, r#"{"repo":"b"}"#);

    let got_a = g
        .get_panel_layout("repo-a", "共享名", "")
        .expect("读取A失败")
        .expect("A 布局应存在");
    assert_eq!(got_a.layout_json, r#"{"repo":"a"}"#);
    assert!(
        g.get_panel_layout("repo-c", "共享名", "")
            .expect("读取C失败")
            .is_none(),
        "未保存过的仓库应读不到布局"
    );
}

#[test]
fn list_returns_newest_first() {
    let path = temp_global_path("layout-order");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    g.save_panel_layout("repo-1", "旧", "", r#"{"v":"old"}"#)
        .expect("保存旧失败");
    // updated_at 为秒级 ISO 8601 文本，等待跨秒以确保排序可判定。
    std::thread::sleep(std::time::Duration::from_millis(1100));
    g.save_panel_layout("repo-1", "新", "", r#"{"v":"new"}"#)
        .expect("保存新失败");

    let list = g.list_panel_layouts("repo-1").expect("列出失败");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].workspace, "新", "最新保存的应排在最前");
    assert_eq!(list[1].workspace, "旧");
}

#[test]
fn empty_name_is_rejected() {
    let path = temp_global_path("layout-empty");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");
    let err = g
        .save_panel_layout("repo-1", "   ", "", r#"{}"#)
        .expect_err("空布局名应被拒绝");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
}

/// D53：每层一份布局 —— 同一布局名在不同层各存一行，互不覆盖。
#[test]
fn layout_is_stored_per_layer() {
    let path = temp_global_path("layout-per-layer");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    g.save_panel_layout("repo-1", "预置", "l_a", r#"{"layer":"a"}"#)
        .expect("保存 A 层失败");
    g.save_panel_layout("repo-1", "预置", "l_b", r#"{"layer":"b"}"#)
        .expect("保存 B 层失败");

    let a = g
        .get_panel_layout("repo-1", "预置", "l_a")
        .expect("读取 A 层失败")
        .expect("A 层布局应存在");
    let b = g
        .get_panel_layout("repo-1", "预置", "l_b")
        .expect("读取 B 层失败")
        .expect("B 层布局应存在");
    assert_eq!(a.layout_json, r#"{"layer":"a"}"#);
    assert_eq!(b.layout_json, r#"{"layer":"b"}"#);
    assert_eq!(a.layer_key, "l_a");
    assert_eq!(b.layer_key, "l_b");

    // 层与布局 1:1：同名跨层是两行，不是覆盖
    let list = g.list_panel_layouts("repo-1").expect("列出失败");
    assert_eq!(list.len(), 2, "同一布局名在两层应各有一行");

    // 覆盖只影响本层
    g.save_panel_layout("repo-1", "预置", "l_a", r#"{"layer":"a2"}"#)
        .expect("覆盖 A 层失败");
    let b_after = g
        .get_panel_layout("repo-1", "预置", "l_b")
        .expect("再次读取 B 层失败")
        .expect("B 层布局应存在");
    assert_eq!(b_after.layout_json, r#"{"layer":"b"}"#, "覆盖 A 层不得影响 B 层");
    assert_eq!(
        g.list_panel_layouts("repo-1").expect("列出失败").len(),
        2,
        "同层覆盖不应新增行"
    );
}

/// D53 兼容：迁移前的层无关行（`layer_key = ''`）在读取任意层时兜底命中。
#[test]
fn legacy_layer_agnostic_row_is_used_as_fallback() {
    let path = temp_global_path("layout-legacy-fallback");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    g.save_panel_layout("repo-1", "旧预设", "", r#"{"legacy":true}"#)
        .expect("保存旧预设失败");

    let hit = g
        .get_panel_layout("repo-1", "旧预设", "l_any")
        .expect("读取失败")
        .expect("应兜底命中层无关行");
    assert_eq!(hit.layout_json, r#"{"legacy":true}"#);

    // 该层写入专属行后，读取优先命中专属行
    g.save_panel_layout("repo-1", "旧预设", "l_any", r#"{"legacy":false}"#)
        .expect("保存专属行失败");
    let after = g
        .get_panel_layout("repo-1", "旧预设", "l_any")
        .expect("读取失败")
        .expect("应命中专属行");
    assert_eq!(after.layout_json, r#"{"legacy":false}"#);
    assert_eq!(after.layer_key, "l_any");
}

/// 重命名/删除/蓝图绑定按**布局名**作用于全部层行（预设级语义）。
#[test]
fn rename_delete_and_binding_span_layers() {
    let path = temp_global_path("layout-preset-scope");
    let mut g = GlobalDb::open(&path).expect("打开全局库失败");

    g.save_panel_layout("repo-1", "预置", "l_a", r#"{"a":1}"#)
        .expect("保存 A 层失败");
    g.save_panel_layout("repo-1", "预置", "l_b", r#"{"b":1}"#)
        .expect("保存 B 层失败");

    g.set_layout_blueprints("repo-1", "预置", &["bp-1".to_string()])
        .expect("写入蓝图绑定失败");
    let a = g
        .get_panel_layout("repo-1", "预置", "l_a")
        .expect("读取失败")
        .expect("A 层应存在");
    let b = g
        .get_panel_layout("repo-1", "预置", "l_b")
        .expect("读取失败")
        .expect("B 层应存在");
    assert_eq!(a.blueprint_ids, vec!["bp-1".to_string()]);
    assert_eq!(b.blueprint_ids, vec!["bp-1".to_string()], "绑定是预设级语义");

    g.rename_panel_layout("repo-1", "预置", "改名后")
        .expect("重命名失败");
    assert!(
        g.get_panel_layout("repo-1", "预置", "l_a")
            .expect("读取失败")
            .is_none(),
        "改名后旧名不应再命中"
    );
    assert_eq!(
        g.list_panel_layouts("repo-1").expect("列出失败").len(),
        2,
        "两层都应改名为新名"
    );

    g.delete_panel_layout("repo-1", "改名后").expect("删除失败");
    assert_eq!(
        g.list_panel_layouts("repo-1")
            .expect("列出失败")
            .len(),
        0,
        "删除预设应清理全部层行"
    );
}
