//! hp-media：媒体子进程管理（libmpv）、播放控制、ffprobe 元数据、ffmpeg 抽帧宿主。
//!
//! M2 范围：ffprobe 元数据探测（D15）、ffmpeg 首帧抽帧（D16）、缩略图缓存。
//! 播放控制（libmpv 子进程）属于 M4，本里程碑不实现。

mod cache;
mod exif;
mod palette;
mod probe;
mod process;
mod thumbnail;

pub use cache::ThumbnailCache;
pub use exif::{extract_exif, ImageExif};
pub use palette::{extract_palette, Palette, DEFAULT_PALETTE_SIZE};
pub use probe::{probe, MediaProbe};
pub use thumbnail::extract_thumbnail;
