//! 图片 EXIF 元数据提取（M4）。
//!
//! 无 EXIF 的图片（PNG 等）返回空摘要而非报错；文件无法打开才返回 `HpError::Io`。

use std::path::Path;

use exif::{In, Reader, Tag};
use hp_core::{HpError, HpResult};

/// 图片 EXIF 摘要。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ImageExif {
    pub make: Option<String>,
    pub model: Option<String>,
    pub date_time: Option<String>,
    pub orientation: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 完整 EXIF 摘要 JSON（供元数据面板展示）。
    pub raw_json: String,
}

/// 提取图片 EXIF；无 EXIF 时返回空摘要（降级，不报错）。
pub fn extract_exif(path: &Path) -> HpResult<ImageExif> {
    let file =
        std::fs::File::open(path).map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?;
    let mut reader = std::io::BufReader::new(file);
    let exif = match Reader::new().read_from_container(&mut reader) {
        Ok(exif) => exif,
        // 无 EXIF（PNG 等）或格式不支持：降级为空摘要（仍返回有效 JSON）。
        Err(_) => return Ok(empty_summary()),
    };

    let text = |tag: Tag| {
        exif.get_field(tag, In::PRIMARY)
            .map(|f| f.display_value().to_string())
            .filter(|s| !s.is_empty())
    };
    let uint = |tag: Tag| {
        exif.get_field(tag, In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
    };

    let make = text(Tag::Make);
    let model = text(Tag::Model);
    let date_time = text(Tag::DateTime);
    let orientation = uint(Tag::Orientation);
    let width = uint(Tag::PixelXDimension);
    let height = uint(Tag::PixelYDimension);

    let raw = serde_json::json!({
        "make": make,
        "model": model,
        "dateTime": date_time,
        "orientation": orientation,
        "width": width,
        "height": height,
    });

    Ok(ImageExif {
        make,
        model,
        date_time,
        orientation,
        width,
        height,
        raw_json: raw.to_string(),
    })
}

/// 无 EXIF 时的空摘要（仍产出有效 JSON，便于前端统一处理）。
fn empty_summary() -> ImageExif {
    ImageExif {
        raw_json: serde_json::json!({
            "make": null,
            "model": null,
            "dateTime": null,
            "orientation": null,
            "width": null,
            "height": null,
        })
        .to_string(),
        ..ImageExif::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_without_exif_returns_empty_summary() {
        let dir = std::env::temp_dir().join(format!("hp-exif-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("plain.png");
        let img = image::RgbImage::from_pixel(4, 4, image::Rgb([10, 20, 30]));
        img.save(&path).expect("写入测试图片失败");

        let exif = extract_exif(&path).expect("提取 EXIF 失败");
        assert!(exif.make.is_none());
        assert!(exif.raw_json.contains("make"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_returns_io_error() {
        let path = std::env::temp_dir().join("hp-exif-not-exist.png");
        let err = extract_exif(&path).expect_err("不存在的文件应报错");
        assert!(matches!(err, HpError::Io(_)));
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos}")
    }
}
