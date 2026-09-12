//! 媒体类型判定：扩展名优先 + 内容兜底（D11）。

use std::io::Read;
use std::path::Path;

use hp_core::MediaType;

/// 扩展名 → 媒体类型映射（扩展名优先，D11）。
fn ext_to_media_type(ext: &str) -> Option<MediaType> {
    match ext.to_ascii_lowercase().as_str() {
        // 图片
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "tif" | "avif" | "heic"
        | "ico" | "svg" => Some(MediaType::Image),
        // 视频
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" | "ts"
        | "3gp" => Some(MediaType::Video),
        // 音频
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" | "opus" | "ape" => {
            Some(MediaType::Audio)
        }
        _ => None,
    }
}

/// 内容兜底：读取文件头 magic bytes 判定媒体类型（D11）。
fn sniff_media_type(path: &Path) -> Option<MediaType> {
    let mut buf = [0u8; 16];
    let mut f = std::fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    let b = &buf[..n];
    if b.len() < 4 {
        return None;
    }

    // 图片
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(MediaType::Image); // JPEG
    }
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some(MediaType::Image); // PNG
    }
    if b.starts_with(b"GIF8") {
        return Some(MediaType::Image);
    }
    if b.starts_with(b"BM") {
        return Some(MediaType::Image); // BMP
    }

    // RIFF 容器（WebP 图片 / AVI 视频 / WAV 音频）
    if b.starts_with(b"RIFF") && b.len() >= 12 {
        match &b[8..12] {
            b"WEBP" => return Some(MediaType::Image),
            b"AVI " => return Some(MediaType::Video),
            b"WAVE" => return Some(MediaType::Audio),
            _ => {}
        }
    }

    // ISO BMFF（mp4/mov/3gp/webm/m4a）
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        if b.len() >= 16 && &b[8..16] == b"M4A " {
            return Some(MediaType::Audio);
        }
        return Some(MediaType::Video);
    }

    // EBML（mkv/webm）
    if b.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(MediaType::Video);
    }

    // 音频
    if b.starts_with(b"ID3") {
        return Some(MediaType::Audio); // MP3 (ID3 tag)
    }
    if b.starts_with(&[0xFF, 0xFB])
        || b.starts_with(&[0xFF, 0xF3])
        || b.starts_with(&[0xFF, 0xF2])
    {
        return Some(MediaType::Audio); // MP3 帧同步
    }
    if b.starts_with(b"fLaC") {
        return Some(MediaType::Audio); // FLAC
    }
    if b.starts_with(b"OggS") {
        return Some(MediaType::Audio); // OGG (vorbis/opus)
    }

    None
}

/// 判定文件媒体类型；未知类型返回 `None`（跳过不索引，D11）。
pub fn detect_media_type(path: &Path) -> Option<MediaType> {
    // 扩展名优先
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if let Some(mt) = ext_to_media_type(ext) {
            return Some(mt);
        }
    }
    // 内容兜底
    sniff_media_type(path)
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

    #[test]
    fn extension_first() {
        let png = write_tmp("photo.png", b"not really a png");
        assert_eq!(detect_media_type(&png), Some(MediaType::Image));
    }

    #[test]
    fn content_fallback_without_extension() {
        let jpeg = write_tmp("noext", &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(detect_media_type(&jpeg), Some(MediaType::Image));
    }

    #[test]
    fn unknown_type_returns_none() {
        let txt = write_tmp("notes.txt", b"hello world plain text");
        assert_eq!(detect_media_type(&txt), None);
    }

    #[test]
    fn audio_detected() {
        let mp3 = write_tmp("song.mp3", b"ID3 fake audio");
        assert_eq!(detect_media_type(&mp3), Some(MediaType::Audio));
    }

    #[test]
    fn uppercase_extension_normalized() {
        let jpg = write_tmp("PHOTO.JPG", &[0xFF, 0xD8, 0xFF, 0xE0]);
        assert_eq!(detect_media_type(&jpg), Some(MediaType::Image));
    }
}
