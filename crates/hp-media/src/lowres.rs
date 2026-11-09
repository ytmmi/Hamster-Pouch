//! 大 JPEG 缩略图的 **ffmpeg `-lowres` 快路径**（D148，缺陷 0018 §4.2 ②，2026-11-09）。
//!
//! ## 为什么按像素分流
//!
//! `-lowres L` 让 ffmpeg 的 MJPEG 解码器直接以 1/2^L 的 DCT 尺度出图（跳过全分辨率
//! IDCT 与大部分像素），对 9000² 这类大图收益显著；但每张图要起一个外部进程
//! （本机实测固定开销约 60–90 ms），小图进程内解码本来只要 10–35 ms，走 ffmpeg
//! 反而慢 2–6 倍（1536²：约 11 ms vs 约 70 ms）。因此**只对大图启用**，阈值由实测
//! 交叉点决定（见 [`LOWRES_MIN_MP`]）。
//!
//! ## 分流判据（全部满足才走快路径）
//!
//! 1. **扩展名是 jpg/jpeg**（D11 扩展名优先口径）。`-lowres` 是 MJPEG 解码器私有
//!    AVOption；PNG/WebP/TIFF 等没有 DCT 缩放解码，试它只会报错或白起进程。
//!    AVIF/HEIC 家族与 ffmpeg-only 格式在 `thumbnail::decode_thumbnail_src` 里
//!    更早的分支已被接走，不会到达这里。
//! 2. **有捆绑 ffmpeg**。没有就走既有进程内路径（行为不变）。
//! 3. **有界请求**（`max_dim < u32::MAX`）。全分辨率预览要 100% 细节，不许降尺度。
//! 4. **短边 ≥ 2 × max_dim**。DCT 档位取"最小的 L 使两轴 ceil(dim/2^L) ≥ max_dim"
//!    （[`lowres_level`]，L ≤ 3——mjpeg 的 lowres 上限就是 3）；短边不足 2× 时
//!    连 L=1 都会把某轴压到 `max_dim` 以下，缩略图会**被迫放大**，违背
//!    "只缩小不放大"的既有口径，宁可进程内全解码。
//! 5. **像素数 ≥ [`LOWRES_MIN_MP`]**。实测（本机 16 逻辑核，release，2026-11-09，
//!    进程内"解码+重采样到 320" vs ffmpeg lowres 全链，中位数 ms）：
//!    1536²≈11/66、2048²≈17/70、3096²≈32/71、4096²≈52/77、4608²≈62–120/84、
//!    5000²≈75–140/88、5500²≈88–170/90、6144²≈105–206/95、9000²≈373–460/135；
//!    真实照片 50–64 MP：341–553 → 129–277（**2.0–2.4×**）。
//!    交叉点在 ~20 MP 附近且随机器浮动，阈值取 **24 MP**（保守：宁可错过一点
//!    收益，不让临界图变慢；≥36 MP 收益稳定，9000² 约 2.8×）。
//! 6. **SOF 分量数 = 3（YCbCr 彩色）**。实测两个例外：
//!    **CMYK JPEG（4 分量）在 lowres 下颜色偏移明显**（同一样本全解码 RGB
//!    (238,121,18) vs lowres (182,80,17)——ffmpeg 的 DCT 缩放路径与全解码路径对
//!    Adobe APP14 反相的处理不一致；缩略图与查看器原图颜色对不上是不可接受的）；
//!    灰度（1 分量）本机语料未覆盖。**判据只认 3**，解析不到 SOF 同样不放行
//!    （保守方向与 [`LOWRES_MIN_MP`] 一致：宁可少赚一次加速）。
//!    代价是一次 ≤128 KiB 的头部读（`jpeg_sof_components`），相对进程内解码是零头。
//!
//! ## 管线与口径
//!
//! `ffmpeg -lowres L -i src -frames:v 1
//! -vf scale=D:D:force_original_aspect_ratio=decrease -f image2pipe -vcodec png -`
//! → 进程内 `image` 解 PNG → 走 `generate_image_thumbnail` 的**同一段**
//! 缩放 + WebP/JPEG 编码落盘。要点：
//!
//! - **`force_original_aspect_ratio=decrease`**：双轴给上限 D、按纵横比收缩。
//!   两个陷阱都实测过：视频抽帧的 `scale='min(D,iw)':-2` 按宽缩、竖图高轴超 D
//!   被二次重采样拉爆（6449×9122 竖图 PSNR 33→21 dB）；两轴各写 `min(D,i·)`
//!   则各自独立夹紧、非方图被拉成 D×D（集成测试红 320×320）。
//! - **ffmpeg 自动应用 EXIF 旋转**（displaymatrix，实测 orientation=6 输出 400×800），
//!   与进程内 `apply_orientation` 语义一致，快路径不再重复旋转。
//! - **质量**：与进程内全解码缩到 320 的结果比，真实照片 PSNR 31–43 dB、
//!   合成梯度 26–29 dB；合成图同刀对照（ffmpeg 全解码→bilinear 320 vs
//!   lowres→bilinear 320）41.5 dB；肉眼在 320 长边
//!   的网格单元里不可辨。图片 dHash 取自**源图**（`scan_compute`），不经缩略图，
//!   感知哈希/调色板缓存可比性不受影响；缩略图按内容哈希寻址，**旧缓存不失效**，
//!   只有未生成的缩略图走新路径。
//! - **失败即回退**：lowres 报错（个别畸形 JPEG、CMYK 边缘样本等）返回 `Err`，
//!   调用方**落回既有进程内路径**，最终行为与旧实现一致；不吞既有格式的坏文件
//!   错误语义（`non_avif_failure_is_not_swallowed_by_ffmpeg` 的口径不变——那测的是
//!   进程内失败后的兜底，这里是**预分流**，进程内路径仍原样兜底）。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout};

