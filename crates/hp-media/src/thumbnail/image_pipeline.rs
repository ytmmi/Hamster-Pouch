//! 图片缩略图与全分辨率预览：档梯吸附、解码分流、WebP 三级降级。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use super::atomic::{commit, temp_sibling};
use crate::process::{hidden_command, run_with_timeout};
use crate::thumb_decode::{decode_thumbnail_src, is_webp_path, write_jpeg};
use crate::webp::encode_webp;

/// 图片缩略图长边上限（像素）。缩略图只缩小不放大，足够覆盖网格单元。
pub const IMAGE_THUMB_MAX_DIM: u32 = 320;

/// 图片缩略图 WebP 质量（`libwebp -quality`）。
///
/// **为什么是 70**：用户口径是「**同质量**下取体积更小的格式」。实测（`docs/issues/0029`，
/// 真实照片语料、SSIM 对齐）WebP `-quality 70` 的平均 SSIM **0.9675**，与既有 JPEG
/// （`image` crate `JpegEncoder` quality 75、4:4:4）的 **0.9674** 基本相等，而体积为
/// **0.53×**——即"同质量、体积减半"。取更高只会白扔压缩收益：
/// `-quality 90` 的 SSIM 0.9908 已明显高于旧 JPEG，体积也反超（1.05×），不再是"同质量"比较。
pub const IMAGE_THUMB_WEBP_QUALITY: u8 = 70;

/// 图片缩略图**长边档梯**（像素）：`thumb.get` 的请求尺寸**向上吸附**到最近一档。
///
/// **为什么是档梯而不是按请求像素逐尺寸落盘**（缺陷 0046）：媒体预览的"图片宽度"是
/// 连续滑条（80–400，步长 8），再乘设备像素比就是上百种请求尺寸；每个尺寸各存一份，
/// 同一个文件会裂出几十份缓存，每份首次都要解一遍原图。档梯把分辨率离散成 5 档，
/// 相邻档最多 1.5× 像素差（640→960），肉眼不可辨，缓存条目上界却只有 5。
///
/// 首档沿用 [`IMAGE_THUMB_MAX_DIM`]（320，旧口径）：默认设置（160 CSS px、DPR 1–2）
/// 仍命中旧缓存文件，升级后不会整库重算（缓存文件名见
/// `ThumbnailCache::path_for_image_at`）。
pub const IMAGE_THUMB_DIM_LADDER: &[u32] = &[IMAGE_THUMB_MAX_DIM, 480, 640, 960, 1280];

/// 档梯上限（长边像素）。超过它的请求一律按这一档生成。
///
/// **为什么封顶在 1280 而不是跟着请求长**：网格单元再大也受
/// `--mp-row-max-factor: 2` 约束（自适应视图行高 = 图片宽度的 2 倍），
/// 1280 已覆盖"400 宽 × DPR 2 × 2 倍行高"的极端组合。再往上缩略图就没有意义了——
/// 那一档**回退到原图**（见 `thumb.get` 的 `should_serve_original`），
/// 而不是为一张 8K 图解码出 8K 的 WebP 塞进内存。
pub const IMAGE_THUMB_MAX_LADDER_DIM: u32 = 1280;

/// 把前端请求的长边像素**向上吸附**到 [`IMAGE_THUMB_DIM_LADDER`] 的某一档。
///
/// `requested == 0`（未指定 / 旧调用方）与一切 ≤ 320 的请求归首档；
/// 超过上限的归 [`IMAGE_THUMB_MAX_LADDER_DIM`]（不报错——请求"更大"是正常诉求，
/// 只是缩略图到此为止，再清晰由原图回退负责）。
pub fn image_thumb_dim_for(requested: u32) -> u32 {
    IMAGE_THUMB_DIM_LADDER
        .iter()
        .copied()
        .find(|&dim| requested <= dim)
        .unwrap_or(IMAGE_THUMB_MAX_LADDER_DIM)
}

