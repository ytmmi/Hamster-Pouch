//! 图片调色板提取（D18，仅图片）。
//!
//! 浏览时按需提取并缓存；算法与色板数量属于实现期开放点，
//! 这里采用“缩放到小图 + 4 位量化 + 频率排序”的稳定实现。

use std::collections::HashMap;
use std::path::Path;

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

/// 提取图片主色调；`max_colors` 为 0 时使用 [`DEFAULT_PALETTE_SIZE`]。
pub fn extract_palette(path: &Path, max_colors: usize) -> HpResult<Palette> {
    let max_colors = if max_colors == 0 {
        DEFAULT_PALETTE_SIZE
    } else {
        max_colors
    };

    let img =
        image::open(path).map_err(|e| HpError::Io(format!("读取图片失败: {e}")))?;
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

    Ok(Palette { colors })
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

        let palette = extract_palette(&path, 3).expect("提取调色板失败");
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

        let palette = extract_palette(&path, 1).expect("提取调色板失败");
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
        assert!(palette_is_locked(r#"{"version":2,"colors":[],"locked":true}"#));
        assert!(!palette_is_locked(r#"{"version":2,"colors":[],"locked":false}"#));
        // 缺字段 / 坏 JSON / 类型不对：一律按"未锁定"处理（重扫不该被坏数据卡住）。
        assert!(!palette_is_locked(r#"{"version":2,"colors":[]}"#));
        assert!(!palette_is_locked("not json"));
        assert!(!palette_is_locked(r#"{"locked":"true"}"#));
        assert!(!palette_is_locked(""));
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
