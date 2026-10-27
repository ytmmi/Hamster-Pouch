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

use hp_core::{FileMark, MediaType, ThumbStatus};
use hp_hash::{ContentHash, PerceptualHash, hash_file};
use hp_media::{IMAGE_THUMB_MAX_DIM, extract_thumbnail, generate_image_thumbnail};

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
    /// 已存在行的**标记集合**（D102：可多值）。扫描只在**一个标记都没有**时补默认值，
    /// **不覆盖**已有标记——标记是用户的选择（用户口径："标记可以交叉"）。
    pub existing_marks: Vec<FileMark>,
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

/// 纯计算：读文件、算哈希、抽帧 / 出缩略图。**不访问数据库、不写索引**。
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
            // 缩略图**扫描期同步生成**（D126）：与视频首帧（D16）同一条路——
            // 解码 / 编码只依赖文件本身，正是并行阶段该干的活。反过来（留到界面要
            // 显示时才逐张补）会让大库第一次滚动就是几百次同步解码。
            let thumb_status = process_image_thumb(&prepared.path, &content, options);
            Computed {
                content: Some(content),
                perceptual,
                palette,
                thumb_status: Some(thumb_status),
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
        // 音频（2026-10-17 / D115）：**不再是 D11 占位行**——与图片/视频同档，
        // 照算内容哈希（移动识别 / 去重靠它），并用 ffprobe 缓存时长 / 编码 / 码率等
        // 媒体信息（此前索引里**根本没有**音频时长，元数据面板只能让前端
        // `preload="metadata"` 临时读一次）。
        //
        // 波形图**不在这里生成**：它是"按需缩略图"（`thumb.get` 缓存未命中时才画），
        // 与视频首帧同一条路——扫描期不出来，免得给全库音频都白做一次 ffmpeg。
        // 感知哈希仍为空：音频没有"视觉本体"，dHash 对它没有意义（与文本/PDF 同款）。
        MediaType::Audio => {
            let Ok(content) = hash_file(&prepared.path) else {
                return Computed {
                    unreadable: true,
                    ..Computed::default()
                };
            };
            let media_info = probe_audio(&prepared.path, options);
            Computed {
                content: Some(content),
                perceptual: None,
                palette: None,
                thumb_status: Some(ThumbStatus::NotGenerated),
                media_info,
                unreadable: false,
            }
        }
        // 文本（2026-10）与 PDF（2026-10-11）：**照算内容哈希**（移动识别/去重与图片
        // 同口径），但不产出感知哈希 / 缩略图 / 调色板 / 媒体信息——两者都不进索引期
        // 的派生数据。封面与正文由 `hp_book` / `hp_pdf` 在**面板取数时**按需解析，
        // 走 `book.meta` / `book.content` 的按内容哈希磁盘缓存（不进索引）。
        //
        // 两者合在一个分支里，是因为入库口径**逐条相同**；分成两个 arm 写两遍
        // 一模一样的代码，只会在下次改动时漏掉其中一个。
        MediaType::Text | MediaType::Pdf => {
            let Ok(content) = hash_file(&prepared.path) else {
                return Computed {
                    unreadable: true,
                    ..Computed::default()
                };
            };
            Computed {
                content: Some(content),
                thumb_status: Some(ThumbStatus::NotGenerated),
                ..Computed::default()
            }
        }
    }
}

/// 图片缩略图：**扫描期同步生成**（2026-10-27 / D126）。
///
/// **口径与视频首帧（D16）一致，与音频波形（D115）相反**：视频首帧扫描期就抽，
/// 音频波形留到按需。分界线是"这张图是不是每张卡片都要显示"——图片缩略图是网格 /
/// 胶片栏的视觉本体，不预生成，第一次滚动就是几百次同步解码；波形只是播放器的辅助图。
///
/// **复用按需路径的同一次调用**（`hp_media::generate_image_thumbnail` + 同一个
/// `ThumbnailCache` 路径）：另写一套扫描期解码会让 EXIF 方向、WebP 编码降级、
/// SVG / AVIF 的 ffmpeg 兜底与 `thumb.get` 分叉，同一张图出现两份不同的字节。
///
/// **缓存命中即跳过重编码**：缩略图按内容哈希寻址，图没变就不必再算一次——
/// 这也让"全量重扫"（右键「全量」）在已有缩略图的库上不额外花时间。
///
/// 没有 `thumbnail_cache`（单元测试 / 精简环境）时不出图：行照建、`thumb_status`
/// 留 0，与视频无 `ffmpeg_bin` 时同款降级。
fn process_image_thumb(path: &Path, content: &ContentHash, options: &ScanOptions) -> ThumbStatus {
    let Some(cache) = &options.thumbnail_cache else {
        return ThumbStatus::NotGenerated;
    };
    let thumb_path = cache.path_for_image(&content.value);
    if thumb_path.exists() {
        return ThumbStatus::Generated;
    }
    if cache.ensure_dir_for(&content.value).is_err() {
        return ThumbStatus::Failed;
    }
    match generate_image_thumbnail(
        path,
        &thumb_path,
        IMAGE_THUMB_MAX_DIM,
        options.ffmpeg_bin.as_deref(),
        options.video_timeout,
    ) {
        Ok(()) => ThumbStatus::Generated,
        // 坏图 / 无解码器：**不影响索引**，行照建，只是没有缩略图
        // （与感知哈希缺失、调色板缺失同一容错口径）。
        Err(_) => ThumbStatus::Failed,
    }
}

