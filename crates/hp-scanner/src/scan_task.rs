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

use crate::scan_compute::{ImageProbe, analyze_image_derivations, decode_scan_image};
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
    /// 图片头的一次读头产物（**配额 + 显示尺寸**，0043 / 第 43 轮）。
    ///
    /// 准备阶段读**一次**：配额交给并行段限流，显示尺寸直接进索引——旧实现在
    /// 限流时读一次头、`compute` 里又读一次同一份头。只有"要重算的图片"有值，
    /// 未变化的图一个字节都不碰。
    pub image_probe: Option<ImageProbe>,
    /// 既有行的**内容哈希**与**感知哈希**（`None` = 库里没有）。
    ///
    /// 只用于"内容一字节未变 → 派生数据可以原样复用"这条判断（2026-11-23 P0-2）：
    /// 全量重扫会忽略 size/mtime 重新核对，核对的手段是**重算内容哈希**（便宜），
    /// 而缩略图 / dHash / 调色板 / 媒体信息是同一份内容的纯函数产物（昂贵），
    /// 哈希相等就没有理由再算一遍——实测 12 267 张 AVIF 的全量重扫 1572 s 里绝大部分是解码。
    pub existing_content_hash: Option<String>,
    pub existing_perceptual_hash: Option<String>,
    /// 那枚 dHash 是**哪个算法版本**算出来的。复用的前提之一必须是它与当前
    /// [`hp_hash::PERCEPTUAL_HASH_ALGO_VERSION`] 相等，否则复用会把旧算法的值
    /// 盖上新的版本戳，库从此谎报这些 dHash 出自新算法（去重会错配且不报错）。
    pub existing_perceptual_hash_algo_version: Option<i64>,
    /// 既有行的缩略图状态与调色板（`Some` 且非空 = 库里有这份产物）。
    pub existing_thumb_status: ThumbStatus,
    pub existing_color_json: Option<String>,
    /// 本轮**允许**复用既有派生数据（缩略图 / dHash / 调色板）吗？
    ///
    /// 由扫描在准备阶段一次性定：只有「该源上一次完整重算用的派生参数 == 当前
    /// [`DERIVATION_VERSION`]」才为真。参数一变（缩略图档位、WebP 质量、dHash 算法…），
    /// 磁盘上的旧缩略图与旧 dHash 就不再是「同一份内容的等价产物」，必须重算——
    /// 否则改了参数却看不到任何变化，而且没有任何报错。
    pub reuse_derivations: bool,
    /// 既有行的 `files.index_only`（新文件 = `false`）。写库阶段据此**跳过无用的 UPDATE**：
    /// 这一列不在 `upsert_file` 的列清单里，旧实现每写一行都恒发一条 `UPDATE files SET
    /// index_only = ?`——绝大多数行本来就与排除态一致，那条 UPDATE 是纯浪费（实测 8.8 µs/行）。
    pub existing_index_only: bool,
    /// 该路径是否**落在被排除子树下**（`source_exclusion`，D149 + 2026-11-12 口径）。
    ///
    /// 为真时这份内容**只建索引**：不读内容、不算哈希、不出缩略图、不算感知哈希与调色板、
    /// 不 `probe` 媒体信息。`compute` 会直接返回空产物，写库再把 `index_only` 落成 1。
    pub excluded: bool,
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
    /// 图片的**显示尺寸**（EXIF 方向已应用，0043）；`None` = 非图片或头读不到。
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 读取失败 → 索引写"不可读"占位（RFC 0001），与旧实现同口径。
    pub unreadable: bool,
}

