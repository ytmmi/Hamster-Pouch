//! 缩略图与预览的取数策略：缓存未命中时按需生成，必要时回退原图。
//!
//! 三条回退判据（扩展名白名单、比档位小、体积上限）缺一不可，回归用例在文件末尾；
//! should_serve_original 是唯一判据，调用方不得再各写一遍。

use crate::AppState;
use crate::commands::shared::{ApiAsync, api_async, api_from_hp, resolve_file_path, with_repo};
use hp_core::{HpError, MediaType};
use tauri::State;

/// 后台线程按需生成缩略图（缓存未命中时才调用；不阻塞 IPC 线程）。
///
/// `out` 的扩展名决定落盘格式（见 `hp_media::ThumbFormat`）：调用方用
/// `ThumbnailCache::path_for_format` 按媒体类型取。
///
/// **音频生成的是波形图**（2026-10-17 / D115）：音频不再有"内容缩略图"，
/// 它在网格那一格显示的是 `ffmpeg showwavespic` 画出的波形 PNG。
/// 与视频首帧同款——**按需生成**，扫描期不出来（免得给全库音频白做一次 ffmpeg）。
/// 一次缩略图生成的全部输入。
///
/// 参数曾一路涨到 8 个（缺陷 0046 加 `max_dim` 之后 clippy 判 `too_many_arguments`），
/// 打成一个结构体既过门禁，也把这些"同一个请求的组成部分"绑在一起——
/// `out` 与 `max_dim` 必须同步（`out` 的文件名带着档位），分开传最容易漂移。
struct ThumbJob {
    hash: String,
    out: std::path::PathBuf,
    src_path: std::path::PathBuf,
    media_type: MediaType,
    ffmpeg: Option<std::path::PathBuf>,
    dims: Option<(u32, u32)>,
    max_dim: u32,
}

fn generate_thumbnail(cache: hp_media::ThumbnailCache, job: ThumbJob) -> bool {
    let ThumbJob {
        hash,
        out,
        src_path,
        media_type,
        ffmpeg,
        dims,
        max_dim,
    } = job;
    if cache.ensure_dir_for(&hash).is_err() {
        return false;
    }
    match media_type {
        // `dims` = 索引里的显示尺寸（缺陷 0043 阶段 3）：有了它，大 JPEG 走
        // `-lowres` 时不必再读一遍文件头问尺寸。
        // `max_dim` = 该档的**长边上限**（缺陷 0046：档梯吸收请求分辨率），
        // 320 档与旧行为逐位一致，更高档只是不再缩到 320。
        MediaType::Image => hp_media::generate_image_thumbnail_known(
            &src_path,
            &out,
            max_dim,
            ffmpeg.as_deref(),
            std::time::Duration::from_secs(30),
            dims,
        )
        .is_ok(),
        MediaType::Video => match ffmpeg {
            Some(bin) => hp_media::extract_thumbnail(
                &src_path,
                &out,
                &bin,
                std::time::Duration::from_secs(30),
            )
            .is_ok(),
            None => false,
        },
        // 音频：波形图（PNG）。**必须有 ffmpeg**——波形由 `showwavespic` 画，
        // 进程内没有等价实现（Web Audio 是浏览器侧的 API，Rust 侧不可用）。
        // 缺 ffmpeg 时返回 false，前端降级为"波形不可用"占位（不阻塞取数）。
        MediaType::Audio => match ffmpeg {
            Some(bin) => hp_media::generate_waveform(
                &src_path,
                &out,
                hp_media::WAVE_SIZE,
                &bin,
                std::time::Duration::from_secs(30),
            )
            .is_ok(),
            None => false,
        },
        // 文本与 PDF 没有索引期的缩略图：
        // - 文本：`epub` 的内嵌封面走 `book.meta`（`hp_book` 解析 + 原格式落盘），
        //   `txt` 由前端用文件名渲染文字封面；
        // - PDF：封面是**第一页栅格化**出来的（`hp_pdf`），同样走 `book.meta` 的磁盘缓存。
        // 两者在这里恒为"没有缩略图"。
        MediaType::Text | MediaType::Pdf => false,
    }
}

/// Chromium 能**原生解码**的图片扩展名（小写、不含点）。
///
/// 与前端 `apps/desktop/src/app_ui/shared/previewUrl.ts` 的 `NATIVE_RENDER_EXTS`
/// **同一张表**：前端用它决定"直接给原图还是走后端预览"，这里用它决定
/// "缩略图已无像素收益时能不能把原图顶上去"（缺陷 0046 ③）。改一侧就要改另一侧。
const NATIVE_RENDER_EXTS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "apng", "gif", "webp", "avif", "bmp", "ico", "svg",
];

/// 回退原图的体积上限（4 MiB）。
///
/// 尺寸判据（原图长边 ≤ 请求档位）只说明"缩略图不会更清晰"，**不说明它不会更小**：
/// 一张 1200×1200 的 PNG 截图可以有 20 MB，网格里几十格同时加载就是灾难。
/// 小尺寸大文件（无 alpha 的 PNG、BMP）仍走缩略图，体积与解码成本都降一个量级。
const ORIGINAL_FALLBACK_MAX_BYTES: i64 = 4 * 1024 * 1024;