/// 音频媒体信息：ffprobe 原始 JSON（2026-10-17 / D115）。
///
/// **与视频同一份探测**（`hp_media::probe`）：ffprobe 对音频同样给出 `format.duration`
/// 与音频流的 `codec_name` / `bit_rate` / `sample_rate` / `channels`——因此不需要
/// 第二条探测命令，只是此前**没人对音频调它**（D11 把音频当占位行，不读内容）。
///
/// 没有 ffprobe（测试夹具 / 精简环境）时返回 `None`：索引行照建、哈希照算，
/// 只是元数据那几行显示 `—`（与视频无 ffprobe 缓存时同款降级）。
fn probe_audio(path: &Path, options: &ScanOptions) -> Option<String> {
    let ffprobe = options.ffprobe_bin.as_ref()?;
    hp_media::probe(path, ffprobe, options.video_timeout)
        .ok()
        .map(|info| info.raw_json)
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

    if let Some(ffprobe) = &options.ffprobe_bin
        && let Ok(info) = hp_media::probe(path, ffprobe, options.video_timeout)
    {
        media_info = Some(info.raw_json);
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

    fn prepared(
        path: PathBuf,
        media_type: MediaType,
        unchanged: bool,
        want_palette: bool,
    ) -> Prepared {
        Prepared {
            relative_path: "x".to_string(),
            path,
            media_type,
            size: 1,
            mtime: "0".to_string(),
            unchanged,
            existing_id: None,
            existing_marks: Vec::new(),
            want_palette,
        }
    }

    #[test]
    fn unchanged_task_does_no_work() {
        let p = prepared(
            PathBuf::from("does-not-exist.png"),
            MediaType::Image,
            true,
            true,
        );
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
    fn audio_is_hashed_but_has_no_visual_derivations() {
        // 音频（2026-10-17 / D115）与文本/PDF **同一档**：照算内容哈希（移动识别/去重），
        // 但没有感知哈希 / 调色板。它与"占位行"的差别正是那个哈希——
        // D11 的占位行无哈希，而元数据面板/去重都指望它。
        let dir = std::env::temp_dir().join(format!("hp-scan-task-audio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("song.mp3");
        std::fs::write(&path, b"ID3 fake audio bytes").expect("写入测试文件失败");

        let p = prepared(path, MediaType::Audio, false, false);
        let got = compute(&p, &ScanOptions::default());
        assert!(got.content.is_some(), "音频升级后应有内容哈希（D115）");
        assert!(got.perceptual.is_none(), "音频没有视觉本体，不该有感知哈希");
        assert!(got.palette.is_none(), "音频没有调色板");
        // 没有 ffprobe（`ScanOptions::default()` 的 `ffprobe_bin` 为 None）时，
        // 元数据如实为空——索引行照建、哈希照算。
        assert!(got.media_info.is_none(), "无 ffprobe 时不该凭空填元数据");
        assert!(!got.unreadable);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn video_cost_is_not_pixel_weighted() {
        // 视频走外部进程，内存占用与像素无关 → 配额恒为 1，不受尺寸影响。
        let p = prepared(PathBuf::from("v.mp4"), MediaType::Video, false, false);
        assert_eq!(pixel_cost(&p), 1);
    }

    #[test]
    fn text_hashes_content_but_no_visual_derivations() {
        // 文本与音频的差别：音频是**占位行**（无哈希），文本要有内容哈希
        // （移动识别/去重靠它），但感知哈希 / 调色板 / 媒体信息一律为空。
        let dir = std::env::temp_dir().join(format!("hp-scan-task-text-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("book.epub");
        std::fs::write(&path, b"PK\x03\x04 not really a zip").expect("写入测试文件失败");

        let p = prepared(path, MediaType::Text, false, false);
        let got = compute(&p, &ScanOptions::default());
        assert!(got.content.is_some(), "文本应有内容哈希");
        assert!(got.perceptual.is_none(), "文本没有视觉本体，不该有感知哈希");
        assert!(got.palette.is_none(), "文本没有调色板");
        assert!(got.media_info.is_none(), "文本不走 ffprobe");
        assert!(!got.unreadable);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_cost_is_not_pixel_weighted() {
        let p = prepared(PathBuf::from("book.epub"), MediaType::Text, false, false);
        assert_eq!(pixel_cost(&p), 1);
    }

    #[test]
    fn marks_default_to_empty_in_fixtures() {
        // 夹具把 `existing_marks` 设为空（= 该文件还没有任何标记 → 扫描补默认值）。
        // 这条断言只是把"默认无标记"钉住，防止日后夹具悄悄带上一个值。
        let p = prepared(PathBuf::from("a.txt"), MediaType::Text, false, false);
        assert!(p.existing_marks.is_empty());
        // 标记是**可多值**的（D102）：同一个文件可以同时带 book 与 manga。
        let book = FileMark::from_raw("book");
        let manga = FileMark::from_raw("manga");
        assert!(book.is_book());
        assert!(!manga.is_book());
    }

    #[test]
    fn image_scan_writes_thumbnail_when_cache_is_present() {
        // D126：图片缩略图在**扫描期**就落盘，不等界面来要。缩略图缓存按内容哈希
        // 寻址，所以断言"缓存里有这个文件"即可——不必关心它是不是 WebP、有多大。
        let dir = std::env::temp_dir().join(format!("hp-scan-task-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("a.png");
        image::RgbImage::from_pixel(48, 32, image::Rgb([0x11, 0xcc, 0x22]))
            .save(&path)
            .expect("写入测试图片失败");

        let cache = hp_media::ThumbnailCache::new(dir.join("thumbs"));
        let options = ScanOptions {
            thumbnail_cache: Some(cache.clone()),
            ..ScanOptions::default()
        };
        let p = prepared(path.clone(), MediaType::Image, false, false);
        let got = compute(&p, &options);
        assert_eq!(
            got.thumb_status,
            Some(ThumbStatus::Generated),
            "有 thumbnail_cache 时图片必须在扫描期出缩略图（D126）"
        );
        let hash = got.content.expect("应有内容哈希").value;
        let thumb_path = cache.path_for_image(&hash);
        assert!(
            thumb_path.exists(),
            "缩略图应落在 内容哈希 对应的缓存路径上"
        );

        // 再算一次：缓存已存在 → 直接判 Generated，**不重编码**（幂等，全量重扫不重复花钱）。
        let again = compute(&prepared(path, MediaType::Image, false, false), &options);
        assert_eq!(again.thumb_status, Some(ThumbStatus::Generated));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn image_scan_without_cache_leaves_thumb_not_generated() {
        // 没有 `thumbnail_cache`（单元测试 / 精简环境）时降级：行照建、哈希照算，
        // 只是 thumb_status 留 0，与视频无 `ffmpeg_bin` 时同款。
        let dir = std::env::temp_dir().join(format!("hp-scan-task-nocache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("b.png");
        image::RgbImage::from_pixel(16, 16, image::Rgb([0, 0, 0]))
            .save(&path)
            .expect("写入测试图片失败");

        let got = compute(
            &prepared(path, MediaType::Image, false, false),
            &ScanOptions::default(),
        );
        assert_eq!(got.thumb_status, Some(ThumbStatus::NotGenerated));
        assert!(got.content.is_some(), "有没有缓存都不影响哈希");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_is_not_thumbnailed_even_with_cache() {
        // 反向钉住 D115：音频**不**在扫描期出波形图——即便 cache 就在手上。
        // 这条与上面的图片用例成对，防止日后"顺手也给音频生成一张"把 D115 推翻。
        let dir =
            std::env::temp_dir().join(format!("hp-scan-task-audiothumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("song.mp3");
        std::fs::write(&path, b"ID3 fake audio bytes").expect("写入测试文件失败");

        let cache = hp_media::ThumbnailCache::new(dir.join("thumbs"));
        let options = ScanOptions {
            thumbnail_cache: Some(cache.clone()),
            ..ScanOptions::default()
        };
        let got = compute(&prepared(path, MediaType::Audio, false, false), &options);
        assert_eq!(got.thumb_status, Some(ThumbStatus::NotGenerated));
        let hash = got.content.expect("应有内容哈希").value;
        assert!(
            !cache.path_for_audio(&hash).exists(),
            "音频波形图仍按需生成（D115），扫描期不该出"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
