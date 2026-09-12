//! hp-scanner：图像源扫描、变更检测、索引任务；媒体类型判定（扩展名优先 + 内容兜底）。

mod media_type;
mod scanner;
mod watcher;

pub use media_type::detect_media_type;
pub use scanner::{ScanOptions, ScanOutcome, ScanPhase, ScanProgress, Scanner};
pub use watcher::SourceWatcher;
