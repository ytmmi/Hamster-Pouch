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

/// 该事件值不值得处理：**访问类**（打开/读/关闭）一律丢弃。
///
/// 缩略图与查看器会不断读源里的文件，`Access` 事件因此非常密集；不丢弃的话监听线程
/// 会被"自己读自己的文件"持续吵醒，去抖窗口永远等不到静默。
pub fn is_relevant_event(event: &Event) -> bool {
    !matches!(event.kind, notify::EventKind::Access(_))
}

/// 库内已有文件在监听判定中要用到的字段（取自 `files` 行）。
///
/// 只带判定必需的四项：`file_id` 用于发事件，`size` / `mtime` 用于判"内容变了"，
/// `missing` 是库里已登记的缺失标记（决定往 `file.missing` 还是 `file.restored` 走）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownFile {
    pub file_id: String,
    pub size: i64,
    pub mtime: String,
    pub missing: bool,
}

/// 一条监听事件最终落到哪个契约事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchDecision {
    /// 库里有、磁盘上没了 → `file.missing`
    Missing { file_id: String },
    /// 库里登记为缺失、磁盘上又出现了 → `file.restored`
    Restored { file_id: String },
    /// 库里有、磁盘上还在、size 或 mtime 变了 → `file.changed(modified)`
    Modified { file_id: String },
    /// 库里没有、磁盘上有 → `file.created`（2026-11-11 第 37 轮裁决：新增文件也要报）
    Created,
}

/// 由"库里怎么记的"与"磁盘上现在什么样"决定发不发事件。
///
/// **语义边界**（对齐 `docs/spec/commands-events.md` 的三条契约）：
///
/// - `known == None` 且磁盘上有 = **新增文件** → `Created`（`file.created`；2026-11-11
///   第 37 轮裁决：用户要求"拖进文件夹就进库"，故新增由监听报出并触发一次增量扫描）。
///   磁盘上也没有（创建后又立刻删）→ `None`。
/// - `disk == None` 且库里**尚未**标记缺失 → `Missing`；已标记过 → `None`（不重复轰炸）。
/// - `disk == Some` 且库里标记缺失 → `Restored`。
/// - `disk == Some`、未标记缺失、`size` 或 `mtime` 变化 → `Modified`；都没变 → `None`
///   （重复 `Modify` 抖动、属性事件都落在这里，天然静默）。
///
/// 判定是**纯函数**：不做 IO、不碰数据库，因此可以在单测里逐条钉死。
pub fn decide(known: Option<&KnownFile>, disk: Option<(i64, String)>) -> Option<WatchDecision> {
    let Some(known) = known else {
        return disk.map(|_| WatchDecision::Created);
    };
    match (disk, known.missing) {
        (None, false) => Some(WatchDecision::Missing {
            file_id: known.file_id.clone(),
        }),
        (None, true) => None,
        (Some(_), true) => Some(WatchDecision::Restored {
            file_id: known.file_id.clone(),
        }),
        (Some((size, mtime)), false) => {
            (size != known.size || mtime != known.mtime).then(|| WatchDecision::Modified {
                file_id: known.file_id.clone(),
            })
        }
    }
}

/// 把绝对路径换成"相对媒体源根"的库内键（`files.relative_path` 口径：`/` 分隔）。
///
/// 不在根之下就返回 `None`（事件来自别的目录）。`notify` 在 Windows 上偶尔给出
/// `\\?\E:\...` 长路径前缀、或大小写与源记录不同，因此先按路径组件剥，失败再按
/// 字符串（忽略 ASCII 大小写）剥一次。
pub fn relative_key(root: &Path, path: &Path) -> Option<String> {
    if let Ok(rel) = path.strip_prefix(root) {
        return Some(rel.to_string_lossy().replace('\\', "/"));
    }
    let root_s = root.to_string_lossy().replace('\\', "/");
    let root_s = root_s.strip_prefix("//?/").unwrap_or(&root_s);
    let root_s = root_s.trim_end_matches('/');
    let path_s = path.to_string_lossy().replace('\\', "/");
    let path_s = path_s.strip_prefix("//?/").unwrap_or(&path_s);
    let (rb, pb) = (root_s.as_bytes(), path_s.as_bytes());
    if pb.len() > rb.len() && pb[..rb.len()].eq_ignore_ascii_case(rb) && pb[rb.len()] == b'/' {
        return Some(path_s[rb.len() + 1..].to_string());
    }
    None
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
            if let Some(Ok(event)) = watcher.try_recv()
                && event.paths.iter().any(|p| p == &dir.path().join("new.txt"))
            {
                got_event = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(got_event, "应在创建文件后收到监听事件");
    }

    /// 判定表的四条主线 + 新增文件不发事件。
    #[test]
    fn decide_maps_disk_state_and_index_state_to_contract_events() {
        let known = |missing: bool| KnownFile {
            file_id: "f1".into(),
            size: 100,
            mtime: "111".into(),
            missing,
        };
        let same = Some((100, "111".to_string()));

        // 库里没有、磁盘上有 = 新增文件（第 37 轮裁决：发 file.created，并触发增量扫描）。
        assert_eq!(decide(None, same.clone()), Some(WatchDecision::Created));
        // 库里没有、磁盘上也没有（创建后又立刻删）：不发。
        assert_eq!(decide(None, None), None);
        // 库里有、磁盘没了、库里未标记 → 缺失。
        assert_eq!(
            decide(Some(&known(false)), None),
            Some(WatchDecision::Missing {
                file_id: "f1".into()
            })
        );
        // 已登记缺失、磁盘仍然没有 → 不重复发。
        assert_eq!(decide(Some(&known(true)), None), None);
        // 已登记缺失、磁盘又出现 → 恢复（即便 size/mtime 也变了，先报恢复）。
        assert_eq!(
            decide(Some(&known(true)), same.clone()),
            Some(WatchDecision::Restored {
                file_id: "f1".into()
            })
        );
        // 未标记缺失、size 变了 → 内容变更。
        assert_eq!(
            decide(Some(&known(false)), Some((101, "111".into()))),
            Some(WatchDecision::Modified {
                file_id: "f1".into()
            })
        );
        // 未标记缺失、只有 mtime 变了 → 同样是内容变更。
        assert_eq!(
            decide(Some(&known(false)), Some((100, "222".into()))),
            Some(WatchDecision::Modified {
                file_id: "f1".into()
            })
        );
        // 一模一样（Access/重复 Modify 抖动）→ 静默。
        assert_eq!(decide(Some(&known(false)), same), None);
    }

    /// 相对键：`/` 归一、根外返回 `None`、长路径前缀与大小写也能剥。
    #[test]
    fn relative_key_normalizes_and_rejects_outside_paths() {
        let root = Path::new("E:/Hamster Pouch/夹具");
        assert_eq!(
            relative_key(root, Path::new("E:/Hamster Pouch/夹具/子/图.png")).as_deref(),
            Some("子/图.png")
        );
        assert_eq!(
            relative_key(root, Path::new("E:/Hamster Pouch/别的/图.png")),
            None
        );
        // Windows 长路径前缀 + 大小写差异。
        assert_eq!(
            relative_key(root, Path::new("\\\\?\\e:\\hamster pouch\\夹具\\a.png")).as_deref(),
            Some("a.png")
        );
    }
}
