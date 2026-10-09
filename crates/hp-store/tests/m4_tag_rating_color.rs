//! M4 验收测试：tag / 评分 / 色彩参考仓储。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M4 范围。

use hp_core::{
    FileId, FileIndexRow, HpError, MediaType, SourceId, ThumbStatus, VerifyStatus,
};
use hp_store::RepoDb;

fn temp_path(tag: &str) -> std::path::PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}.sqlite3"))
}

fn seed_file(db: &mut RepoDb, source_id: &SourceId, rel: &str) -> FileId {
    let id = FileId::generate();
    let row = FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: rel.to_string(),
        media_type: MediaType::Image,
        subtype: None,
        content_hash: Some(format!("hash-{rel}")),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 1,
        mtime: "1".to_string(),
        scan_time: "t".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    };
    db.upsert_file(&row).expect("写入文件索引失败");
    id
}

#[test]
fn tag_crud_and_file_association() {
    let path = temp_path("m4_tag");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg");

    let tag = db
        .create_tag("repo-1", "风景", Some("#00ff00"))
        .expect("创建 tag 失败");
    // 同名幂等
    let again = db
        .create_tag("repo-1", "风景", None)
        .expect("重复创建失败");
    assert_eq!(tag.id, again.id, "同仓库同名 tag 应幂等返回");

    let found = db
        .find_tag_by_name("repo-1", "风景")
        .expect("查询失败")
        .expect("tag 应存在");
    assert_eq!(found.id, tag.id);

    db.add_file_tag(f1.as_str(), tag.id.as_str())
        .expect("建立关联失败");
    assert_eq!(db.count_file_tags(tag.id.as_str()).expect("统计失败"), 1);

    let file_tags = db.list_file_tags(f1.as_str()).expect("查询文件 tag 失败");
    assert_eq!(file_tags.len(), 1);

    let tags = db.list_tags_for_file(f1.as_str()).expect("查询 tag 实体失败");
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "风景");

    let files = db.list_files_by_tag(tag.id.as_str()).expect("查询 tag 文件失败");
    assert_eq!(files.len(), 1);

    // D21：自动关联与人工关联为独立表，同名 tag 可共存（tag 实体共用）
    db.add_file_auto_tag(f1.as_str(), tag.id.as_str(), Some(0.9), Some("demo-model"))
        .expect("建立自动关联失败");
    assert_eq!(
        db.count_file_tags(tag.id.as_str()).expect("统计失败"),
        1,
        "人工关联数不受自动关联影响"
    );
    assert_eq!(db.count_file_auto_tags(tag.id.as_str()).expect("统计失败"), 1);

    let manual = db.list_file_tags(f1.as_str()).expect("查询人工失败");
    assert_eq!(manual.len(), 1);
    let auto = db.list_file_auto_tags(f1.as_str()).expect("查询自动失败");
    assert_eq!(auto.len(), 1);
    assert_eq!(auto[0].confidence, Some(0.9));
    assert_eq!(auto[0].tag_id, manual[0].tag_id, "tag 实体共用");

    // 移除人工关联后自动关联保留
    db.remove_file_tag(f1.as_str(), tag.id.as_str())
        .expect("移除人工关联失败");
    assert_eq!(db.count_file_tags(tag.id.as_str()).expect("统计失败"), 0);
    assert_eq!(db.count_file_auto_tags(tag.id.as_str()).expect("统计失败"), 1);
    db.remove_file_auto_tag(f1.as_str(), tag.id.as_str())
        .expect("移除自动关联失败");
    assert_eq!(db.count_file_auto_tags(tag.id.as_str()).expect("统计失败"), 0);

    // 删除 tag 级联清除人工与自动关联
    db.add_file_tag(f1.as_str(), tag.id.as_str())
        .expect("建立关联失败");
    db.add_file_auto_tag(f1.as_str(), tag.id.as_str(), Some(0.5), Some("m"))
        .expect("建立自动关联失败");
    db.delete_tag(tag.id.as_str()).expect("删除 tag 失败");
    assert!(db.get_tag(tag.id.as_str()).expect("查询失败").is_none());
    assert_eq!(db.count_file_tags(tag.id.as_str()).expect("统计失败"), 0);
    assert_eq!(db.count_file_auto_tags(tag.id.as_str()).expect("统计失败"), 0);

    db.close().expect("关闭失败");
}

#[test]
fn rating_upsert_validation_and_delete() {
    let path = temp_path("m4_rating");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg");

    let r = db.upsert_rating(f1.as_str(), 4).expect("写入评分失败");
    assert_eq!(r.rating, 4);
    let got = db
        .get_rating(f1.as_str())
        .expect("查询失败")
        .expect("评分应存在");
    assert_eq!(got.rating, 4);

    // 越界拒绝
    let err = db.upsert_rating(f1.as_str(), 6).expect_err("越界评分应被拒绝");
    assert!(matches!(err, HpError::InvalidArgument(_)));

    db.delete_rating(f1.as_str()).expect("删除评分失败");
    assert!(db.get_rating(f1.as_str()).expect("查询失败").is_none());

    db.close().expect("关闭失败");
}

#[test]
fn color_ref_upsert_and_delete() {
    let path = temp_path("m4_color");
    let mut db = RepoDb::create(&path, "仓库").expect("创建仓库失败");
    let s = db
        .mount_source("repo-1", "C:/photos", None, None)
        .expect("挂载失败");
    let f1 = seed_file(&mut db, &s.id, "a.jpg");

    let palette = r##"{"colors":["#112233","#445566"],"locked":false}"##;
    db.upsert_color_ref(f1.as_str(), palette)
        .expect("写入色彩参考失败");
    let got = db
        .get_color_ref(f1.as_str())
        .expect("查询失败")
        .expect("色彩参考应存在");
    assert_eq!(got.color_json, palette);

    // 手动锁定覆盖
    let locked = r##"{"colors":["#000000"],"locked":true}"##;
    db.upsert_color_ref(f1.as_str(), locked)
        .expect("覆盖色彩参考失败");
    let got = db
        .get_color_ref(f1.as_str())
        .expect("查询失败")
        .expect("色彩参考应存在");
    assert_eq!(got.color_json, locked);

    db.delete_color_ref(f1.as_str()).expect("删除色彩参考失败");
    assert!(db.get_color_ref(f1.as_str()).expect("查询失败").is_none());

    db.close().expect("关闭失败");
}
