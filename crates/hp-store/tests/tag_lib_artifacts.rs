//! RFC 0008 四库产物集成测试：用**真实构建产物**验证聚合层可用。
//!
//! 这些测试只在产物存在时运行（CI 无产物时跳过），目的是防止「管线产出的 schema
//! 与 Rust 侧读取代码漂移」——这正是旧 `TagDictDb` 与新库文件错配会造成的故障。

use std::path::PathBuf;

use hp_core::LibLayer;
use hp_store::{TagLibDb, TagLibSet};

/// 定位仓库内产物（`CARGO_MANIFEST_DIR` = crates/hp-store）。
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("仓库根")
        .to_path_buf()
}

fn base_lib() -> Option<PathBuf> {
    let p = repo_root().join("tools/tagdict/output/tag_lib_base.sqlite3");
    p.is_file().then_some(p)
}

fn full_lib() -> Option<PathBuf> {
    let p = repo_root().join("tools/tagdict/output/tag_lib.sqlite");
    p.is_file().then_some(p)
}

/// 内置基底库能被只读打开，且用户示例六种写法命中同一 work 概念（D37）。
#[test]
fn base_lib_opens_and_resolves_user_example() {
    let Some(path) = base_lib() else {
        eprintln!("跳过：未找到 tag_lib_base.sqlite3（先运行 tools/tagdict/build_base_lib.py）");
        return;
    };
    let db = TagLibDb::open_readonly(&path, LibLayer::Base).expect("只读打开基底库");
    assert!(db.count().unwrap() > 1000, "基底库概念数应远超 1000");

    let mut set = TagLibSet::new();
    set.add(db);

    // D37 用户示例：六种写法命中同一概念
    let anchor = "tag-1a4deaf60eceb34a";
    for q in [
        "碧蓝档案",
        "蔚蓝档案",
        "ブルーアーカイブ",
        "ブルアカ",
        "BlueArchive",
        "Blue Archive",
    ] {
        let hits = set.find(q, 50).expect("查询");
        assert!(
            hits.iter().any(|d| d.concept.id == anchor),
            "查询 {q} 应命中 {anchor}，实际 {:?}",
            hits.iter().map(|d| &d.concept.id).collect::<Vec<_>>()
        );
    }

    // 三语标准名齐备（D37 三语对等）
    let detail = set.merged_concept(anchor).unwrap().expect("锚点概念存在");
    let std_langs: Vec<&str> = detail
        .names
        .iter()
        .filter(|n| n.kind == hp_core::TagNameKind::Standard)
        .map(|n| n.lang.as_str())
        .collect();
    for lang in ["zh", "ja", "en"] {
        assert!(std_langs.contains(&lang), "应含 {lang} 标准名，实际 {std_langs:?}");
    }
    assert_eq!(detail.layer, LibLayer::Base);
}

/// 库 2 内置关系树可读，且用户示例两棵树的父子关系可还原（D34）。
#[test]
fn base_lib_lib2_relations_roundtrip() {
    let Some(path) = base_lib() else {
        eprintln!("跳过：未找到 tag_lib_base.sqlite3");
        return;
    };
    let mut set = TagLibSet::new();
    set.add(TagLibDb::open_readonly(&path, LibLayer::Base).unwrap());

    let nodes = set.relation_nodes().expect("构建参考树");
    assert!(!nodes.is_empty(), "基底库应含内置关系树");
    // 多父级 DAG 语义：存在带父级的节点
    assert!(
        nodes.iter().any(|n| !n.parents.is_empty()),
        "关系树应有父子结构"
    );
    // 用户示例中的「初音未来」应有子级（雪未来 / 樱未来 / fufu）
    let miku = nodes
        .iter()
        .find(|n| n.display_name == "初音未来")
        .expect("关系树应含「初音未来」");
    assert!(
        miku.children.len() >= 3,
        "初音未来应有 >=3 个子级，实际 {:?}",
        miku.children
    );
}

/// 全量库（扩展包源）能被只读打开，规模符合 RFC 0008 记录。
#[test]
fn full_lib_opens_with_expected_scale() {
    let Some(path) = full_lib() else {
        eprintln!("跳过：未找到 tag_lib.sqlite（先运行 tools/tagdict/build_tag_lib.py）");
        return;
    };
    let db = TagLibDb::open_readonly(&path, LibLayer::Extension).expect("只读打开全量库");
    // RFC 0008「实施结果」记录概念 306,844
    assert_eq!(db.count().unwrap(), 306_844, "概念数应与 RFC 0008 记录一致");
    assert_eq!(
        db.meta("source").unwrap().as_deref(),
        Some("extension"),
        "lib_meta.source 应标为 extension"
    );

    // artist 全量纳入（D35）：库 3 艺术家行数应为 142,959
    let detail = db.concept("tag-1a4deaf60eceb34a").unwrap().unwrap();
    assert!(detail.work.is_some(), "该概念应带库 3 原作字段");
    assert_eq!(detail.sources.len(), 11, "该概念的生态来源应有 11 条");
}
