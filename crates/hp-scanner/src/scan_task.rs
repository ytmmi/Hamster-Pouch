//! 扫描期的**单文件任务**：串行准备 → 并行纯计算 → 串行写库（`docs/issues/0018`）。
//!
//! 为什么要拆成三段：解码 / 哈希 / 抽帧这些工作**只依赖文件本身**，可以并行；
//! 而所有数据库写入必须串行（`RepoDb` 在扫描期是 `&mut`，天然不可跨线程共享）。
//! 拆开之后，并行部分**不持有任何数据库句柄**，正确性不依赖锁顺序。
//!
//! **结果与旧实现逐位相同**：本模块只搬运"先算什么、后写什么"，算法本身一个字没改
//! ——感知哈希仍走 `hp_hash::dhash_image`，调色板仍走 `hp_media::extract_palette_from_image`
//! （与 `extract_palette` 是同一段代码），抽帧仍走 `hp_media::extract_thumbnail`。
//! AVIF/HEIC 家族的 ffmpeg 兜底解码只影响**此前从未解码成功**的格式（`docs/issues/0018`
//! §7 P1-D），既有格式的派生结果不受影响。

use std::path::{Path, PathBuf};

use hp_core::{MediaType, ThumbStatus};
use hp_hash::{hash_file, ContentHash, PerceptualHash};
use hp_media::extract_thumbnail;

use crate::scan_compute::analyze_image;
use crate::scanner::ScanOptions;

/// 串行准备阶段的产物：只含**廉价**信息（媒体类型、stat、是否变化、调色板是否要重算）。
#[derive(Debug, Clone)]
pub struct Prepared {
    pub path: PathBuf,
    pub relative_path: String,
    pub media_type: MediaType,
    pub size: i64,
    pub mtime: String,
    /// 已存在且 size/mtime 未变、且非全量重扫 → **完全跳过计算**。
    pub unchanged: bool,
    /// 已存在行的 id（`None` = 新文件）。写库阶段据此决定"更新"还是"新建"，
    /// 并保留原 id（RFC 0001：内容未变时身份不变）。
    pub existing_id: Option<String>,
    /// 调色板是否需要重算（仅图片有意义；已手动锁定时为 `false`，见 `write_palette`）。
    pub want_palette: bool,
}

/// 并行计算阶段的产物：纯数据，不含数据库句柄。
#[derive(Debug, Clone, Default)]
pub struct Computed {
    /// 内容哈希；`None` 且 `unreadable` 为真表示读取/哈希失败。
    pub content: Option<ContentHash>,
    pub perceptual: Option<PerceptualHash>,
    /// 调色板颜色（`#rrggbb`）；`None` = 未要求或提取失败。
    pub palette: Option<Vec<String>>,
    pub thumb_status: Option<ThumbStatus>,
    pub media_info: Option<String>,
    /// 读取失败 → 索引写"不可读"占位（RFC 0001），与旧实现同口径。
    pub unreadable: bool,
}

/// 该任务在并行阶段的**像素配额**（用于限流，防止大图并发把内存打爆）。
///
/// 只有图片需要按尺寸加权：一张 9000² 图解码后约 231 MB（RGB8），
/// 16 个核同时持图就是 3.7 GB。视频走外部进程，内存占用与像素无关。
pub fn pixel_cost(prepared: &Prepared) -> u64 {
    if prepared.unchanged || prepared.media_type != MediaType::Image {
        return 1;
    }
    crate::scan_compute::image_pixel_cost(&prepared.path)
}

/// 纯计算：读文件、算哈希、抽帧。**不访问数据库、不写索引**。
///
/// 视频抽帧会写缩略图缓存（`ThumbnailCache`），那是按内容哈希分文件的独立路径，
/// 且 `hp_media` 侧已改为**原子落盘**（先写临时文件再改名），因此并发安全。
pub fn compute(prepared: &Prepared, options: &ScanOptions) -> Computed {
    if prepared.unchanged {
        return Computed::default();
    }

    match prepared.media_type {
        MediaType::Image => {
            let Ok(content) = hash_file(&prepared.path) else {
                return Computed {
                    unreadable: true,
                    ..Computed::default()
                };
            };
            // 解码一次，同时得出感知哈希与调色板（旧实现解码两次）。
            // 解码失败**不影响索引**：与旧实现 `dhash_file(path).ok()` +
            // `extract_palette(..).ok()` 的容错口径一致。
            let (perceptual, palette) = match analyze_image(
                &prepared.path,
                prepared.want_palette,
                options.ffmpeg_bin.as_deref(),
                options.video_timeout,
            ) {
                Ok(derived) => (derived.perceptual, derived.palette),
                Err(_) => (None, None),
            };
            Computed {
                content: Some(content),
                perceptual,
                palette,
                thumb_status: Some(ThumbStatus::NotGenerated),
                media_info: None,
                unreadable: false,
            }
        }
        MediaType::Video => {
            let Ok(content) = hash_file(&prepared.path) else {
                return Computed {
                    unreadable: true,
                    ..Computed::default()
                };
            };
            let (thumb_status, perceptual, media_info) =
                process_video(&prepared.path, &content, options);
            Computed {
                content: Some(content),
                perceptual,
                palette: None,
                thumb_status: Some(thumb_status),
                media_info,
                unreadable: false,
            }
        }
        // 音频是占位行（D11）：不哈希、不缩略图、不调色板。
        MediaType::Audio => Computed {
            thumb_status: Some(ThumbStatus::NotGenerated),
            ..Computed::default()
        },
    }
}

