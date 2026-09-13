//! hp-media：媒体子进程管理（libmpv）、播放控制、ffprobe 元数据、ffmpeg 抽帧宿主。
//!
//! M2 范围：ffprobe 元数据探测（D15）、ffmpeg 首帧抽帧（D16）、缩略图缓存。
//! M4 范围：媒体子进程管理（D14 / RFC 0005，`player` 模块）。

mod cache;
mod exif;
mod palette;
mod player;
mod probe;
mod process;
mod thumbnail;

pub use cache::ThumbnailCache;
pub use exif::{extract_exif, ImageExif};
pub use palette::{extract_palette, Palette, DEFAULT_PALETTE_SIZE};
pub use player::{MediaProcess, DEFAULT_PIPE_PATH};
pub use probe::{probe, MediaProbe};
pub use thumbnail::{extract_thumbnail, generate_image_thumbnail, IMAGE_THUMB_MAX_DIM};
