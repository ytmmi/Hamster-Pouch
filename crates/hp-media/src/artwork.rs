//! 音频**封面**与**歌词**的旁挂取料（2026-11-13 / 音乐播放器面板）。
//!
//! ## 口径（用户裁决，别在这里自作主张改顺序）
//!
//! - 封面：**内嵌封面优先**（容器里的 attached picture）→ **同目录同名图片**兜底
//!   （`a.mp3` ↔ `a.jpg` / `a.png` / `a.webp` / `a.bmp`）→ 两者都没有就**不显示图**
//!   （面板画兜底晕染，不画"假封面"）。
//! - 歌词：**同目录同名 `.lrc`**（`a.mp3` ↔ `a.lrc`），没有就**不显示歌词**。
//!   本 crate **不解码**歌词：编码自动识别（UTF-8 / GBK / UTF-16）走
//!   `hp-book` 的 `decode_file_limited`，那边已经有成套的判定与截断口径，
//!   这里不引第二套（`encoding_rs` 也就不必进 hp-media 的依赖表）。
//!
//! ## 为什么封面要落盘
//!
//! 内嵌封面不是文件系统里的一个路径，要交给前端 `<img src>` 就必须先解出来写成图。
//! 解一次要起一个 ffmpeg 子进程（实测单曲 40–90 ms），所以按内容哈希缓存
//! （[`ThumbnailCache::path_for_audio_cover`]）；**"没有封面"这个结论也缓存**
//! （[`ThumbnailCache::path_for_audio_cover_missing`]），否则没有封面的歌每次打开
//! 播放器都要再起一次 ffmpeg 去证明同一件事。
//!
//! ## 落盘与并发
//!
//! 与 `waveform` / `thumbnail` 同一套：**先写同目录临时文件、成功后 `rename`**
//! （[`temp_sibling`] / [`commit`]）。同一首歌可能被子进程并发解两次（面板重开 +
//! 队列预取），直接写目标文件会交错出半张图；`rename` 同一卷内原子，后到者覆盖。

use std::path::{Path, PathBuf};
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout};
use crate::thumbnail::{commit, temp_sibling};

/// 内嵌封面解码后的**最大边长**（px，等比缩放，不放大）。
///
/// 640 是"卡片 + 唱片 + 全屏舞台"三处都能吃的尺度：样式一的封面卡最宽约 320，
/// 样式二的唱片直径约 220，高 DPI 下 2× 也够；再大只是白白多传几十上百 KB。
/// 内嵌封面原始尺寸常常是 1000–1500（专辑图常见 1400×1400），缩到 640 肉眼无差。
pub const AUDIO_COVER_MAX_DIM: u32 = 640;

/// 封面 JPEG 的质量档（ffmpeg `-q:v`，2 = 最好 / 31 = 最差）。
///
/// 取 3：实测 640×640 约 60–90 KB，与 2 的肉眼差异不可辨，体积少约 20%。
pub const AUDIO_COVER_QUALITY: u8 = 3;

/// 同名封面图的扩展名白名单，**按优先顺序**排列（列表靠前的先中）。
pub const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

/// 同名歌词文件的扩展名白名单。
pub const LYRICS_EXTS: &[&str] = &["lrc"];

/// 找出与 `audio_path` **同目录同名**、扩展名落在 `exts` 里的文件。
///
/// 比较是**大小写不敏感**的（`A.mp3` ↔ `a.JPG`）：Windows 上这两者本来就是同一个
/// 文件，但 Linux/macOS 上不是，而媒体库里混着两种命名是常态。同名判定只比
/// `file_stem`（最后一个点之前），因此 `01.曲名.mp3` ↔ `01.曲名.jpg` 也能配上。
///
/// `exts` 的顺序即优先级：`a.jpg` 与 `a.png` 同时存在时取 `jpg`（更常见的封面格式）。
pub fn find_sibling_with_exts(audio_path: &Path, exts: &[&str]) -> Option<PathBuf> {
    let parent = audio_path.parent()?;
    let stem = audio_path.file_stem()?.to_string_lossy().to_lowercase();
    let entries = std::fs::read_dir(parent).ok()?;
    let mut best: Option<(usize, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let candidate_stem = match path.file_stem() {
            Some(s) => s.to_string_lossy().to_lowercase(),
            None => continue,
        };
        if candidate_stem != stem {
            continue;
        }
        let ext = match path.extension() {
            Some(e) => e.to_string_lossy().to_lowercase(),
            None => continue,
        };
        let rank = match exts.iter().position(|known| *known == ext) {
            Some(r) => r,
            None => continue,
        };
        if best.as_ref().is_none_or(|(best_rank, _)| rank < *best_rank) {
            best = Some((rank, path));
        }
    }
    best.map(|(_, path)| path)
}

