//! M2 验收测试：扫描索引、同名替换识别、移动/重命名不丢身份、音频占位、文本入库、未知跳过。
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

/// 创建临时仓库 + 挂载临时媒体源。
fn setup(tmp: &tempfile::TempDir) -> (RepoDb, Source) {
    let source_dir = tmp.path().join("photos");
    std::fs::create_dir_all(&source_dir).expect("创建媒体源目录失败");
    let repo_path = tmp.path().join("repo.sqlite3");
    let mut db = RepoDb::create(&repo_path, "测试仓库").expect("创建仓库失败");
    let source = db
        .mount_source("test-repo", source_dir.to_str().unwrap(), None, None)
        .expect("挂载媒体源失败");
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
fn scan_indexes_image_audio_and_text_with_hashes() {
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);

    make_png(&dir.join("photo.png"), 1);
    std::fs::write(dir.join("notes.txt"), b"hello plain text").expect("写 txt 失败");
    std::fs::write(dir.join("song.mp3"), b"ID3 fake audio").expect("写 mp3 失败");
    // 真正的未知类型：扩展名不在任何表里、内容也没有 magic bytes。
    // **不能再用 `.txt` 当"未知"**：2026-10 起 `txt` 是 `text` 媒体类型（D93）。
    std::fs::write(dir.join("blob.bin"), b"hello plain text").expect("写 bin 失败");

    let outcome = scan(&mut db, &source, false).expect("扫描失败");
    assert_eq!(outcome.indexed, 3, "图片 / 音频 / 文本应各写一行");
    assert_eq!(outcome.skipped, 1, "未知 .bin 应跳过");

    // 图片：有内容哈希 + 感知哈希
    let img = db
        .get_file_by_path(source.id.as_str(), "photo.png")
        .expect("查询图片失败")
        .expect("图片应已索引");
    assert_eq!(img.media_type, MediaType::Image);
    assert!(img.content_hash.is_some(), "图片应有内容哈希");
    assert!(img.perceptual_hash.is_some(), "图片应有感知哈希");
    assert_eq!(img.verify_status, VerifyStatus::Ok);

    // 音频（2026-10-17 / D115）：**不再是占位行**——照算内容哈希（移动识别/去重
    // 与图片同口径），校验状态 `ok`；感知哈希仍为空（音频没有视觉本体）。
    // 这条断言是"占位行升级"的第一手证据：旧口径下 `content_hash` 必为 NULL。
    let audio = db
        .get_file_by_path(source.id.as_str(), "song.mp3")
        .expect("查询音频失败")
        .expect("音频应已索引");
    assert_eq!(audio.media_type, MediaType::Audio);
    assert!(
        audio.content_hash.is_some(),
        "音频升级后应有内容哈希（D115 取代 D11 占位行）"
    );
    assert!(
        audio.perceptual_hash.is_none(),
        "音频没有视觉本体，不应有感知哈希"
    );
    assert_eq!(audio.verify_status, VerifyStatus::Ok);

    // 文本（2026-10 / D93）：**算内容哈希**（移动识别与去重），但不产出视觉派生。
    // **标记（2026-10-10 / D102）**：`txt` / `md` 默认**不带**任何标记，
    // 只有 `epub` 默认带 `book`；标记是**可多值**的、与类目正交（用户可自行打上 manga）。
    let text = db
        .get_file_by_path(source.id.as_str(), "notes.txt")
        .expect("查询 txt 失败")
        .expect("文本应已索引");
    assert_eq!(text.media_type, MediaType::Text);
    assert!(
        text.marks.is_empty(),
        "txt 默认不带标记（旧口径的 document 子类型已废弃）"
    );
    assert!(text.content_hash.is_some(), "文本应有内容哈希（与音频占位行不同）");
    assert!(text.perceptual_hash.is_none(), "文本没有视觉本体，不应有感知哈希");
    assert_eq!(text.verify_status, VerifyStatus::Ok);

    // 未知类型不入库
    assert!(
        db.get_file_by_path(source.id.as_str(), "blob.bin")
            .expect("查询 bin 失败")
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
fn legacy_audio_placeholder_is_upgraded_in_place() {
    // **本次升级的核心回归**（D11 → D115）：旧库里音频是**占位行**
    // （`content_hash` 为 NULL、`verify_status = 'placeholder'`），且 size/mtime 与
    // 磁盘一致。若升级只写"新扫描的哈希"，这些**内容未变的既有行**会被"未变即跳过"
    // 原样留下——表现为"升了级却还是没有哈希、没有时长"。
    //
    // 因此这里**不重扫全量**（`full = false`），直接构造一行旧口径的占位行，
    // 再跑一次普通扫描，断言它被就地补齐。判据只看 `content_hash`：
    // 它是"这份内容到底算没算过"的事实，而 status 只是镜像。
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    let audio_path = dir.join("old.mp3");
    std::fs::write(&audio_path, b"ID3 legacy placeholder audio").expect("写 mp3 失败");

    // 先按**新口径**扫一次，拿到一行正常索引（含真实 size/mtime）。
    scan(&mut db, &source, false).expect("首次扫描失败");
    let indexed = db
        .get_file_by_path(source.id.as_str(), "old.mp3")
        .expect("查询失败")
        .expect("音频应已索引");
    let hash_now = indexed.content_hash.clone().expect("新口径应有哈希");

    // 再把这行**打回旧口径的占位行**（模拟"旧版本应用写的库"）：
    // 清哈希、状态置 placeholder。size/mtime 一字不改。
    // 用公开的 `upsert_file` 整行写回，**不新增仅供测试的库 API**。
    let mut legacy = indexed.clone();
    legacy.content_hash = None;
    legacy.content_hash_algo = None;
    legacy.content_hash_algo_version = None;
    legacy.verify_status = VerifyStatus::Placeholder;
    db.upsert_file(&legacy).expect("回退为占位行失败");
    let rolled_back = db
        .get_file_by_path(source.id.as_str(), "old.mp3")
        .expect("查询失败")
        .expect("应仍在索引");
    assert!(
        rolled_back.content_hash.is_none(),
        "前提校验：回退后必须真的没有哈希（否则本用例测不到升级路径）"
    );
    assert_eq!(rolled_back.verify_status, VerifyStatus::Placeholder);

    // 普通扫描（**非全量**）：内容没变，但占位行必须被重算。
    scan(&mut db, &source, false).expect("升级扫描失败");
    let upgraded = db
        .get_file_by_path(source.id.as_str(), "old.mp3")
        .expect("查询失败")
        .expect("应仍在索引");
    assert!(
        upgraded.content_hash.is_some(),
        "存量占位行必须被原位补齐哈希——'未变即跳过'不得把它留下"
    );
    assert_eq!(
        upgraded.content_hash.as_deref(),
        Some(hash_now.as_str()),
        "补算出的哈希应与内容一致（内容没变，哈希就该相同）"
    );
    assert_eq!(
        upgraded.verify_status,
        VerifyStatus::Ok,
        "升级后校验状态应为 ok（不再是 placeholder）"
    );
    assert_eq!(upgraded.id, indexed.id, "原位升级必须保留文件身份（id 不变）");
}

#[test]
fn rewritten_audio_row_is_skipped_after_upgrade() {
    // 升级路径**不得**变成"每次扫描都重哈希全部音频"：补算过一次之后，
    // 那些行就回到正常的"内容未变即跳过"。这条与上一条是一对——
    // 少了它，把 `needs_audio_upgrade` 写成恒真也能让上一条全绿，
    // 代价是全库音频每次扫描都被重算（正是要避免的浪费）。
    let tmp = tempfile::tempdir().expect("创建临时目录失败");
    let (mut db, source) = setup(&tmp);
    let dir = Path::new(&source.local_path);
    std::fs::write(dir.join("song.mp3"), b"ID3 already upgraded").expect("写 mp3 失败");

    scan(&mut db, &source, false).expect("首次扫描失败");
    let outcome = scan(&mut db, &source, false).expect("二次扫描失败");
    assert_eq!(
        outcome.changed, 0,
        "已是新口径的音频行在第二次扫描时应被跳过（changed 必须为 0）"
    );
    assert_eq!(outcome.indexed, 0, "第二次扫描不得新增行");
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
