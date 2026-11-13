//! 图片调色板提取（D18，仅图片）。
//!
//! 浏览时按需提取并缓存；算法与色板数量属于实现期开放点，
//! 这里采用“缩放到小图 + 4 位量化 + 频率排序”的稳定实现。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

/// 默认提取色板数量（**8 色**，用户 2026-09-29 指定；此前为 6）。
///
/// 改这个数、或改量化/排序算法，**必须同时递增 [`PALETTE_FORMAT_VERSION`]**：
/// 前端按版本号判断缓存是否过期，否则已缓存过的图片会永远显示旧结果
/// （色彩参考面板里没有手动重提按钮，缓存自愈是唯一路径）。
pub const DEFAULT_PALETTE_SIZE: usize = 8;

/// 调色板缓存（`color_refs.color_json`）的**格式版本**。
///
/// 前端 `apps/desktop/src/app_ui/shared/paletteJson.ts` 的 `PALETTE_FORMAT_VERSION`
/// 必须与此相等（`pnpm check:panels` 断言）；版本不匹配的缓存按「未提取」处理并自动重算。
/// 版本历史：1（隐式，无 `version` 字段，色板 6 色）→ 2（色板 8 色 + 显式 `version`）。
pub const PALETTE_FORMAT_VERSION: u32 = 2;

/// 调色板提取结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    /// 十六进制颜色列表（`#rrggbb`），按出现频率降序。
    pub colors: Vec<String>,
}

/// 调色板缓存的 JSON 形态（`color_refs.color_json` 的**自动**结果）。
///
/// **只有这一处拼这个串**：写入方是"全面分析"（源扫描 / `file.reanalyze`）与按需提取命令
/// （`color.extract`）；前端的 `shared/paletteJson.ts` 是同一口径的读取方
/// （`version` + `colors` + `locked`）。少写一个字段，前端就会把这条缓存当"未提取"并反复重算
/// —— `PALETTE_FORMAT_VERSION` 的相等由 `pnpm check:panels` 断言，字段形状由 Rust 单测断言。
pub fn encode_palette_json(colors: &[String]) -> String {
    serde_json::json!({
        "version": PALETTE_FORMAT_VERSION,
        "colors": colors,
        "locked": false,
    })
    .to_string()
}

/// 缓存是否被**手动锁定**（`locked: true`）。
///
/// 解析不出时返回 `false`（按未锁定处理）：坏数据不该让"重新分析"整批失败，
/// 前端 `parsePaletteJson` 对坏值也按"未提取"处理——两边都不猜。
/// 用途是**写入前的一道闸**：手动锁定的色值是用户的判定权，重扫不得覆盖它。
pub fn palette_is_locked(color_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(color_json)
        .ok()
        .and_then(|value| value.get("locked").and_then(|locked| locked.as_bool()))
        .unwrap_or(false)
}

/// 调色板解码的**有界尺寸**（仅 ffmpeg 兜底路径用）：调色板只需 64×64 重采样，
/// 有界解码到长边 256 后重采样，避免为一张 9000² 的 AVIF/HEIC 做全分辨率解码 +
/// Triangle 重采样（`docs/issues/0018` 实测重采样是主要成本）。按文件确定性，
/// 同一文件每次扫描结果一致。
const FFMPEG_DECODE_BOUND: u32 = 256;

/// 提取图片主色调；`max_colors` 为 0 时使用 [`DEFAULT_PALETTE_SIZE`]。
///
/// 这是"自带解码"的入口；**扫描路径不该用它**——那里已经为感知哈希解码过一次，
/// 应当复用同一张已解码图像走 [`extract_palette_from_image`]（大图重采样是主要成本，
/// 见 `docs/issues/0018`）。解码统一走 [`crate::decode::decode_image_fallback`]：
/// AVIF/HEIC 家族与**进程内无解码器**的格式（JPEG 2000 / JPEG XL / PSD / PCX…，
/// 2026-10-11 / D111）经捆绑 ffmpeg 有界解码；既有格式的输出与旧实现逐位相同。
pub fn extract_palette(
    path: &Path,
    max_colors: usize,
    ffmpeg_bin: Option<&Path>,
    timeout: Duration,
) -> HpResult<Palette> {
    let img = crate::decode::decode_image_fallback(path, ffmpeg_bin, FFMPEG_DECODE_BOUND, timeout)
        .map_err(|e| HpError::Io(format!("读取图片失败: {e}")))?;
    Ok(extract_palette_from_image(&img, max_colors))
}

