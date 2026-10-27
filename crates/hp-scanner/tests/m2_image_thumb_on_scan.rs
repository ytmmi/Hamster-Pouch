//! M2 验收测试：**图片缩略图在扫描期生成**（2026-10-27 / D126）。
//!
//! 这条钉住的是端到端的一件事：`source_scan(full = true)` 走完，缩略图缓存里就已经
//! 有为每张图片准备好的缩略图，界面第一次滚动不再逐张现解压。单元测试已经覆盖了
//! `compute` 的分支，这里覆盖的是"`scanner` 写行 + `ThumbnailCache` 落盘"接得上。

use std::path::Path;

use hp_core::{MediaType, Source, ThumbStatus};
use hp_media::ThumbnailCache;
use hp_scanner::{ScanOptions, ScanProgress, Scanner};
use hp_store::RepoDb;

/// 生成一张确定性的彩色 PNG（尺寸远小于 320，测"不放大"用）。
fn make_png(path: &Path, seed: u8) {
    let img = image::RgbImage::from_fn(64, 48, |x, y| {
        image::Rgb([
            (x.wrapping_mul(4).wrapping_add(seed as u32)) as u8,
            (y.wrapping_mul(5).wrapping_add(seed as u32)) as u8,
            seed,
        ])
    });
    img.save(path).expect("保存 PNG 失败");
}

fn setup(tmp: &tempfile::TempDir) -> (RepoDb, Source) {
    let source_dir = tmp.path().join("photos");
    std::fs::create_dir_all(&source_dir).expect("创建媒体源目录失败");
    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", source_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");
    (db, source)
}

fn scan_with(
    db: &mut RepoDb,
    source: &Source,
    full: bool,
    cache: Option<ThumbnailCache>,
) -> hp_core::HpResult<hp_scanner::ScanOutcome> {
    let scanner = Scanner::new();
    let options = ScanOptions {
        full,
        thumbnail_cache: cache,
        ..ScanOptions::default()
    };
    let mut progress = |_p: &ScanProgress| {};
    scanner.scan_source(db, source, &options, &mut progress)
}

/// 端到端：一次扫描跑完，图片缩略图已经在缓存里。
#[test]
fn image_thumbnail_is_generated_during_scan() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    make_png(&dir.join("a.png"), 7);
    make_png(&dir.join("b.png"), 9);

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    let outcome = scan_with(&mut db, &source, false, Some(cache.clone())).expect("扫描失败");
    assert_eq!(outcome.indexed, 2, "两张图都应入库");

    for name in ["a.png", "b.png"] {
        let row = db
            .get_file_by_path(source.id.as_str(), name)
            .expect("查询失败")
            .expect("图片应已索引");
        assert_eq!(row.media_type, MediaType::Image);
        assert_eq!(
            row.thumb_status,
            ThumbStatus::Generated,
            "{name} 扫描期内应已生成缩略图（D126）"
        );
        let hash = row.content_hash.expect("图片应有内容哈希");
        let thumb_path = cache.path_for_image(&hash);
        let bytes = std::fs::metadata(&thumb_path)
            .unwrap_or_else(|e| panic!("{name} 的缩略图应已落盘：{e}"))
            .len();
        assert!(bytes > 0, "{name} 的缩略图不该是空文件");

        // 不解码断言具体格式（WebP 编码失败时会降级写 JPEG），只断言"能解回、且没被放大"。
        let thumb = image::open(&thumb_path).expect("缩略图应能解码");
        assert!(
            thumb.width() <= hp_media::IMAGE_THUMB_MAX_DIM
                && thumb.height() <= hp_media::IMAGE_THUMB_MAX_DIM,
            "{name} 的缩略图应受 {0} 边长上限约束，实际 {}x{}",
            thumb.width(),
            thumb.height()
        );
    }
}

/// 「全量」的语义（D126）：**已经入库但没有缩略图**的库，跑一次全量就能补齐。
///
/// 这也解释了为什么缩略图生成挂在计算阶段而不是准备阶段：增量扫描会跳过未变化的
/// 文件（`unchanged`），只有全量/重新分析才会重新算——正好是"补齐"该发生的时机。
#[test]
fn full_rescan_backfills_thumbnails_missing_from_an_earlier_scan() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    make_png(&dir.join("a.png"), 3);

    // ① 没有缩略图缓存（例如精简环境）时首次扫描：行建好了，但没有图。
    scan_with(&mut db, &source, false, None).expect("扫描失败");
    let row = db
        .get_file_by_path(source.id.as_str(), "a.png")
        .expect("查询失败")
        .expect("图片应已索引");
    assert_eq!(
        row.thumb_status,
        ThumbStatus::NotGenerated,
        "没有缓存时不该凭空标 Generated"
    );
    let hash = row.content_hash.clone().expect("应有内容哈希");

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    assert!(
        !cache.path_for_image(&hash).exists(),
        "前提：此时还没有缩略图"
    );

    // ② 右键「全量」：同一批文件重新算一遍，缩略图补上。
    let outcome = scan_with(&mut db, &source, true, Some(cache.clone())).expect("全量重扫失败");
    // 既有文件走 `upsert_file` → 计入 `changed`（新文件才计 `indexed`）。
    assert_eq!(outcome.changed, 1, "全量应重新写这一行");
    let row = db
        .get_file_by_path(source.id.as_str(), "a.png")
        .expect("查询失败")
        .expect("图片应仍在索引里");
    assert_eq!(row.thumb_status, ThumbStatus::Generated, "全量应补齐缩略图");
    assert!(
        cache.path_for_image(&hash).exists(),
        "全量扫描后缩略图应已在缓存中"
    );
}

/// 反向钉住 D115：**音频与文本在扫描期不出图**，即使 `thumbnail_cache` 就在手上。
#[test]
fn scan_does_not_generate_waveforms_or_text_thumbs() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::write(dir.join("notes.txt"), b"hello plain text").expect("写 txt 失败");
    std::fs::write(dir.join("song.mp3"), b"ID3 fake audio").expect("写 mp3 失败");

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    scan_with(&mut db, &source, false, Some(cache.clone())).expect("扫描失败");

    let audio = db
        .get_file_by_path(source.id.as_str(), "song.mp3")
        .expect("查询失败")
        .expect("音频应已索引");
    assert_eq!(
        audio.thumb_status,
        ThumbStatus::NotGenerated,
        "音频波形图按需生成（D115），扫描期不该出"
    );
    let audio_hash = audio.content_hash.expect("音频应有哈希");
    assert!(!cache.path_for_audio(&audio_hash).exists(), "不该有波形图");

    let text = db
        .get_file_by_path(source.id.as_str(), "notes.txt")
        .expect("查询失败")
        .expect("文本应已索引");
    assert_eq!(
        text.thumb_status,
        ThumbStatus::NotGenerated,
        "文本没有缩略图"
    );
}