/// 快路径的像素阈值（百万像素）。低于它进程内解码更快（外部进程固定开销
/// 约 60–90 ms，本机实测），见模块文档的实测表。该值为**可调参数**。
pub(crate) const LOWRES_MIN_MP: u64 = 24;

/// jpg/jpeg 扩展名（大小写不敏感，D11 扩展名优先）。
fn is_jpeg_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
}

/// DCT 缩放档位：最小的 L∈[0,3] 使两轴 `ceil(dim / 2^L) >= target`。
///
/// 返回 0 表示"不缩放"（对快路径调用方而言即不适用——两轴条件在
/// [`lowres_level`] 之外还有短边闸门）。mjpeg 的 `lowres` 上限是 3（1/8）。
pub(crate) fn lowres_level(w: u32, h: u32, target: u32) -> u32 {
    let mut level = 0;
    while level < 3 {
        let div = 1u32 << (level + 1);
        if w.div_ceil(div) >= target && h.div_ceil(div) >= target {
            level += 1;
        } else {
            break;
        }
    }
    level
}

/// **SOF 分量数 = 3（YCbCr 彩色）才放行**（判据 6）。
///
/// 实测 CMYK（4 分量）在 lowres 与全解码之间**颜色偏移明显**（同一样本全解码
/// (238,121,18) vs lowres (182,80,17)——ffmpeg DCT 缩放路径与全解码路径对 Adobe
/// APP14 反相处理不一致），缩略图与查看器原图颜色对不上不可接受；灰度（1 分量）
/// 语料未覆盖——保守只认 3。只扫头部窗口（SOF 在首个熵段之前），解析不到按
/// "不放行"（与 [`LOWRES_MIN_MP`] 同一保守方向）。
fn jpeg_sof_is_ycbcr(src: &Path) -> bool {
    use std::io::Read;
    // 头部窗口：正常 JPEG 的 SOF 在几 KB 内；64 KiB 是"再大就不正常、宁可放弃
    // 快路径"的止损线（读的是文件头，不是全文件）。
    const WINDOW: usize = 64 * 1024;
    let mut buf = vec![0u8; WINDOW];
    let Ok(mut file) = std::fs::File::open(src) else {
        return false;
    };
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    let data = &buf[..n];
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return false;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            return false;
        }
        let marker = data[i + 1];
        // 独立标记（无长度字段）：填充 FF、RST0–RST7、SOI/EOI/TEM。
        if marker == 0xFF || (0xD0..=0xD9).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = (usize::from(data[i + 2]) << 8) | usize::from(data[i + 3]);
        if len < 2 || i + 2 + len > data.len() {
            return false;
        }
        // SOF0–3 / SOF5–7 / SOF9–11 / SOF13–15：payload = precision(1) h(2) w(2) ncomp(1)。
        if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
            return i + 9 < data.len() && data[i + 9] == 3;
        }
        // SOS（熵数据开始）或 EOI 而没先见到 SOF → 放弃快路径。
        if marker == 0xDA || marker == 0xD9 {
            return false;
        }
        i += 2 + len;
    }
    false
}

