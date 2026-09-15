//! 词库生成文件兼容性集成测试（RFC 0006）。
//!
//! 读取 `tools/tagdict/` 数据管线生成的内置词库文件，验证 `TagDictDb`
//! 可直接打开并完成跨语言查询。生成文件不在仓库时跳过（提示运行数据管线）。
//! 该测试同时充当"管线产物 ↔ Rust 仓储"格式兼容性的回归保护。

use std::path::PathBuf;

use hp_store::TagDictDb;

fn genfile_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/tagdict/output/tag_dict.sqlite")
}

#[test]
fn open_generated_dict_and_lookup_across_languages() {
    let path = genfile_path();
    if !path.exists() {
        eprintln!(
            "跳过：未找到数据管线生成的词库文件 {}（先运行 tools/tagdict/build_tag_dict.py）",
            path.display()
        );
        return;
    }

    let db = TagDictDb::open(&path).unwrap();

    // 规模合理性：pixiv 16.9 万 + danbooru 5.3 万（过滤后）
    let n = db.count().unwrap();
    assert!(
        (150_000..=300_000).contains(&n),
        "词条数应在 15 万~30 万之间，实际 {n}"
    );

    // 用户案例：任意语言命中 → 中文聚合（写真 → 摄影 + Gravure）
    let hits = db.lookup("写真", 10).unwrap();
    assert!(!hits.is_empty(), "输入「写真」应命中词条");
    let zhs: Vec<&str> = hits.iter().map(|h| h.entry.zh.as_str()).collect();
    assert!(
        zhs.contains(&"摄影") || zhs.contains(&"写真"),
        "「写真」应命中中文主词 摄影/写真，实际 {zhs:?}"
    );

    // 英文命中（Photo）→ 同中文聚合
    let en_hits = db.lookup("Photo", 10).unwrap();
    assert!(!en_hits.is_empty(), "输入「Photo」应命中词条");

    // 建议查询（中文前缀）返回非空
    let sugs = db.suggest("少女", 5).unwrap();
    assert!(!sugs.is_empty(), "前缀建议「少女」应返回结果");

    // 元信息版本存在
    assert!(db.meta("version").unwrap().is_some(), "词库应含 version 元信息");

    db.close().unwrap();
}