/// 该任务在并行阶段的**像素配额**（用于限流，防止大图并发把内存打爆）。
///
/// 只有图片需要按尺寸加权：一张 9000² 图解码后约 231 MB（RGB8），
/// 16 个核同时持图就是 3.7 GB。视频走外部进程，内存占用与像素无关。
///
/// 配额来自准备阶段那次读头（[`Prepared::image_probe`]，第 43 轮）；调用方没带
/// （自建 `Prepared` 的测试/工具）时现场读一次头，与旧行为完全一致。
pub fn pixel_cost(prepared: &Prepared) -> u64 {
    // 被排除的条目根本不进解码队列，配额按最小单位算（否则准备阶段没读头，
    // 这里会为了一个"不打算解码"的文件去读一次文件头，等于把省掉的工作又做回来）。
    if prepared.unchanged || prepared.excluded || prepared.media_type != MediaType::Image {
        return 1;
    }
    match prepared.image_probe {
        Some(probe) => probe.pixel_cost.max(1),
        None => crate::scan_compute::image_pixel_cost(&prepared.path),
    }
}

/// 派生数据参数版本：**只要任何一种派生产物的生成参数变了，就把它 +1**。
///
/// 覆盖的参数面：扫描解码上限（`SCAN_DECODE_BOUND`）、缩略图档位与编码质量
/// （`IMAGE_THUMB_MAX_DIM` / `IMAGE_THUMB_DIM_LADDER` / `IMAGE_THUMB_WEBP_QUALITY`）、
/// dHash 算法与之依赖的解码分辨率、调色板抽取参数。
///
/// 为什么需要它：内容哈希没变时扫描会**直接复用磁盘上那份缩略图与库里那枚 dHash**
/// （见 [`reuse_image_derivations`]）。如果只改参数不认版本，复用的仍是旧参数产物，
/// 表现为「改了缩略图质量 / 换了 dHash 算法，扫描跑完却什么都没变，也不报错」。
/// 有了这一版，升级参数 → 版本不等 → 该源退回逐张解码重算一次，然后重新盖章。
///
/// **按源记录**（`repo_meta.derivation_version:<source_id>`）：一个仓库可以挂多个源，
/// 源 A 重算过不代表源 B 的磁盘产物也出自当前参数。
pub const DERIVATION_VERSION: i64 = 1;
/// **内容未变时复用既有派生数据**（2026-11-23 P0-2）；不满足前提返回 `None`，走老路重算。
///
/// 前提（缺一不可）：
/// 1. 库里存过内容哈希，且与刚重算的一致——这是"内容没变"的**事实判据**；
/// 2. 库里存过非空的 dHash——空的说明上次就没算出来，得再给一次机会；
/// 3. 缩略图状态是 `Generated` 且（配了缓存目录时）缓存文件确实还在；
/// 4. 调色板要么不需要重算（手动锁定 D82），要么库里已经有——否则"缺失的调色板"
///    永远补不上，因为补它需要整图解码。
///
/// 复用时**不回写调色板**（`palette: None`）：库里那行本来就是对的，重写一遍只会多一次
/// `upsert_color_ref`。
fn reuse_image_derivations(
    prepared: &Prepared,
    content: &ContentHash,
    options: &ScanOptions,
) -> Option<Computed> {
    // 版本门在最外层：该源的派生参数与当前不符时，磁盘上的产物一律不可信。
    if !prepared.reuse_derivations {
        return None;
    }
    if prepared.existing_content_hash.as_deref() != Some(content.value.as_str()) {
        return None;
    }
    if prepared.want_palette && prepared.existing_color_json.is_none() {
        return None;
    }
    // 版本必须**逐值相等**才复用：`algo_version` 升级后，库里那枚 dHash 出自旧算法，
    // 复用它等于把旧值盖上新的版本戳（写库只写 `perceptual_hash` 与版本号两列），
    // 从此库里声称这些 dHash 由新算法产出——去重 / 相似检索会静默错配。
    if prepared.existing_perceptual_hash_algo_version != Some(hp_hash::PERCEPTUAL_HASH_ALGO_VERSION)
    {
        return None;
    }
    let perceptual = match prepared.existing_perceptual_hash.as_deref() {
        Some(value) if !value.is_empty() => PerceptualHash {
            value: value.to_string(),
            algo: hp_hash::PERCEPTUAL_HASH_ALGO.to_string(),
            algo_version: hp_hash::PERCEPTUAL_HASH_ALGO_VERSION,
        },
        _ => return None,
    };
    if prepared.existing_thumb_status != ThumbStatus::Generated {
        return None;
    }
    if let Some(cache) = options.thumbnail_cache.as_ref()
        && !cache.path_for_image(&content.value).exists()
    {
        // 缓存目录被清过 / 换了位置：`thumb_status` 指向的文件不在了，得重建。
        return None;
    }
    let probe = prepared
        .image_probe
        .unwrap_or_else(|| crate::scan_compute::probe_image(&prepared.path));
    Some(Computed {
        content: Some(content.clone()),
        perceptual: Some(perceptual),
        palette: None,
        thumb_status: Some(ThumbStatus::Generated),
        media_info: None,
        width: probe.display.map(|(w, _)| w),
        height: probe.display.map(|(_, h)| h),
        unreadable: false,
    })
}