/// 生成**全分辨率** JPEG 预览（`preview.get` 命令，供 Chromium 无法原生解码的
/// HEIC/HEIF 查看器使用，缺陷 0019）。
///
/// - **SVG / SVGZ**：进程内 `resvg` 栅格化 → JPEG 质量 90（见下）；
/// - 有 ffmpeg：**ffmpeg 直出 JPEG**（`-q:v 2`，单趟解码 + 编码，libjpeg 级质量 ≈90；
///   无中间像素往返，102 MP 也只需数秒）——查看器要能 100% 检视细节；
/// - 无 ffmpeg（测试夹具等）：进程内解码（仅可解格式）→ JPEG 质量 90。
///
/// **不缩放**：用户 2026-10-06 裁定（不要 2048 有界预览），预览尺寸 = 原始分辨率。
/// 代价是首次生成耗时与缓存体积按原始分辨率走，之后缓存命中即显示。
///
/// ## 为什么 SVG 要在这里就分流（D112）
///
/// `generate_preview_via_ffmpeg` 是"一条管线直出 JPEG"的快路径，而**捆绑 ffmpeg 对
/// SVG 没有解码器**（只有解复用器 `svg_pipe`，见 `docs/rfc/0005` §4）——让它去解 SVG
/// 是**必然失败**，表现为 `preview.get` 返回 `null`、查看器里"该文件不可用"。
///
/// 这一支**必须在 ffmpeg 快路径之前**：生产环境 `preview.get` 传的
/// `state.ffmpeg_bin` **总是 `Some`**（捆绑 ffmpeg 随包分发），因此
/// "有 ffmpeg 就交给 ffmpeg"的写法会让 SVG **永远**走不到进程内栅格化。
/// 两侧后果不对称：`svg` 走原图（Chromium 原生渲染）看不出问题，
/// 而 `svgz` **必须**走后端预览 —— 漏掉这一支就是"SVGZ 一片空白"。
/// 由 `svg_preview_ignores_ffmpeg_fast_path` 钉住（传一个**不存在**的 ffmpeg 路径）。
pub fn generate_image_preview(
    src: &Path,
    output_jpg: &Path,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    if crate::svg::is_svg(src) {
        return generate_preview_via_image(src, output_jpg, timeout);
    }
    if let Some(bin) = ffmpeg_bin {
        return generate_preview_via_ffmpeg(src, output_jpg, bin, timeout);
    }
    generate_preview_via_image(src, output_jpg, timeout)
}

/// ffmpeg 直出 JPEG：一条管线（解码 → mjpeg 编码），无中间像素往返。
fn generate_preview_via_ffmpeg(
    src: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_jpg);
    // `hidden_command`：GUI 父进程下不新建控制台窗口（首次查看 HEIC/HEIF 的全分辨率预览）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(&temp);
    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 生成预览失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_jpg)
}

/// 进程内解码 → JPEG 质量 90（仅 ffmpeg 缺失时的兜底；`u32::MAX` = 不缩放）。
fn generate_preview_via_image(src: &Path, output_jpg: &Path, timeout: Duration) -> HpResult<()> {
    let img = decode_thumbnail_src(src, None, u32::MAX, timeout, None)?;
    // 原子落盘（见模块文档）：与缩略图同款，并发安全。
    let temp = temp_sibling(output_jpg);
    let result = (|| -> image::ImageResult<()> {
        let file = std::fs::File::create(&temp)?;
        let mut writer = std::io::BufWriter::new(file);
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 90);
        img.to_rgb8().write_with_encoder(encoder)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入预览失败: {e}")));
    }
    commit(&temp, output_jpg)
}

