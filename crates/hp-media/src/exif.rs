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
    let file = std::fs::File::open(path).map_err(|e| HpError::Io(format!("打开图片失败: {e}")))?;
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

    // 拍摄参数（2026-11-08 / D145）：光圈 / 快门 / ISO / 焦距。
    // 数值口径：光圈与焦距是 RATIONAL，**取 num/denom 算成 f64**——`display_value()` 对
    // RATIONAL 走 `d_decimal`，输出的是 `"28/10"` 这种分数串而非小数，直接拿去显示会是
    // `f/28/10`。快门用 `display_value()`（`d_exptime` 已把 `<1s` 渲染成 `1/200`、`≥1s`
    // 渲染成小数秒，正是人话）；ISO 是 SHORT，取整数。缺哪项哪项为 null（前端"有就显示"）。
    let rational = |tag: Tag| {
        exif.get_field(tag, In::PRIMARY)
            .and_then(|f| match &f.value {
                exif::Value::Rational(v) => v.first().filter(|r| r.denom != 0).map(|r| r.to_f64()),
                _ => None,
            })
    };
    let f_number = rational(Tag::FNumber);
    let focal_length = rational(Tag::FocalLength);
    let exposure_time = text(Tag::ExposureTime);
    // ISO 标准标签是 PhotographicSensitivity（0x8827）；老相机可能只写 ISOSpeed（0x8833），兜底取它。
    let iso = uint(Tag::PhotographicSensitivity).or_else(|| uint(Tag::ISOSpeed));

    let raw = serde_json::json!({
        "make": make,
        "model": model,
        "dateTime": date_time,
        "orientation": orientation,
        "width": width,
        "height": height,
        "exposureTime": exposure_time,
        "fNumber": f_number,
        "iso": iso,
        "focalLength": focal_length,
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

/// **只取方向**（`Tag::Orientation`）的轻量读取。
///
/// 与 [`extract_exif`] 的区别：不构造 `raw_json`、不读任何其它 tag。索引期每张图片
/// 都要问一次方向（缺陷 0043 的显示尺寸口径），完整摘要那套序列化在这里是纯浪费。
/// 无 EXIF、打不开、或没有该 tag 一律返回 `None`（方向未知 = 不交换宽高）。
pub fn orientation_of(path: &Path) -> Option<u32> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = Reader::new().read_from_container(&mut reader).ok()?;
    exif.get_field(Tag::Orientation, In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
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
            "exposureTime": null,
            "fNumber": null,
            "iso": null,
            "focalLength": null,
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

    /// 用 `experimental::Writer` 造一份带拍摄参数的真实 TIFF-EXIF（`read_from_container`
    /// 认 TIFF 头），钉住"光圈/焦距取 num/denom 算 f64、快门取 display 人话、ISO 取整数"。
    fn write_exif_fixture(path: &std::path::Path, fields: &[exif::Field]) {
        use std::io::Cursor;
        let mut writer = exif::experimental::Writer::new();
        for f in fields {
            writer.push_field(f);
        }
        let mut buf = Cursor::new(Vec::new());
        writer.write(&mut buf, false).expect("写入 EXIF 失败");
        std::fs::write(path, buf.into_inner()).expect("落盘 EXIF 夹具失败");
    }

    fn field(tag: Tag, value: exif::Value) -> exif::Field {
        exif::Field {
            tag,
            ifd_num: In::PRIMARY,
            value,
        }
    }

    #[test]
    fn shooting_params_extracted_from_exif() {
        let dir = std::env::temp_dir().join(format!("hp-exif-shoot-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("shot.tiff");
        // 光圈 28/10 = 2.8、焦距 50/1 = 50、快门 1/200、ISO 400。
        write_exif_fixture(
            &path,
            &[
                field(Tag::Make, exif::Value::Ascii(vec![b"Canon".to_vec()])),
                field(
                    Tag::FNumber,
                    exif::Value::Rational(vec![(28u32, 10u32).into()]),
                ),
                field(
                    Tag::FocalLength,
                    exif::Value::Rational(vec![(50u32, 1u32).into()]),
                ),
                field(
                    Tag::ExposureTime,
                    exif::Value::Rational(vec![(1u32, 200u32).into()]),
                ),
                field(Tag::PhotographicSensitivity, exif::Value::Short(vec![400])),
            ],
        );

        let exif = extract_exif(&path).expect("提取 EXIF 失败");
        let v: serde_json::Value =
            serde_json::from_str(&exif.raw_json).expect("raw_json 应是合法 JSON");
        // `display_value()` 对 ASCII 会带引号（`"Canon"`），这是既有口径，断言含 Canon 即可。
        assert!(v["make"].as_str().unwrap().contains("Canon"));
        assert_eq!(v["fNumber"].as_f64(), Some(2.8));
        assert_eq!(v["focalLength"].as_f64(), Some(50.0));
        assert_eq!(v["exposureTime"], "1/200");
        assert_eq!(v["iso"].as_u64(), Some(400));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn shooting_params_absent_are_null() {
        let dir = std::env::temp_dir().join(format!("hp-exif-noshoot-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let path = dir.join("noshoot.tiff");
        // 只有 Make，没有任何拍摄参数 → 四项必须全是 null（前端据此"无就不显示"）。
        write_exif_fixture(
            &path,
            &[field(
                Tag::Make,
                exif::Value::Ascii(vec![b"Nikon".to_vec()]),
            )],
        );

        let exif = extract_exif(&path).expect("提取 EXIF 失败");
        let v: serde_json::Value =
            serde_json::from_str(&exif.raw_json).expect("raw_json 应是合法 JSON");
        assert!(v["exposureTime"].is_null());
        assert!(v["fNumber"].is_null());
        assert!(v["iso"].is_null());
        assert!(v["focalLength"].is_null());

        let _ = std::fs::remove_dir_all(&dir);
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
