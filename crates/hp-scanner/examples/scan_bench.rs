//! 扫描基准（**排查/度量用**，不进产品路径）。
//!
//! 用法：
//! ```text
//! cargo run -q --release -p hp-scanner --example scan_bench -- \
//!     <仓库库路径.sqlite3> <媒体源目录> [--full] [--rounds N] [--cache <目录>] [--seed]
//! ```
//!
//! - 库不存在则新建并把源挂上去；已存在则打开并复用其中**唯一**的源。
//! - `--seed`：只遍历 + `stat` + `detect_media_type`，把行**直接写进索引**
//!   （内容哈希留空、不读图片头、不解码），一次事务写完。用来给"索引期开销"
//!   造一份能在秒级生成的等价起点——未变的 `size`/`mtime` 才是判定 `unchanged`
//!   的全部依据，因此随后的增量扫描行为与真扫出来的索引一致。
//! - 每轮打印：耗时、`indexed/changed/missing/skipped`。

use std::path::PathBuf;
use std::time::Instant;

use hp_core::{FileId, FileIndexRow, MediaType, ThumbStatus, VerifyStatus};
use hp_media::ThumbnailCache;
use hp_scanner::{ScanOptions, Scanner, detect_media_type, file_stat};
use hp_store::RepoDb;
use time::format_description::well_known::Rfc3339;
use walkdir::WalkDir;

fn main() {
    let mut args = std::env::args().skip(1);
    let repo_path: PathBuf = args.next().expect("缺少仓库库路径").into();
    let root: PathBuf = args.next().expect("缺少媒体源目录").into();
    let mut full = false;
    let mut seed = false;
    let mut rounds = 1usize;
    let mut cache: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--full" => full = true,
            "--seed" => seed = true,
            "--rounds" => {
                rounds = args
                    .next()
                    .expect("--rounds 缺参数")
                    .parse()
                    .expect("轮数非法")
            }
            "--cache" => cache = Some(args.next().expect("--cache 缺参数").into()),
            other => panic!("未知参数：{other}"),
        }
    }

    let root_str = root.to_string_lossy().to_string();
    let mut db = if repo_path.exists() {
        RepoDb::open(repo_path.as_path()).expect("打开仓库库失败")
    } else {
        let mut db = RepoDb::create(repo_path.as_path(), "基准仓库").expect("创建仓库库失败");
        db.mount_source("bench-repo", &root_str, Some("基准源"), None)
            .expect("挂载媒体源失败");
        db
    };
    let source = db
        .list_sources("bench-repo")
        .expect("列出媒体源失败")
        .into_iter()
        .next()
        .expect("仓库库里没有媒体源");

    if seed {
        let started = Instant::now();
        let now = time::OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .expect("格式化时间失败");
        let mut rows = Vec::new();
        for entry in WalkDir::new(&root).follow_links(false) {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(media_type) = detect_media_type(entry.path()) else {
                continue;
            };
            let Some((size, mtime)) = file_stat(entry.path()) else {
                continue;
            };
            let relative = entry
                .path()
                .strip_prefix(&root)
                .expect("strip_prefix 失败")
                .to_string_lossy()
                .replace('\\', "/");
            rows.push(FileIndexRow {
                id: FileId::generate(),
                source_id: source.id.clone(),
                relative_path: relative,
                media_type,
                marks: Vec::new(),
                content_hash: None,
                content_hash_algo: None,
                content_hash_algo_version: None,
                perceptual_hash: None,
                perceptual_hash_algo: None,
                perceptual_hash_algo_version: None,
                size,
                mtime,
                width: None,
                height: None,
                scan_time: now.clone(),
                verify_status: VerifyStatus::Ok,
                thumb_status: ThumbStatus::NotGenerated,
                missing_status: 0,
                media_info_json: None,
            });
        }
        db.begin_write_batch().expect("开始写批次失败");
        for row in &rows {
            db.upsert_file(row).expect("播种索引失败");
        }
        db.commit_write_batch().expect("提交写批次失败");
        let kinds = rows
            .iter()
            .filter(|r| r.media_type == MediaType::Image)
            .count();
        println!(
            "播种完成：{} 行（其中图片 {}）· {:.3} s",
            rows.len(),
            kinds,
            started.elapsed().as_secs_f64()
        );
        return;
    }

    let scanner = Scanner::new();
    let options = ScanOptions {
        full,
        ffmpeg_bin: Some("external-cli/ffmpeg/bin/ffmpeg.exe".into()),
        ffprobe_bin: Some("external-cli/ffmpeg/bin/ffprobe.exe".into()),
        thumbnail_cache: cache.map(ThumbnailCache::new),
        video_timeout: std::time::Duration::from_secs(30),
    };

    for round in 1..=rounds {
        scanner.reset();
        let started = Instant::now();
        let outcome = scanner
            .scan_source(&mut db, &source, &options, &mut |_p| {})
            .expect("扫描失败");
        let elapsed = started.elapsed();
        println!(
            "第 {round} 轮（full={full}）：{:.3} s · indexed={} changed={} missing={} skipped={} cancelled={}",
            elapsed.as_secs_f64(),
            outcome.indexed,
            outcome.changed,
            outcome.missing,
            outcome.skipped,
            outcome.cancelled
        );
    }
}
