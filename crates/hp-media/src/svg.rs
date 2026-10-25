//! SVG / SVGZ **进程内栅格化**（D112）。
//!
//! ## 为什么需要这一层（为什么 ffmpeg 不够）
//!
//! 捆绑 ffmpeg 对 SVG 是**有解复用器、无解码器**的典型：`-demuxers` 里查得到
//! `svg_pipe`，但 `-decoders` 里**没有** svg，按本项目真实管线跑一遍会报
//! `Decoding requested, but no decoder found for: svg` / `unspecified size`，
//! 产物是**空文件**。这正是 D111「不能只读清单判定」的教科书反例（`docs/rfc/0005` §4）。
//!
//! 所以 SVG 需要一个**进程内栅格化器**。选 `resvg`（+ 纯 Rust 光栅后端 `tiny-skia`）：
//!
//! - **纯 Rust、零 C 依赖、零运行期外部二进制**——符合 D20「依赖与构建链本地化」，
//!   与 D110 选 `hayro` 而不是 pdfium / mupdf 同一条判据（那两者都要运行期原生库）；
//! - 许可 Apache-2.0 / MIT，与本项目其它依赖一致；
//! - **刻意不开 `system-fonts` / `memmap-fonts`**：不扫系统字体目录、不要求用户装字体，
//!   与 `hayro` 的 `embed-fonts` 同属"不把用户环境变成运行期前提"。
//!
//! ## 与查看器显示的关系（重要）
//!
//! Chromium **原生就能渲染** SVG，所以查看器显示一直没问题（走原图路径，
//! 见 `apps/desktop/src/app_ui/shared/previewUrl.ts` 的 `NATIVE_RENDER_EXTS`）。
//! 本模块补的是**派生数据**：缩略图 / 调色板 / 感知哈希——这三样此前对 SVG 一律是空的，
//! 表现为"能打开、但列表里没有格子、调不出颜色、感知检索失效"。
//!
//! ## 边界（如实记录，不假装）
//!
//! - **文字依赖字体**：本项目**不捆绑字体**，因此 SVG 里的 `<text>` 因找不到字体而
//!   **不渲染**（图形部分正常）。这是"不把用户字体目录变成运行期前提"的代价，
//!   与 `hp-pdf` 不引入 pdfium 是同一组取舍。留了 `fontdb` 注入口子，将来要支持
//!   文字渲染时不必换库。
//! - **脚本 / 外链不执行**：`usvg` 是**安全解析器**，不执行 JavaScript、不拉取外部资源
//!   （`<image>` href 不解析，只解 data: 内嵌位图）。这是**安全边界而非缺陷**。
//! - **滤镜**：`feGaussianBlur` 等在 `tiny-skia` 上支持有限；解析失败或渲染不出画布时
//!   返回**明确错误**，由调用方按既有口径降级（缩略图用占位、扫描跳过派生数据——
//!   见 `scan_task` 的"解码失败不影响索引"）。
//!
//! ## 尺寸口径
//!
//! 矢量图**没有**"原图尺寸"这回事，取尺寸靠 `width` / `height` / `viewBox`。
//! `usvg` 在三者都缺时给不出尺寸，此时按 CSS 对 replaced element 规定的默认值兜底，
//! 否则会渲染成一张**空白**缩略图（表现为"入库了但格子是空的"，极难归因）。

use std::path::Path;

use hp_core::{HpError, HpResult};
// `resvg` 把 `usvg`（解析器）与 `tiny_skia`（光栅后端）作为公开重导出——
// 直接依赖它们会让版本与 `resvg` 内部用的不一致，因此**只从 `resvg` 拿**。
use resvg::tiny_skia;
use resvg::usvg;

/// SVG 相关扩展名（**大小写不敏感**）。
///
/// `svgz` 是 gzip 压缩的 SVG（`image/svg+xml` 的官方压缩变体），Chromium **不**原生
/// 渲染它，因此它必须走后端预览（见 `previewUrl.ts` 的白名单取反口径）。
pub const SVG_EXTS: [&str; 2] = ["svg", "svgz"];

