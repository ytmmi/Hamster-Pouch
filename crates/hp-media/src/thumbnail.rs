//! ffmpeg 首帧抽帧（D16）：扫描时同步生成视频首帧缩略图。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::run_with_timeout;

/// 抽帧过滤器：宽度不超过 512、高度按比例，小图不放大。
const SCALE_FILTER: &str = "scale='min(512,iw)':-2";

/// 抽取视频首帧并写入 `output_jpg`；失败返回 `HpError::Io`（调用方可用占位图降级）。
pub fn extract_thumbnail(
    video_path: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    let mut cmd = Command::new(ffmpeg_bin);
    cmd.args(["-y", "-i"])
        .arg(video_path)
        .args(["-frames:v", "1", "-vf", SCALE_FILTER, "-q:v", "3"])
        .arg(output_jpg);

    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}
