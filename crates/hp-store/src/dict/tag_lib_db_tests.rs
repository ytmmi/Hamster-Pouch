// 四库测试夹具（RFC 0008 / D33-D37）。
//
// 本文件由 `tag_lib_db.rs` 的 `mod tests` 以 `include!` 展开：拆的是**文件**不是模块，
// 因此 `super::*`（句柄/行映射/写入/聚合层）与私有字段照旧可见。
// 注：用 `include!` 内联展开，故本文件不使用内层文档注释（`//!`）。

fn concept(id: &str, kind: TagKind, pop: i64) -> TagConcept {
    TagConcept {
        id: id.into(),
        kind,
        nsfw: false,
        popularity: Some(pop),
        extra_json: None,
    }
}

fn name(tag_id: &str, lang: &str, value: &str, kind: TagNameKind) -> TagName {
    TagName {
        tag_id: tag_id.into(),
        lang: lang.into(),
        value: value.into(),
        kind,
    }
}

fn src(tag_id: &str, source: &str, key: &str, pop: i64) -> LibTagSource {
    LibTagSource {
        tag_id: tag_id.into(),
        source: source.into(),
        source_key: key.into(),
        popularity: Some(pop),
    }
}

/// 用户库可写：写入概念后能按任意语言命中（D37 三语对等）。
#[test]
fn user_db_roundtrip_multilingual() {
    let dir = tempdir().unwrap();
    let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
    assert_eq!(db.layer(), LibLayer::User);

    let c = concept("tag-ba", TagKind::Work, 100);
    let names = vec![
        name("tag-ba", "zh", "蔚蓝档案", TagNameKind::Standard),
        name("tag-ba", "zh", "碧蓝档案", TagNameKind::Alias),
        name("tag-ba", "ja", "ブルーアーカイブ", TagNameKind::Standard),
        name("tag-ba", "en", "Blue Archive", TagNameKind::Standard),
    ];
    let sources = vec![src("tag-ba", "manual", "蔚蓝档案", 100)];
    let work = TagWork { tag_id: "tag-ba".into(), short_name: Some("BA".into()), medium: Some("game".into()) };
    db.upsert_concept(&c, &names, &sources, None, None, Some(&work)).unwrap();

    assert_eq!(db.count().unwrap(), 1);
    // 任意语言与别名都应命中同一概念（D37 用户示例）
    for q in ["蔚蓝档案", "碧蓝档案", "ブルーアーカイブ", "Blue Archive"] {
        assert_eq!(db.find_by_name(q, 10).unwrap(), vec!["tag-ba"], "查询 {q}");
    }
    let detail = db.concept("tag-ba").unwrap().unwrap();
    assert_eq!(detail.names.len(), 4);
    assert_eq!(detail.work.unwrap().tag_id, "tag-ba");
}

/// D37 硬约束：每 (tag, lang) 至多一个 standard（由唯一索引强制）。
#[test]
fn duplicate_standard_name_rejected() {
    let dir = tempdir().unwrap();
    let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
    let c = concept("tag-x", TagKind::General, 1);
    db.upsert_concept(
        &c,
        &[name("tag-x", "zh", "甲", TagNameKind::Standard)],
        &[],
        None,
        None,
        None,
    )
    .unwrap();
    let err = db.upsert_concept(
        &c,
        &[name("tag-x", "zh", "乙", TagNameKind::Standard)],
        &[],
        None,
        None,
        None,
    );
    assert!(err.is_err(), "同语言第二个 standard 必须被唯一索引拒绝");
}

/// 只读层拒绝写入（数据包是只读资产，D36）。
#[test]
fn readonly_layer_rejects_write() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("base.sqlite");
    // 先建好再以只读打开
    TagLibDb::open(&path).unwrap();
    let mut ro = TagLibDb::open_readonly(&path, LibLayer::Base).unwrap();
    assert_eq!(ro.layer(), LibLayer::Base);
    let err = ro.upsert_concept(&concept("tag-y", TagKind::General, 1), &[], &[], None, None, None);
    assert!(matches!(err, Err(HpError::Permission(_))), "只读层必须拒绝写入");
}