/// 是否应走 `-lowres` 快路径（判据见模块文档；读不到尺寸按"不适用"处理）。
/// `pub`：经 `lib.rs` 导出供集成测试与基准探针钉口径（生产判定在 `thumbnail` 内部）。
pub fn should_use_lowres(src: &Path, max_dim: u32) -> bool {
    if !is_jpeg_path(src) || max_dim == u32::MAX || max_dim == 0 {
        return false;
    }
    let Ok((w, h)) = image::image_dimensions(src) else {
        return false;
    };
    // 短边闸门：连 L=1 都保不住 max_dim 的图不许走（缩略图只缩小不放大）。
    if w.min(h) < max_dim.saturating_mul(2) {
        return false;
    }
    if u64::from(w) * u64::from(h) < LOWRES_MIN_MP * 1_000_000 {
        return false;
    }
    jpeg_sof_is_ycbcr(src)
}

/// 用 `-lowres` 解码大 JPEG 并缩到 ≤ `max_dim`，PNG 经 stdout 进内存。
///
/// 失败返回 `HpError::Io`，调用方回退进程内路径（见模块文档"失败即回退"）。
/// EXIF 旋转由 ffmpeg 的 displaymatrix 自动应用，调用方**不得**再旋转。
pub(crate) fn decode_lowres_thumbnail(
    src: &Path,
    ffmpeg_bin: &Path,
    max_dim: u32,
    timeout: Duration,
) -> HpResult<image::DynamicImage> {
    let (w, h) =
        image::image_dimensions(src).map_err(|e| HpError::Io(format!("读取图片尺寸失败: {e}")))?;
    let level = lowres_level(w, h, max_dim);
    // 保持纵横比：w/h 用 -1（按另一轴推、四舍五入），双轴 min 夹住上限。
    // **不能**两轴都写 min(D,i·)——那是各自独立夹紧，非方图会被拉成 D×D
    // （端到端测试实测 320×320，宽高比失真）。
    let scale = format!(
        "scale='min({max_dim},iw)':'min({max_dim},ih)':force_original_aspect_ratio=decrease"
    );
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-hide_banner", "-loglevel", "error", "-lowres"])
        .arg(level.to_string())
        .arg("-i")
        .arg(src)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &scale,
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ]);
    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffmpeg lowres 解码失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    if output.stdout.is_empty() {
        return Err(HpError::Io("ffmpeg lowres 未产出图像数据".into()));
    }
    image::load_from_memory(&output.stdout)
        .map_err(|e| HpError::Io(format!("解析 ffmpeg lowres 输出失败: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_keeps_both_axes_at_least_target() {
        // 9000² → L3（1125 ≥ 320）；2048² → L2（512）；1536² → L2（384）。
        assert_eq!(lowres_level(9000, 9000, 320), 3);
        assert_eq!(lowres_level(2048, 2048, 320), 2);
        assert_eq!(lowres_level(1536, 1536, 320), 2);
        // 3096：L3 = 387 ≥ 320，但 L4 不存在（mjpeg 上限 3）。
        assert_eq!(lowres_level(3096, 3096, 320), 3);
        // 短边不足：4000×600 → L1 时 600/2=300 < 320 → L0。
        assert_eq!(lowres_level(4000, 600, 320), 0);
        // 极端宽图：11435×4435 → L3（1430×555）。
        assert_eq!(lowres_level(11435, 4435, 320), 3);
        // ceil 语义：2559/8 = 319.875 → 320 ≥ 320，仍取 L3。
        assert_eq!(lowres_level(2559, 2559, 320), 3);
    }

    #[test]
    fn gate_rejects_small_narrow_and_non_jpeg() {
        let dir = std::env::temp_dir().join(format!("hp-lowres-gate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        // 小 JPEG（2 MP 级）：像素阈值之下。
        let small = dir.join("small.jpg");
        image::RgbImage::from_pixel(1600, 1200, image::Rgb([1, 2, 3]))
            .save(&small)
            .unwrap();
        assert!(!should_use_lowres(&small, 320));
        // 大 PNG：格式不符（-lowres 是 MJPEG 私有选项）。
        let png = dir.join("big.png");
        image::RgbImage::from_pixel(6000, 4000, image::Rgb([1, 2, 3]))
            .save(&png)
            .unwrap();
        assert!(!should_use_lowres(&png, 320));
        // 大 JPEG 但短边不足 2×320：不许走（会放大）。
        let narrow = dir.join("narrow.jpg");
        image::RgbImage::from_pixel(40000, 600, image::Rgb([1, 2, 3]))
            .save(&narrow)
            .unwrap();
        assert!(!should_use_lowres(&narrow, 320));
        // 大 JPEG（6000×4000 = 24 MP，短边 4000）：走。
        let big = dir.join("big.jpg");
        image::RgbImage::from_pixel(6000, 4000, image::Rgb([1, 2, 3]))
            .save(&big)
            .unwrap();
        assert!(should_use_lowres(&big, 320));
        // 大小写不敏感；全分辨率请求（u32::MAX）不走。
        let upper = dir.join("UPPER.JPEG");
        std::fs::copy(&big, &upper).unwrap();
        assert!(should_use_lowres(&upper, 320));
        assert!(!should_use_lowres(&upper, u32::MAX));

        // **判据 6（SOF 分量数）**：非 3 分量（CMYK=4、灰度=1）必须被拒——
        // ffmpeg DCT 缩放与全解码两条路径对 Adobe APP14 反相处理不一致，实测
        // 同一样本全解码 (238,121,18) vs lowres (182,80,17) 的颜色偏移（缩略图
        // 与查看器原图对不上色，比慢更糟）。
        //
        // 用**真实**灰度 JPEG（`image` 写 Luma8 → SOF0 ncomp=1）走整链判据；
        // CMYK 用**手写头**直接喂解析器——手写残帧会被 `image::image_dimensions`
        // 拒掉（zune 校验 SOS），那会经由"读不到尺寸"分支给出**假通过**，
        // 证明不了分量判据本身。
        let gray = dir.join("gray.jpg");
        image::GrayImage::from_pixel(5000, 5000, image::Luma([7]))
            .save(&gray)
            .expect("写灰度 JPEG 失败");
        assert_eq!(
            image::image_dimensions(&gray).unwrap(),
            (5000, 5000),
            "前提：灰度样本尺寸可读、像素过阈"
        );
        assert!(!should_use_lowres(&gray, 320), "1 分量灰度不得走快路径");

        let sof_header = |ncomp: u8| -> Vec<u8> {
            let mut v: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xC0]; // SOI + SOF0
            v.extend_from_slice(&(8 + 3 * ncomp as u16).to_be_bytes());
            v.push(8); // precision
            v.extend_from_slice(&6000u16.to_be_bytes()); // height
            v.extend_from_slice(&6000u16.to_be_bytes()); // width
            v.push(ncomp);
            for c in 1..=ncomp {
                v.extend_from_slice(&[c, 0x11, 0]);
            }
            v
        };
        let header_file = |name: &str, ncomp: u8| -> std::path::PathBuf {
            let p = dir.join(name);
            std::fs::write(&p, sof_header(ncomp)).unwrap();
            p
        };
        assert!(
            jpeg_sof_is_ycbcr(&header_file("sof3.jpg", 3)),
            "3 分量 YCbCr 头应放行"
        );
        assert!(
            !jpeg_sof_is_ycbcr(&header_file("sof4.jpg", 4)),
            "4 分量 CMYK 头应拒绝"
        );
        assert!(
            !jpeg_sof_is_ycbcr(&header_file("sof1.jpg", 1)),
            "1 分量灰度头应拒绝"
        );
        // 解析器在窗口内见不到 SOF（无长度字段的独立标记后接垃圾）→ 拒绝。
        let truncated = dir.join("trunc.jpg");
        std::fs::write(&truncated, [0xFFu8, 0xD8, 0xFF, 0xE0]).unwrap();
        assert!(!jpeg_sof_is_ycbcr(&truncated), "解析不到 SOF → 保守拒绝");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
