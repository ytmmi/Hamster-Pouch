//! 图片缩略图的 **WebP 编码**（D91 三级降级），从 `thumbnail` 拆出。
//!
//! **为什么单独成模块**（2026-10-25，D120-R3）：`thumbnail.rs` 同时承担
//! 「视频首帧抽帧」与「图片缩略图生成（含 WebP 三级降级）」两件事，格式化成 rustfmt
//! 口径后涨到 1230 行、越过 1200 行红线。按**职责**拆比按行数硬压更合适：
//! WebP 编码是一个自带完整语义的子域（快路径 / 降级 / 可用性兜底），
//! 与抽帧、预览生成正交，且它的模块文档本来就写在本文件顶部。
//!
//! 本模块只搬走"怎么编码"，**不搬**"缩略图多大、什么时候生成"——
//! 后者仍在 `thumbnail`（`IMAGE_THUMB_MAX_DIM` / `generate_image_thumbnail`）。
//! 调用关系：`thumbnail` → `webp::encode_webp`。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout_stdin};
use crate::thumbnail::{IMAGE_THUMB_WEBP_QUALITY, commit, temp_sibling};

// 仅测试用：强制"进程内编码失败"，以验证 ffmpeg 降级**真的会接手**。
//
// **必须是 `thread_local`**：测试并行跑，用全局静态会让"注入失败"泄漏到同进程的
// 其他用例（实测：`in_process_encoder_produces_lossy_webp` 因被邻居置位而误走降级、
// 拿到 JPEG 后断言失败）。每个用例各在自己的线程上，线程局部变量天然隔离。
//
// `cfg(test)` 门控——**不进生产构建**，因此不是可被误用的运行时开关。
#[cfg(test)]
thread_local! {
    pub(crate) static FORCE_IN_PROCESS_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

/// 把图像编码为 WebP 并原子落盘到 `output_webp`，**快路径优先**（见模块文档的三级降级）：
///
/// 1. 进程内 `libwebp`（`libwebp` 特性）——最快；
/// 2. ffmpeg 子进程（`ffmpeg_bin` 可用时）；
///
/// 两级都不可用 / 都失败时返回 `Err`，由调用方降级为 JPEG。
pub(crate) fn encode_webp(
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
pub(crate) fn encode_webp_in_process(
    img: &image::DynamicImage,
    output_webp: &Path,
) -> HpResult<()> {
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
pub(crate) fn encode_webp_via_ffmpeg(
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
