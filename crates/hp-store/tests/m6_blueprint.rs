//! M6 验收测试：蓝图（RFC 0007 / D28-D60）。
//! 覆盖：仓库库蓝图存储往返、默认蓝图唯一与回退、模板复制、语义校验拒绝、
//! 分层/浮层校验、v1→v2 文档迁移，以及 hp-core 图文档 JSON 往返。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M6/M7 验证线。

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

/// 最小合法蓝图图文档（单层 + 面板控件 + 互斥组 + 事件→动作），当前 schema 版本。
fn valid_blueprint_json() -> String {
    r#"{
      "schema_version": 2,
      "layers": [{"key":"l_main","name":"主界面"}],
      "nodes": [
        {"key":"ui","type":"interface","layer":"l_main","position":{"x":40,"y":40}},
        {"key":"c_preview","type":"control","layer":"l_main","panel_id":"media","title_key":"panel.media"},
        {"key":"c_viewer","type":"control","layer":"l_main","panel_id":"viewer","title_key":"panel.viewer"},
        {"key":"k_image","type":"class","layer":"l_main","control":"c_preview","media_type":"image"},
        {"key":"o_img","type":"object","layer":"l_main","class":"k_image","scope":"double_clicked"},
        {"key":"g_viewers","type":"group","layer":"l_main","mode":"exclusive","default_visible":[],
         "hide_direction":"left","position":{"x":0,"y":0}},
        {"key":"e_dbl","type":"event","layer":"l_main","trigger":"double_click","target":"o_img"},
        {"key":"a_show","type":"action","layer":"l_main","op":"show","target":"c_viewer"}
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
    assert_eq!(db.schema_version().expect("读版本失败"), 7);

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
    // 1) 两个仓库库文件各自的蓝图互不可见（D30：定义按仓库持久化）。
    let mut db_a = RepoDb::create(temp_repo_path("iso-a"), "仓库A").expect("创建A失败");
    let row = db_a
        .create_blueprint("repo-a", "A 的蓝图", &valid_blueprint_json())
        .expect("创建失败");
    drop(db_a);

    let db_b = RepoDb::create(temp_repo_path("iso-b"), "仓库B").expect("创建B失败");
    assert_eq!(db_b.list_blueprints("repo-b").expect("列出失败").len(), 0);
    assert!(db_b.get_blueprint(&row.id).expect("查询失败").is_none());
    db_b.close().expect("关闭失败");

    // 2) **同一张表里的两个 repo_id** 必须互相不可见：真正跑一遍 `WHERE repo_id` 过滤。
    //    只用两个库文件时，过滤条件一次都没被验证过（空库怎么查都是 0 行）。
    let mut db = RepoDb::create(temp_repo_path("iso-same-db"), "同库双仓库").expect("创建失败");
    let a = db
        .create_blueprint("repo-a", "A 的蓝图", &valid_blueprint_json())
        .expect("创建 A 失败");
    let b = db
        .create_blueprint("repo-b", "B 的蓝图", &valid_blueprint_json())
        .expect("创建 B 失败");
    db.set_default_blueprint("repo-a", &a.id).expect("设 A 默认失败");
    db.set_default_blueprint("repo-b", &b.id).expect("设 B 默认失败");

    let listed_a = db.list_blueprints("repo-a").expect("列出 A 失败");
    assert_eq!(listed_a.len(), 1, "只应看到本仓库的蓝图");
    assert_eq!(listed_a[0].id, a.id);
    let listed_b = db.list_blueprints("repo-b").expect("列出 B 失败");
    assert_eq!(listed_b.len(), 1, "只应看到本仓库的蓝图");
    assert_eq!(listed_b[0].id, b.id);

    assert_eq!(
        db.get_default_blueprint("repo-a")
            .expect("查询 A 默认失败")
            .map(|r| r.id),
        Some(a.id),
        "默认蓝图按仓库隔离（D30）"
    );
    assert_eq!(
        db.get_default_blueprint("repo-b")
            .expect("查询 B 默认失败")
            .map(|r| r.id),
        Some(b.id),
        "默认蓝图按仓库隔离（D30）"
    );
    db.close().expect("关闭失败");
}

#[test]
fn save_path_normalizes_document_and_version_column() {
    // D58：文档内 `schema_version` 为权威，列必须**同步**——save 路径也要归一化，
    // 不能只在 create 路径归一化（否则"保存旧文档"会把 v1 与列 2 写在一起）。
    let path = temp_repo_path("save-version");
    let mut db = RepoDb::create(&path, "版本仓库").expect("创建失败");
    let row = db
        .create_blueprint("repo-s", "旧图", &valid_blueprint_json())
        .expect("创建失败");

    let v1 = r#"{"schema_version":1,"nodes":[{"key":"ui","type":"interface","name":"主界面"}],"edges":[]}"#;
    let saved = db
        .save_blueprint("repo-s", &row.id, "旧图", v1)
        .expect("保存失败");
    assert_eq!(saved.schema_version, BLUEPRINT_SCHEMA_VERSION);
    let graph = BlueprintGraph::from_json(&saved.blueprint_json).expect("解析失败");
    assert_eq!(
        graph.schema_version, BLUEPRINT_SCHEMA_VERSION,
        "保存后文档内版本应为当前版本（D58）"
    );
    assert_eq!(graph.layers.len(), 1, "v1 → v2 迁移应补出层（D51）");

    let stored = db
        .get_blueprint(&row.id)
        .expect("查询失败")
        .expect("蓝图应存在");
    assert_eq!(
        stored.schema_version, BLUEPRINT_SCHEMA_VERSION,
        "列版本必须与文档内版本一致（D58）"
    );
    db.close().expect("关闭失败");
}

#[test]
fn document_without_schema_version_gets_it_injected() {
    // "文档内 schema_version 为权威" 的前提是文档里**确实有**这个字段：
    // 缺字段的输入（旧调用/手写 JSON）在写库时必须补上，否则列写 2、文档没有版本，
    // 读取端（前端 `BlueprintGraph.schema_version`）会拿到 undefined。
    let path = temp_repo_path("normalize-version");
    let mut db = RepoDb::create(&path, "归一化仓库").expect("创建失败");
    let row = db
        .create_blueprint("repo-n", "无版本图", r#"{"nodes":[],"edges":[]}"#)
        .expect("创建失败");
    assert_eq!(row.schema_version, BLUEPRINT_SCHEMA_VERSION);
    assert!(
        row.blueprint_json.contains("\"schema_version\""),
        "写库后文档必须显式带 schema_version：{}",
        row.blueprint_json
    );
    db.close().expect("关闭失败");
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

    // 非法 hide_direction（toward 指向存在但类型不是组）
    let errors = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"c","type":"control","panel_id":"viewer"},
          {"key":"g","type":"group","mode":"exclusive","hide_direction":"toward:c"}
        ],"edges":[]}"#,
    );
    assert!(errors.iter().any(|e| e.contains("必须是组节点")));
    // 而指向**已删除**的组只是"未接通"（软），不阻塞保存
    let soft = BlueprintGraph::validate_json(
        r#"{"schema_version":1,"nodes":[
          {"key":"g","type":"group","mode":"exclusive","hide_direction":"toward:gone"}
        ],"edges":[]}"#,
    );
    assert!(soft.is_empty(), "{soft:?}");

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
    // 夹具由 packages/config DEFAULT_BLUEPRINT 生成：
    // `pnpm generate:blueprint-fixture`（tools/generate-blueprint-fixture.mjs）。
    // 内置默认蓝图必须通过服务端校验，否则仓库种子默认蓝图会失败（表现为"没有默认蓝图"）。
    let json = include_str!("default_blueprint.json");
    let graph = BlueprintGraph::from_json(json).expect("解析默认蓝图失败");
    let errors = graph.validate();
    assert!(errors.is_empty(), "默认蓝图校验失败: {errors:?}");
    assert_eq!(graph.nodes.len(), 27, "默认蓝图应有 27 个节点");
    assert_eq!(graph.edges.len(), 26, "默认蓝图应有 26 条边");
    assert_eq!(graph.default_version, Some(7), "引入分层后内置默认升版（D51）");

    // 分层（D51）：内置默认是**单层「主界面」**，每个节点都带 layer 归属。
    assert_eq!(graph.schema_version, BLUEPRINT_SCHEMA_VERSION);
    assert_eq!(graph.layers.len(), 1, "内置默认蓝图应是单层");
    assert_eq!(graph.layers[0].key, "l_main");
    assert_eq!(graph.layers[0].name, "主界面");
    assert!(
        graph.nodes.iter().all(|n| n.layer.as_deref() == Some("l_main")),
        "默认蓝图每个节点都必须归属 l_main"
    );

    // 顶层界面节点（页面，D47）：每层至多一个；界面显示名取自层名，不另存 name。
    let interfaces: Vec<&hp_core::BlueprintNode> = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == NodeType::Interface)
        .collect();
    assert_eq!(interfaces.len(), 1, "内置默认蓝图应有且仅有一个界面节点（ui）");
    assert_eq!(interfaces[0].key, "ui");
    assert!(interfaces[0].name.is_none(), "界面显示名取自层名（D51）");
    for block in ["blk_left", "blk_center", "blk_right"] {
        assert!(
            graph.edges.iter().any(|e| e.from == "ui"
                && e.to == block
                && e.edge_kind == hp_core::EdgeKind::Contains),
            "界面节点应包含 {block}"
        );
    }
    assert!(
        !graph
            .edges
            .iter()
            .any(|e| e.from == "ui" && !e.to.starts_with("blk_")),
        "界面节点只应连布局块"
    );

    // 结构：布局块 ⊃ 标签组 ⊃ 控件（**标签组优先**）
    // 中栏只有一个标签组 g_media，布局块不直接连成员控件。
    assert!(graph.edges.iter().any(|e| e.from == "blk_center"
        && e.to == "g_media"
        && e.edge_kind == hp_core::EdgeKind::Contains));
    assert!(
        !graph.edges.iter().any(|e| e.from == "blk_center"
            && e.edge_kind == hp_core::EdgeKind::Contains
            && e.to != "g_media"),
        "中栏（blk_center）应只包含标签组，不应直接连控件"
    );
    for member in ["c_media", "c_viewer", "c_player"] {
        assert!(
            graph.edges.iter().any(|e| e.from == "g_media"
                && e.to == member
                && e.edge_kind == hp_core::EdgeKind::Contains),
            "g_media 应包含 {member}"
        );
    }
    // 右栏同理：只有一个标签组 g_inspector。
    assert!(graph.edges.iter().any(|e| e.from == "blk_right"
        && e.to == "g_inspector"
        && e.edge_kind == hp_core::EdgeKind::Contains));
    assert!(!graph.edges.iter().any(|e| e.from == "blk_right"
        && e.edge_kind == hp_core::EdgeKind::Contains
        && e.to != "g_inspector"));
    for member in ["c_color", "c_tags", "c_metadata"] {
        assert!(
            graph.edges.iter().any(|e| e.from == "g_inspector"
                && e.to == member
                && e.edge_kind == hp_core::EdgeKind::Contains),
            "g_inspector 应包含 {member}"
        );
    }
    // 左栏是三个独立面板（无标签组）：布局块直接连控件。
    assert!(graph.edges.iter().any(|e| e.from == "blk_left"
        && e.to == "c_repo"
        && e.edge_kind == hp_core::EdgeKind::Contains));

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

    // 如实表达当前默认「媒体-测试」布局：中栏 = 媒体预览 + 查看器/播放器；
    // 右栏 = 色彩参考/标签·评分/元数据；左栏 = 仓库/媒体源/相册。
    let panel_ids: Vec<&str> = graph
        .nodes
        .iter()
        .filter(|n| n.node_type == NodeType::Control)
        .filter_map(|n| n.panel_id.as_deref())
        .collect();
    for expected in [
        "repo", "sources", "albums", "media", "viewer", "player", "color", "tags", "metadata",
    ] {
        assert!(panel_ids.contains(&expected), "默认蓝图缺少面板控件: {expected}");
    }
    // 「媒体-测试」布局未挂载 tag表/任务，默认蓝图不表达它们。
    assert!(!panel_ids.contains(&"tagtable"));
    assert!(!panel_ids.contains(&"tasks"));
}