/// 纯计算：读文件、算哈希、抽帧 / 出缩略图。**不访问数据库、不写索引**。
///
/// 视频抽帧会写缩略图缓存（`ThumbnailCache`），那是按内容哈希分文件的独立路径，
/// 且 `hp_media` 侧已改为**原子落盘**（先写临时文件再改名），因此并发安全。
pub fn compute(prepared: &Prepared, options: &ScanOptions) -> Computed {
    if prepared.unchanged {
        return Computed::default();
    }
    // **只建索引**（2026-11-12）：被排除的子树不读内容。放在 `match` 之前是为了让这条
    // 分支不可能被某个媒体类型漏掉——这里早退，写库阶段拿到的就是"无哈希、无缩略图、
    // 无感知哈希、无媒体信息、无调色板"的空产物，缩略图缓存也不会被写。
    //
    // 注意**不能**把这种行写成 `unreadable`：那是"读了但读不出来"的语义（RFC 0001），
    // 会让界面报损坏；这里是有意不读，`thumb_status` 落 `NotGenerated` 即可。
    if prepared.excluded {
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
            // **内容没变就复用派生数据**（2026-11-23 P0-2）。
            //
            // 全量重扫的语义是"忽略 size/mtime 重新核对"，不是"无条件重算一切"：只要重算
            // 出来的内容哈希与库里一致，缩略图 / dHash / 调色板 / 媒体信息就是同一份内容的
            // 同一份纯函数产物。旧实现只按 size/mtime 判"跳过"，因此每次 `--full` 都要把
            // 12 267 张 AVIF 从头解码一遍（真实库实测 1572 s，其中解码占绝大部分）。
            //
            // 复用是有**前置条件**的，缺一不可：
            // - 哈希相等：内容确实没变（这是唯一的事实判据，不是启发式）；
            // - 缩略图缓存目录已配置且缓存文件仍在：否则 `thumb_status` 会指向一个不存在的文件；
            // - 库里的 dHash 不是空串（`Failed` 的图下次还得给它一次机会）。
            //
            // 调色板**不**作为前置条件：手动锁定（D82）本来就不归扫描管，未锁定的缺失调色板
            // 是历史遗留，靠 `want_palette` 那条老路补齐即可——但那时哈希已相等，
            // 我们必须仍然解码一次（`want_palette` 只影响要不要算调色板，不影响其它产物）。
            if let Some(reused) = reuse_image_derivations(prepared, &content, options) {
                return reused;
            }
            // **一张图只解码一次**，这张图同时喂三个消费者：dHash、调色板、缩略图。
            // （第 44 轮 / D161：缩略图此前会**再解码一次**——冷缓存全量扫描实测
            // 120 张 AVIF 从 20.3 s 涨到 40.9 s，多出来的就是这第二次解码加第二次
            // ffmpeg 进程启动，单次启动在 Windows 上约 53 ms。）
            //
            // 解码失败**不影响索引**：与旧实现 `dhash_file(path).ok()` +
            // `extract_palette(..).ok()` 的容错口径一致。
            let (perceptual, palette, thumb_status) = match decode_scan_image(
                &prepared.path,
                options.ffmpeg_bin.as_deref(),
                options.video_timeout,
            ) {
                Ok(img) => {
                    let derived = analyze_image_derivations(&img, prepared.want_palette);
                    let thumb = process_image_thumb_from(img, &content, options);
                    (derived.perceptual, derived.palette, thumb)
                }
                // 解不开：派生数据照旧缺失；缩略图**退回独立解码**那条路——两条路的
                // 解码器集合并不完全相同（大 JPEG 的 `-lowres` 快路径、SVG 的 resvg），
                // 让它还有一次成功的机会，比一起放弃好。
                Err(_) => (
                    None,
                    None,
                    process_image_thumb(&prepared.path, &content, options),
                ),
            };
            // 宽高来自**准备阶段那次读头**（0043 / 第 43 轮）：解码结果的尺寸在 AVIF/HEIC
            // 家族里是**有界中间尺寸**（`SCAN_DECODE_BOUND = 256`），且 JPEG 解码不应用 EXIF
            // 方向，两者都不能当显示尺寸用。读头失败的图片按"未知"入库，消费方降级
            // （不回填 0）。调用方没带读头结果时现场补一次，行为与旧实现一致。
            let probe = prepared
                .image_probe
                .unwrap_or_else(|| crate::scan_compute::probe_image(&prepared.path));
            Computed {
                content: Some(content),
                perceptual,
                palette,
                thumb_status: Some(thumb_status),
                media_info: None,
                width: probe.display.map(|(w, _)| w),
                height: probe.display.map(|(_, h)| h),
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
                width: None,
                height: None,
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
                width: None,
                height: None,
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
    let thumb_path = match thumb_target(content, options) {
        Ok(path) => path,
        Err(status) => return status,
    };
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

/// 缩略图的**落点**：命中缓存或环境不支持时，直接用状态短路，不必再解码。
///
/// 两条生成路径（独立解码 / 复用扫描期那张图）都从这里出发，因此"缓存命中即跳过
/// 重编码""没有 `thumbnail_cache` 就不出图"这两条口径只有一处实现。
fn thumb_target(
    content: &ContentHash,
    options: &ScanOptions,
) -> Result<std::path::PathBuf, ThumbStatus> {
    let Some(cache) = &options.thumbnail_cache else {
        return Err(ThumbStatus::NotGenerated);
    };
    let thumb_path = cache.path_for_image(&content.value);
    if thumb_path.exists() {
        return Err(ThumbStatus::Generated);
    }
    if cache.ensure_dir_for(&content.value).is_err() {
        return Err(ThumbStatus::Failed);
    }
    Ok(thumb_path)
}

/// 用**扫描期已经解码的那张图**生成缩略图（第 44 轮 / D161）。
///
/// 与 [`process_image_thumb`] 的唯一区别是"图从哪来"：这里不碰磁盘、不再起 ffmpeg，
/// 只做缩放 + WebP 编码。缩放与编码走 [`hp_media::encode_image_thumbnail`]，
/// 与按需路径（`thumb.get` → `generate_image_thumbnail`）**是同一份实现**，
/// 所以同一张图两条路产出的是同一种字节，不会出现"扫描期一张、点开又是一张"。
fn process_image_thumb_from(
    img: image::DynamicImage,
    content: &ContentHash,
    options: &ScanOptions,
) -> ThumbStatus {
    let thumb_path = match thumb_target(content, options) {
        Ok(path) => path,
        Err(status) => return status,
    };
    match hp_media::encode_image_thumbnail(
        img,
        &thumb_path,
        IMAGE_THUMB_MAX_DIM,
        options.ffmpeg_bin.as_deref(),
        options.video_timeout,
    ) {
        Ok(()) => ThumbStatus::Generated,
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
            existing_content_hash: None,
            existing_perceptual_hash: None,
            existing_perceptual_hash_algo_version: None,
            existing_thumb_status: ThumbStatus::NotGenerated,
            existing_color_json: None,
            reuse_derivations: true,
            existing_index_only: false,
            want_palette,
            image_probe: None,
            excluded: false,
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
