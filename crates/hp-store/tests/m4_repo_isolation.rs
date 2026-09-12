//! M4 验收测试：仓库隔离（同一图像源挂载到两个仓库时 tag/评分互不可见）。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M4 验证线。

use hp_core::{
    FileId, FileIndexRow, MediaType, SourceId, TagSource, ThumbStatus, VerifyStatus,
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
        content_hash: Some("same-content".to_string()),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 10,
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
fn tag_and_rating_are_isolated_between_repos() {
    let mut db1 = RepoDb::create(temp_path("m4_repo1"), "仓库1").expect("创建仓库1失败");
    let mut db2 = RepoDb::create(temp_path("m4_repo2"), "仓库2").expect("创建仓库2失败");

    // 同一本地图像源分别挂载到两个仓库（真实文件共享，解释数据隔离）。
    let s1 = db1
        .mount_source("repo-1", "C:/shared", None, None)
        .expect("挂载源1失败");
    let s2 = db2
        .mount_source("repo-2", "C:/shared", None, None)
        .expect("挂载源2失败");

    let f1 = seed_file(&mut db1, &s1.id, "a.jpg");
    let f2 = seed_file(&mut db2, &s2.id, "a.jpg");

    // 仓库1 添加 tag 与评分
    let tag = db1
        .create_tag("repo-1", "风景", Some("#00ff00"))
        .expect("创建 tag 失败");
    db1.add_file_tag(f1.as_str(), tag.id.as_str(), TagSource::User, None, None)
        .expect("建立关联失败");
    db1.upsert_rating(f1.as_str(), 5).expect("写入评分失败");

    // 仓库1 内可见
    assert_eq!(db1.list_tags("repo-1").expect("列 tag 失败").len(), 1);
    assert_eq!(
        db1.get_rating(f1.as_str())
            .expect("查评分失败")
            .map(|r| r.rating),
        Some(5)
    );

    // 仓库2 内不可见（隔离）
    assert_eq!(
        db2.list_tags("repo-2").expect("列 tag 失败").len(),
        0,
        "仓库2 不应看到仓库1 的 tag"
    );
    assert!(
        db2.get_rating(f2.as_str()).expect("查评分失败").is_none(),
        "仓库2 不应看到仓库1 的评分"
    );
    assert_eq!(
        db2.list_file_tags(f2.as_str())
            .expect("查文件 tag 失败")
            .len(),
        0,
        "仓库2 不应看到仓库1 的文件 tag 关联"
    );

    // 仓库2 自己添加的 tag 也不影响仓库1
    let tag2 = db2
        .create_tag("repo-2", "风景", None)
        .expect("创建 tag 失败");
    db2.add_file_tag(f2.as_str(), tag2.id.as_str(), TagSource::User, None, None)
        .expect("建立关联失败");
    assert_eq!(db1.list_tags("repo-1").expect("列 tag 失败").len(), 1);
    assert_eq!(db1.count_file_tags(tag.id.as_str()).expect("统计失败"), 1);

    db1.close().expect("关闭仓库1失败");
    db2.close().expect("关闭仓库2失败");
}