/// 生成图片缩略图：应用 EXIF 方向后等比缩放到长边不超过 `max_dim`，写入 `output`。
///
/// **落盘格式由 `output` 的扩展名决定**（调用方经 `ThumbnailCache::path_for_image` 取路径）：
/// - `.webp` → WebP（**进程内 `libwebp` 优先，ffmpeg 降级**，见 [`encode_webp`]）；
/// - 其它（如 `.jpg`）→ 进程内 JPEG，沿用 `image` crate 的默认质量 75。
///
/// 解码优先走进程内 `image` crate（jpg/png 等既有格式输出与旧实现**逐位相同**）；
/// 进程内**没有解码器**的格式（JPEG 2000 / JPEG XL / PSD / PCX…）与 AVIF/HEIC 家族
/// 进程内失败时回退**捆绑 ffmpeg 有界解码**（`src/decode.rs`，输出已缩到 ≤ `max_dim`，
/// ffmpeg 默认应用旋转元数据）。小图不放大；读取 / 解码 / 写入失败
/// 返回 `HpError::Io`（调用方可降级为占位）。
///
/// **WebP 失败时降级为 JPEG 同路径落盘**：两级 WebP 编码都不可用（特性关闭且无 ffmpeg /
/// 编码失败）时，宁可用体积大些的 JPEG 也要有图（与 `ffmpeg` 缺失时既有行为一致）。
pub fn generate_image_thumbnail(
    src: &Path,
    output: &Path,
    max_dim: u32,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    generate_image_thumbnail_known(src, output, max_dim, ffmpeg_bin, timeout, None)
}

/// 同上，`known` 是**索引里已知的显示尺寸**（缺陷 0043 阶段 3）。
///
/// 生产侧的 `thumb.get` 手里就有 `files.width`/`height`，传进来可以省掉一次
/// "读文件头问尺寸"——大 JPEG 走 `-lowres` 时本来要问两次（判据一次、算档位一次）。
/// 非大图（进程内解码）用不到它，忽略即可。
pub fn generate_image_thumbnail_known(
    src: &Path,
    output: &Path,
    max_dim: u32,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
    known: Option<(u32, u32)>,
) -> HpResult<()> {
    let img = decode_thumbnail_src(src, ffmpeg_bin, max_dim, timeout, known)?;
    encode_image_thumbnail(img, output, max_dim, ffmpeg_bin, timeout)
}

/// **已解码**的图 → 缩略图落盘（缩放 + 编码）。
///
/// 与 [`generate_image_thumbnail_known`] 的后半段**是同一份实现**：那条路先解码再调它。
/// 单独拆出来是为了让**扫描期**复用自己已经拿到的那张图（第 44 轮 / D161）：
/// 扫描为了算 dHash 与调色板已经解码过一次，缩略图再解码一次就是第二次全量解码
/// 外加第二次 ffmpeg 进程启动（实测 120 张 AVIF：冷缓存 20.3 s → 40.9 s）。
///
/// **缩放口径与非复用路径逐位相同**：仅当长边超过 `max_dim` 时 `thumbnail()`
/// （那是 `image` crate 的整数快缩放，和 `resize()` 的滤波器不是一回事，不能换）。
pub fn encode_image_thumbnail(
    img: image::DynamicImage,
    output: &Path,
    max_dim: u32,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    // 仅当长边超过上限时缩放，避免小图被放大。
    let thumb = if img.width() > max_dim || img.height() > max_dim {
        img.thumbnail(max_dim, max_dim)
    } else {
        img
    };

    if is_webp_path(output) {
        if encode_webp(&thumb, output, ffmpeg_bin, timeout).is_ok() {
            return Ok(());
        }
        // 降级：两级 WebP 都不可用——写 JPEG 到**同一个目标路径**
        // （后缀仍是 .webp，但内容按魔数自描述，Chromium 与 ffmpeg 都能按内容识别）。
        // 保证"有图"优先于"格式正确"；换路径会让调用方的缓存命中判断失效。
        return write_jpeg(&thumb, output);
    }

    write_jpeg(&thumb, output)
}