/// 从**已解码**图像提取主色调；`max_colors` 为 0 时使用 [`DEFAULT_PALETTE_SIZE`]。
///
/// 与 [`extract_palette`] 是**同一份算法**（后者只是先 `image::open` 再委托到这里），
/// 因此两条路径的结果**逐位相同**——这不是"近似等价"，是同一段代码。
/// 存在的唯一理由是让调用方（扫描器）把解码复用给感知哈希，避免同一张图解码两次。
pub fn extract_palette_from_image(img: &image::DynamicImage, max_colors: usize) -> Palette {
    let max_colors = if max_colors == 0 {
        DEFAULT_PALETTE_SIZE
    } else {
        max_colors
    };

    let small = img.resize_exact(64, 64, image::imageops::FilterType::Triangle);
    let rgb = small.to_rgb8();

    let mut counts: HashMap<u32, u32> = HashMap::new();
    for px in rgb.pixels() {
        let r = (px[0] >> 4) as u32;
        let g = (px[1] >> 4) as u32;
        let b = (px[2] >> 4) as u32;
        let key = (r << 8) | (g << 4) | b;
        *counts.entry(key).or_insert(0) += 1;
    }

    let mut buckets: Vec<(u32, u32)> = counts.into_iter().collect();
    buckets.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    let colors = buckets
        .into_iter()
        .take(max_colors)
        .map(|(key, _)| {
            let r = ((key >> 8) & 0xF) * 17;
            let g = ((key >> 4) & 0xF) * 17;
            let b = (key & 0xF) * 17;
            format!("#{r:02x}{g:02x}{b:02x}")
        })
        .collect();

    Palette { colors }
}

/// 音乐播放器色晕用的**主导色**：按面积取前 `count` 个色块，并且互不近似。
///
/// 与 [`extract_palette_from_image`] 的区别是**目的不同**，不是精度不同：
/// - 调色板（色彩参考面板）要"这张图有哪些颜色"，所以按频率给出 8 个桶；
/// - 色晕要"这块背景该是什么氛围"，所以只取**面积最大**的几个色块，并且必须
///   互不相似（同一张图上三个 `#eeeeee` 级别的近白会合成一团灰，用户看到的就是
///   "两团模糊的圆"而不是层次）。
///
/// 近无彩像素（饱和度 < 0.12）只在**彩色像素不足**时才参与：白底插画的主色常常是
/// 白纸本身，直接选它会让整块背景失去封面氛围（这正是一开始"洗白"的原因）。
pub fn dominant_colors_from_image(img: &image::DynamicImage, count: usize) -> Vec<String> {
    const BUCKET_SHIFT: u8 = 3; // 5 位/通道：9216 个采样点里够细，又不会被噪声劈碎
    const MIN_DISTANCE: f32 = 46.0; // 两个色块在 RGB 空间的最小距离
    const MIN_SATURATION: f32 = 0.12;

    let small = img.resize_exact(96, 96, image::imageops::FilterType::Triangle);
    let rgb = small.to_rgb8();

    let mut buckets: HashMap<u32, (u32, [f32; 3])> = HashMap::new();
    for px in rgb.pixels() {
        let r = px[0];
        let g = px[1];
        let b = px[2];
        let key = ((r >> BUCKET_SHIFT) as u32) << 16
            | ((g >> BUCKET_SHIFT) as u32) << 8
            | (b >> BUCKET_SHIFT) as u32;
        let entry = buckets.entry(key).or_insert((0, [0.0, 0.0, 0.0]));
        entry.0 += 1;
        entry.1[0] += f32::from(r);
        entry.1[1] += f32::from(g);
        entry.1[2] += f32::from(b);
    }

    struct Candidate {
        weight: u32,
        rgb: [f32; 3],
        saturation: f32,
    }

    let candidates: Vec<Candidate> = buckets
        .into_values()
        .map(|(weight, sum)| {
            let n = weight as f32;
            let rgb = [sum[0] / n, sum[1] / n, sum[2] / n];
            Candidate {
                weight,
                rgb,
                saturation: saturation_of(rgb),
            }
        })
        .collect();

    let total: u32 = candidates.iter().map(|c| c.weight).sum();
    let chromatic: u32 = candidates
        .iter()
        .filter(|c| c.saturation >= MIN_SATURATION)
        .map(|c| c.weight)
        .sum();
    // 彩色像素占比够高就只从它们里选（避免白纸/黑边吃掉一个名额）。
    let prefer_chromatic = total > 0 && chromatic * 5 >= total;

    let mut ordered: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| !prefer_chromatic || c.saturation >= MIN_SATURATION)
        .collect();
    // 面积优先；同面积时饱和度高的优先（同样的"块"，有颜色的那块更有信息量）。
    ordered.sort_by(|a, b| {
        b.weight
            .cmp(&a.weight)
            .then(b.saturation.total_cmp(&a.saturation))
    });

    let mut picked: Vec<[f32; 3]> = Vec::new();
    for candidate in ordered {
        if picked.len() >= count {
            break;
        }
        let distinct = picked.iter().all(|existing| {
            let dr = existing[0] - candidate.rgb[0];
            let dg = existing[1] - candidate.rgb[1];
            let db = existing[2] - candidate.rgb[2];
            (dr * dr + dg * dg + db * db).sqrt() >= MIN_DISTANCE
        });
        if distinct {
            picked.push(candidate.rgb);
        }
    }

    picked.iter().map(|rgb| hex_of(*rgb)).collect()
}

