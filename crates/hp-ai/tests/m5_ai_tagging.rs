//! M5 验收测试：AI 打标任务提交、结果回写自动关联表、人工/自动 tag 独立共存、自动组内撤销。
//! 对应 D6 / D17 / D21 与路线图 M5 验证线。

use std::path::{Path, PathBuf};

use hp_ai::{AiTaggingProvider, AiTaggingService};
use hp_core::{
    AiTagCandidate, AiTaggingInput, AiTaggingOutput, FileId, FileIndexRow, HpResult, MediaType,
    ThumbStatus, VerifyStatus,
};
use hp_store::RepoDb;

const REPO: &str = "repo-1";

fn temp_dir(tag: &str) -> PathBuf {
    let path = tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(tag);
    std::fs::create_dir_all(&path).expect("创建临时子目录失败");
    path
}

fn sample_file(id: &FileId, source_id: &hp_core::SourceId, media: MediaType) -> FileIndexRow {
    FileIndexRow {
        id: id.clone(),
        source_id: source_id.clone(),
        relative_path: "pic.jpg".into(),
        media_type: media,
        subtype: None,
        content_hash: Some("hash-1".into()),
        content_hash_algo: Some("blake3".into()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 5,
        mtime: "2026-01-01T00:00:00Z".into(),
        scan_time: "2026-01-01T00:00:00Z".into(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::Generated,
        missing_status: 0,
        media_info_json: None,
    }
}

/// 返回固定候选 tag 的测试提供方。
struct MockProvider {
    tags: Vec<AiTagCandidate>,
}

impl AiTaggingProvider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }
    fn model(&self) -> &str {
        "mock-model"
    }
    fn tag_image(&self, _input: &AiTaggingInput, _path: &Path) -> HpResult<AiTaggingOutput> {
        Ok(AiTaggingOutput {
            tags: self.tags.clone(),
            source_model: self.model().to_string(),
            generated_at: "2026-01-01T00:00:00Z".into(),
        })
    }
}

fn mock(confidence: f64) -> MockProvider {
    MockProvider {
        tags: vec![AiTagCandidate {
            name: "风景".into(),
            confidence,
        }],
    }
}

fn setup(media: MediaType) -> (RepoDb, FileId) {
    let dir = temp_dir("ai-src");
    let repo_path = temp_dir("ai-repo").join("repo.sqlite3");
    let mut db = RepoDb::create(&repo_path, "AI 仓库").expect("创建仓库失败");
    let source = db
        .mount_source(REPO, dir.to_str().unwrap(), Some("S"), None)
        .expect("挂载源失败");
    let file_id = FileId::generate();
    db.upsert_file(&sample_file(&file_id, &source.id, media))
        .expect("写入文件失败");
    (db, file_id)
}

#[test]
fn submit_rejects_non_image() {
    let (db, file_id) = setup(MediaType::Video);
    let mut svc = AiTaggingService::new();
    let err = svc
        .submit(&db, REPO, &[file_id.as_str().to_string()], "cfg-1", "{}")
        .expect_err("视频应被拒绝（D17）");
    assert!(matches!(err, hp_core::HpError::InvalidArgument(_)));
    db.close().expect("关闭失败");
}

#[test]
fn tagging_writes_back_auto_group_with_confidence_and_model() {
    let (mut db, file_id) = setup(MediaType::Image);
    let mut svc = AiTaggingService::new();
    svc.submit(&db, REPO, &[file_id.as_str().to_string()], "cfg-1", "{}")
        .expect("提交失败");
    assert_eq!(svc.queue().pending_count(), 1);

    let runs = svc.run_all(&mut db, &mock(0.8)).expect("执行失败");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].writeback.written, 1);
    assert_eq!(runs[0].writeback.overwritten, 0);
    assert!(runs[0].writeback.undo_ids.is_empty());

    // 结果写入自动关联表；人工关联表为空。
    let auto = db.list_file_auto_tags(file_id.as_str()).expect("查询失败");
    assert_eq!(auto.len(), 1);
    assert_eq!(auto[0].confidence, Some(0.8));
    assert_eq!(auto[0].source_model.as_deref(), Some("mock-model"));
    assert!(db.list_file_tags(file_id.as_str()).expect("查询失败").is_empty());
    db.close().expect("关闭失败");
}

#[test]
fn ai_and_user_tags_coexist_in_independent_tables() {
    let (mut db, file_id) = setup(MediaType::Image);

    // 人工关联表先打上「风景」。
    let user_tag = db.create_tag(REPO, "风景", None).expect("创建 tag 失败");
    db.add_file_tag(file_id.as_str(), user_tag.id.as_str())
        .expect("人工关联失败");

    let mut svc = AiTaggingService::new();
    svc.submit(&db, REPO, &[file_id.as_str().to_string()], "cfg-1", "{}")
        .expect("提交失败");
    let runs = svc.run_all(&mut db, &mock(0.95)).expect("执行失败");
    assert_eq!(runs[0].writeback.written, 1);
    assert_eq!(runs[0].writeback.overwritten, 0, "首次 AI 写入不应产生撤销");

    // 同名 tag：人工关联表与自动关联表各一条，互不覆盖（D21）。
    let manual = db.list_file_tags(file_id.as_str()).expect("查询人工失败");
    let auto = db.list_file_auto_tags(file_id.as_str()).expect("查询自动失败");
    assert_eq!(manual.len(), 1);
    assert_eq!(auto.len(), 1);
    assert_eq!(manual[0].tag_id, auto[0].tag_id, "tag 实体共用（同名同一实体）");
    assert_eq!(auto[0].confidence, Some(0.95));
    db.close().expect("关闭失败");
}

#[test]
fn repeat_ai_tagging_records_undo_within_auto_group() {
    let (mut db, file_id) = setup(MediaType::Image);
    let mut svc = AiTaggingService::new();

    svc.submit(&db, REPO, &[file_id.as_str().to_string()], "cfg-1", "{}")
        .expect("提交失败");
    svc.run_all(&mut db, &mock(0.7)).expect("首次执行失败");

    // 第二次 AI 打标同一 tag：自动关联更新并记录撤销。
    svc.submit(&db, REPO, &[file_id.as_str().to_string()], "cfg-1", "{}")
        .expect("再次提交失败");
    let runs = svc.run_all(&mut db, &mock(0.9)).expect("再次执行失败");
    assert_eq!(runs[0].writeback.overwritten, 1);
    assert_eq!(runs[0].writeback.undo_ids.len(), 1);

    let auto = db.list_file_auto_tags(file_id.as_str()).expect("查询失败");
    assert_eq!(auto.len(), 1, "自动关联同名只保留一条");
    assert_eq!(auto[0].confidence, Some(0.9));
    assert_eq!(db.count_ai_tag_undo(REPO).expect("统计失败"), 1);

    let undo = db
        .latest_ai_tag_undo(file_id.as_str(), auto[0].tag_id.as_str())
        .expect("查询失败")
        .expect("应有撤销记录");
    assert_eq!(undo.prev_confidence, Some(0.7));
    db.close().expect("关闭失败");
}
