//! M6 验收测试：蓝图（RFC 0007 / D28-D32）。
//! 覆盖：仓库库蓝图存储往返、默认蓝图唯一与回退、模板复制、语义校验拒绝、
//! 以及 hp-core 图文档 JSON 往返。对应 docs/roadmap/phase-1-top-level-plan.md 的 M6 验证线。

use std::path::PathBuf;

use hp_core::{
    BlueprintGraph, BlueprintTemplateRow, HideDirection, NodeType, BLUEPRINT_SCHEMA_VERSION,
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

/// 最小合法蓝图图文档（控件 + 互斥组 + 事件→动作）。
fn valid_blueprint_json() -> String {
    r#"{
      "schema_version": 1,
      "nodes": [
        {"key":"c_preview","type":"control","panel_id":"media","title_key":"panel.media"},
        {"key":"c_viewer","type":"control","panel_id":"viewer","title_key":"panel.viewer"},
        {"key":"k_image","type":"class","control":"c_preview","media_type":"image"},
        {"key":"o_img","type":"object","class":"k_image","scope":"double_clicked"},
        {"key":"g_viewers","type":"group","mode":"exclusive","default_visible":[],
         "hide_direction":"left","position":{"x":0,"y":0}},
        {"key":"e_dbl","type":"event","trigger":"double_click","target":"o_img"},
        {"key":"a_show","type":"action","op":"show","target":"c_viewer"}
      ],
      "edges": [
        {"from":"c_preview","to":"k_image","kind":"contains","order":1},
        {"from":"k_image","to":"o_img","kind":"contains","order":1},
        {"from":"c_viewer","to":"g_viewers","kind":"memberOf","order":1},
        {"from":"e_dbl","to":"a_show","kind":"fires","order":1}
      ]
    }"#
    .to_string()
}

/// 解析并断言文档合法。
fn assert_valid(json: &str) -> BlueprintGraph {
    let graph = BlueprintGraph::from_json(json).expect("解析蓝图失败");
    assert!(
        graph.validate().is_empty(),
        "蓝图应合法: {:?}",
        graph.validate()
    );
    graph
}

#[test]
fn blueprint_crud_roundtrip_and_default() {
    let path = temp_repo_path("blueprint");
    let mut db = RepoDb::create(&path, "蓝图仓库").expect("创建仓库失败");
    assert_eq!(db.schema_version().expect("读版本失败"), 6);

    assert_eq!(db.count_blueprints("repo-1").expect("统计失败"), 0);

    let json = valid_blueprint_json();
    let row = db
        .create_blueprint("repo-1", "默认联动", &json)
        .expect("创建蓝图失败");
    assert_eq!(row.is_default, false);
    assert_eq!(row.schema_version, BLUEPRINT_SCHEMA_VERSION);
    assert!(!row.id.is_empty());

    let got = db
        .get_blueprint(&row.id)
        .expect("查询失败")
        .expect("蓝图应存在");
    assert_eq!(got.name, "默认联动");
    assert_eq!(got.blueprint_json, json);
    assert_eq!(db.count_blueprints("repo-1").expect("统计失败"), 1);

    // 整文档替换（save = 覆盖）
    let updated = db
        .save_blueprint("repo-1", &row.id, "改名后", &json)
        .expect("保存失败");
    assert_eq!(updated.name, "改名后");
    assert_eq!(db.list_blueprints("repo-1").expect("列出失败").len(), 1);

    // 默认蓝图唯一：设默认后再建第二个并设默认，前一个被清除
    db.set_default_blueprint("repo-1", &row.id)
        .expect("设默认失败");
    let def = db
        .get_default_blueprint("repo-1")
        .expect("读默认失败")
        .expect("应有默认");
    assert_eq!(def.id, row.id);
    let row2 = db
        .create_blueprint("repo-1", "第二份", &json)
        .expect("创建第二份失败");
    db.set_default_blueprint("repo-1", &row2.id)
        .expect("切换默认失败");
    let def = db
        .get_default_blueprint("repo-1")
        .expect("读默认失败")
        .expect("应有默认");
    assert_eq!(def.id, row2.id);
    assert_eq!(db.list_blueprints("repo-1").expect("列出失败").len(), 2);

    // 删除默认蓝图 → get_default_blueprint 回退为 None（消费层回退内置默认）
    db.delete_blueprint(&row2.id).expect("删除失败");
    assert!(db
        .get_default_blueprint("repo-1")
        .expect("读默认失败")
        .is_none());

    // 保存到不存在的蓝图 / 删除不存在的蓝图 → NotFound
    assert!(db
        .save_blueprint("repo-1", "missing", "x", &json)
        .is_err());
    assert!(db.delete_blueprint("missing").is_err());

    db.close().expect("关闭失败");
}