/// 视频处理：ffprobe 元数据 + ffmpeg 首帧抽帧 + 首帧感知哈希（D12/D15/D16）。
fn process_video(
    path: &Path,
    content: &ContentHash,
    options: &ScanOptions,
) -> (ThumbStatus, Option<PerceptualHash>, Option<String>) {
    let mut thumb_status = ThumbStatus::NotGenerated;
    let mut perceptual: Option<PerceptualHash> = None;
    let mut media_info: Option<String> = None;

    if let Some(ffprobe) = &options.ffprobe_bin {
        if let Ok(info) = hp_media::probe(path, ffprobe, options.video_timeout) {
            media_info = Some(info.raw_json);
        }
    }

    if let (Some(ffmpeg), Some(cache)) = (&options.ffmpeg_bin, &options.thumbnail_cache) {
        // 视频首帧缩略图**保持 JPEG**：下方 `dhash_file` 对缩略图本身算感知哈希，
        // 换编码会轻微改变像素、使已入库的视频感知哈希与新值不再逐位可比
        // （实测汉明距离中位 0、最大 5 bit）——属需独立裁决的迁移问题，
        // 故本轮只把**图片**缩略图切到体积更小的 WebP（见 `hp_media::thumbnail` 模块文档）。
        let thumb_path = cache.path_for_video(&content.value);
        if cache.ensure_dir_for(&content.value).is_ok() {
            match extract_thumbnail(path, &thumb_path, ffmpeg, options.video_timeout) {
                Ok(()) => {
                    thumb_status = ThumbStatus::Generated;
                    perceptual = hp_hash::dhash_file(&thumb_path).ok();
                }
                Err(_) => thumb_status = ThumbStatus::Failed,
            }
        }
    }

    (thumb_status, perceptual, media_info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared(path: PathBuf, media_type: MediaType, unchanged: bool, want_palette: bool) -> Prepared {
        Prepared {
            relative_path: "x".to_string(),
            path,
            media_type,
            size: 1,
            mtime: "0".to_string(),
            unchanged,
            existing_id: None,
            want_palette,
        }
    }

    #[test]
    fn unchanged_task_does_no_work() {
        let p = prepared(PathBuf::from("does-not-exist.png"), MediaType::Image, true, true);
        let got = compute(&p, &ScanOptions::default());
        assert!(!got.unreadable, "跳过的任务不该被当成不可读");
        assert!(got.content.is_none());
        assert!(got.perceptual.is_none());
        assert!(got.palette.is_none());
    }

    #[test]
    fn missing_file_is_reported_unreadable() {
        let p = prepared(
            std::env::temp_dir().join("hp-scan-task-missing.png"),
            MediaType::Image,
            false,
            true,
        );
        let got = compute(&p, &ScanOptions::default());
        assert!(got.unreadable, "读不到的文件必须走不可读占位（RFC 0001）");
    }

    #[test]
    fn image_computes_hash_hash_and_palette_in_one_pass() {
        let dir = std::env::temp_dir().join(format!("hp-scan-task-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("a.png");
        // 取 17 的倍数：4 位量化（`>>4` 再 `*17`）能**原样还原**，
        // 因此期望值可以写死而不必复算一遍算法。
        image::RgbImage::from_pixel(48, 32, image::Rgb([0x11, 0xcc, 0x22]))
            .save(&path)
            .expect("写入测试图片失败");

        let p = prepared(path.clone(), MediaType::Image, false, true);
        let got = compute(&p, &ScanOptions::default());
        assert!(got.content.is_some(), "图片应有内容哈希");
        assert!(got.perceptual.is_some(), "图片应有感知哈希");
        assert_eq!(
            got.palette.expect("应当提取调色板")[0],
            "#11cc22",
            "纯色图的第一个调色板色应当原样还原（17 的倍数可被 4 位量化无损还原）"
        );

        // 不需要调色板时省下那次重采样，但哈希照旧。
        let p2 = prepared(path, MediaType::Image, false, false);
        let got2 = compute(&p2, &ScanOptions::default());
        assert!(got2.perceptual.is_some());
        assert!(got2.palette.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_is_a_placeholder_row() {
        let p = prepared(PathBuf::from("song.mp3"), MediaType::Audio, false, false);
        let got = compute(&p, &ScanOptions::default());
        assert!(got.content.is_none(), "音频占位行无哈希（D11）");
        assert!(got.perceptual.is_none());
        assert!(got.palette.is_none());
        assert!(!got.unreadable);
    }

    #[test]
    fn video_cost_is_not_pixel_weighted() {
        // 视频走外部进程，内存占用与像素无关 → 配额恒为 1，不受尺寸影响。
        let p = prepared(PathBuf::from("v.mp4"), MediaType::Video, false, false);
        assert_eq!(pixel_cost(&p), 1);
    }
}