#[test]
fn legacy_v1_document_is_migrated_on_write() {
    // v1 文档（无分层）落库时归一化到当前版本（D52/D58）：层由界面节点拆出、
    // 节点补 layer、列版本与文档版本一致。
    let path = temp_repo_path("blueprint-migrate");
    let mut db = RepoDb::create(&path, "迁移仓库").expect("创建仓库失败");
    let v1 = r#"{
      "schema_version": 1,
      "default_version": 6,
      "nodes": [
        {"key":"ui","type":"interface","name":"主界面","position":{"x":40,"y":40}},
        {"key":"c_preview","type":"control","panel_id":"media"},
        {"key":"e_dbl","type":"event","trigger":"double_click","target":"c_preview"},
        {"key":"a_show","type":"action","op":"show","target":"c_preview"}
      ],
      "edges": [{"from":"e_dbl","to":"a_show","kind":"fires","order":1}]
    }"#;
    let row = db
        .create_blueprint("repo-1", "旧图", v1)
        .expect("创建蓝图失败");
    assert_eq!(
        row.schema_version, BLUEPRINT_SCHEMA_VERSION,
        "列版本必须同步为当前版本（D58）"
    );
    let graph = BlueprintGraph::from_json(&row.blueprint_json).expect("解析失败");
    assert_eq!(graph.schema_version, BLUEPRINT_SCHEMA_VERSION);
    assert_eq!(graph.layers.len(), 1, "界面节点应拆出一个层");
    assert_eq!(graph.layers[0].name, "主界面");
    assert_eq!(graph.default_version, Some(6), "内置默认标记保留");
    assert!(
        graph.nodes.iter().all(|n| n.layer.as_deref() == Some("l_ui")),
        "所有节点应补上层归属"
    );
    assert!(graph.validate().is_empty(), "{:?}", graph.validate());

    // 已是当前版本 → 落库原样（不做无谓改写）
    let current = valid_blueprint_json();
    let row = db
        .create_blueprint("repo-1", "新图", &current)
        .expect("创建第二份失败");
    assert_eq!(row.blueprint_json, current);
    db.close().expect("关闭失败");
}

