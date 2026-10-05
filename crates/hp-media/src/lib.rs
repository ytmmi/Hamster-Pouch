//! hp-media：媒体子进程管理（libmpv）、播放控制、ffprobe 元数据、ffmpeg 抽帧宿主。
//!
//! M2 范围：ffprobe 元数据探测（D15）、ffmpeg 首帧抽帧（D16）、缩略图缓存。
//! M4 范围：媒体子进程管理（D14 / RFC 0005，`player` 模块）。
//!
//! **休眠（2026-09）**：`player` 模块的 libmpv 播放路径已随缺陷 `docs/issues/0001` 退役
//! ——播放器面板改走 DOM `<video>`，桥接层 `media.*` 在正式界面 `app_ui` 里**无调用方**
//! （唯一调用方是 dev harness `test_ui`）。该模块与 `MediaProcess` **保留不删**，仅作将来
//! 复活时的参考。**注意区分**：同 crate 的 `probe` / `thumbnail` / `cache` / `palette` / `exif`
//! 属 M2 能力，**仍在生产使用**，不受本休眠影响。

mod cache;
mod exif;
mod palette;
mod player;
mod probe;
mod process;
mod thumbnail;

pub use cache::ThumbnailCache;
pub use exif::{extract_exif, ImageExif};
pub use palette::{
    encode_palette_json, extract_palette, extract_palette_from_image, palette_is_locked, Palette,
    DEFAULT_PALETTE_SIZE, PALETTE_FORMAT_VERSION,
};
pub use player::{MediaProcess, DEFAULT_PIPE_PATH};
pub use probe::{probe, MediaProbe};
pub use thumbnail::{extract_thumbnail, generate_image_thumbnail, IMAGE_THUMB_MAX_DIM};
