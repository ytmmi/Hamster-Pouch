//! hp-scanner：媒体源扫描、变更检测、索引任务；媒体类型判定（扩展名优先 + 内容兜底）。

mod media_type;
mod scan_compute;
mod scan_pool;
mod scan_task;
mod scanner;
mod watcher;

pub use media_type::{default_file_marks, detect_media_type};
pub use scan_compute::{analyze_image, image_pixel_cost, ImageDerivations};
pub use scan_pool::{map_bounded, pixel_cost, worker_count, PIXEL_BUDGET_MP};
pub use scanner::{ScanOptions, ScanOutcome, ScanPhase, ScanProgress, Scanner};
pub use watcher::SourceWatcher;
