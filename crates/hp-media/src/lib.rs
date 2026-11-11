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
mod decode;
mod dimensions;
mod exif;
mod lowres;
mod palette;
mod player;
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
pub use player::{DEFAULT_PIPE_PATH, MediaProcess};
pub use probe::{MediaProbe, probe};
pub use process::hidden_command;
pub use svg::{SVG_EXTS, is_svg, rasterize_svg};
pub use thumbnail::{
    IMAGE_THUMB_DIM_LADDER, IMAGE_THUMB_MAX_DIM, IMAGE_THUMB_MAX_LADDER_DIM,
    IMAGE_THUMB_WEBP_QUALITY, VIDEO_BLACK_SKIP_WINDOW, extract_thumbnail, generate_image_preview,
    generate_image_thumbnail, generate_image_thumbnail_known, image_thumb_dim_for,
};
pub use waveform::{WAVE_COLOR, WAVE_SIZE, generate_waveform};

/// 大 JPEG `-lowres` 快路径的分流判据（D148 / 0018 §4.2 ②）。
/// 生产判定在 `thumbnail` 内部完成；这里导出供集成测试与基准探针钉口径。
pub use lowres::{should_use_lowres, should_use_lowres_known};
