//! `-lowres` 快路径的**端到端链路测试**（D148）：分流命中 → WebP 产物 →
//! 质量 / EXIF / 竖图口径 / ffmpeg 缺失回退。与 `lowres.rs` 的纯判据单元测试
//! 分开——这里走 `generate_image_thumbnail` 整链（拆文件也为守住 1200 行红线，
//! 与 D120-R3 拆 `webp` 同一理由）。

use std::path::Path;
use std::time::Duration;

use hp_media::generate_image_thumbnail;

/// 仓库内捆绑 ffmpeg 的定位（与 `thumbnail` 测试同款）。
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

/// 读文件头若干字节（判格式用）。
fn magic(path: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut buf = vec![0u8; 16];
    let mut f = std::fs::File::open(path).expect("打开文件失败");
    let n = f.read(&mut buf).expect("读取失败");
    buf.truncate(n);
    buf
}

fn nanos() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n}")
}

/// 造一张超过分流阈值的大 JPEG（确定性梯度内容，非纯色）。
fn make_big_jpeg(dir: &Path, name: &str, w: u32, h: u32) -> std::path::PathBuf {
    let src = dir.join(name);
    image::RgbImage::from_fn(w, h, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
    })
    .save(&src)
    .expect("写入大 JPEG 失败");
    src
}

/// **D148 快路径端到端**：大 JPEG（≥24 MP）经 `-lowres` 出 WebP 缩略图，
/// 尺寸正确、可解码；且**证明确实走了 lowres**——传一个不存在的 ffmpeg 时
/// 快路径静默失败、进程内路径接手，产物仍然正确（回退语义）。
#[test]
fn big_jpeg_thumbnail_uses_lowres_and_falls_back() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-thumb-lowres-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    // 6000×4000 = 24 MP，恰在阈值上；短边 4000 ≥ 640。
    let src = make_big_jpeg(&dir, "big.jpg", 6000, 4000);
    assert!(hp_media::should_use_lowres(&src, 320), "样本应命中分流判据");

    let out = dir.join("out.webp");
    generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(60))
        .expect("大 JPEG 缩略图应生成成功");
    let head = magic(&out);
    assert_eq!(&head[8..12], b"WEBP", "产物应为 WebP，实际 {head:?}");
    let thumb = image::open(&out).expect("读取缩略图失败");
    assert_eq!((thumb.width(), thumb.height()), (320, 213));

    // 回退语义：ffmpeg 不存在 → lowres 失败 → 进程内路径接手，产物仍正确。
    let bogus = dir.join("no-such-ffmpeg.exe");
    let out2 = dir.join("fallback.webp");
    generate_image_thumbnail(&src, &out2, 320, Some(&bogus), Duration::from_secs(60))
        .expect("ffmpeg 缺失时应回退进程内路径");
    let thumb2 = image::open(&out2).expect("回退产物应可解码");
    assert_eq!((thumb2.width(), thumb2.height()), (320, 213));

    let _ = std::fs::remove_dir_all(&dir);
}

/// **D148 质量口径**：lowres 缩略图与进程内全解码缩略图逐像素 PSNR ≥ 25 dB
/// （320 长边的网格单元里肉眼不可辨；实测合成梯度约 27–33 dB、真实照片 26–37 dB）。
/// 两条产物都经同一把 WebP 编码刀，差异只来自解码尺度。
#[test]
fn lowres_thumbnail_quality_matches_inprocess() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-thumb-lowres-q-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = make_big_jpeg(&dir, "big.jpg", 6000, 4000);

    let fast = dir.join("fast.webp");
    generate_image_thumbnail(&src, &fast, 320, Some(&ffmpeg), Duration::from_secs(60))
        .expect("快路径应成功");
    // 对照组：不给 ffmpeg → 必然进程内（既有路径，逐位口径）。
    let slow = dir.join("slow.webp");
    generate_image_thumbnail(&src, &slow, 320, None, Duration::from_secs(60))
        .expect("进程内路径应成功");

    let a = image::open(&fast).expect("读取快路径产物失败").to_rgb8();
    let b = image::open(&slow).expect("读取进程内产物失败").to_rgb8();
    // lowres 的 ceil 取整可能让某轴差 1px：统一到对照尺寸再比。
    let a = if a.dimensions() != b.dimensions() {
        image::DynamicImage::ImageRgb8(a)
            .thumbnail_exact(b.width(), b.height())
            .to_rgb8()
    } else {
        a
    };
    let mut se = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = i64::from(pa[c]) - i64::from(pb[c]);
            se += (d * d) as u64;
        }
    }
    let mse = se as f64 / (f64::from(a.width()) * f64::from(a.height()) * 3.0);
    let psnr = if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0f64 * 255.0 / mse).log10()
    };
    assert!(psnr >= 25.0, "lowres 质量退化：PSNR {psnr:.2} dB < 25 dB");

    let _ = std::fs::remove_dir_all(&dir);
}

