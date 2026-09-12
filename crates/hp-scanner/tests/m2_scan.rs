//! M2 验收测试：扫描索引、同名替换识别、移动/重命名不丢身份、音频占位、未知跳过。
//! 对应 docs/roadmap/phase-1-top-level-plan.md 的 M2 验证线。

use std::path::Path;

use hp_core::{MediaType, Source, VerifyStatus};
use hp_scanner::{ScanOptions, ScanProgress, Scanner};
use hp_store::RepoDb;

/// 生成一张确定性的灰度 PNG（不同 seed 得到不同内容）。
fn make_png(path: &Path, seed: u8) {
    let img = image::GrayImage::from_fn(32, 32, |x, y| {
        image::Luma([(x.wrapping_mul(7).wrapping_add(y).wrapping_add(seed as u32)) as u8])
    });
    img.save(path).expect("保存 PNG 失败");
}

/// 创建临时仓库 + 挂载临时图像源。
fn setup(tmp: &tempfile::TempDir) -> (RepoDb, Source) {
    let source_dir = tmp.path().join("photos");
    std::fs::create_dir_all(&source_dir).expect("创建图像源目录失败");
    let repo_path = tmp.path().join("repo.sqlite3");
    let mut db = RepoDb::create(&repo_path, "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", source_dir.to_str().unwrap(), None, None)
        .expect("挂载图像源失败");
    (db, source)
}

fn scan(db: &mut RepoDb, source: &Source, full: bool) -> hp_core::HpResult<hp_scanner::ScanOutcome> {
    let scanner = Scanner::new();
    let options = ScanOptions {
        full,
        ..ScanOptions::default()
    };
    let mut progress = |_p: &ScanProgress| {};
    scanner.scan_source(db, source, &options, &mut progress)
}

#[test]
fn scan_indexes_image_skips_unknown_and_audio_placeholder() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);

    make_png(&dir.join("photo.png"), 1);
    std::fs::write(dir.join("notes.txt"), b"hello plain text").expect("写 txt 失败");
    std::fs::write(dir.join("song.mp3"), b"ID3 fake audio").expect("写 mp3 失败");

    let outcome = scan(&mut db, &source, false).expect("扫描失败");
    assert_eq!(outcome.indexed, 2, "图片与音频应各写一行");
    assert_eq!(outcome.skipped, 1, "未知 txt 应跳过");

    // 图片：有内容哈希 + 感知哈希
    let img = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询图片失败")
        .expect("图片应已索引");
    assert_eq!(img.media_type, MediaType::Image);
    assert!(img.content_hash.is_some(), "图片应有内容哈希");
    assert!(img.perceptual_hash.is_some(), "图片应有感知哈希");
    assert_eq!(img.verify_status, VerifyStatus::Ok);

    // 音频：占位行，无哈希（D11）
    let audio = db
        .get_file_by_path(source.id.as_str(), "song.mp3")
        .expect("查询音频失败")
        .expect("音频应落占位行");
    assert_eq!(audio.media_type, MediaType::Audio);
    assert!(audio.content_hash.is_none(), "音频占位行不应有内容哈希");
    assert_eq!(audio.verify_status, VerifyStatus::Placeholder);

    // 未知类型不入库
    assert!(
        db.get_file_by_path(source.id.as_str(), "notes.txt")
            .expect("查询 txt 失败")
            .is_none(),
        "未知类型不应进入文件索引"
    );
}

#[test]
fn same_name_replacement_is_detected() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    make_png(&dir.join("photo.png"), 1);

    scan(&mut db, &source, false).expect("首次扫描失败");
    let before = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询失败")
        .expect("应已索引");
    let hash_before = before.content_hash.clone().expect("应有哈希");

    // 同名替换：同路径写入不同内容
    std::thread::sleep(std::time::Duration::from_millis(20));
    make_png(&dir.join("photo.png"), 200);

    scan(&mut db, &source, false).expect("二次扫描失败");
    let after = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询失败")
        .expect("应仍索引");
    assert_ne!(
        after.content_hash.as_deref(),
        Some(hash_before.as_str()),
        "同名替换应更新内容哈希"
    );
}

#[test]
fn move_rename_preserves_identity() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    make_png(&dir.join("photo.png"), 1);

    scan(&mut db, &source, false).expect("首次扫描失败");
    let before = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询失败")
        .expect("应已索引");
    let id_before = before.id.clone();

    // 重命名（同内容移动）
    std::fs::rename(dir.join("photo.png"), dir.join("renamed.png")).expect("重命名失败");

    scan(&mut db, &source, true).expect("二次扫描失败");

    // 旧路径消失，新路径出现且 id 不变（身份保留，RFC 0001）
    assert!(
        db.get_file_by_path(source.id.as_str(), "photo.png")
            .expect("查询失败")
            .is_none(),
        "旧路径索引应随移动消失"
    );
    let after = db
        .get_file_by_path(source.id.as_str(), "renamed.png")
        .expect("查询失败")
        .expect("新路径应已索引");
    assert_eq!(after.id, id_before, "移动/重命名应保留文件身份");
}

#[test]
fn full_scan_corrects_out_of_band_change() {
    // watcher 漏事件后，定期全量校验（full=true）能修正（D9 兜底）
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    make_png(&dir.join("photo.png"), 1);

    scan(&mut db, &source, false).expect("首次扫描失败");
    let hash_before = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询失败")
        .expect("应已索引")
        .content_hash
        .expect("应有哈希");

    // 外部修改内容（例如 watcher 漏掉了这个事件）
    make_png(&dir.join("photo.png"), 77);

    // 定期全量校验强制重算
    scan(&mut db, &source, true).expect("全量扫描失败");
    let hash_after = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询失败")
        .expect("应仍索引")
        .content_hash
        .expect("应有哈希");

    assert_ne!(hash_before, hash_after, "全量校验应修正被漏掉的变更");
}
