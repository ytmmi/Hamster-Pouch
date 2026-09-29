//! 调色板与"全面分析"的绑定回归（用户口径 2026-09）。
//!
//! 政策：调色板**不再由界面点击触发**，而是源扫描 / 源全量重扫 / `file.reanalyze` 这类
//! **全面分析文件**的副产品。三条不变量在这里被钉住：
//!
//! 1. 扫描**图片**会写入调色板（含 `version`，前端据此判断缓存是否过期）；
//! 2. **非图片**（音频占位行 D11）不写调色板（D18：色彩参考仅图片）；
//! 3. **手动锁定**（`locked:true`）的色值不被重扫覆盖——那是用户的判定权。

use std::path::Path;

use hp_media::{encode_palette_json, PALETTE_FORMAT_VERSION};
use hp_scanner::{ScanOptions, Scanner};
use hp_store::RepoDb;

/// 写一张纯色 PNG（`extract_palette` 对纯色的结果是确定的）。
fn write_solid_png(path: &Path, color: [u8; 3]) {
    let img = image::RgbImage::from_pixel(32, 32, image::Rgb(color));
    img.save(path).expect("写测试图失败");
}

fn scan_all(db: &mut RepoDb, source: &hp_core::Source, full: bool) -> hp_scanner::ScanOutcome {
    let scanner = Scanner::new();
    let options = ScanOptions {
        full,
        ..ScanOptions::default()
    };
    let mut progress = |_: &hp_scanner::ScanProgress| {};
    scanner
        .scan_source(db, source, &options, &mut progress)
        .expect("扫描失败")
}

#[test]
fn scan_writes_palette_for_images_only() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let src_dir = tmp.path().join("media");
    std::fs::create_dir_all(&src_dir).expect("创建媒体源目录失败");
    write_solid_png(&src_dir.join("red.png"), [255, 0, 0]);
    // 音频是 D11 占位行：扫描不会读它的内容，也不该给它写调色板。
    std::fs::write(src_dir.join("track.mp3"), b"not really audio").expect("写占位音频失败");

    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", src_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");
    scan_all(&mut db, &source, false);

    let image = db
        .get_file_by_path(source.id.as_str(), "red.png")
        .expect("查询失败")
        .expect("图片应已索引");
    let palette = db
        .get_color_ref(image.id.as_str())
        .expect("读取色彩参考失败")
        .expect("扫描图片应顺带写入调色板");
    let value: serde_json::Value =
        serde_json::from_str(&palette.color_json).expect("调色板应是不透明 JSON");
    assert_eq!(
        value["version"], PALETTE_FORMAT_VERSION,
        "缓存必须带版本号，否则前端会把它当'未提取'反复重算"
    );
    assert_eq!(value["locked"], false, "自动结果不得自称已锁定");
    assert_eq!(value["colors"][0], "#ff0000", "纯红图的首色应为 #ff0000");

    let audio = db
        .get_file_by_path(source.id.as_str(), "track.mp3")
        .expect("查询失败")
        .expect("音频应写入占位行");
    assert!(
        db.get_color_ref(audio.id.as_str())
            .expect("读取色彩参考失败")
            .is_none(),
        "色彩参考仅图片（D18）：音频不该有调色板"
    );
}

#[test]
fn reanalyze_refreshes_palette_but_never_overwrites_locked() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let src_dir = tmp.path().join("media");
    std::fs::create_dir_all(&src_dir).expect("创建媒体源目录失败");
    let image_path = src_dir.join("red.png");
    write_solid_png(&image_path, [255, 0, 0]);

    let mut db = RepoDb::create(tmp.path().join("repo.sqlite3"), "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", src_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");
    scan_all(&mut db, &source, false);

    let file = db
        .get_file_by_path(source.id.as_str(), "red.png")
        .expect("查询失败")
        .expect("图片应已索引");
    let scanner = Scanner::new();

    // 1）未锁定：`file.reanalyze` 走的就是 `rescan_file`，重扫应把调色板刷新成当前内容。
    let stale = encode_palette_json(&["#000000".to_string()]);
    db.upsert_color_ref(file.id.as_str(), &stale).expect("写入旧调色板失败");
    scanner
        .rescan_file(&mut db, &source, "red.png", &ScanOptions::default(), None)
        .expect("重新分析失败");
    let refreshed = db
        .get_color_ref(file.id.as_str())
        .expect("读取色彩参考失败")
        .expect("重新分析后仍应有调色板");
    let refreshed_value: serde_json::Value =
        serde_json::from_str(&refreshed.color_json).expect("调色板应是不透明 JSON");
    assert_eq!(
        refreshed_value["colors"][0], "#ff0000",
        "未锁定的调色板应被重新分析刷新（旧值 #000000 是过期的）"
    );

    // 2）已锁定：手动锁定的色值是用户的判定权，重扫不得覆盖。
    let locked = r##"{"version":2,"colors":["#123456"],"locked":true}"##.to_string();
    db.upsert_color_ref(file.id.as_str(), &locked).expect("写入锁定调色板失败");
    // 文件内容也换掉，确保"刷新"的条件成立（否则可能是碰巧没重算）
    write_solid_png(&image_path, [0, 0, 255]);
    scan_all(&mut db, &source, true);
    let after = db
        .get_color_ref(file.id.as_str())
        .expect("读取色彩参考失败")
        .expect("锁定的调色板必须还在");
    assert_eq!(
        after.color_json, locked,
        "locked:true 的调色板不得被全量重扫覆盖（用户手动锁定的判定权）"
    );
}
