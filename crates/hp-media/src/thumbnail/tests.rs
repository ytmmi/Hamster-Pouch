// 缩略图生成链路的测试（D215：从原 `thumbnail.rs` 的 `mod tests` 原样搬出，只去掉 wrapper）。
use super::*;
use std::path::Path;
use std::time::Duration;

use crate::thumb_decode::write_jpeg;
use crate::webp::{FORCE_IN_PROCESS_FAILURE, encode_webp_in_process, encode_webp_via_ffmpeg};

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

/// 档梯吸附（缺陷 0046）：向上取最近一档，两端夹紧。
#[test]
fn thumb_dim_snaps_up_to_ladder() {
    assert_eq!(image_thumb_dim_for(0), IMAGE_THUMB_MAX_DIM);
    assert_eq!(image_thumb_dim_for(1), IMAGE_THUMB_MAX_DIM);
    assert_eq!(image_thumb_dim_for(320), 320);
    assert_eq!(image_thumb_dim_for(321), 480);
    assert_eq!(image_thumb_dim_for(480), 480);
    assert_eq!(image_thumb_dim_for(800), 960);
    assert_eq!(image_thumb_dim_for(1280), IMAGE_THUMB_MAX_LADDER_DIM);
    // 超出上限不报错、不放大：夹到 1280 档（再清晰由原图回退负责）。
    assert_eq!(image_thumb_dim_for(5000), IMAGE_THUMB_MAX_LADDER_DIM);
}