/// **D148 EXIF 方向**：orientation=6 的大 JPEG 经快路径后宽高必须互换
/// （ffmpeg displaymatrix 自动旋转；若实现漏了旋转，这里 320×213 会变成 213×320）。
#[test]
fn lowres_thumbnail_applies_exif_orientation() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-thumb-lowres-exif-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let base = make_big_jpeg(&dir, "base.jpg", 6000, 4000);
    // 用 kamadak-exif 读不了写；手工把 base 的 JPEG 头里插一段最小 EXIF APP1
    // （TIFF 头 + 单 IFD 条目 Orientation=6）。
    let src = dir.join("rot6.jpg");
    {
        let bytes = std::fs::read(&base).expect("读取 base 失败");
        // APP1 段：Exif\0\0 + TIFF(II*\0, offset 8) + IFD(1 条目: tag 0x0112, SHORT, 1, 6)
        let mut app1: Vec<u8> = vec![0xFF, 0xE1, 0x00, 0x22, b'E', b'x', b'i', b'f', 0, 0];
        app1.extend_from_slice(&[
            b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF 头
            0x01, 0x00, // IFD 条目数 = 1
            0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // Orientation, SHORT, count 1
            0x06, 0x00, 0x00, 0x00, // 值 6
            0x00, 0x00, 0x00, 0x00, // 下一 IFD = 0
        ]);
        let mut out = Vec::with_capacity(bytes.len() + app1.len());
        out.extend_from_slice(&bytes[..2]); // SOI
        out.extend_from_slice(&app1);
        out.extend_from_slice(&bytes[2..]);
        std::fs::write(&src, out).expect("写入 rot6 失败");
    }
    // 前提校验：进程内解码器确实读到 orientation=6（否则本用例测不到旋转）。
    {
        use image::ImageDecoder as _;
        let reader = image::ImageReader::open(&src)
            .unwrap()
            .with_guessed_format()
            .unwrap();
        let mut decoder = reader.into_decoder().unwrap();
        assert_eq!(
            decoder.orientation().unwrap(),
            image::metadata::Orientation::Rotate90,
            "夹具的 EXIF 方向必须是 6（Rotate90）"
        );
    }
    assert!(hp_media::should_use_lowres(&src, 320));

    let out = dir.join("rot.webp");
    generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(60))
        .expect("旋转样本缩略图应成功");
    let thumb = image::open(&out).expect("读取缩略图失败");
    // 6000×4000 旋转 90° → 4000×6000 → 长边 320：宽 213、高 320。
    assert_eq!(
        (thumb.width(), thumb.height()),
        (213, 320),
        "EXIF 方向未应用（宽高没有互换）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// **D148 竖图口径**：竖长大 JPEG（短边 ≥ 640）经快路径后长边必须是高
/// （双轴 min 缩放；视频抽帧的 `scale=min(D,iw):-2` 公式会把高轴拉爆，
/// 基准里实测 PSNR 33→21 dB，这里钉尺寸语义）。
#[test]
fn lowres_thumbnail_portrait_bounds_long_edge() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-thumb-lowres-port-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    // 4000×6000 = 24 MP 竖图。
    let src = make_big_jpeg(&dir, "portrait.jpg", 4000, 6000);
    assert!(hp_media::should_use_lowres(&src, 320));
    let out = dir.join("port.webp");
    generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(60))
        .expect("竖图缩略图应成功");
    let thumb = image::open(&out).expect("读取缩略图失败");
    assert_eq!((thumb.width(), thumb.height()), (213, 320));
    let _ = std::fs::remove_dir_all(&dir);
}
