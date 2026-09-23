//! 文件变更监听（notify）：实时监听 + 定期全量校验兜底（D9）。

use std::path::Path;
use std::sync::mpsc::Receiver;

use hp_core::{HpError, HpResult};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

/// 单个媒体源的实时文件监听器。
///
/// 用 `notify` 监听目录树变化；上层通过 `try_recv` 轮询事件并触发局部重扫。
/// 事件丢失/溢出由定期全量校验兜底（D9）。
pub struct SourceWatcher {
    _watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
}

impl SourceWatcher {
    /// 启动对 `path` 的递归监听。
    pub fn start(path: impl AsRef<Path>) -> HpResult<Self> {
        let (tx, rx) = std::sync::mpsc::channel();
        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                let _ = tx.send(res);
            },
            Config::default(),
        )
        .map_err(|e| HpError::Io(format!("创建文件监听失败: {e}")))?;

        let mut watcher = watcher;
        watcher
            .watch(path.as_ref(), RecursiveMode::Recursive)
            .map_err(|e| HpError::Io(format!("监听路径失败: {e}")))?;

        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// 非阻塞获取下一个文件事件；无事件返回 `None`。
    pub fn try_recv(&self) -> Option<notify::Result<Event>> {
        self.rx.try_recv().ok()
    }

    /// 阻塞获取下一个文件事件。
    pub fn recv(&self) -> Option<notify::Result<Event>> {
        self.rx.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn watcher_detects_file_creation() {
        let dir = tempfile::tempdir().expect("创建临时目录失败");
        let watcher = SourceWatcher::start(dir.path()).expect("启动监听失败");

        // 创建文件触发事件
        let p = dir.path().join("new.txt");
        let mut f = std::fs::File::create(&p).expect("创建文件失败");
        f.write_all(b"x").expect("写入失败");

        // 事件可能延迟到达，轮询一小段时间
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let mut got_event = false;
        while std::time::Instant::now() < deadline {
            if let Some(Ok(event)) = watcher.try_recv() {
                if event.paths.iter().any(|p| p == &dir.path().join("new.txt")) {
                    got_event = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(got_event, "应在创建文件后收到监听事件");
    }
}