#[test]
fn blueprint_repo_isolation_across_repos() {
    // 两个仓库库文件各自的蓝图互不可见（D30：定义按仓库持久化）。
    let mut db_a = RepoDb::create(temp_repo_path("iso-a"), "仓库A").expect("创建A失败");
    let row = db_a
        .create_blueprint("repo-a", "A 的蓝图", &valid_blueprint_json())
        .expect("创建失败");
    drop(db_a);

    let db_b = RepoDb::create(temp_repo_path("iso-b"), "仓库B").expect("创建B失败");
    assert_eq!(db_b.list_blueprints("repo-b").expect("列出失败").len(), 0);
    assert!(db_b.get_blueprint(&row.id).expect("查询失败").is_none());
    db_b.close().expect("关闭失败");
}

#[test]
fn blueprint_template_copy_semantics() {
    let global_path = temp_global_path("bp-template");
    let mut g = GlobalDb::open(&global_path).expect("打开全局库失败");
    assert_eq!(g.list_blueprint_templates().expect("列出模板失败").len(), 0);

    let json = valid_blueprint_json();
    let tpl = g
        .create_blueprint_template("标签页组模板", Some("互斥标签页组示例"), &json)
        .expect("创建模板失败");
    assert_eq!(tpl.schema_version, BLUEPRINT_SCHEMA_VERSION);

    let got = g
        .get_blueprint_template(&tpl.id)
        .expect("查询模板失败")
        .expect("模板应存在");
    assert_eq!(got.name, "标签页组模板");
    assert_eq!(got.description.as_deref(), Some("互斥标签页组示例"));
    assert_eq!(got.blueprint_json, json);

    // UPSERT 不产生重复
    let mut updated = got.clone();
    updated.name = "模板改名".into();
    g.upsert_blueprint_template(&updated).expect("更新模板失败");
    assert_eq!(g.list_blueprint_templates().expect("列出模板失败").len(), 1);

    // 删除模板
    g.remove_blueprint_template(&tpl.id).expect("删除模板失败");
    assert!(g.get_blueprint_template(&tpl.id).expect("查询失败").is_none());

    // 模板安装语义由命令层组合（模板 → 复制进仓库 blueprints 表）：
    // 复制后与模板脱离 —— 修改模板 JSON 不影响已复制蓝图。
    let tpl2 = g
        .create_blueprint_template("可复制模板", None, &json)
        .expect("创建模板2失败");
    let repo_path = temp_repo_path("tpl-copy");
    let mut db = RepoDb::create(&repo_path, "复制仓库").expect("创建仓库失败");
    let row = db
        .create_blueprint("repo-c", "从模板复制", &tpl2.blueprint_json)
        .expect("复制到仓库失败");
    assert_eq!(row.blueprint_json, tpl2.blueprint_json);

    let mut changed = tpl2.clone();
    changed.blueprint_json = r#"{"schema_version":1,"nodes":[],"edges":[]}"#.into();
    g.upsert_blueprint_template(&changed).expect("修改模板失败");
    let copied = db
        .get_blueprint(&row.id)
        .expect("查询失败")
        .expect("蓝图应存在");
    assert_eq!(
        copied.blueprint_json, json,
        "复制后与模板脱离：模板修改不影响已复制蓝图"
    );
    db.close().expect("关闭失败");
}

#[test]
fn validate_rejects_all_spec_errors() {
    // 悬空引用
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","panel_id":"viewer"},
          {"key":"a","type":"action","op":"show","target":"c"}
        ],"edges":[{"from":"ghost","to":"a","kind":"fires","order":1}]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("不存在的起点")));

    // 未知节点类型（JSON 解析层报错）
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[{"key":"x","type":"magic"}],"edges":[]}"#,
    );
    assert!(!errors.is_empty());

    // key 重复
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","panel_id":"viewer"},
          {"key":"c","type":"control","panel_id":"player"}
        ],"edges":[]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("key 重复")));

    // 互斥组 default_visible 多于一个
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c1","type":"control","panel_id":"viewer"},
          {"key":"c2","type":"control","panel_id":"player"},
          {"key":"g","type":"group","mode":"exclusive","default_visible":["c1","c2"]}
        ],"edges":[]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("default_visible 至多一个成员")));

    // 非法 hide_direction（toward 指向非组）
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","panel_id":"viewer"},
          {"key":"g","type":"group","mode":"exclusive","hide_direction":"toward:c"}
        ],"edges":[]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("必须是组节点")));

    // 非法 hide_direction 值（解析层报错）
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"g","type":"group","mode":"exclusive","hide_direction":"diagonal"}
        ],"edges":[]}"#,
    );
    assert!(!errors.is_empty());

    // 条件表达式不支持
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"cond","type":"condition","expr":"rating == 3"}
        ],"edges":[]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("不支持的条件")));

    // 环（fires/guards 求值链）
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","panel_id":"viewer"},
          {"key":"ca","type":"condition","expr":"media_type == image"},
          {"key":"cb","type":"condition","expr":"media_type == video"},
          {"key":"a","type":"action","op":"show","target":"c"}
        ],"edges":[
          {"from":"ca","to":"cb","kind":"fires","order":1},
          {"from":"cb","to":"ca","kind":"fires","order":1},
          {"from":"cb","to":"a","kind":"guards","order":1}
        ]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("存在环")));
}

