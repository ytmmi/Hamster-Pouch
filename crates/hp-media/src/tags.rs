//! 音频**标签**（曲名 / 艺术家）：给音乐播放器的标题行与"占位封面"取真名
//! （2026-11-13 / D167）。
//!
//! ## 为什么读标签，而不是继续从文件名猜
//!
//! 面板此前用文件名切分：`艺人 - 曲名.mp3` 取 `" - "` 左右两侧。但主流下载源的命名
//! 并不统一（B 站导出是 `曲名 - 艺人`，同人专辑是 `01. 曲名`），同一条规则必然把
//! 某一类文件读反——用户看到的就是"占位封面上写着艺人名"。
//!
//! 标签是**文件自己声明的**，没有歧义；文件名只在标签缺失时兜底。
//!
//! ## 为什么用 ffprobe（而不是自己解 ID3/FLAC/Vorbis）
//!
//! 捆绑的 `external-cli/ffmpeg` 里就有 `ffprobe`（同目录、同一次分发），它一个
//! 子进程就能读 ID3v2 / FLAC Vorbis comment / MP4 atoms / Vorbis / APE 的
//! `format_tags`，且与已经用于封面、波形、探测的进程口径一致（都走
//! [`crate::process::hidden_command`]，不会弹控制台窗口）。
//!
//! **失败即"没有标签"**：读不出来（无 ffprobe、超时、容器损坏）都退化成 `None`，
//! 由调用方回退到文件名切分——这不是错误态。

use std::path::Path;
use std::time::Duration;

use hp_core::{HpError, HpResult};

use crate::process::{hidden_command, run_with_timeout};

/// 音频标签。两个字段都可能为空（文件没打标签是常态）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AudioTags {
    /// 曲名（`TITLE` / `title`）。
    pub title: Option<String>,
    /// 艺术家（`ARTIST` / `album_artist` 兜底）。
    pub artist: Option<String>,
}

impl AudioTags {
    /// 两个字段都为空——调用方据此决定是否回退到文件名。
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.artist.is_none()
    }
}

/// 读 `format_tags` 里的 `title` / `artist`。
///
/// 参数与 [`crate::probe::probe`] 同款：显式给 `ffprobe` 路径与超时，调用方决定
/// 拿不到二进制时怎么办（生产环境一律"没有标签"）。
pub fn read_audio_tags(
    audio_path: &Path,
    ffprobe_bin: &Path,
    timeout: Duration,
) -> HpResult<AudioTags> {
    // `-show_entries format_tags`：只要标签，不扫流，几十毫秒级别。
    let mut cmd = hidden_command(ffprobe_bin);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_entries",
        "format_tags",
    ])
    .arg(audio_path);

    let output = run_with_timeout(&mut cmd, timeout)?;
    if !output.status.success() {
        return Err(HpError::Io(format!(
            "ffprobe 读取标签失败: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    parse_tags_json(&output.stdout)
}

/// 解析 `ffprobe -show_entries format_tags -of json` 的输出。
///
/// 键名大小写随容器而变（Matroska 给 `TITLE`，FLAC 给 `TITLE`，MP4 给 `title`），
/// 因此一律按**小写**比对。空串与纯空白当作"没有这个标签"。
fn parse_tags_json(bytes: &[u8]) -> HpResult<AudioTags> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| HpError::Io(format!("解析 ffprobe 标签 JSON 失败: {e}")))?;
    let tags = value.pointer("/format/tags");

    let get = |keys: &[&str]| -> Option<String> {
        let tags = tags?;
        for key in keys {
            let Some(raw) = tags.get(*key) else { continue };
            // 少数容器把同名标签写成数组（Vorbis 允许多值），取第一条即可。
            let text = match raw {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Array(items) => items
                    .iter()
                    .find_map(|item| item.as_str())
                    .unwrap_or_default()
                    .to_string(),
                _ => continue,
            };
            let text = text.trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
        None
    };

    // ffprobe 的 JSON 键大小写与容器一致，这里对两种常见写法都试一遍。
    Ok(AudioTags {
        title: get(&["title", "TITLE", "Title"]),
        artist: get(&["artist", "ARTIST", "Artist", "album_artist", "ALBUM_ARTIST"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uppercase_and_lowercase_keys() {
        let upper = br#"{"format":{"tags":{"ARTIST":"DECO*27","TITLE":"Reunion"}}}"#;
        let tags = parse_tags_json(upper).expect("应能解析");
        assert_eq!(tags.title.as_deref(), Some("Reunion"));
        assert_eq!(tags.artist.as_deref(), Some("DECO*27"));

        let lower = br#"{"format":{"tags":{"title":"  Curtain Call  ","artist":"ACANE"}}}"#;
        let tags = parse_tags_json(lower).expect("应能解析");
        assert_eq!(
            tags.title.as_deref(),
            Some("Curtain Call"),
            "两侧空白要修掉"
        );
        assert_eq!(tags.artist.as_deref(), Some("ACANE"));
    }

    #[test]
    fn missing_or_blank_tags_are_none() {
        let none = parse_tags_json(br#"{"format":{}}"#).expect("应能解析");
        assert!(none.is_empty());

        let blank = br#"{"format":{"tags":{"TITLE":"   ","ARTIST":""}}}"#;
        assert!(parse_tags_json(blank).expect("应能解析").is_empty());
    }

    #[test]
    fn falls_back_to_album_artist() {
        let album = br#"{"format":{"tags":{"ALBUM_ARTIST":"Various","TITLE":"Track"}}}"#;
        let tags = parse_tags_json(album).expect("应能解析");
        assert_eq!(
            tags.artist.as_deref(),
            Some("Various"),
            "没有 artist 时用 album_artist 兜底"
        );
    }

    #[test]
    fn reads_tags_from_a_real_file_when_ffprobe_is_bundled() {
        let Some(ffprobe) = bundled_ffprobe() else {
            eprintln!("跳过：未找到捆绑 ffprobe");
            return;
        };
        let dir = tempfile::TempDir::new().expect("建临时目录");
        let audio = dir.path().join("tagged.m4a");
        // 用 ffmpeg 现造一个带 title/artist 的 m4a，避免依赖仓库外的素材。
        let Some(ffmpeg) = bundled_ffmpeg() else {
            eprintln!("跳过：未找到捆绑 ffmpeg");
            return;
        };
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
                "-metadata",
                "title=测试曲名",
                "-metadata",
                "artist=测试艺人",
                "-c:a",
                "aac",
            ])
            .arg(&audio)
            .status()
            .expect("启动 ffmpeg 失败");
        assert!(status.success(), "生成测试音频失败");

        let tags = read_audio_tags(&audio, &ffprobe, Duration::from_secs(10)).expect("应读到标签");
        assert_eq!(tags.title.as_deref(), Some("测试曲名"));
        assert_eq!(tags.artist.as_deref(), Some("测试艺人"));
    }

    fn bundled_ffprobe() -> Option<std::path::PathBuf> {
        let cwd = std::env::current_dir().ok()?;
        let mut dir = cwd.as_path();
        loop {
            let candidate = dir.join("external-cli/ffmpeg/bin/ffprobe.exe");
            if candidate.exists() {
                return Some(candidate);
            }
            dir = dir.parent()?;
        }
    }

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
}
