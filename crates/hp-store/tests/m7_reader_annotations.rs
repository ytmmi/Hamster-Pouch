//! 阅读批注（书签 / 笔记 / 高亮）仓储验收测试 —— 迁移 0011 / D113。
//!
//! 覆盖三件事：**三种形态各自能存能取**、**校验在写库前生效**、
//! **删除幂等且外键级联**（文件行没了批注随之消失）。

use std::path::PathBuf;

use hp_core::{AnnotationKind, FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_store::{NewAnnotation, RepoDb};

fn temp_repo_path(tag: &str) -> PathBuf {
    tempfile::tempdir()
        .expect("创建临时目录失败")
        .keep()
        .join(format!("{tag}-repo.sqlite3"))
}

/// 造一个文件索引行（批注有外键指向 `files`）。
fn file_row(id: &str, source_id: hp_core::SourceId, relative_path: &str) -> FileIndexRow {
    FileIndexRow {
        id: FileId::from_raw(id),
        source_id,
        relative_path: relative_path.to_string(),
        media_type: MediaType::Text,
        marks: Vec::new(),
        content_hash: Some(format!("hash-{id}")),
        content_hash_algo: Some("BLAKE3".to_string()),
        content_hash_algo_version: Some(1),
        perceptual_hash: None,
        perceptual_hash_algo: None,
        perceptual_hash_algo_version: None,
        size: 100,
        mtime: "2026-10-16T00:00:00Z".to_string(),
        scan_time: "2026-10-16T00:00:00Z".to_string(),
        verify_status: VerifyStatus::Ok,
        thumb_status: ThumbStatus::NotGenerated,
        missing_status: 0,
        media_info_json: None,
    }
}

/// 造一个带源与文件的仓库。
fn repo_with_file(tag: &str) -> (RepoDb, String) {
    let path = temp_repo_path(tag);
    let mut db = RepoDb::create(&path, "阅读仓库").expect("创建仓库失败");
    let source = db
        .mount_source("repo-1", "E:/books", None, None)
        .expect("挂载源失败");
    db.upsert_file(&file_row("file-1", source.id, "novel.txt"))
        .expect("写文件失败");
    (db, "file-1".to_string())
}

#[test]
fn three_kinds_round_trip_and_stay_separate() {
    let (mut db, file_id) = repo_with_file("annotations");

    let bookmark = db
        .create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Bookmark,
            cursor: "12",
            progress: 1_234,
            title: "第一章",
            excerpt: "",
            note: "",
        })
        .expect("写书签失败");
    let note = db
        .create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Note,
            cursor: "40",
            progress: 2_500,
            title: "第二章",
            excerpt: "",
            note: "这里写得真好",
        })
        .expect("写笔记失败");
    let highlight = db
        .create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Highlight,
            cursor: "80",
            progress: 5_000,
            title: "第三章",
            excerpt: "他抬起头，望向远处。",
            note: "伏笔",
        })
        .expect("写高亮失败");

    // id 由仓储生成（UUID），三条互不相同。
    assert_ne!(bookmark.id, note.id);
    assert_ne!(note.id, highlight.id);

    let all = db.list_annotations(&file_id).expect("列批注失败");
    assert_eq!(all.len(), 3, "三种形态都应在同一张表里：{all:?}");
    // 按创建时间升序（写入顺序）；同一秒内按 id 兜底排序，因此这里只断言集合内容。
    let kinds: Vec<&str> = all.iter().map(|a| a.kind.as_str()).collect();
    assert!(kinds.contains(&"bookmark"));
    assert!(kinds.contains(&"note"));
    assert!(kinds.contains(&"highlight"));

    let stored_highlight = all
        .iter()
        .find(|a| a.kind == AnnotationKind::Highlight)
        .expect("高亮应在");
    assert_eq!(stored_highlight.excerpt, "他抬起头，望向远处。");
    assert_eq!(stored_highlight.note, "伏笔");
    assert_eq!(stored_highlight.cursor, "80");
    assert_eq!(stored_highlight.progress, 5_000);
    assert_eq!(stored_highlight.title, "第三章");

    // 单条查询与列表一致。
    let one = db
        .get_annotation(&note.id)
        .expect("查批注失败")
        .expect("应存在");
    assert_eq!(one.note, "这里写得真好");
    assert_eq!(one.excerpt, "", "笔记没有选中原文");
    assert!(db.get_annotation("不存在").expect("查批注失败").is_none());

    db.close().expect("关闭失败");
}

