//! 被排除子树的「仅索引」与排除时清理衍生产物（D164）回归。
//!
//! 口径：扫描**仍遍历**被排除目录（不遍历会被判 `missing` 清掉），但只写索引列，
//! 不读内容、不算哈希、不出缩略图；`source.exclude` 之后衍生产物当场收干净，
//! 而**同一内容哈希只要还有可见行引用就整份保留**；取消排除后由下次扫描重建。

use std::path::Path;

use hp_core::{MediaType, Source, ThumbStatus};
use hp_media::ThumbnailCache;
use hp_scanner::{ScanOptions, ScanProgress, Scanner, purge_excluded_derivatives};
use hp_store::RepoDb;

/// 生成一张确定性的彩色 PNG：同样的 `seed` 必然产出同样的字节（测共享哈希用）。
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

fn scan(
    db: &mut RepoDb,
    source: &Source,
    full: bool,
    cache: &ThumbnailCache,
) -> hp_scanner::ScanOutcome {
    let options = ScanOptions {
        full,
        thumbnail_cache: Some(cache.clone()),
        ..ScanOptions::default()
    };
    let mut progress = |_p: &ScanProgress| {};
    Scanner::new()
        .scan_source(db, source, &options, &mut progress)
        .expect("扫描失败")
}

/// 先被排除、再扫描：行要建（路径/类型可查），衍生产物一样都不许有。
#[test]
fn excluded_subtree_is_indexed_without_derivatives() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::create_dir_all(dir.join("drop")).expect("创建子目录失败");
    make_png(&dir.join("keep.png"), 1);
    make_png(&dir.join("drop").join("hidden.png"), 2);
    db.exclude_source_dir(source.id.as_str(), "drop")
        .expect("排除失败");

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    let outcome = scan(&mut db, &source, false, &cache);
    assert_eq!(
        outcome.indexed, 2,
        "被排除的子目录也要建索引行（只是不产衍生物）"
    );

    let hidden = db
        .get_file_by_path(source.id.as_str(), "drop/hidden.png")
        .expect("查询失败")
        .expect("被排除的图片仍应有索引行");
    assert_eq!(hidden.media_type, MediaType::Image);
    assert_eq!(hidden.content_hash, None, "只建索引：不算内容哈希");
    assert_eq!(hidden.perceptual_hash, None, "只建索引：不算感知哈希");
    assert_eq!(
        hidden.thumb_status,
        ThumbStatus::NotGenerated,
        "只建索引：不出缩略图"
    );
    assert_eq!(
        hidden.verify_status,
        hp_core::VerifyStatus::Ok,
        "不许标成 unreadable"
    );

    let visible = db
        .get_file_by_path(source.id.as_str(), "keep.png")
        .expect("查询失败")
        .expect("可见图片应入库");
    let hash = visible.content_hash.clone().expect("可见图片应有内容哈希");
    assert_eq!(visible.thumb_status, ThumbStatus::Generated);
    assert!(
        cache.path_for_image(&hash).exists(),
        "可见图片的缩略图应落盘"
    );
}

/// 已扫描过的子树被排除：缓存文件与派生列当场清掉，索引行与标记保留。
#[test]
fn excluding_a_scanned_subtree_purges_derivatives() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::create_dir_all(dir.join("drop")).expect("创建子目录失败");
    make_png(&dir.join("keep.png"), 3);
    make_png(&dir.join("drop").join("hidden.png"), 4);

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    scan(&mut db, &source, true, &cache);
    let hidden = db
        .get_file_by_path(source.id.as_str(), "drop/hidden.png")
        .expect("查询失败")
        .expect("图片应已索引");
    let hidden_hash = hidden.content_hash.clone().expect("扫描后应有内容哈希");
    assert!(cache.path_for_image(&hidden_hash).exists());

    db.exclude_source_dir(source.id.as_str(), "drop")
        .expect("排除失败");
    let purge = purge_excluded_derivatives(&mut db, source.id.as_str(), Some(&cache))
        .expect("清理衍生产物失败");
    assert_eq!(purge.rows, 1, "只该清被排除的那一行");
    assert!(purge.cache_files >= 1, "该哈希的缓存文件应被删除");
    assert!(
        !cache.path_for_image(&hidden_hash).exists(),
        "排除后缩略图缓存不该还在"
    );

    let hidden = db
        .get_file_by_path(source.id.as_str(), "drop/hidden.png")
        .expect("查询失败")
        .expect("索引行必须保留");
    assert_eq!(hidden.content_hash, None);
    assert_eq!(hidden.thumb_status, ThumbStatus::NotGenerated);
    assert!(
        db.list_excluded_derivative_rows(source.id.as_str())
            .expect("查询失败")
            .is_empty(),
        "清过之后 index_only 应为 1，不再出现在待清理候选里"
    );
    assert!(
        !db.has_visible_content_hash(&hidden_hash).expect("查询失败"),
        "该哈希已无可见行引用"
    );

    let visible = db
        .get_file_by_path(source.id.as_str(), "keep.png")
        .expect("查询失败")
        .expect("可见行应保留");
    assert!(visible.content_hash.is_some());
    assert!(
        cache
            .path_for_image(visible.content_hash.as_ref().unwrap())
            .exists()
    );
}

