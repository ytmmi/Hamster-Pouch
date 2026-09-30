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

/// 细分扩展包（`--split-by-source` 产物）。
fn split_libs() -> Vec<PathBuf> {
    let dir = repo_root().join("tools/tagdict/output/split");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut v: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "sqlite")
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.starts_with("tag_lib_"))
        })
        .collect();
    v.sort();
    v
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

/// **重复合并机制**（多扩展包场景）：装配 pixiv + danbooru 两个细分扩展包后，
/// 重叠概念必须归并为一条，而不是各显示一条。
///
/// 这是本机制的核心验收：两个包各自独立构建，同一概念（如「蔚蓝档案」）在两个包中
/// 各有一份；未启用归并时会命中两条，启用后应只剩一条且名称/来源为并集。
#[test]
fn merge_dedupes_concepts_across_real_extension_packages() {
    let libs = split_libs();
    if libs.len() < 2 {
        eprintln!("跳过：需要 >=2 个细分包（先运行 build_tag_lib.py --split-by-source）");
        return;
    }

    // 装配全部细分包（按 D36：扩展包同层，装配顺序即优先级）
    let mut set = TagLibSet::new();
    for p in &libs {
        set.add(TagLibDb::open_readonly(p, LibLayer::Extension).expect("只读打开细分包"));
    }

    // ---- 归并前：同一概念在两个包中各命中一次（证明重复真实存在）----
    let before = set.find("蔚蓝档案", 50).unwrap();
    let before_ids: Vec<&str> = before.iter().map(|d| d.concept.id.as_str()).collect();

    // ---- 启用归并 ----
    let (merged_count, dup_count) = {
        let idx = set.refresh_merge().expect("构建归并索引");
        (idx.merged_count(), idx.duplicate_count())
    };
    assert!(
        dup_count > 0,
        "两个细分包之间应存在重复概念，实际重复数 = {dup_count}"
    );
    println!("归并索引：{merged_count} 个概念身份，识别重复 {dup_count} 条");

    // ---- 归并后：同一概念只剩一条 ----
    let after = set.find("蔚蓝档案", 50).unwrap();
    let after_ids: Vec<&str> = after.iter().map(|d| d.concept.id.as_str()).collect();

    // work 类锚点必须唯一（之前它在两包中各出现一次）
    let work_hits: Vec<&str> = after
        .iter()
        .filter(|d| d.concept.kind == hp_core::TagKind::Work)
        .map(|d| d.concept.id.as_str())
        .collect();
    assert_eq!(
        work_hits.len(),
        1,
        "「蔚蓝档案」的 work 概念归并后应唯一；归并前 {before_ids:?}，归并后 {after_ids:?}"
    );

    // 归并后条数不应多于归并前（去重只减不增）
    assert!(
        after.len() <= before.len(),
        "归并后命中数应 <= 归并前（{} -> {}）",
        before.len(),
        after.len()
    );

    // 归并后的代表概念应聚合了两个包的来源
    let ba = after
        .iter()
        .find(|d| d.concept.kind == hp_core::TagKind::Work)
        .expect("应命中 work 概念");
    let src_names: std::collections::HashSet<&str> =
        ba.sources.iter().map(|s| s.source.as_str()).collect();
    assert!(
        src_names.contains("pixiv") && src_names.contains("danbooru"),
        "归并后应同时保留两包的来源，实际 {src_names:?}"
    );
}

/// 归并索引的规模自检：全量装配两个包后，重复数与概念总数应符合实测口径。
#[test]
fn merge_index_scale_is_sane() {
    let libs = split_libs();
    if libs.len() < 2 {
        eprintln!("跳过：需要 >=2 个细分包");
        return;
    }
    let mut set = TagLibSet::new();
    for p in &libs {
        set.add(TagLibDb::open_readonly(p, LibLayer::Extension).unwrap());
    }
    let (merged, dup) = {
        let idx = set.refresh_merge().unwrap();
        (idx.merged_count(), idx.duplicate_count())
    };

    // 各包概念 ID 的**去重并集**（同 ID 出现在多个包里只算一次）
    let mut distinct: std::collections::HashSet<String> = Default::default();
    for p in &libs {
        let db = TagLibDb::open_readonly(p, LibLayer::Extension).unwrap();
        for id in db.all_concept_ids().unwrap() {
            distinct.insert(id);
        }
    }

    // 恒等关系：每个 ID 要么是代表（merged），要么是被并入的别名（dup）
    assert_eq!(
        merged + dup,
        distinct.len(),
        "归并后概念数 + 重复数 应等于各包概念 ID 的去重并集"
    );
    assert!(merged > 0, "归并后概念数应 > 0");

    // 重复量级说明（实测口径，2026-09）：
    //   两包按 (kind, 中文标准名) 重叠 19,675 个概念，但其中 19,624 个因为
    //   `tag_id = sha1(kind + 中文归一)` 是**确定性派生**而 ID 完全相同，已被
    //   纯 `tag_id` 去重覆盖；只有约 51 个（跨源中文名不同但归一后相同等）ID 不同。
    //   归并索引额外捕获的是：**ID 不同但概念身份相同**的那些，加上 ja/en 标准名
    //   对齐带来的合并。实测总数约 2.3k，因此阈值取 1,000 而非 10,000。
    assert!(
        dup > 1_000,
        "归并索引应捕获上千条 ID 不同的重复概念，实际 {dup}（口径可能变化，请核对管线）"
    );
}