#[test]
fn content_validation_runs_before_the_write() {
    let (mut db, file_id) = repo_with_file("annotation-validation");

    // 书签不需要正文。
    assert!(
        db.create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Bookmark,
            cursor: "1",
            progress: 0,
            title: "",
            excerpt: "",
            note: ""
        })
        .is_ok()
    );
    // 笔记 / 高亮必须有内容——否则列表里就是一行空白（用户会以为没存上）。
    assert!(
        db.create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Note,
            cursor: "1",
            progress: 0,
            title: "",
            excerpt: "",
            note: "  "
        })
        .is_err()
    );
    assert!(
        db.create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Highlight,
            cursor: "1",
            progress: 0,
            title: "",
            excerpt: "",
            note: ""
        })
        .is_err()
    );
    // 游标非空（没有位置的批注跳不回去，等于一条坏记录）。
    assert!(
        db.create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Bookmark,
            cursor: "  ",
            progress: 0,
            title: "",
            excerpt: "",
            note: ""
        })
        .is_err()
    );
    // 空文件 id 也拒。
    assert!(
        db.create_annotation(NewAnnotation {
            file_id: "",
            kind: AnnotationKind::Bookmark,
            cursor: "1",
            progress: 0,
            title: "",
            excerpt: "",
            note: ""
        })
        .is_err()
    );

    // 被拒的都不该留下记录：只剩最开始那条合法书签。
    assert_eq!(db.list_annotations(&file_id).expect("列批注失败").len(), 1);

    db.close().expect("关闭失败");
}

#[test]
fn delete_is_idempotent_and_cascades_with_the_file() {
    let (mut db, file_id) = repo_with_file("annotation-delete");
    let one = db
        .create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Bookmark,
            cursor: "5",
            progress: 100,
            title: "序章",
            excerpt: "",
            note: "",
        })
        .expect("写书签失败");
    let two = db
        .create_annotation(NewAnnotation {
            file_id: &file_id,
            kind: AnnotationKind::Bookmark,
            cursor: "9",
            progress: 200,
            title: "终章",
            excerpt: "",
            note: "",
        })
        .expect("写书签失败");

    // 删两次都成功（幂等）：用户在列表里连点两下删除不该报错。
    assert!(db.delete_annotation(&one.id).expect("删失败"));
    assert!(!db.delete_annotation(&one.id).expect("重复删应成功但无改动"));
    assert_eq!(db.list_annotations(&file_id).expect("列批注失败").len(), 1);

    // 外键级联：文件行没了，剩下的批注随之消失（不留孤儿）。
    db.delete_files(std::slice::from_ref(&file_id))
        .expect("删文件失败");
    assert!(
        db.list_annotations(&file_id)
            .expect("列批注失败")
            .is_empty(),
        "文件被删后批注必须级联消失"
    );
    assert!(db.get_annotation(&two.id).expect("查批注失败").is_none());

    db.close().expect("关闭失败");
}

#[test]
fn annotations_are_scoped_per_file() {
    let (mut db, file_id) = repo_with_file("annotation-scope");
    let source_id = db.list_sources("repo-1").expect("列源失败")[0].id.clone();
    db.upsert_file(&file_row("file-2", source_id, "other.txt"))
        .expect("写第二个文件失败");

    db.create_annotation(NewAnnotation {
        file_id: &file_id,
        kind: AnnotationKind::Bookmark,
        cursor: "1",
        progress: 0,
        title: "甲",
        excerpt: "",
        note: "",
    })
    .expect("写失败");

    // 另一本书看不到这本书的批注（批注是"读者在某个条目上的"，不是全局的）。
    assert_eq!(db.list_annotations("file-2").expect("列失败").len(), 0);
    assert_eq!(db.list_annotations(&file_id).expect("列失败").len(), 1);

    db.close().expect("关闭失败");
}