/// 该文件扩展名是否在 Chromium 原生可解码白名单里。
fn is_natively_renderable(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| NATIVE_RENDER_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 这一档是不是**该直接回退原图**（缺陷 0046：大图不糊，小图也不白做缩略图）。
///
/// 三条同时成立才回退：
/// ① 扩展名在 Chromium 白名单里——否则前端根本解不了原图（HEIC/HEIF 另有
///    `preview.get` 的全分辨率 JPEG，与本命令无关）；
/// ② 索引里有显示尺寸，且**原图长边 ≤ 请求档**——再生成缩略图只会得到一张
///    "和原图一样大"的 WebP，像素收益为零；
/// ③ 原文件 ≤ [`ORIGINAL_FALLBACK_MAX_BYTES`]——见该常量的理由。
///
/// 尺寸未知（未回填的旧库）时不回退：宁可生成一张 320 缩略图，也不把一张
/// 12000×12000 的原图塞进网格（那正是 0046 要修的两端：糊 / 爆内存）。
fn should_serve_original(
    src_path: &std::path::Path,
    dims: Option<(u32, u32)>,
    dim: u32,
    file_size: i64,
) -> bool {
    if file_size <= 0 || file_size > ORIGINAL_FALLBACK_MAX_BYTES {
        return false;
    }
    if !is_natively_renderable(src_path) {
        return false;
    }
    match dims {
        Some((w, h)) => w.max(h) <= dim,
        None => false,
    }
}

#[cfg(test)]
mod thumb_fallback_tests {
    //! 缺陷 0046 ④：回退原图的**三条判据缺一不可**。
    //!
    //! 这三条都是"少一条就会坏"的闸门，而且坏法不同：缺白名单 → 前端解不出图
    //! （网格里一片碎图）；缺尺寸判据 → 大图被原样塞进网格（0046 的另一端：
    //! 爆内存）；缺体积上限 → 小尺寸大 PNG 拖垮整屏。因此逐条变异都要红。

    use super::*;
    use std::path::Path;

    const MIB: i64 = 1024 * 1024;

    #[test]
    fn original_fallback_requires_all_three_conditions() {
        let jpg = Path::new("E:/photos/a.jpg");
        // 三条都满足：原图 1000×800、请求 1280 档、1 MiB。
        assert!(should_serve_original(jpg, Some((1000, 800)), 1280, MIB));
        // ② 尺寸判据：原图比档位大（竖图算高轴）。
        assert!(!should_serve_original(jpg, Some((1000, 800)), 640, MIB));
        assert!(!should_serve_original(jpg, Some((800, 1000)), 960, MIB));
        // ① 白名单：HEIC 由 `preview.get` 出 JPEG，原图 Chromium 解不了。
        assert!(!should_serve_original(
            Path::new("E:/photos/a.heic"),
            Some((1000, 800)),
            1280,
            MIB
        ));
        // ③ 体积上限：恰好 4 MiB 放行，多 1 字节即拒。
        assert!(should_serve_original(jpg, Some((1000, 800)), 1280, 4 * MIB));
        assert!(!should_serve_original(
            jpg,
            Some((1000, 800)),
            1280,
            4 * MIB + 1
        ));
        // 尺寸未知（旧库未回填）时不回退——宁可给 320 缩略图。
        assert!(!should_serve_original(jpg, None, 1280, MIB));
        // 体积为 0 / 负数（读不到 stat）同样不回退。
        assert!(!should_serve_original(jpg, Some((1000, 800)), 1280, 0));
    }

    #[test]
    fn extension_check_is_case_insensitive_and_ignores_no_extension() {
        assert!(is_natively_renderable(Path::new("E:/photos/A.JPG")));
        assert!(is_natively_renderable(Path::new("E:/photos/b.WebP")));
        assert!(!is_natively_renderable(Path::new("E:/photos/c.tiff")));
        assert!(!is_natively_renderable(Path::new("E:/photos/noext")));
    }
}

/// thumb.get：按需生成并返回文件缩略图绝对路径（供前端 `convertFileSrc` 预览）。
///
/// 图片用 image crate 缩放，视频复用 ffmpeg 抽帧，**音频用 ffmpeg 画波形图**（D115）；
/// 命中缓存直接返回。无内容哈希 / 生成失败 / 不支持的媒体类型返回 `None`
/// （前端降级为占位）。
///
/// **`size` = 前端算出的设备像素长边**（缺陷 0046：自适应分辨率）：
/// 图片请求按 [`hp_media::image_thumb_dim_for`] 向上吸附到档梯
/// （320 / 480 / 640 / 960 / 1280），缓存文件随之分档
/// （`<hash>.webp` 为 320 档、`<hash>@960.webp` 为 960 档）。
/// 不传（旧调用方）按首档处理，与升级前逐位一致。
/// 视频首帧（512 宽）与波形图只有单尺寸缓存，忽略该参数。
///
/// **大图回退原图**：要求的分辨率已经达到原图水平时（照片原图长边 ≤ 档位、
/// 且体积不大、且 Chromium 能原生解码），直接返回原图路径，见
/// [`should_serve_original`]——那时缩略图只会是一张"和原图一样大"的有损副本，
/// 既糊了细节又白花一次解码。该判断**在缓存查询之前**做，保证同一请求不会
/// 因为"缓存里恰好有旧档缩略图"而忽好忽坏。
#[tauri::command]
pub(crate) async fn thumb_get(
    repo_id: String,
    file_id: String,
    size: Option<u32>,
    state: State<'_, AppState>,
) -> ApiAsync<Option<String>> {
    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard。
        let (src_path, content_hash, media_type, cache, ffmpeg, dims, file_size) =
            with_repo(&state, &repo_id, |db| {
                let file = db
                    .get_file(&file_id)?
                    .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
                let src_path = resolve_file_path(db, &file)?;
                Ok((
                    src_path,
                    file.content_hash,
                    file.media_type,
                    (*state.thumb_cache).clone(),
                    (*state.ffmpeg_bin).clone(),
                    file.width.zip(file.height),
                    file.size,
                ))
            })?;

        let Some(hash) = content_hash else {
            return Ok(None);
        };

        // 缓存路径按媒体类型选格式（图片 WebP / 视频 JPEG；音频不生成缩略图）。
        let Some(format) = hp_media::ThumbFormat::for_media_type(media_type) else {
            return Ok(None);
        };

        // 图片：请求长边吸附档梯（`size` 缺省 → 首档 320）；视频 / 音频单尺寸。
        let max_dim = if media_type == MediaType::Image {
            hp_media::image_thumb_dim_for(size.unwrap_or(0))
        } else {
            hp_media::IMAGE_THUMB_MAX_DIM
        };

        // 回退原图（见函数文档：在缓存查询之前判定，结果与缓存状态无关）。
        if media_type == MediaType::Image
            && should_serve_original(&src_path, dims, max_dim, file_size)
        {
            return Ok(Some(src_path.to_string_lossy().to_string()));
        }

        let thumb_path = if media_type == MediaType::Image {
            cache.path_for_image_at(&hash, max_dim)
        } else {
            cache.path_for_format(&hash, format)
        };
        if thumb_path.exists() {
            return Ok(Some(thumb_path.to_string_lossy().to_string()));
        }

        // 缓存未命中：后台线程按需生成，避免阻塞 IPC 线程。
        let gen_out = thumb_path.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            generate_thumbnail(
                cache,
                ThumbJob {
                    hash,
                    out: gen_out,
                    src_path,
                    media_type,
                    ffmpeg,
                    dims,
                    max_dim,
                },
            )
        })
        .await
        .unwrap_or(false);

        if generated && thumb_path.exists() {
            Ok(Some(thumb_path.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }
    .await;
    api_async(api_from_hp(outcome))
}

/// preview.get：按需生成并返回**全分辨率**预览绝对路径（原始尺寸 JPEG、质量 90，
/// 缓存于缩略图缓存 `<hash>.preview.jpg`）。
///
/// 用途：Chromium 无法原生解码的图片（HEIC/HEIF，缺陷 0019）的查看器取图；
/// 不缩放——查看器要能 100% 检视细节（用户 2026-10-06 裁定：不要 2048 有界预览）。
/// 仅图片，其余媒体类型 / 无内容哈希 / 生成失败返回 `None`（前端降级为不可用）。
///
/// **预览保持 JPEG**（不随缩略图改 WebP）：它是 100% 检视用的原始尺寸图，
/// 与"网格缩略图"是两件事，本就不该有损到缩略图那种程度。
#[tauri::command]
pub(crate) async fn preview_get(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<Option<String>> {
    let outcome = async {
        // 同步取出所需数据后立即释放锁，避免跨 await 持有 MutexGuard。
        let (src_path, content_hash, media_type, cache, ffmpeg) =
            with_repo(&state, &repo_id, |db| {
                let file = db
                    .get_file(&file_id)?
                    .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
                let src_path = resolve_file_path(db, &file)?;
                Ok((
                    src_path,
                    file.content_hash,
                    file.media_type,
                    (*state.thumb_cache).clone(),
                    (*state.ffmpeg_bin).clone(),
                ))
            })?;

        if media_type != MediaType::Image {
            return Ok(None);
        }
        let Some(hash) = content_hash else {
            return Ok(None);
        };

        let preview_path = cache.path_for_preview(&hash);
        if preview_path.exists() {
            return Ok(Some(preview_path.to_string_lossy().to_string()));
        }

        // 缓存未命中：后台线程按需生成（全分辨率解码，不缩放）。
        let gen_out = preview_path.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            if cache.ensure_dir_for(&hash).is_err() {
                return false;
            }
            hp_media::generate_image_preview(
                &src_path,
                &gen_out,
                ffmpeg.as_deref(),
                std::time::Duration::from_secs(60),
            )
            .is_ok()
        })
        .await
        .unwrap_or(false);

        if generated && preview_path.exists() {
            Ok(Some(preview_path.to_string_lossy().to_string()))
        } else {
            Ok(None)
        }
    }
    .await;
    api_async(api_from_hp(outcome))
}
