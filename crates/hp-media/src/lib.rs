//! hp-media：ffprobe 元数据、解码、缩略图、调色板、波形——**全部经子进程或进程内库**，
//! 不持有播放器。
//!
//! M2 范围：ffprobe 元数据探测（D15）、ffmpeg 首帧抽帧（D16）、缩略图缓存。
//!
//! **libmpv 播放路径已于 2026-11-11 删除（D163，缺陷 0047）**：2026-09 起播放器面板改走
//! DOM `<video>`，`player` 模块与其 `MediaProcess` 自那时休眠、生产 0 调用；本轮连同
//! 桥接层 11 条 `media.*` 命令、`embed_window.rs` 与 mpv 二进制资产一起退役。
//! 同 crate 的 `probe` / `thumbnail` / `cache` / `palette` / `exif` / `decode` / `waveform`
//! 属 M2 能力，**仍在生产使用**。

mod cache;
mod decode;
mod dimensions;
mod exif;
mod lowres;
mod palette;
mod probe;
mod process;
mod svg;
mod thumb_decode;
mod thumbnail;
mod waveform;
mod webp;

pub use cache::{ThumbFormat, ThumbnailCache};
pub use decode::{decode_image_fallback, ensure_libheif_hooks};
pub use dimensions::{apply_orientation, display_dimensions, header_dimensions};
pub use exif::{ImageExif, extract_exif, orientation_of};
pub use palette::{
    DEFAULT_PALETTE_SIZE, PALETTE_FORMAT_VERSION, Palette, encode_palette_json, extract_palette,
    extract_palette_from_image, palette_is_locked,
};
pub use probe::{MediaProbe, probe};
pub use process::hidden_command;
pub use svg::{SVG_EXTS, is_svg, rasterize_svg};
pub use thumbnail::{
    IMAGE_THUMB_DIM_LADDER, IMAGE_THUMB_MAX_DIM, IMAGE_THUMB_MAX_LADDER_DIM,
    IMAGE_THUMB_WEBP_QUALITY, VIDEO_BLACK_SKIP_WINDOW, encode_image_thumbnail, extract_thumbnail,
    generate_image_preview, generate_image_thumbnail, generate_image_thumbnail_known,
    image_thumb_dim_for,
};
pub use waveform::{WAVE_COLOR, WAVE_SIZE, generate_waveform};

/// 大 JPEG `-lowres` 快路径的分流判据（D148 / 0018 §4.2 ②）。
/// 生产判定在 `thumbnail` 内部完成；这里导出供集成测试与基准探针钉口径。
pub use lowres::{should_use_lowres, should_use_lowres_known};
