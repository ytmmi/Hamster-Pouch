//! ffprobe 元数据探测（D15）：全量媒体信息，缓存进文件索引。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// 解析 "num/den" 比率字符串为 f64。
fn parse_ratio(s: &str) -> Option<f64> {
    let mut parts = s.split('/');
    let num = parts.next()?.parse::<f64>().ok()?;
    let den = parts.next().unwrap_or("1").parse::<f64>().ok()?;
    if den == 0.0 {
        None
    } else {
        Some(num / den)
    }
}

/// 视频全量媒体信息（时长/分辨率/编码/帧率/码率）。
///
/// `raw_json` 保存 ffprobe 完整输出，供 `files.media_info_json` 缓存（D15）。
#[derive(Debug, Clone, PartialEq)]
pub struct MediaProbe {
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub format_name: Option<String>,
    pub codec_name: Option<String>,
    pub frame_rate: Option<f64>,
    pub bit_rate: Option<i64>,
    pub raw_json: String,
}

/// 探测视频元数据；失败返回 `HpError::Io`（错误降级由调用方决定）。
pub fn probe(video_path: &Path, ffprobe_bin: &Path, timeout: Duration) -> HpResult<MediaProbe> {
    let mut cmd = Command::new(ffprobe_bin);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(video_path);

    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffprobe 探测失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let raw_json = String::from_utf8_lossy(&output.stdout).to_string();
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| HpError::Io(format!("解析 ffprobe JSON 失败: {e}")))?;

    let duration_ms = value
        .pointer("/format/duration")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|secs| (secs * 1000.0) as i64);

    let format_name = value
        .pointer("/format/format_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let bit_rate = value
        .pointer("/format/bit_rate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok());

    let streams = value.get("streams").and_then(|s| s.as_array());
    let video = streams.and_then(|arr| {
        arr.iter()
            .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"))
    });

    let width = video.and_then(|v| v.get("width")).and_then(|w| w.as_i64());
    let height = video.and_then(|v| v.get("height")).and_then(|w| w.as_i64());
    let codec_name = video
        .and_then(|v| v.get("codec_name"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    let frame_rate = video
        .and_then(|v| {
            v.get("avg_frame_rate")
                .or_else(|| v.get("r_frame_rate"))
        })
        .and_then(|r| r.as_str())
        .and_then(parse_ratio);

    Ok(MediaProbe {
        duration_ms,
        width,
        height,
        format_name,
        codec_name,
        frame_rate,
        bit_rate,
        raw_json,
    })
}