/// 同一份内容的两个路径（一可见、一被排除）：缓存按哈希共享，必须整份保留。
#[test]
fn shared_content_hash_keeps_the_cached_thumbnail() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::create_dir_all(dir.join("drop")).expect("创建子目录失败");
    make_png(&dir.join("keep.png"), 7);
    make_png(&dir.join("drop").join("copy.png"), 7);

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    scan(&mut db, &source, true, &cache);
    let keep_hash = db
        .get_file_by_path(source.id.as_str(), "keep.png")
        .expect("查询失败")
        .expect("图片应已索引")
        .content_hash
        .expect("应有内容哈希");

    db.exclude_source_dir(source.id.as_str(), "drop")
        .expect("排除失败");
    let purge = purge_excluded_derivatives(&mut db, source.id.as_str(), Some(&cache))
        .expect("清理衍生产物失败");
    assert_eq!(purge.rows, 0, "哈希仍被可见行引用时一行都不该动");
    assert_eq!(purge.cache_files, 0, "共享缓存的缩略图不能被删");
    assert!(
        cache.path_for_image(&keep_hash).exists(),
        "可见行的缩略图必须还在"
    );

    let copy = db
        .get_file_by_path(source.id.as_str(), "drop/copy.png")
        .expect("查询失败")
        .expect("索引行应保留");
    assert_eq!(
        copy.content_hash.as_deref(),
        Some(keep_hash.as_str()),
        "共享哈希的行保留原值：它没有需要重建的东西"
    );
}

/// 取消排除后，下次扫描按「index_only 与当前排除状态不一致」强制重算，缩略图重建。
#[test]
fn unexclude_rebuilds_derivatives_on_the_next_scan() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::create_dir_all(dir.join("drop")).expect("创建子目录失败");
    make_png(&dir.join("drop").join("hidden.png"), 9);

    let cache = ThumbnailCache::new(tmp.path().join("thumbs"));
    scan(&mut db, &source, true, &cache);
    let before = db
        .get_file_by_path(source.id.as_str(), "drop/hidden.png")
        .expect("查询失败")
        .expect("图片应已索引");
    let hash = before.content_hash.clone().expect("应有内容哈希");

    db.exclude_source_dir(source.id.as_str(), "drop")
        .expect("排除失败");
    purge_excluded_derivatives(&mut db, source.id.as_str(), Some(&cache)).expect("清理失败");
    assert!(!cache.path_for_image(&hash).exists());

    db.unexclude_source_dirs(source.id.as_str(), &["drop".to_string()])
        .expect("取消排除失败");
    let outcome = scan(&mut db, &source, false, &cache);
    assert_eq!(outcome.changed, 1, "恢复的行应按 index_only 不一致强制重算");

    let after = db
        .get_file_by_path(source.id.as_str(), "drop/hidden.png")
        .expect("查询失败")
        .expect("图片应已索引");
    assert_eq!(
        after.content_hash.as_deref(),
        Some(hash.as_str()),
        "哈希应重新算出且一致"
    );
    assert_eq!(after.thumb_status, ThumbStatus::Generated, "缩略图应重建");
    assert!(
        cache.path_for_image(&hash).exists(),
        "恢复后缩略图应重新落盘"
    );
}