/// 默认蓝图的节点坐标必须互不重叠（打开编辑器即可读清结构；用户要求）。
#[test]
fn default_blueprint_nodes_do_not_overlap() {
    let json = include_str!("default_blueprint.json");
    let graph = BlueprintGraph::from_json(json).expect("解析默认蓝图失败");
    // 画布节点卡片近似占位（宽 220、高 100），用于重叠判定。
    const W: f64 = 220.0;
    const H: f64 = 100.0;
    let boxes: Vec<(&str, f64, f64)> = graph
        .nodes
        .iter()
        .map(|n| {
            let p = n.position.as_ref().expect("默认蓝图节点必须带 position");
            (n.key.as_str(), p.x, p.y)
        })
        .collect();
    for (i, (ka, xa, ya)) in boxes.iter().enumerate() {
        for (kb, xb, yb) in boxes.iter().skip(i + 1) {
            let overlap_x = (xa - xb).abs() < W;
            let overlap_y = (ya - yb).abs() < H;
            assert!(
                !(overlap_x && overlap_y),
                "默认蓝图节点重叠: {ka}({xa},{ya}) 与 {kb}({xb},{yb})"
            );
        }
    }
}

/// 工厂夹具必须通过真实校验：`tools/blueprint-node-check.mjs` 用编辑器真实的
/// "新增节点"工厂（`apps/desktop/src/app_ui/panels/blueprintNodeFactory.ts`）构造
/// 文档并写入 `tests/blueprint_factory/`，这里逐份跑 hp-core 校验。
///
/// 守住的是真实故障：新增对象节点没有 `class` → 保存报
/// "对象节点 o_1 的 class 必须是类节点 key（当前: ）"。
#[test]
fn factory_built_docs_validate() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("blueprint_factory");
    let entries = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("读取工厂夹具目录失败 {}: {e}", dir.display()));
    let mut checked = 0;
    for entry in entries {
        let path = entry.expect("读取夹具失败").path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let json = std::fs::read_to_string(&path).expect("读取夹具失败");
        let graph = BlueprintGraph::from_json(&json)
            .unwrap_or_else(|e| panic!("夹具解析失败 {}: {e}", path.display()));
        let errors = graph.validate();
        assert!(
            errors.is_empty(),
            "工厂产出的文档未通过校验 {}: {errors:?}",
            path.display()
        );
        checked += 1;
    }
    assert!(checked > 0, "没有找到工厂夹具（先跑 pnpm check:blueprint-nodes）");
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