#[test]
fn graph_document_roundtrip_preserves_semantics() {
    let json = valid_blueprint_json();
    let graph = assert_valid(&json);
    // 关键语义抽查
    assert!(graph.nodes.iter().any(|n| n.node_type == NodeType::Control));
    let group = graph
        .nodes
        .iter()
        .find(|n| n.node_type == NodeType::Group)
        .expect("应有组节点");
    assert_eq!(
        group.hide_direction.as_ref().map(|d| d.as_str()),
        Some("left".to_string())
    );
    assert!(matches!(
        group.hide_direction,
        Some(HideDirection::Left)
    ));
    assert_eq!(group.position.as_ref().map(|p| (p.x, p.y)), Some((0.0, 0.0)));
    // 序列化 → 再解析 → 语义一致
    let back = BlueprintGraph::from_json(&graph.to_json()).expect("再解析失败");
    assert_eq!(back, graph);
}

#[test]
fn default_blueprint_fixture_validates() {
    // 夹具由 packages/config DEFAULT_BLUEPRINT 生成（node 序列化导出）：
    // 内置默认蓝图必须通过服务端校验，否则仓库种子默认蓝图会失败（表现为"没有默认蓝图"）。
    let json = include_str!("default_blueprint.json");
    let graph = BlueprintGraph::from_json(json).expect("解析默认蓝图失败");
    let errors = graph.validate();
    assert!(errors.is_empty(), "默认蓝图校验失败: {errors:?}");
    assert_eq!(graph.nodes.len(), 23, "默认蓝图应有 23 个节点");
    assert_eq!(graph.edges.len(), 20, "默认蓝图应有 20 条边");
    // 结构：布局块 ⊃ 标签组/控件；标签组 ⊃ 控件（contains）
    assert!(graph
        .edges
        .iter()
        .any(|e| e.from == "g_viewers" && e.to == "c_viewer" && e.edge_kind == hp_core::EdgeKind::Contains));
    assert!(graph
        .edges
        .iter()
        .any(|e| e.from == "blk_right" && e.to == "c_meta" && e.edge_kind == hp_core::EdgeKind::Contains));
    // 规则三元组：对象 → 操作 → 状态（on 边 + fires 边，全部连线）
    assert!(graph
        .edges
        .iter()
        .any(|e| e.from == "o_img" && e.to == "e_dbl_img" && e.edge_kind == hp_core::EdgeKind::On));
    assert!(graph
        .edges
        .iter()
        .any(|e| e.from == "e_dbl_img" && e.to == "a_show_viewer" && e.edge_kind == hp_core::EdgeKind::Fires));
    // 操作节点无 target 字段（靠 on 边驱动）
    let ev = graph.nodes.iter().find(|n| n.key == "e_dbl_img").expect("应有操作节点");
    assert!(ev.target.is_none());
    assert_eq!(graph.default_version, Some(2));
}

#[test]
fn builtin_template_row_crud() {
    let global_path = temp_global_path("tpl-row");
    let mut g = GlobalDb::open(&global_path).expect("打开全局库失败");
    let row = BlueprintTemplateRow {
        id: "tpl-manual".into(),
        name: "手工模板".into(),
        description: Some("描述".into()),
        schema_version: BLUEPRINT_SCHEMA_VERSION,
        blueprint_json: valid_blueprint_json(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
    };
    g.upsert_blueprint_template(&row).expect("写入失败");
    let got = g
        .get_blueprint_template("tpl-manual")
        .expect("查询失败")
        .expect("应存在");
    assert_eq!(got, row);
    g.remove_blueprint_template("tpl-manual").expect("删除失败");
    assert!(g
        .get_blueprint_template("tpl-manual")
        .expect("查询失败")
        .is_none());
}