/// 是否是 SVG / SVGZ（按扩展名判定，扩展名优先是 D11 的既有口径）。
pub fn is_svg(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SVG_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// SVG 无任何尺寸信息时的**兜底尺寸**（px）：CSS 对 replaced element 规定的默认值。
const SVG_DEFAULT_SIZE: f32 = 300.0;

/// **画布像素上限**（100 MP，与 `docs/issues/0018` 实测语料里最大的 100 MP 同档）。
///
/// ## 为什么必须有（不能像原来那样"相信矢量天然有界"）
///
/// `tiny_skia::Pixmap::new` 内部是 `vec![0; w * h * 4]`，**没有可失败分配**
/// （库源码原话："We cannot check that allocation was successful yet"）。
/// 因此一个自声明 `width="100000" height="100000"` 的 SVG —— 纯文本、几行、几 KB ——
/// 会让 **整个进程 abort**（Rust 分配失败即 abort，捕获不到、降级不了），
/// 这正是 `docs/issues/0018` 那类"大图"问题的**更坏版本**：位图至少要先有那么多像素，
/// 而矢量只需要**声称**这么大。
///
/// 所以"矢量渲染天然有界"是**错的**：矢量不会因为文件大而变大，但会因为
/// **自声明尺寸**而变大。位图路径有 `decode.rs` 的尺寸分流与 ffmpeg 的
/// `-vf scale` 兜底，矢量路径没有，只能在这里夹住。
///
/// 上限取 100 MP 而不是更小：这是本项目**已经实测承载过**的最大图像档
/// （0018 的 `huge_10000`），真实 SVG 的自声明尺寸远在这个量级之下，
/// 因此正常文件**一个像素都不会被缩**，只有畸形/恶意声明才被按比例收进来。
const SVG_MAX_PIXELS: u64 = 100_000_000;

/// **读文件字节上限**（8 MiB）。SVG 是纯文本、解析器要在内存里建树，
/// 无上限等于给一个改名的文本文件开"吃满内存"的入口（D11 的输入面）。
const SVG_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 把 SVG / SVGZ 栅格化为位图。
///
/// `max_dim` 语义与图片路径**完全一致**：
/// - `max_dim < u32::MAX`：**有界**渲染到长边不超过 `max_dim`（缩略图 / 调色板 / 感知哈希）；
/// - `max_dim == u32::MAX`：**不缩放**，按 SVG 自身尺寸渲染（查看器全分辨率预览）。
///
/// **两种情况都再夹一道 [`SVG_MAX_PIXELS`]**：矢量图的"原图尺寸"是**文件的自声明**
/// 而非事实，无上限时一个几 KB 的畸形 SVG 就能让 `tiny_skia` 的
/// `vec![0; w * h * 4]` 把进程 abort（`Pixmap::new` 没有可失败分配）。
/// 有界调用（`max_dim` 很小）本就不会触到上限，因此这条夹子只影响全分辨率预览。
///
/// **SVGZ 由 `usvg::Tree::from_data` 按魔数处理**（`svgz` 特性）：识别 `1F 8B` gzip 头，
/// 与后缀无关——改名的 gzip SVG 照样能解，这正是 D11「内容兜底」该管的事。
pub fn rasterize_svg(src: &Path, max_dim: u32) -> HpResult<image::DynamicImage> {
    let bytes = read_svg_bytes(src)?;
    let options = usvg::Options::default();
    let tree = usvg::Tree::from_data(&bytes, &options)
        .map_err(|e| HpError::Io(format!("解析 SVG 失败 {}: {e}", src.display())))?;

    let (w, h) = resolve_size(tree.size(), max_dim);
    let mut pixmap = tiny_skia::Pixmap::new(w, h).ok_or_else(|| {
        HpError::Io(format!(
            "渲染 SVG 失败 {}: 无法分配 {w}×{h} 画布",
            src.display()
        ))
    })?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_row(w as f32, 0.0, 0.0, h as f32, 0.0, 0.0),
        &mut pixmap.as_mut(),
    );

    // RGBA 底色；后续 `analyze_image` / 缩略图路径都 `to_rgb8()`，这里保持原样。
    let rgba = image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), pixmap.data().to_vec())
        .ok_or_else(|| HpError::Io(format!("渲染 SVG 失败 {}: 画布尺寸非法", src.display())))?;
    Ok(image::DynamicImage::ImageRgba8(rgba))
}

/// 读取 SVG 字节并做大小上限检查。
fn read_svg_bytes(src: &Path) -> HpResult<Vec<u8>> {
    let meta = std::fs::metadata(src)
        .map_err(|e| HpError::Io(format!("读取 SVG 失败 {}: {e}", src.display())))?;
    if meta.len() > SVG_MAX_BYTES {
        return Err(HpError::Io(format!(
            "SVG 过大（{} 字节，上限 {SVG_MAX_BYTES}）: {}",
            meta.len(),
            src.display()
        )));
    }
    std::fs::read(src).map_err(|e| HpError::Io(format!("读取 SVG 失败 {}: {e}", src.display())))
}