/// 聚合层覆盖优先级：用户库 > 扩展包 > 内置基底，且名称做并集。
#[test]
fn aggregate_layer_priority_and_name_union() {
    let dir = tempdir().unwrap();

    // 基底：只有 zh 名，热度低
    let base_path = dir.path().join("base.sqlite");
    {
        let mut base = TagLibDb::open(&base_path).unwrap();
        base.upsert_concept(
            &concept("tag-ba", TagKind::Work, 10),
            &[name("tag-ba", "zh", "蔚蓝档案", TagNameKind::Standard)],
            &[src("tag-ba", "danbooru", "blue_archive", 10)],
            None,
            None,
            None,
        )
        .unwrap();
    }

    // 用户库：同名概念、热度更高、补充 ja 名
    let user_path = dir.path().join("user.sqlite");
    {
        let mut user = TagLibDb::open(&user_path).unwrap();
        user.upsert_concept(
            &concept("tag-ba", TagKind::Work, 999),
            &[name("tag-ba", "ja", "ブルーアーカイブ", TagNameKind::Standard)],
            &[src("tag-ba", "manual", "蔚蓝档案", 999)],
            None,
            None,
            None,
        )
        .unwrap();
    }

    let mut set = TagLibSet::new();
    set.add(TagLibDb::open_readonly(&base_path, LibLayer::Base).unwrap());
    set.add(TagLibDb::open_readonly(&user_path, LibLayer::User).unwrap());
    assert_eq!(set.len(), 2);

    let d = set.merged_concept("tag-ba").unwrap().unwrap();
    // 概念行取用户库（高优先级）
    assert_eq!(d.layer, LibLayer::User);
    assert_eq!(d.concept.popularity, Some(999));
    // 名称是并集：zh（来自基底）+ ja（来自用户库）
    let langs: std::collections::HashSet<_> = d.names.iter().map(|n| n.lang.as_str()).collect();
    assert!(langs.contains("zh"), "应并集保留基底的 zh 名");
    assert!(langs.contains("ja"), "应并集保留用户库的 ja 名");
    // 来源也是并集
    let srcs: std::collections::HashSet<_> =
        d.sources.iter().map(|s| s.source.as_str()).collect();
    assert!(srcs.contains("danbooru") && srcs.contains("manual"));
}

/// 库 2 参考树：多父级 DAG 与父/子查询。
#[test]
fn relation_tree_multi_parent() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("base.sqlite");
    {
        let mut db = TagLibDb::open(&path).unwrap();
        for (id, zh) in [
            ("tag-root", "根"),
            ("tag-a", "甲"),
            ("tag-b", "乙"),
            ("tag-leaf", "叶"),
        ] {
            db.upsert_concept(
                &concept(id, TagKind::General, 1),
                &[name(id, "zh", zh, TagNameKind::Standard)],
                &[],
                None,
                None,
                None,
            )
            .unwrap();
        }
        // leaf 有两个父级（多父级 DAG，D34）
        db.conn
            .execute_batch(
                "INSERT INTO tag_relation VALUES ('r1','tag-a','tag-leaf','hierarchy','2026-01-01T00:00:00Z');
                 INSERT INTO tag_relation VALUES ('r2','tag-b','tag-leaf','hierarchy','2026-01-01T00:00:00Z');
                 INSERT INTO tag_relation VALUES ('r3','tag-root','tag-a','hierarchy','2026-01-01T00:00:00Z');",
            )
            .unwrap();
    }

    let mut set = TagLibSet::new();
    set.add(TagLibDb::open_readonly(&path, LibLayer::Base).unwrap());

    let (p, c) = set.relations_of("tag-leaf").unwrap();
    assert_eq!(p.len(), 2, "叶节点应有两个父级（多父级 DAG）");
    assert!(c.is_empty());

    let nodes = set.relation_nodes().unwrap();
    let leaf = nodes.iter().find(|n| n.tag_id == "tag-leaf").unwrap();
    assert_eq!(leaf.display_name, "叶");
    assert_eq!(leaf.parents.len(), 2);
    let a = nodes.iter().find(|n| n.tag_id == "tag-a").unwrap();
    assert_eq!(a.children, vec!["tag-leaf"]);
}

/// 前缀建议：任意语言命中并按热度排序。
#[test]
fn suggest_prefix_across_languages() {
    let dir = tempdir().unwrap();
    let mut db = TagLibDb::open(dir.path().join("user.sqlite")).unwrap();
    db.upsert_concept(
        &concept("tag-1", TagKind::Work, 50),
        &[name("tag-1", "zh", "蔚蓝档案", TagNameKind::Standard)],
        &[],
        None,
        None,
        None,
    )
    .unwrap();
    db.upsert_concept(
        &concept("tag-2", TagKind::General, 500),
        &[name("tag-2", "en", "Blue Sky", TagNameKind::Standard)],
        &[],
        None,
        None,
        None,
    )
    .unwrap();

    let mut set = TagLibSet::new();
    set.add(db);
    let hits = set.suggest("Blue", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].concept.id, "tag-2");
}