/// 同一张图在不同档位落盘时，长边恰好等于该档。
#[test]
fn ladder_dim_downscales_to_exactly_that_dim() {
    let dir = std::env::temp_dir().join(format!("hp-thumb-ladder-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("big.png");
    let img = image::RgbImage::from_pixel(1200, 600, image::Rgb([40, 50, 60]));
    img.save(&src).expect("写入测试图片失败");

    for dim in [480u32, 960] {
        let out = dir.join(format!("big@{dim}.jpg"));
        generate_image_thumbnail(&src, &out, dim, None, Duration::from_secs(30))
            .expect("生成缩略图失败");
        let thumb = image::open(&out).expect("读取缩略图失败");
        assert_eq!(thumb.width(), dim);
        assert_eq!(thumb.height(), dim / 2);
    }

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
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=800x600",
            "-frames:v",
            "1",
            "-c:v",
            "libaom-av1",
            "-crf",
            "20",
            "-still-picture",
            "1",
        ])
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
    assert!(
        px[0] > 200 && px[1] < 60 && px[2] < 60,
        "角像素应为红色，实际 {px:?}"
    );

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

/// 端到端：**进程内无解码器**的格式经 ffmpeg 兜底生成缩略图（2026-10-11 / D111）。
///
/// 用 JPEG 2000 作代表。这条断言补的是"解码测试覆盖不到的那一半"——
/// 网格与胶片栏真正消费的是**缩略图**（`thumb.get` → `generate_image_thumbnail`），
/// 只测 `decode_image_fallback` 不能证明这条链路通（`decode_thumbnail_src`
/// 有它自己的分支）。依赖捆绑 ffmpeg，缺失即跳过。
#[test]
fn ffmpeg_only_format_thumbnail_falls_back_to_bundled_ffmpeg() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-thumb-jp2-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.jp2");
    let out = dir.join("out.webp");
    let status = crate::process::hidden_command(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=800x600",
            "-frames:v",
            "1",
            "-c:v",
            "jpeg2000",
        ])
        .arg(&src)
        .status()
        .expect("启动 ffmpeg 失败");
    assert!(status.success(), "生成 JPEG 2000 样本失败");
    // 前提校验：进程内确实解不了，否则本用例测不到兜底路径。
    assert!(image::open(&src).is_err(), "JPEG 2000 不应能进程内解码");

    generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30))
        .expect("JPEG 2000 缩略图应生成成功");
    // 产物是 WebP（图片缩略图的既定口径，D90/D91），且能解回、尺寸正确。
    let head = magic(&out);
    assert_eq!(&head[0..4], b"RIFF", "缩略图应为 WebP，实际 {head:?}");
    assert_eq!(&head[8..12], b"WEBP", "缩略图应为 WebP，实际 {head:?}");
    let thumb = image::open(&out).expect("读取缩略图失败");
    // 800×600 → 长边 320：宽 320、高 240；纯红角像素保留。
    assert_eq!((thumb.width(), thumb.height()), (320, 240));
    let rgb = thumb.to_rgb8();
    let px = *rgb.get_pixel(0, 0);
    assert!(
        px[0] > 200 && px[1] < 60 && px[2] < 60,
        "角像素应为红色，实际 {px:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 端到端：SVG 经**进程内 `resvg`** 生成缩略图（D112）。
///
/// 这条断言钉住的是"SVG 不只进了扩展名表，而是真的有缩略图"——
/// SVG 此前**既不走 ffmpeg、也不走 `image::open`**，两处都必然失败，
/// 表现为网格里没有格子。**不依赖 ffmpeg**（证明它确实绕开了 ffmpeg 兜底）。
#[test]
fn svg_thumbnail_via_in_process_resvg() {
    let dir = std::env::temp_dir().join(format!("hp-thumb-svg-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.svg");
    std::fs::write(
            &src,
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#3355aa"/></svg>"##,
        )
        .expect("写入 SVG 失败");
    // 前提校验：`image::open` 解不了 SVG，ffmpeg 也没有 SVG 解码器——
    // 因此本用例走的必然是**新加的第三条路径**（进程内栅格化）。
    assert!(image::open(&src).is_err(), "SVG 不应能被 image::open 解码");

    let out = dir.join("out.webp");
    generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(30))
        .expect("SVG 缩略图应生成成功（不依赖 ffmpeg）");
    let head = magic(&out);
    assert_eq!(&head[8..12], b"WEBP", "缩略图应为 WebP，实际 {head:?}");
    let thumb = image::open(&out).expect("读取缩略图失败");
    assert_eq!(
        (thumb.width(), thumb.height()),
        (320, 240),
        "800×600 → 长边 320"
    );
    let rgb = thumb.to_rgb8();
    let px = *rgb.get_pixel(0, 0);
    let close = |a: u8, b: u8| a.abs_diff(b) <= 12;
    assert!(
        close(px[0], 0x33) && close(px[1], 0x55) && close(px[2], 0xaa),
        "角像素应为 #3355aa，实际 {px:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 端到端：**SVGZ（gzip）** 同样能出缩略图——按魔数解压，不靠后缀。
#[test]
fn svgz_thumbnail_via_magic_bytes() {
    let dir = std::env::temp_dir().join(format!("hp-thumb-svgz-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.svgz");
    // 真实 gzip 压缩（与 `usvg` 的 `svgz` 解码器同源同后端）。
    {
        use std::io::Write as _;
        let f = std::fs::File::create(&src).expect("创建文件失败");
        let mut gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        gz.write_all(
                br##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#cc3333"/></svg>"##,
            )
            .expect("gzip 写入失败");
        gz.finish().expect("gzip 完成失败");
    }

    let out = dir.join("out.webp");
    generate_image_thumbnail(&src, &out, 160, None, Duration::from_secs(30))
        .expect("SVGZ 缩略图应生成成功");
    let thumb = image::open(&out).expect("读取缩略图失败");
    assert_eq!((thumb.width(), thumb.height()), (160, 120));
    let rgb = thumb.to_rgb8();
    let px = *rgb.get_pixel(0, 0);
    let close = |a: u8, b: u8| a.abs_diff(b) <= 12;
    assert!(
        close(px[0], 0xcc) && close(px[1], 0x33) && close(px[2], 0x33),
        "角像素应为 #cc3333，实际 {px:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// **全分辨率预览**（缺陷 0019 口径）：SVG 走 `generate_image_preview` 必须出 JPEG。
#[test]
fn svg_preview_produces_full_size_jpeg() {
    let dir = std::env::temp_dir().join(format!("hp-prev-svg-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.svg");
    std::fs::write(
            &src,
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#227744"/></svg>"##,
        )
        .expect("写入 SVG 失败");

    let out = dir.join("preview.jpg");
    generate_image_preview(&src, &out, None, Duration::from_secs(30)).expect("SVG 预览应生成成功");
    let head = magic(&out);
    assert_eq!(
        &head[0..3],
        &[0xFF, 0xD8, 0xFF],
        "预览应为 JPEG，实际 {head:?}"
    );
    let img = image::open(&out).expect("读取预览失败");
    assert_eq!((img.width(), img.height()), (640, 480), "预览不缩放");
    let _ = std::fs::remove_dir_all(&dir);
}

/// **生产口径**：`preview.get` 总是传**真实的捆绑 ffmpeg**，而 SVG 必须**绕开**它。
///
/// 上一条用例传的是 `None`（无 ffmpeg 的测试夹具口径），那条路径在**生产里永远不走**
/// ——`preview_get` 传的 `state.ffmpeg_bin` 随包分发、恒为 `Some`。因此若
/// `generate_image_preview` 按"有 ffmpeg 就交给 ffmpeg"写，SVG 会**必然失败**
/// （ffmpeg 只有 `svg_pipe` 解复用器、没有解码器），表现为
/// **SVGZ 在查看器里一片空白**——而 `svg` 走原图（Chromium 原生渲染），
/// 所以这个缺陷只在 svgz 上显形，极易漏掉。
///
/// 这里传一个**根本不存在**的 ffmpeg 路径：只要实现还偷偷走 ffmpeg，就必然报
/// "启动 ffmpeg 失败"；成功即证明走了进程内 `resvg`。
#[test]
fn svg_preview_ignores_ffmpeg_fast_path() {
    let dir = std::env::temp_dir().join(format!("hp-prev-svgz-ff-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.svgz");
    {
        // 真实 gzip 压缩（`.svgz` 是 Chromium **画不了**的那一半，必须走后端预览）。
        use std::io::Write as _;
        let f = std::fs::File::create(&src).expect("创建文件失败");
        let mut gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        gz.write_all(
                br##"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#227744"/></svg>"##,
            )
            .expect("gzip 写入失败");
        gz.finish().expect("gzip 完成失败");
    }

    let bogus = dir.join("no-such-ffmpeg.exe");
    let out = dir.join("preview.jpg");
    generate_image_preview(&src, &out, Some(&bogus), Duration::from_secs(30))
        .expect("SVGZ 预览必须绕开 ffmpeg 快路径（传的是不存在的 ffmpeg）");
    assert_eq!(&magic(&out)[0..3], &[0xFF, 0xD8, 0xFF], "预览应为 JPEG");
    let img = image::open(&out).expect("读取预览失败");
    assert_eq!(
        (img.width(), img.height()),
        (320, 240),
        "SVGZ 预览 = SVG 自声明尺寸（不缩放）"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn ffmpeg_only_format_thumbnail_without_ffmpeg_reports_clear_error() {
    let dir = std::env::temp_dir().join(format!("hp-thumb-jp2-noff-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("x.jp2");
    let out = dir.join("out.webp");
    std::fs::write(&src, b"\x00\x00\x00\x0cjP  \r\n\x87\nfake").expect("写入失败");

    let err = generate_image_thumbnail(&src, &out, 320, None, Duration::from_secs(5))
        .expect_err("无 ffmpeg 时该格式应报错");
    assert!(
        format!("{err}").contains("ffmpeg"),
        "错误信息应点明需要 ffmpeg，实际：{err}"
    );
    assert!(!out.exists(), "失败时不得留下半成品缩略图");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 端到端：**进程内无解码器**的格式经 `generate_image_preview` 出**全分辨率 JPEG**。
///
/// 这条覆盖的是**图像查看器的主路径**（`preview.get` → `generate_image_preview`）：
/// 前端白名单取反后，新格式全部走预览，因此这条链路才是用户点开图时真正走的那条。
/// 与缩略图不同，预览**不缩放**（要能 100% 检视细节）。
#[test]
fn ffmpeg_only_format_preview_is_full_resolution_jpeg() {
    let Some(ffmpeg) = bundled_ffmpeg() else {
        eprintln!("跳过：未找到 external-cli/ffmpeg");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hp-preview-jp2-{}", nanos()));
    std::fs::create_dir_all(&dir).expect("创建临时目录失败");
    let src = dir.join("sample.jp2");
    let out = dir.join("preview.jpg");
    let status = crate::process::hidden_command(&ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x3355aa:s=800x600",
            "-frames:v",
            "1",
            "-c:v",
            "jpeg2000",
        ])
        .arg(&src)
        .status()
        .expect("启动 ffmpeg 失败");
    assert!(status.success(), "生成 JPEG 2000 样本失败");

    generate_image_preview(&src, &out, Some(&ffmpeg), Duration::from_secs(30))
        .expect("JPEG 2000 预览应生成成功");
    assert_eq!(&magic(&out)[0..3], &[0xFF, 0xD8, 0xFF], "预览应为 JPEG");
    let img = image::open(&out).expect("读取预览失败");
    // **不缩放**：800×600 原样（用户 2026-10-06 裁定不要 2048 有界预览）。
    assert_eq!(
        (img.width(), img.height()),
        (800, 600),
        "预览必须是原始分辨率（不缩放）"
    );
    let rgb = img.to_rgb8();
    let px = *rgb.get_pixel(0, 0);
    let close = |a: u8, b: u8| a.abs_diff(b) <= 12;
    assert!(
        close(px[0], 0x33) && close(px[1], 0x55) && close(px[2], 0xaa),
        "角像素应为 #3355aa 附近，实际 {px:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
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
        (
            "solid",
            image::RgbImage::from_pixel(200, 150, image::Rgb([12, 200, 90])),
        ),
        (
            "wide",
            image::RgbImage::from_fn(640, 40, |x, _| image::Rgb([(x % 256) as u8, 40, 200])),
        ),
        (
            "tall",
            image::RgbImage::from_fn(40, 640, |_, y| image::Rgb([200, (y % 256) as u8, 40])),
        ),
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
            a,
            b,
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
    let result = generate_image_thumbnail(&src, &out, 320, Some(&ffmpeg), Duration::from_secs(30));
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
