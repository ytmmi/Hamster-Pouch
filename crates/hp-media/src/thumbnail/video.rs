//! 视频首帧抽帧（D16）与跳过片头黑屏（D143）。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use super::atomic::{commit, temp_sibling};
use crate::process::{hidden_command, run_with_timeout};

/// 抽帧过滤器：宽度不超过 512、高度按比例，小图不放大。
const SCALE_FILTER: &str = "scale='min(512,iw)':-2";

/// 跳过前置黑屏的抽帧过滤器（D143）：`blackframe` 逐帧算"黑像素占比"写进 metadata，
/// `metadata` 过滤器把占比 ≥ `value` 的帧丢掉，`-frames:v 1` 便取到窗口内第一个非黑帧。
///
/// `amount=0` **不是笔误**——`blackframe` 只在 `pblack >= amount` 时才写那条 metadata，
/// 缺省 98 会让非黑帧上没有该键，`metadata=select` 反而丢掉**每一帧**（那一遍会以非零
/// 码退出且**不建输出文件**，见模块文档）。`threshold=32` 是 `blackframe` 判定"黑"的
/// 亮度上限（0–255），`value=98` 是选择侧要求的黑像素占比下限：这个组合下
/// `testsrc` 这类带暗区的正常画面（实测占比 12）不会被误判，只有真正压满黑帧的
/// 片头才会被跳。
const BLACK_SKIP_FILTER: &str = "blackframe=amount=0:threshold=32,\
metadata=mode=select:key=lavfi.blackframe.pblack:value=98:function=less,\
scale='min(512,iw)':-2";

/// 跳过片头黑屏时**最多向前解码**的时长（D143）。
///
/// 这是上界而不是目标：黑开场短于它就直接给出黑屏之后的画面，长于它（含全黑视频）则
/// 退回首帧。取值受扫描路径的超时预算约束——源扫描给单次抽帧的超时是 20 s
/// （`SCAN_MEDIA_TIMEOUT`），而 1080p30 下 5 s 的黑屏搜索实测只花约 0.2 s。
pub const VIDEO_BLACK_SKIP_WINDOW: Duration = Duration::from_secs(5);

/// 抽取视频首帧并写入 `output_jpg`；失败返回 `HpError::Io`（调用方可用占位图降级）。
///
/// 默认就是首帧；只有片头是黑屏时才向后跳（见 [`VIDEO_BLACK_SKIP_WINDOW`]）。
pub fn extract_thumbnail(
    video_path: &Path,
    output_jpg: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<()> {
    // 先写到临时文件，成功后原子改名（见模块文档）。
    let temp = temp_sibling(output_jpg);
    // 第一遍：窗口内跳过片头黑帧（D143）。
    let first = extract_frame(
        video_path,
        &temp,
        ffmpeg_bin,
        timeout,
        Some(VIDEO_BLACK_SKIP_WINDOW),
    )?;
    if let Frame::Empty { .. } = first {
        // 窗口内一帧都没留下 = 片头（或整段）都是黑的：退回"首帧"这条既有口径，
        // 保证任何输入都仍然有缩略图（见模块文档"跳过片头黑屏"）。真的解不开的视频
        // 也会走到这里——它会在第二遍以同样的方式失败，错误照样浮上来。
        let _ = std::fs::remove_file(&temp);
        if let Frame::Empty { stderr } =
            extract_frame(video_path, &temp, ffmpeg_bin, timeout, None)?
        {
            let _ = std::fs::remove_file(&temp);
            return Err(HpError::Io(format!("ffmpeg 抽帧失败: {stderr}")));
        }
    }
    commit(&temp, output_jpg)
}

/// 一次抽帧的结果。
enum Frame {
    /// 已经写出 `temp`。
    Written,
    /// **一帧都没选中**（片头全是黑帧，或整段解不开）：ffmpeg 不建输出文件。
    /// `stderr` 留给调用方——回退那遍也拿不到帧时，用它报出可读的失败原因。
    Empty { stderr: String },
}

/// 抽一帧写到 `temp`；`skip_black` 为 `Some(window)` 时先在 `window` 内跳过黑帧。
///
/// `Err` 只留给"ffmpeg 根本起不来 / 超时 / 写了文件却非零退出"；"一帧都没选中"是
/// [`Frame::Empty`]，不是失败（见 [`BLACK_SKIP_FILTER`] 与模块文档）。
fn extract_frame(
    video_path: &Path,
    temp: &Path,
    ffmpeg_bin: &Path,
    timeout: Duration,
    skip_black: Option<Duration>,
) -> HpResult<Frame> {
    // `hidden_command`：GUI 父进程下不新建控制台窗口（源扫描抽帧）。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y"]);
    if let Some(window) = skip_black {
        // `-t` 放在 `-i` **之前**：这是输入侧限长，黑屏搜索最多向前解码 `window`。
        cmd.arg("-t").arg(window.as_secs_f64().to_string());
        // `blackframe` 会**逐帧**打 INFO 日志（5 s 窗口就是上百行），而抽帧的 stderr
        // 只有失败时才有用：压到 warning 档，错误与告警一行不少（实测 82 行 → 11 行）。
        cmd.args(["-loglevel", "warning"]);
    }
    let filter = match skip_black {
        Some(_) => BLACK_SKIP_FILTER,
        None => SCALE_FILTER,
    };
    cmd.args(["-i"])
        .arg(video_path)
        .args(["-frames:v", "1", "-vf", filter, "-q:v", "3"])
        .arg(temp);

    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(temp);
            return Err(e);
        }
    };
    // **判据是"有没有产物"，不是退出码**：整段被过滤掉时 ffmpeg 以非零码退出
    // （实测 -22 / `Conversion failed!`）**且不建输出文件**——既不是成功，也不该
    // 当成硬失败，交给调用方回退。
    if !temp.exists() {
        return Ok(Frame::Empty {
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    if !output.status.success() {
        let _ = std::fs::remove_file(temp);
        return Err(HpError::Io(format!(
            "ffmpeg 抽帧失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(Frame::Written)
}
