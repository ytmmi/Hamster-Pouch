//! 缩略图生成：ffmpeg 首帧抽帧（D16，视频）+ 图片进程内缩放（AVIF/HEIC 家族回退
//! 捆绑 ffmpeg 有界解码，见 `docs/issues/0018` §7 P1-D）。
//!
//! **落盘格式按媒体类型分流**（用户 2026-10-08 口径：「同像素和质量的情况下，选择
//! 体积更小的格式」）：
//!
//! - **图片缩略图 → WebP**（质量 [`IMAGE_THUMB_WEBP_QUALITY`]）；
//! - **视频首帧缩略图 → JPEG**（ffmpeg 的 `mjpeg`，沿用既有 `-q:v 3`）。
//!
//! 实测依据（真实照片语料，长边 320、SSIM 对齐，见 `docs/issues/0029`）：WebP 在
//! **每张图**上都比 JPEG 小，等质量下体积约为 JPEG 的 **0.53–0.57**（省 43%–47%）；
//! 真实生产代码路径 A/B（60 张）实测 **0.572（省 42.8%）**。
//!
//! ## WebP 编码器的三级降级（D91）
//!
//! 用户 2026-10-08 裁定「换成 libwebp-sys，并保留 ffmpeg 作降级」。顺序是
//! **快路径优先、可用性兜底**，前两级产出**同一个 WebP**（实测**逐字节相同**）：
//!
//! 1. **进程内 `libwebp`**（`libwebp-sys`，默认特性 `libwebp`）——每张省掉一次进程开销，
//!    真实生产路径实测 **64 ms/张**（对照 ffmpeg 子进程 **157 ms/张**，**2.44×**）；
//! 2. **ffmpeg 子进程**（`libwebp` 编码器，rawvideo 经 stdin 喂像素）——特性关闭、
//!    非 Windows、或进程内失败时使用；
//! 3. **JPEG 同路径落盘**——前两级都不可用时（见 [`write_jpeg`] 的说明）。
//!
//! **为什么敢说"换了也不变"**：`libwebp-sys` 与 ffmpeg 内嵌的 libwebp **同源同版本**，
//! 实测 145/145 组（29 张 × 5 个质量）**逐字节相同**——因此切换**不需要重新生成任何
//! 既有缩略图**，质量口径零变化，`IMAGE_THUMB_WEBP_QUALITY` 也无需重设。
//! 该等价性由 `in_process_and_ffmpeg_webp_are_byte_identical` 持续钉住。
//!
//! 视频**不跟着换**，理由是 `crates/hp-scanner` 在抽帧后对**缩略图本身**算 dHash
//! （`process_video` 的 `dhash_file(&thumb_path)`），换编码会轻微改变像素、使已入库的
//! 视频感知哈希与新值不再逐位可比（实测汉明距离中位 0、最大 5 bit），属需要独立裁决的
//! 迁移问题。图片路径不受影响：图片的 dHash 取自**源图**而非缩略图。
//!
//! **落盘是原子的**：一律先写同目录下的临时文件、成功后 `rename` 到目标名。
//! 原因是扫描已改为**并行**（`docs/issues/0018`）：同一份内容（内容哈希相同）
//! 可能被两个线程同时抽帧，直接写目标文件会交错出半张图；而 `rename` 在同一卷内
//! 是原子的，后到者覆盖先到者，读到的永远是**完整**文件。顺带也消除了
//! "生成中途崩溃留下损坏缩略图、此后一直被 `exists()` 命中"的问题。

use std::path::{Path, PathBuf};
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout, run_with_timeout_stdin};

/// 抽帧过滤器：宽度不超过 512、高度按比例，小图不放大。
const SCALE_FILTER: &str = "scale='min(512,iw)':-2";

/// 为 `target` 生成一个同目录、同扩展名的唯一临时路径。
///
/// 必须**同目录**：跨卷 `rename` 会退化成复制，就不再是原子替换了。
/// 进程号 + 计数器保证并发线程之间不撞名。
fn temp_sibling(target: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let name = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("thumb");
    target.with_file_name(format!(".{name}.{}.{seq}.tmp{ext}", std::process::id()))
}

/// 把 `temp` 原子地替换到 `target`；失败时清理临时文件。
fn commit(temp: &Path, target: &Path) -> HpResult<()> {
    match std::fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(temp);
            Err(HpError::Io(format!("写入缩略图失败: {e}")))
        }
    }
}