/// 同目录同名封面图（内嵌封面不可用时的兜底），见 [`find_sibling_with_exts`]。
pub fn find_sibling_cover(audio_path: &Path) -> Option<PathBuf> {
    find_sibling_with_exts(audio_path, COVER_EXTS)
}

/// 同目录同名歌词文件（`.lrc`）。没有就是"这首歌没有歌词"，面板不显示歌词区。
pub fn find_sibling_lyrics(audio_path: &Path) -> Option<PathBuf> {
    find_sibling_with_exts(audio_path, LYRICS_EXTS)
}

/// 把音频容器里的**内嵌封面**解成 JPEG 并原子落盘到 `output_jpg`。
///
/// - 返回值：`Ok(true)` = 解出了封面；`Ok(false)` = 这个容器**没有**内嵌封面
///   （没有 attached picture 流，或解出来的帧是空的）——这是常态，不是错误。
/// - `Err`：ffmpeg 缺失 / 超时 / 输入真的坏了。调用方据此降级为"没有封面"，
///   **不要**把它当致命错误，封面只是观感。
///
/// 只取第一条视频流的第一帧（`-map 0:v:0 -frames:v 1`）：attached picture 在容器里
/// 就是一个单帧视频流，这条映射对 mp3 / m4a / flac / ogg 都成立。
pub fn extract_embedded_cover(
    audio_path: &Path,
    output_jpg: &Path,
    max_dim: u32,
    quality: u8,
    ffmpeg_bin: &Path,
    timeout: Duration,
) -> HpResult<bool> {
    let temp = temp_sibling(output_jpg);
    let dim = max_dim.max(64);
    // `-2` 让高度按偶数取整（mjpeg 要求偶数边长）；`min(dim,iw)` 不放大原图。
    let scale = format!("scale='min({dim},iw)':-2");
    // `hidden_command`：GUI 父进程下不新建控制台窗口。
    let mut cmd = hidden_command(ffmpeg_bin);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(audio_path)
        .args([
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-vf",
        ])
        .arg(&scale)
        .args(["-c:v", "mjpeg", "-q:v"])
        .arg(quality.clamp(2, 31).to_string())
        // 显式指定 muxer：临时文件名是 `*.jpg.tmp`，没有扩展名可猜格式。
        .args(["-f", "image2"])
        .arg(&temp);

    let output = match run_with_timeout(&mut cmd, timeout) {
        Ok(o) => o,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        let _ = std::fs::remove_file(&temp);
        // "没有这条流"是正常结论，不当错误上报（否则日志里全是无封面的歌）。
        if stderr.contains("matches no streams") || stderr.contains("does not contain any stream") {
            return Ok(false);
        }
        return Err(HpError::Io(format!(
            "ffmpeg 解内嵌封面失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    // ffmpeg 偶尔会"成功"但没写出文件（例如封面帧解码失败）。
    let wrote = std::fs::metadata(&temp)
        .map(|m| m.len() > 0)
        .unwrap_or(false);
    if !wrote {
        let _ = std::fs::remove_file(&temp);
        return Ok(false);
    }
    commit(&temp, output_jpg)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 一个临时目录（用例结束即删），与 `waveform` 测试同款。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!("hp-artwork-{tag}-{}", nanos()));
            std::fs::create_dir_all(&base).expect("建临时目录失败");
            Self(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn nanos() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{n}")
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"x").expect("写测试文件失败");
    }

    /// 仓库内捆绑 ffmpeg 的定位（与 `waveform` 测试同款）。
    fn bundled_ffmpeg() -> Option<PathBuf> {
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

    #[test]
    fn sibling_cover_matches_stem_case_insensitively_and_ranks_exts() {
        let dir = TempDir::new("cover-sibling");
        let audio = dir.path().join("01.曲名.mp3");
        touch(&audio);
        assert!(
            find_sibling_cover(&audio).is_none(),
            "没有候选图时应当是 None"
        );

        // 同名但不同扩展名的无关文件不算封面。
        touch(&dir.path().join("01.曲名.txt"));
        assert!(find_sibling_cover(&audio).is_none());

        // 大小写不同的扩展名也认。
        touch(&dir.path().join("01.曲名.PNG"));
        assert_eq!(
            find_sibling_cover(&audio).unwrap(),
            dir.path().join("01.曲名.PNG")
        );

        // 同时存在时按 COVER_EXTS 的顺序取 jpg。
        touch(&dir.path().join("01.曲名.jpg"));
        assert_eq!(
            find_sibling_cover(&audio).unwrap(),
            dir.path().join("01.曲名.jpg")
        );

        // 前缀相同的别的歌不算（`01.曲名 (1).jpg` 的 stem 是 `01.曲名 (1)`）。
        touch(&dir.path().join("01.曲名 (1).jpg"));
        assert_eq!(
            find_sibling_cover(&audio).unwrap(),
            dir.path().join("01.曲名.jpg")
        );
    }

    #[test]
    fn sibling_lyrics_only_matches_lrc() {
        let dir = TempDir::new("lyrics-sibling");
        let audio = dir.path().join("track.flac");
        touch(&audio);
        assert!(find_sibling_lyrics(&audio).is_none());
        touch(&dir.path().join("track.JPG"));
        assert!(find_sibling_lyrics(&audio).is_none(), "图片不是歌词");
        touch(&dir.path().join("track.LRC"));
        assert_eq!(
            find_sibling_lyrics(&audio).unwrap(),
            dir.path().join("track.LRC"),
            "扩展名大小写不敏感"
        );
    }

    /// 内嵌封面：有 → 解出 JPEG；没有 → `Ok(false)` 且不留临时文件。
    #[test]
    fn embedded_cover_is_extracted_and_absent_is_not_an_error() {
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到捆绑 ffmpeg");
            return;
        };
        let dir = TempDir::new("embedded");
        // 造一张 300×200 的纯色图，再把它作为 attached picture 混进 m4a。
        let png = dir.path().join("pic.png");
        let status = hidden_command(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=300x200:d=1",
                "-frames:v",
                "1",
            ])
            .arg(&png)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成测试图失败");

        let with_cover = dir.path().join("with.m4a");
        let status = hidden_command(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-i",
            ])
            .arg(&png)
            .args([
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-c:a",
                "aac",
                "-c:v",
                "mjpeg",
                "-disposition:v",
                "attached_pic",
                "-frames:v",
                "1",
            ])
            .arg(&with_cover)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成带封面测试音频失败");

        let out = dir.path().join("cover.jpg");
        let got = extract_embedded_cover(
            &with_cover,
            &out,
            AUDIO_COVER_MAX_DIM,
            AUDIO_COVER_QUALITY,
            &ffmpeg,
            Duration::from_secs(30),
        )
        .expect("解封面不应报错");
        assert!(got, "这条音频应当有内嵌封面");
        let meta = std::fs::metadata(&out).expect("封面应当落盘");
        assert!(meta.len() > 0, "封面不应是空文件");

        // 无封面的音频：`Ok(false)`，且不留下临时文件。
        let bare = dir.path().join("bare.m4a");
        let status = hidden_command(&ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:a",
                "aac",
            ])
            .arg(&bare)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成无封面测试音频失败");
        let out2 = dir.path().join("none.jpg");
        let got = extract_embedded_cover(
            &bare,
            &out2,
            AUDIO_COVER_MAX_DIM,
            AUDIO_COVER_QUALITY,
            &ffmpeg,
            Duration::from_secs(30),
        )
        .expect("没有封面不是错误");
        assert!(!got, "这条音频没有内嵌封面");
        assert!(!out2.exists(), "失败路径不应留下目标文件");
        assert!(
            !dir.path().join("none.jpg.tmp").exists(),
            "失败路径不应留下临时文件"
        );
    }
}