/// 决定输出画布尺寸：`max_dim` 有界 / 全尺寸两条口径共用同一套取尺寸规则。
///
/// 三道夹子，顺序固定：**兜底尺寸 → `max_dim` 有界 → 像素上限**。
/// 最后一道不可省（见 [`SVG_MAX_PIXELS`]）：`Pixmap::new` 没有可失败分配，
/// 超限画布 = 进程 abort 而不是返回错误。
fn resolve_size(size: tiny_skia::Size, max_dim: u32) -> (u32, u32) {
    let (mut w, mut h) = (size.width(), size.height());
    if !(w.is_finite() && h.is_finite()) || w <= 0.0 || h <= 0.0 {
        // 无 `width` / `height` / `viewBox`：按 CSS 默认 replaced 尺寸兜底。
        (w, h) = (SVG_DEFAULT_SIZE, SVG_DEFAULT_SIZE);
    }
    let long = w.max(h);
    if max_dim < u32::MAX && long > max_dim as f32 {
        let k = max_dim as f32 / long;
        w *= k;
        h *= k;
    }
    // 像素上限：按**面积**等比收（不是按长边），这样宽扁 / 高瘦的畸形声明
    // 与方形声明受同一条约束。
    let pixels = f64::from(w) * f64::from(h);
    if pixels > SVG_MAX_PIXELS as f64 {
        let k = (SVG_MAX_PIXELS as f64 / pixels).sqrt() as f32;
        w *= k;
        h *= k;
    }
    (w.round().max(1.0) as u32, h.round().max(1.0) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = tempfile::tempdir().expect("创建临时目录失败").keep();
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).expect("创建文件失败");
        f.write_all(bytes).expect("写入失败");
        path
    }

    // 注意用 `r##"…"##`：`fill="#3355aa"` 里的 `"#` 会提前结束 `r#"…"#`。
    const RECT_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48"><rect width="64" height="48" fill="#3355aa"/></svg>"##;

    /// SVG 能进程内栅格化，并按 `max_dim` 有界。
    #[test]
    fn rasterizes_plain_svg_bounded() {
        let src = write_tmp("a.svg", RECT_SVG.as_bytes());
        let img = rasterize_svg(&src, 32).expect("SVG 应能栅格化");
        assert_eq!((img.width(), img.height()), (32, 24), "长边应缩到 32");
        let rgb = img.to_rgb8();
        let p = rgb.get_pixel(0, 0);
        let close = |a: u8, b: u8| a.abs_diff(b) <= 8;
        assert!(
            close(p[0], 0x33) && close(p[1], 0x55) && close(p[2], 0xaa),
            "左上应为 #3355aa，实际 {p:?}"
        );
        let _ = std::fs::remove_file(&src);
    }

    /// `u32::MAX` = 查看器预览口径：不缩放。
    #[test]
    fn rasterizes_at_native_size() {
        let src = write_tmp("b.svg", RECT_SVG.as_bytes());
        let img = rasterize_svg(&src, u32::MAX).expect("SVG 应能栅格化");
        assert_eq!((img.width(), img.height()), (64, 48));
        let _ = std::fs::remove_file(&src);
    }

    /// 只有 `width` 没有 `height`（极常见的合法 SVG）必须给出**方形**画布。
    #[test]
    fn width_only_svg_gets_square_canvas() {
        let src = write_tmp(
            "c.svg",
            br##"<svg xmlns="http://www.w3.org/2000/svg" width="40"><rect width="40" height="40" fill="#ffffff"/></svg>"##,
        );
        let img = rasterize_svg(&src, u32::MAX).expect("只有 width 的 SVG 应能栅格化");
        assert_eq!((img.width(), img.height()), (40, 40));
        let _ = std::fs::remove_file(&src);
    }

    /// 完全没有尺寸信息 → CSS 默认兜底，**不得**是 0×0 空白图。
    #[test]
    fn sizeless_svg_falls_back_to_default() {
        let src = write_tmp(
            "d.svg",
            br##"<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#000"/></svg>"##,
        );
        let img = rasterize_svg(&src, u32::MAX).expect("无尺寸 SVG 应能栅格化");
        assert!(
            img.width() > 0 && img.height() > 0,
            "无尺寸 SVG 不得渲染成 0×0（会表现为空白缩略图）"
        );
        let _ = std::fs::remove_file(&src);
    }

    /// 扩展名识别大小写不敏感，且 `svgz` 同样被认作 SVG。
    #[test]
    fn recognizes_svg_exts_case_insensitively() {
        assert!(is_svg(Path::new("a.svg")));
        assert!(is_svg(Path::new("A.SVG")));
        assert!(is_svg(Path::new("a.svgz")));
        assert!(!is_svg(Path::new("a.png")));
        assert!(!is_svg(Path::new("a")));
    }

    /// 非法 SVG 必须报**明确错误**（调用方据此降级成占位），而不是 panic 或空图。
    #[test]
    fn malformed_svg_reports_error() {
        let src = write_tmp("e.svg", b"<svg><<<not really svg");
        assert!(rasterize_svg(&src, 128).is_err(), "非法 SVG 应报错");
        let _ = std::fs::remove_file(&src);
    }

    /// **SVGZ 端到端**：真实 gzip 压缩的 SVG 必须能解压 + 栅格化。
    /// 这条钉住的是"svgz 不只是进了扩展名表，而是真的能解码"（D111 的两件事同时做）。
    #[test]
    fn rasterizes_gzip_svgz_by_magic() {
        // 真实 gzip 压缩产物（用系统 gzip 生成，非手造）。
        let gz = gzip_svgz();
        // **顶着 `.svgz` 后缀** + **顶着 `.svg` 后缀**都必须能解——判据是魔数而非后缀。
        for name in ["f.svgz", "f.svg"] {
            let src = write_tmp(name, &gz);
            let img = rasterize_svg(&src, 32).unwrap_or_else(|e| panic!("{name} 应能栅格化: {e}"));
            assert_eq!((img.width(), img.height()), (32, 24), "{name} 尺寸应有界");
            let _ = std::fs::remove_file(&src);
        }
    }

    /// gzip 数据必须是**真实的** gzip 头（1F 8B），否则测不到解压路径。
    fn gzip_svgz() -> Vec<u8> {
        // 用 flate2 的纯 Rust 后端压缩（与 `usvg` 同一个解码器，保证可解）。
        use std::io::Write as _;
        let mut enc = Vec::new();
        let mut gz = flate2::write::GzEncoder::new(&mut enc, flate2::Compression::default());
        gz.write_all(RECT_SVG.as_bytes()).expect("gzip 写入失败");
        gz.finish().expect("gzip 完成失败");
        assert_eq!(&enc[0..2], &[0x1F, 0x8B], "必须是 gzip 魔数");
        enc
    }

    /// **畸形自声明尺寸不得把进程带走**（D112）。
    ///
    /// `tiny_skia::Pixmap::new` 内部是 `vec![0; w * h * 4]`、**没有可失败分配**，
    /// 所以一个几 KB 的 `<svg width="100000" height="100000">` 在无上限时会
    /// **直接 abort**（不是返回 Err，捕获不到也降级不了）。
    ///
    /// 这里测的是**取尺寸规则**（纯函数）而不是真的渲染：真渲染 100 MP 要 400 MB，
    /// 放进单元测试只会让它又慢又脆；而"能不能 abort"完全由传进 `Pixmap::new`
    /// 的尺寸决定，钉住尺寸就等于钉住这条边界。
    #[test]
    fn absurd_declared_size_is_capped() {
        let huge = tiny_skia::Size::from_wh(100_000.0, 100_000.0).expect("构造尺寸失败");
        let (w, h) = resolve_size(huge, u32::MAX);
        assert!(
            u64::from(w) * u64::from(h) <= SVG_MAX_PIXELS,
            "全分辨率口径也必须收进像素上限，实际 {w}×{h}"
        );
        // 等比收：方形声明收完仍是方形（不是把宽高各夹到上限）。
        assert_eq!(w, h, "等比收缩不得改变宽高比");

        // **上限内的正常声明一个像素都不许缩**——上限不是"一律缩小"。
        let normal = tiny_skia::Size::from_wh(4000.0, 3000.0).expect("构造尺寸失败");
        assert_eq!(
            resolve_size(normal, u32::MAX),
            (4000, 3000),
            "常见尺寸（含超大壁纸）必须原样渲染"
        );

        // 极扁的畸形声明受**面积**约束，而不是只夹长边。
        let flat = tiny_skia::Size::from_wh(1_000_000.0, 100.0).expect("构造尺寸失败");
        let (fw, fh) = resolve_size(flat, u32::MAX);
        assert!(
            u64::from(fw) * u64::from(fh) <= SVG_MAX_PIXELS,
            "极扁声明同样受面积上限约束，实际 {fw}×{fh}"
        );

        // 有界口径（缩略图）本来就在 max_dim 之内，上限不得把它改大或改小。
        let big = tiny_skia::Size::from_wh(50_000.0, 50_000.0).expect("构造尺寸失败");
        assert_eq!(resolve_size(big, 320), (320, 320));
    }
}