/// HSV 里的饱和度（0–1）；色晕只关心"有没有颜色"，不看明度。
fn saturation_of(rgb: [f32; 3]) -> f32 {
    let max = rgb[0].max(rgb[1]).max(rgb[2]);
    let min = rgb[0].min(rgb[1]).min(rgb[2]);
    if max <= 0.0 {
        return 0.0;
    }
    (max - min) / max
}

fn hex_of(rgb: [f32; 3]) -> String {
    let channel = |value: f32| value.round().clamp(0.0, 255.0) as u8;
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(rgb[0]),
        channel(rgb[1]),
        channel(rgb[2])
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_solid(path: &Path, color: [u8; 3]) {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb(color));
        img.save(path).expect("写入测试图片失败");
    }

    #[test]
    fn solid_color_palette_is_stable() {
        let dir = std::env::temp_dir().join(format!("hp-palette-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("red.png");
        write_solid(&path, [255, 0, 0]);

        let palette =
            extract_palette(&path, 3, None, Duration::from_secs(30)).expect("提取调色板失败");
        assert!(!palette.colors.is_empty());
        assert_eq!(palette.colors[0], "#ff0000");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn palette_respects_max_colors() {
        let dir = std::env::temp_dir().join(format!("hp-palette-max-{}", nanos()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("blue.png");
        write_solid(&path, [0, 0, 255]);

        let palette =
            extract_palette(&path, 1, None, Duration::from_secs(30)).expect("提取调色板失败");
        assert_eq!(palette.colors.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缓存 JSON 的形状是**跨端契约**（前端 `parsePaletteJson` 按这三个字段读）：
    /// `version` 必须在里面，否则前端会把每条自动缓存当作"未提取"反复重算。
    #[test]
    fn palette_json_carries_version_and_is_not_locked() {
        let json = encode_palette_json(&["#ff0000".to_string(), "#00ff00".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("缓存 JSON 解析失败");
        assert_eq!(value["version"], PALETTE_FORMAT_VERSION);
        assert_eq!(value["locked"], false);
        assert_eq!(value["colors"][0], "#ff0000");
        assert!(!palette_is_locked(&json));
    }

    #[test]
    fn palette_is_locked_reads_the_flag_and_tolerates_bad_json() {
        assert!(palette_is_locked(
            r#"{"version":2,"colors":[],"locked":true}"#
        ));
        assert!(!palette_is_locked(
            r#"{"version":2,"colors":[],"locked":false}"#
        ));
        // 缺字段 / 坏 JSON / 类型不对：一律按"未锁定"处理（重扫不该被坏数据卡住）。
        assert!(!palette_is_locked(r#"{"version":2,"colors":[]}"#));
        assert!(!palette_is_locked("not json"));
        assert!(!palette_is_locked(r#"{"locked":"true"}"#));
        assert!(!palette_is_locked(""));
    }

    #[test]
    fn dominant_colors_take_largest_blocks_and_skip_near_duplicates() {
        // 三块面积递减的纯色 + 一块近白底：期望按面积给出三块**互不相同**的色。
        let mut img = image::RgbImage::from_pixel(96, 96, image::Rgb([250, 250, 250]));
        for y in 0..96 {
            for x in 0..96 {
                let color = if x < 48 && y < 60 {
                    [200, 40, 40] // 面积 48×60 = 2880
                } else if x >= 48 && y < 40 {
                    [40, 160, 60] // 面积 48×40 = 1920
                } else if y >= 60 && x < 30 {
                    [40, 60, 200] // 面积 30×36 = 1080
                } else {
                    [250, 250, 250]
                };
                img.put_pixel(x, y, image::Rgb(color));
            }
        }
        let colors = dominant_colors_from_image(&image::DynamicImage::ImageRgb8(img), 3);
        assert_eq!(colors.len(), 3, "应取到三个主导色: {colors:?}");
        assert!(
            colors.iter().all(|c| c != "#fafafa"),
            "近白底不该挤进主导色: {colors:?}"
        );
        for (i, a) in colors.iter().enumerate() {
            for b in colors.iter().skip(i + 1) {
                assert_ne!(a, b, "主导色必须互不相同: {colors:?}");
            }
        }
    }

    #[test]
    fn dominant_colors_respect_count() {
        let img = image::RgbImage::from_pixel(32, 32, image::Rgb([10, 120, 200]));
        let colors = dominant_colors_from_image(&image::DynamicImage::ImageRgb8(img), 3);
        assert_eq!(colors.len(), 1, "纯色图只该有一个主导色: {colors:?}");
        assert_eq!(colors[0], "#0a78c8");
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