/// 抽取视频首帧并写入 `output_jpg`；失败返回 `HpError::Io`（调用方可用占位图降级）。
pub fn extract_thumbnail(
    video_path: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_jpg);
    // `hidden_command`：GUI 父进程下不新建控制台窗口（源扫描抽帧）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-i"])
        .arg(video_path)
        .args(["-frames:v", "1", "-vf", SCALE_FILTER, "-q:v", "3"])
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
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_jpg)
}

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

// 仅测试用：强制"进程内编码失败"，以验证 ffmpeg 降级**真的会接手**。
//
// **必须是 `thread_local`**：测试并行跑，用全局静态会让"注入失败"泄漏到同进程的
// 其他用例（实测：`in_process_encoder_produces_lossy_webp` 因被邻居置位而误走降级、
// 拿到 JPEG 后断言失败）。每个用例各在自己的线程上，线程局部变量天然隔离。
//
// `cfg(test)` 门控——**不进生产构建**，因此不是可被误用的运行时开关。
#[cfg(test)]
thread_local! {
    static FORCE_IN_PROCESS_FAILURE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 把图像编码为 WebP 并原子落盘到 `output_webp`，**快路径优先**（见模块文档的三级降级）：
///
/// 1. 进程内 `libwebp`（`libwebp` 特性）——最快；
/// 2. ffmpeg 子进程（`ffmpeg_bin` 可用时）；
///
/// 两级都不可用 / 都失败时返回 `Err`，由调用方降级为 JPEG。
fn encode_webp(
    img: &image::DynamicImage,
    output_webp: &Path,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
    // 1. 进程内 libwebp（D91 快路径）。
    #[cfg(feature = "libwebp")]
    {
        #[cfg(test)]
        let forced = FORCE_IN_PROCESS_FAILURE.with(std::cell::Cell::get);
        #[cfg(not(test))]
        let forced = false;

        let attempt = if forced {
            Err(HpError::Io("测试注入：进程内编码失败".into()))
        } else {
            encode_webp_in_process(img, output_webp)
        };
        match attempt {
            Ok(()) => return Ok(()),
            Err(e) => {
                // 不静默吞掉：进程内失败要能看出是"退回 ffmpeg"还是"彻底失败"。
                // 但**不能**直接返回 Err——ffmpeg 仍可能成功（见模块文档的三级降级）。
                if ffmpeg_bin.is_none() {
                    return Err(e);
                }
            }
        }
    }

    // 2. ffmpeg 子进程（保留的降级路径，D91）。
    match ffmpeg_bin {
        Some(bin) => encode_webp_via_ffmpeg(img, output_webp, bin, timeout),
        None => Err(HpError::Io(
            "WebP 编码不可用：未启用 libwebp 特性且没有 ffmpeg".into(),
        )),
    }
}

/// 进程内 `libwebp` 编码（`libwebp-sys`，MIT，C 源码随 crate vendored）。
///
/// 与 ffmpeg 内嵌的 libwebp **同源同版本**，实测输出**逐字节相同**（见模块文档），
/// 因此这是纯粹的"省一次进程开销"替换，不改变任何像素结果。
///
/// **`unsafe` 的必要性**：`libwebp-sys` 只暴露 C ABI。这里的两处 `unsafe` 是
/// ①把 `rgb` 的指针交给 C（长度由 `width*height*3` 与 `stride = width*3` 保证一致，
/// `WebPEncodeRGB` 只读该区间）；②把 C `malloc` 的输出按返回长度构造成切片并
/// `WebPFree` 释放——**`WebPFree` 必须在 `to_vec()` 之前配对**，否则泄漏。
#[cfg(feature = "libwebp")]
fn encode_webp_in_process(img: &image::DynamicImage, output_webp: &Path) -> HpResult<()> {
    use libwebp_sys::{WebPEncodeRGB, WebPFree};

    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let bytes = rgb.as_raw();

    let mut out: *mut u8 = std::ptr::null_mut();
    // SAFETY：`bytes` 是 `w*h*3` 字节的连续 RGB 缓冲（`to_rgb8` 保证），
    // stride 传 `w*3` 与之相符；`WebPEncodeRGB` 只读入参、只写 `out` 指向的新分配。
    let len = unsafe {
        WebPEncodeRGB(
            bytes.as_ptr(),
            w as i32,
            h as i32,
            (w * 3) as i32,
            IMAGE_THUMB_WEBP_QUALITY as f32,
            &mut out as *mut *mut u8,
        )
    };
    if len == 0 || out.is_null() {
        return Err(HpError::Io("libwebp 编码失败（返回空缓冲）".into()));
    }
    // SAFETY：`len > 0` 且 `out` 非空时，libwebp 保证该指针指向 `len` 字节有效数据。
    let data = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
    // 复制完成后再释放（顺序不能反）。
    // SAFETY：`out` 由 libwebp 分配，只能交回 `WebPFree`，且此处只释放一次。
    unsafe { WebPFree(out as *mut std::ffi::c_void) };

    // 原子落盘：与 ffmpeg 路径同一套临时文件 + rename（见模块文档）。
    let temp = temp_sibling(output_webp);
    if let Err(e) = std::fs::write(&temp, &data) {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入 WebP 缩略图失败: {e}")));
    }
    commit(&temp, output_webp)
}

/// 用 ffmpeg 的 `libwebp` 把 `img` 编码成 WebP 并原子落盘到 `output_webp`。
///
/// **这是降级路径**（D91：进程内 `libwebp` 优先，见 [`encode_webp`]）。走
/// **进程内解码 + 缩放 → ffmpeg 只做编码**（rawvideo 经 stdin 管道喂像素），而不是
/// `ffmpeg -i <源文件>` 一把梭：缩放仍在进程内完成，因此
/// - 结果与既有实现**同一套缩放算法**（`image::DynamicImage::thumbnail`），
/// - 源图若已由进程内路径解码（含 libheif 的 HEIC/AVIF），不必让 ffmpeg 再解一遍，
/// - 实测比"一把梭"更快（省掉 ffmpeg 的源图解码）。
///
/// 编码失败（ffmpeg 缺失 / 版本无 libwebp / 超时）返回 `HpError::Io`，由 [`encode_webp`]
/// 决定是否继续降级（它是**第二级**，见模块文档的三级降级）。
fn encode_webp_via_ffmpeg(
    img: &image::DynamicImage,
    output_webp: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_webp);
    // `hidden_command`：GUI 父进程下不新建控制台窗口（首次生成图片缩略图）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24"])
        .args(["-s", &format!("{w}x{h}")])
        .args(["-i", "-", "-frames:v", "1"])
        .args(["-c:v", "libwebp"])
        .args(["-quality", &IMAGE_THUMB_WEBP_QUALITY.to_string()])
        .arg(&temp);

    // 像素经 stdin 喂入：数据量（320×320 RGB ≈ 300 KiB）远超管道缓冲，必须并发写（见 process 文档）。
    let output = match run_with_timeout_stdin(&mut cmd, timeout, Some(rgb.into_raw())) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!(
            "ffmpeg 编码 WebP 失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    commit(&temp, output_webp)
}

/// 生成**全分辨率** JPEG 预览（`preview.get` 命令，供 Chromium 无法原生解码的
/// HEIC/HEIF 查看器使用，缺陷 0019）。
///
/// - 有 ffmpeg：**ffmpeg 直出 JPEG**（`-q:v 2`，单趟解码 + 编码，libjpeg 级质量 ≈90；
///   无中间像素往返，102 MP 也只需数秒）——查看器要能 100% 检视细节；
/// - 无 ffmpeg（测试夹具等）：进程内解码（仅可解格式）→ JPEG 质量 90。
///
/// **不缩放**：用户 2026-10-06 裁定（不要 2048 有界预览），预览尺寸 = 原始分辨率。
/// 代价是首次生成耗时与缓存体积按原始分辨率走，之后缓存命中即显示。
pub fn generate_image_preview(
    src: &Path,
    output_jpg: &Path,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<()> {
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
fn generate_preview_via_image(
    src: &Path,
    output_jpg: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let img = decode_thumbnail_src(src, None, u32::MAX, timeout)?;
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
/// AVIF/HEIC 家族进程内失败时回退**捆绑 ffmpeg 有界解码**（`src/decode.rs`，输出已
/// 缩到 ≤ `max_dim`，ffmpeg 默认应用旋转元数据）。小图不放大；读取 / 解码 / 写入失败
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
    let img = decode_thumbnail_src(src, ffmpeg_bin, max_dim, timeout)?;

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

/// 目标路径是否为 WebP（按扩展名判断，大小写不敏感）。
fn is_webp_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("webp"))
}

/// 把图像编码为 JPEG 并原子落盘（沿用 `image` crate 的默认质量 75）。
///
/// **必须显式指定 JPEG 编码器**：`DynamicImage::save` 按**路径扩展名**选编码器，而本函数
/// 要写的是 `.webp` 目标（WebP 编码失败的降级路径），`save` 会因此选中
/// `WebPEncoder::new_lossless`——无损 WebP 实测体积约为 JPEG 的 **4.5×**，
/// 比不降级还糟。显式构造 `JpegEncoder` 后，内容与后缀不一致是**刻意**的：
/// 图片格式自描述（JPEG 魔数 `FF D8 FF`），Chromium 与 ffmpeg 都按内容识别。
fn write_jpeg(img: &image::DynamicImage, output: &Path) -> HpResult<()> {
    // 原子落盘（见模块文档）：并行扫描下同一内容可能被多个线程同时生成。
    let temp = temp_sibling(output);
    let result = (|| -> image::ImageResult<()> {
        let file = std::fs::File::create(&temp)?;
        let mut writer = std::io::BufWriter::new(file);
        img.to_rgb8().write_with_encoder(
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 75),
        )
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(HpError::Io(format!("写入缩略图失败: {e}")));
    }
    commit(&temp, output)
}


/// 解码图片源文件：进程内路径（EXIF 方向 + 解码，输出与旧实现逐位相同）；
/// 失败时若属 AVIF/HEIC 家族且 ffmpeg 可用，回退 ffmpeg 有界解码（见模块文档）。
///
/// `into_decoder()` 与 `DynamicImage::from_decoder` **两处都可能是失败点**：
/// 未编译解码器时（如 AVIF 无 `avif-native`）前者报 `Unsupported`，文件损坏时后者报错，
/// 两处都要进兜底分支。
fn decode_thumbnail_src(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
) -> HpResult<image::DynamicImage> {
    use image::{DynamicImage, ImageDecoder, ImageReader};

    // 首次进入即注册 libheif hooks（幂等）：heic/heif/avif 可进程内解码，
    // 失败才落 ffmpeg 兜底（见 `decode` 模块文档）。
    crate::decode::ensure_libheif_hooks();
    // **尺寸分流**（有界请求 + AVIF/HEIC 超大图 + 有 ffmpeg）：直接 ffmpeg 有界，
    // 跳过进程内全分辨率解码（实测大图快 3.4×，见 `decode::LIBHEIF_FULL_RES_MAX_MP`）。
    if max_dim < u32::MAX && crate::decode::is_avif_family(src) {
        if let Some(bin) = ffmpeg_bin {
            if crate::decode::is_huge_avif_family(src) {
                return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout)
                    .map_err(|fe| {
                        HpError::Io(format!("解码图片失败: 超大图走 ffmpeg 有界失败: {fe}"))
                    });
            }
        }
    }

    let reader = ImageReader::open(src)
        .map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?
        .with_guessed_format()
        .map_err(|e| HpError::Io(format!("识别图片格式失败: {e}")))?;
    let mut decoder = match reader.into_decoder() {
        Ok(decoder) => decoder,
        Err(e) => {
            return fallback_decode(src, ffmpeg_bin, max_dim, timeout, &e.to_string(), "创建图片解码器失败");
        }
    };
    // 读取 EXIF 方向（缺失 / 不可读时按无变换处理，不报错）。
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    match DynamicImage::from_decoder(decoder) {
        Ok(mut img) => {
            img.apply_orientation(orientation);
            Ok(img)
        }
        Err(e) => fallback_decode(src, ffmpeg_bin, max_dim, timeout, &e.to_string(), "解码图片失败"),
    }
}

/// 进程内解码失败后的兜底：仅 AVIF/HEIC 家族且 ffmpeg 可用时走 ffmpeg 有界解码；
/// 其余情况原样返回进程内错误（既有格式口径不变）。
fn fallback_decode(
    src: &Path,
    ffmpeg_bin: Option<&Path>,
    max_dim: u32,
    timeout: Duration,
    cause: &str,
    step: &str,
) -> HpResult<image::DynamicImage> {
    if crate::decode::is_avif_family(src) {
        if let Some(bin) = ffmpeg_bin {
            return crate::decode::decode_image_with_ffmpeg(src, bin, max_dim, timeout).map_err(
                |fe| HpError::Io(format!("{step}: {cause}；ffmpeg 兜底: {fe}")),
            );
        }
    }
    Err(HpError::Io(format!("{step}: {cause}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscales_longest_side_without_upscaling() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("big.png");
        let out = dir.join("big.jpg");
        let img = image::RgbImage::from_pixel(800, 400, image::Rgb([10, 20, 30]));
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), 320);
        assert_eq!(thumb.height(), 160);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_image_keeps_original_size() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-small-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("small.png");
        let out = dir.join("small.jpg");
        let img = image::RgbImage::from_pixel(100, 50, image::Rgb([200, 100, 0]));
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), 100);
        assert_eq!(thumb.height(), 50);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 仓库内捆绑 ffmpeg 的定位（与 `hp-scanner/tests/m2_video_scan.rs` 同款）。
    fn bundled_ffmpeg() -> Option<std::path::PathBuf> {
        let cwd = std::env::current_dir().ok()?;
        let mut dir = cwd.as_path();
        loop {
            let candidate = dir.join("external-cli/ffmpeg/bin/ffmpeg.exe");
            if candidate.exists() {
                return Some(candidate);
            }
            dir = dir.parent()?;
        }
    }

    /// 端到端：AVIF 走 ffmpeg 兜底生成缩略图（依赖捆绑 ffmpeg；缺失时跳过，不卡 CI）。
    #[test]
    fn avif_thumbnail_falls_back_to_bundled_ffmpeg() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-avif-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("sample.avif");
        let out = dir.join("out.jpg");
        let status = crate::process::hidden_command(&ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=800x600", "-frames:v", "1", "-c:v", "libaom-av1", "-crf", "20", "-still-picture", "1"])
            .arg(&src)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成 AVIF 样本失败");

        generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30))
            .expect("AVIF 缩略图应生成成功");
        let thumb = image::open(&out).expect("读取缩略图失败");
        // 800×600 → 长边 320：宽 320、高 240；纯红角像素保留。
        assert_eq!((thumb.width(), thumb.height()), (320, 240));
        let rgb = thumb.to_rgb8();
        let px = rgb.get_pixel(0, 0);
        assert!(px[0] > 200 && px[1] < 60 && px[2] < 60, "角像素应为红色，实际 {px:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 读文件头若干字节（判格式用）。
    fn magic(path: &Path) -> Vec<u8> {
        use std::io::Read;
        let mut buf = vec![0u8; 16];
        let mut f = std::fs::File::open(path).expect("打开文件失败");
        let n = f.read(&mut buf).expect("读取失败");
        buf.truncate(n);
        buf
    }

    /// `.webp` 目标 + 有 ffmpeg：应落盘**真正的有损 WebP**（RIFF....WEBP），且能解回。
    ///
    /// 这条断言钉住的是"用户口径"本身：图片缩略图必须是 WebP。若哪天退回 JPEG，
    /// 体积优势（实测约一半）会静默消失，而功能测试不会发现。
    #[test]
    fn image_thumbnail_is_lossy_webp_when_ffmpeg_available() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-webp-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        // 有梯度、非纯色，避免退化成"随便编码都极小"的平凡样本。
        let img = image::RgbImage::from_fn(800, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30))
            .expect("WebP 缩略图应生成成功");

        let head = magic(&out);
        assert_eq!(&head[0..4], b"RIFF", "应为 RIFF 容器，实际 {head:?}");
        assert_eq!(&head[8..12], b"WEBP", "应为 WebP，实际 {head:?}");
        let thumb = image::open(&out).expect("WebP 缩略图应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 无 ffmpeg **且**未启用 `libwebp` 特性时降级为 JPEG：内容须是 JPEG，
    /// 且**不得**退化成无损 WebP。
    ///
    /// 这是关键回归点：`DynamicImage::save` 按**扩展名**选编码器，写 `.webp`
    /// 目标会选中 `WebPEncoder::new_lossless`——实测无损 WebP 体积约为 JPEG 的 **4.5×**。
    /// 因此降级必须显式用 `JpegEncoder`，本断言按魔数钉死。
    ///
    /// 启用 `libwebp` 后（默认）这条端到端降级**不再可达**——没有 ffmpeg 也能出 WebP，
    /// 故整体 `cfg` 掉；但"显式 JpegEncoder"这个陷阱守卫由
    /// [`write_jpeg_to_webp_path_stays_jpeg`] 在**所有**特性组合下继续把守。
    #[cfg(not(feature = "libwebp"))]
    #[test]
    fn webp_target_without_ffmpeg_falls_back_to_jpeg_not_lossless_webp() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-fallback-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        let img = image::RgbImage::from_fn(800, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
        });
        img.save(&src).expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("无 ffmpeg 时应降级成功");
        assert_jpeg_content(&out);
        // 按**内容**解码（`image::open` 按扩展名选解码器，而这里后缀与内容刻意不一致）。
        let thumb = image::ImageReader::open(&out)
            .expect("打开失败")
            .with_guessed_format()
            .expect("识别格式失败")
            .decode()
            .expect("降级 JPEG 应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 直接验证降级写入器：目标路径是 `.webp`，但内容**必须**是 JPEG。
    ///
    /// 与特性组合无关，因此始终运行——它把守的是"按扩展名 `save` 会写成无损 WebP"
    /// 那个 4.5× 陷阱（见 `write_jpeg` 文档）。
    #[test]
    fn write_jpeg_to_webp_path_stays_jpeg() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-wj-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let out = dir.join("out.webp");
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(64, 32, |x, _| {
            image::Rgb([(x % 256) as u8, 128, 64])
        }));

        write_jpeg(&img, &out).expect("降级写入应成功");
        assert_jpeg_content(&out);
        let decoded = image::ImageReader::open(&out)
            .expect("打开失败")
            .with_guessed_format()
            .expect("识别格式失败")
            .decode()
            .expect("应可解码");
        assert_eq!((decoded.width(), decoded.height()), (64, 32));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 断言文件内容确实是 JPEG（按魔数），且**不是** RIFF/WebP 容器。
    fn assert_jpeg_content(path: &Path) {
        let head = magic(path);
        assert_eq!(
            &head[0..3],
            &[0xFF, 0xD8, 0xFF],
            "产物应为 JPEG，实际 {head:?}"
        );
        assert_ne!(&head[0..4], b"RIFF", "**不得**写成无损 WebP");
    }

    /// `.jpg` 目标仍走进程内 JPEG（视频首帧抽帧那条路径不受影响）。
    #[test]
    fn jpg_target_stays_jpeg() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-jpg-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.jpg");
        image::RgbImage::from_pixel(400, 200, image::Rgb([1, 2, 3]))
            .save(&src)
            .expect("写入测试图片失败");

        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        assert_eq!(&magic(&out)[0..3], &[0xFF, 0xD8, 0xFF], "应为 JPEG");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// WebP 质量常量必须是我们实测选定的 70，且在 `libwebp` 的合法区间内。
    ///
    /// 用 `const` 断言而非 `assert!`：`assert!(CONST <= 100)` 是**编译期已知为真**的
    /// 常量表达式，运行时断言毫无意义（clippy 也会报 `assertions_on_constants`）。
    /// 改成 `const` 块后，若将来有人把常量改出区间，**编译就不过**。
    #[test]
    fn webp_quality_is_within_libwebp_range() {
        const _: () = assert!(IMAGE_THUMB_WEBP_QUALITY <= 100);
        assert_eq!(IMAGE_THUMB_WEBP_QUALITY, 70);
    }

    /// **D91 的核心不变量**：进程内 `libwebp` 与 ffmpeg 的 `libwebp` 输出**逐字节相同**。
    ///
    /// 这条断言是"换成进程内编码器**不需要重新生成既有缩略图**、质量口径零变化"的
    /// 唯一依据（`docs/issues/0029` §8.3 实测 145/145 组）。它一旦变红，说明两个
    /// 编码器不再等价——那时**不能**默默接受：要么重新生成缓存，要么重新标定
    /// [`IMAGE_THUMB_WEBP_QUALITY`]。因此这里逐字节比，而不是只比体积或只比魔数。
    #[cfg(feature = "libwebp")]
    #[test]
    fn in_process_and_ffmpeg_webp_are_byte_identical() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg（对照路径不可用）");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-identical-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");

        // 多样本：渐变、噪点、纯色、极端宽高比——覆盖不同熵与色度分布。
        let cases: Vec<(&str, image::RgbImage)> = vec![
            (
                "gradient",
                image::RgbImage::from_fn(400, 240, |x, y| {
                    image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
                }),
            ),
            (
                "noise",
                image::RgbImage::from_fn(320, 320, |x, y| {
                    let n = (x * 7919 + y * 104729) % 256;
                    image::Rgb([n as u8, (n * 3 % 256) as u8, (n * 7 % 256) as u8])
                }),
            ),
            ("solid", image::RgbImage::from_pixel(200, 150, image::Rgb([12, 200, 90]))),
            ("wide", image::RgbImage::from_fn(640, 40, |x, _| {
                image::Rgb([(x % 256) as u8, 40, 200])
            })),
            ("tall", image::RgbImage::from_fn(40, 640, |_, y| {
                image::Rgb([200, (y % 256) as u8, 40])
            })),
        ];

        for (label, img) in cases {
            let src = dir.join(format!("{label}.png"));
            img.save(&src).expect("写入测试图片失败");
            // ① 进程内（快路径）② ffmpeg（降级路径）——直接调两级编码器，绕开调度顺序。
            let decoded = image::open(&src).expect("解码失败");
            let inproc = dir.join(format!("{label}.inproc.webp"));
            let viaff = dir.join(format!("{label}.ffmpeg.webp"));
            encode_webp_in_process(&decoded, &inproc).expect("进程内编码失败");
            encode_webp_via_ffmpeg(&decoded, &viaff, &ffmpeg, Duration::from_secs(30))
                .expect("ffmpeg 编码失败");

            let a = std::fs::read(&inproc).expect("读取失败");
            let b = std::fs::read(&viaff).expect("读取失败");
            assert_eq!(
                a, b,
                "{label}: 进程内 libwebp 与 ffmpeg libwebp 输出不再逐字节相同\
                 （{}B vs {}B）——不得默默接受，需重生成缓存或重新标定质量",
                a.len(),
                b.len()
            );
            assert_eq!(&a[0..4], b"RIFF", "{label}: 应为 WebP");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 进程内快路径产出的确实是**有损 WebP**（魔数 + 可解码 + 尺寸正确）。
    #[cfg(feature = "libwebp")]
    #[test]
    fn in_process_encoder_produces_lossy_webp() {
        let dir = std::env::temp_dir().join(format!("hp-thumb-inproc-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        image::RgbImage::from_fn(800, 400, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8])
        })
        .save(&src)
        .expect("写入测试图片失败");

        // ffmpeg_bin = None：证明**不依赖 ffmpeg** 也能出 WebP（这正是本改动的目的）。
        generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
            .expect("进程内路径应成功");
        let head = magic(&out);
        assert_eq!(&head[0..4], b"RIFF", "应为 RIFF 容器，实际 {head:?}");
        assert_eq!(&head[8..12], b"WEBP", "应为 WebP，实际 {head:?}");
        let thumb = image::open(&out).expect("应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **降级确实会接手**：强制进程内编码失败后，ffmpeg 必须仍产出 WebP。
    ///
    /// 这是"保留 ffmpeg 作降级"这条要求的**行为证据**——只写 `match ... Err(_) =>`
    /// 并不能证明那条分支真的可达、真的能成功（可能永远走不到，或走到了也失败）。
    /// 用 `cfg(test)` 的注入开关把快路径打断，再看产物是不是 ffmpeg 的 WebP。
    #[cfg(feature = "libwebp")]
    #[test]
    fn ffmpeg_fallback_engages_when_in_process_fails() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到 external-cli/ffmpeg（降级路径不可用）");
            return;
        };
        let dir = std::env::temp_dir().join(format!("hp-thumb-fb-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let src = dir.join("src.png");
        let out = dir.join("out.webp");
        image::RgbImage::from_fn(600, 300, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 77])
        })
        .save(&src)
        .expect("写入测试图片失败");

        // 打断快路径，再走完整链路（decode → 缩放 → encode_webp）。
        FORCE_IN_PROCESS_FAILURE.with(|f| f.set(true));
        let result =
            generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30));
        FORCE_IN_PROCESS_FAILURE.with(|f| f.set(false));

        result.expect("进程内失败后，ffmpeg 降级应接手并成功");
        let head = magic(&out);
        assert_eq!(&head[0..4], b"RIFF", "降级产物仍应为 WebP，实际 {head:?}");
        assert_eq!(&head[8..12], b"WEBP", "降级产物仍应为 WebP，实际 {head:?}");
        let thumb = image::open(&out).expect("应可解码");
        assert_eq!((thumb.width(), thumb.height()), (320, 160));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn nanos() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{n}")
    }
}
