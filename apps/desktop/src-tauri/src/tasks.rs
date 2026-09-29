//! 长任务控制块注册表（扫描 / 卸载）—— 缺陷 `docs/issues/0003` 的修复点。
//!
//! **旧实现的问题**：取消请求用 `AppState` 上**一个全局** `AtomicBool` 表达
//! （连同 `Scanner` 自身的标志），于是 `task.cancel` / `task.pause` / `task.resume`
//! 都**没有参数**：调用者无法指定取消哪一个任务，任何一条控制请求都会作用到"当前那条"，
//! 而"当前是哪条"由后端隐式决定（与契约 `commands-events.md` §3.7 的 `{ taskId }` 不符）。
//!
//! **现在**：控制权收敛为"按 `task_id` 登记的控制块"。每条长任务在启动线程**之前**登记，
//! 所有控制请求都必须带 `task_id`，**只有命中当前任务才改动状态**；
//! 目标不是当前任务时返回 [`RequestOutcome::NotCurrent`]，由命令层回报布尔值
//! （`cancelled: false` / `paused: false`）——竞态窗口内任务恰好结束**不当作错误**。
//!
//! 单任务闸门仍在：注册表同一时刻至多持有一条任务，`start` 在忙时返回 `None`。
//! 本模块只做"任务身份 + 取消标志 + 能力判定"，不直接操作 `Scanner`
//! （暂停/恢复由命令层按 `kind` 决定是否置位扫描器，见 `commands/source.rs`）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// 长任务种类。能力不同：**只有扫描支持暂停/恢复**（完全卸载的清理循环与单文件分析都没有暂停点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskKind {
    Scan,
    /// 单文件「重新分析」（`file.reanalyze`）：与扫描同源（`Scanner::rescan_file`）、有进度浮窗与取消，
    /// 但**没有暂停点**（一个文件的哈希/抽帧/调色板是一口气做完的）。
    Analyze,
    Unmount,
}

impl TaskKind {
    /// 契约里 `task.status` 上报的稳定字符串。
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TaskKind::Scan => "scan",
            TaskKind::Analyze => "analyze",
            TaskKind::Unmount => "unmount",
        }
    }

    /// 该种类的任务是否支持暂停/恢复。
    pub(crate) fn is_pausable(self) -> bool {
        matches!(self, TaskKind::Scan)
    }
}

/// 一条长任务的控制块。任务线程持有克隆，按自己的标志决定是否中止。
#[derive(Debug, Clone)]
pub(crate) struct TaskControl {
    task_id: String,
    kind: TaskKind,
    cancel: Arc<AtomicBool>,
}

impl TaskControl {
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }

    /// 取消标志：任务线程轮询它（`Arc` 可直接 `clone` 进线程）。
    pub(crate) fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    /// 该任务是否已被请求取消。
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

/// 控制请求的受理结果。
///
/// 控制器**不**直接操作 `Scanner`：把"按 id 定位"这条策略与"置位扫描器"这条副作用分开，
/// 前者因此可以单测（本文件的 `tests`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RequestOutcome {
    /// 命中当前任务且已受理（取消标志已置位，或调用方应置位扫描器）。
    Accepted { kind: TaskKind },
    /// 该 id 不是当前任务（已结束或从未存在）：**未改动任何状态**。
    NotCurrent,
    /// 是当前任务，但该操作不适用于该种类（如对卸载任务暂停）。
    Unsupported { kind: TaskKind },
}

impl RequestOutcome {
    /// 命令层回报的布尔值：请求是否真的被受理。
    pub(crate) fn is_accepted(self) -> bool {
        matches!(self, RequestOutcome::Accepted { .. })
    }
}

/// 当前任务的快照（`task.status` 用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskSnapshot {
    pub(crate) task_id: String,
    pub(crate) kind: TaskKind,
}

/// 长任务注册表：单任务闸门 + 按 `task_id` 定位的控制请求。
#[derive(Debug, Default)]
pub(crate) struct TaskRegistry {
    current: Mutex<Option<TaskControl>>,
}

impl TaskRegistry {
    pub(crate) fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// 尝试登记一条长任务；已有任务在跑时返回 `None`（单任务闸门）。
    ///
    /// 必须在**启动线程之前**调用：这样任务一被外部看见就已有可定位的控制块。
    pub(crate) fn start(&self, task_id: impl Into<String>, kind: TaskKind) -> Option<TaskControl> {
        let mut guard = self.lock();
        if guard.is_some() {
            return None;
        }
        let control = TaskControl {
            task_id: task_id.into(),
            kind,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        *guard = Some(control.clone());
        Some(control)
    }

    /// 注销任务。**只有 id 匹配当前任务才清除**——旧任务的收尾不得抹掉新任务的控制块。
    pub(crate) fn finish(&self, task_id: &str) {
        let mut guard = self.lock();
        if guard.as_ref().is_some_and(|c| c.task_id == task_id) {
            *guard = None;
        }
    }

    /// 按 `task_id` 请求取消。
    ///
    /// 命中时置位该任务**自己的**取消标志。扫描线程除扫描器自身标志外还承认这个标志
    /// （`Scanner::scan_source_with_cancel`），因此"登记后、扫描 `reset()` 之前"发出的取消
    /// 也不会丢。
    pub(crate) fn request_cancel(&self, task_id: &str) -> RequestOutcome {
        let guard = self.lock();
        match guard.as_ref() {
            Some(c) if c.task_id == task_id => {
                c.cancel.store(true, Ordering::SeqCst);
                RequestOutcome::Accepted { kind: c.kind }
            }
            _ => RequestOutcome::NotCurrent,
        }
    }

    /// 按 `task_id` 请求暂停（仅扫描支持）。
    pub(crate) fn request_pause(&self, task_id: &str) -> RequestOutcome {
        self.request_pausable(task_id)
    }

    /// 按 `task_id` 请求恢复（仅扫描支持）。
    pub(crate) fn request_resume(&self, task_id: &str) -> RequestOutcome {
        self.request_pausable(task_id)
    }

    fn request_pausable(&self, task_id: &str) -> RequestOutcome {
        let guard = self.lock();
        match guard.as_ref() {
            Some(c) if c.task_id == task_id => {
                if c.kind.is_pausable() {
                    RequestOutcome::Accepted { kind: c.kind }
                } else {
                    RequestOutcome::Unsupported { kind: c.kind }
                }
            }
            _ => RequestOutcome::NotCurrent,
        }
    }

    /// 当前任务快照；无任务返回 `None`。
    pub(crate) fn snapshot(&self) -> Option<TaskSnapshot> {
        self.lock().as_ref().map(|c| TaskSnapshot {
            task_id: c.task_id.clone(),
            kind: c.kind,
        })
    }

    /// 是否有长任务在进行中。
    pub(crate) fn is_busy(&self) -> bool {
        self.lock().is_some()
    }

    /// 取锁。中毒说明持锁线程 panic 过；本模块只读写一个控制块，
    /// 恢复内层值比 `unwrap()` 更稳（否则一次 panic 会把后续所有任务控制都变成错误）。
    fn lock(&self) -> MutexGuard<'_, Option<TaskControl>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缺陷 0003 回归（核心）：控制请求必须**按 `task_id` 定位**。
    ///
    /// 旧实现没有 `task_id` 参数、只置位一个全局标志，因此"取消另一个任务"也会把
    /// 当前任务停掉 —— 本测试断言相反的语义：id 不命中时**一点状态都不许改**。
    #[test]
    fn cancel_targets_only_the_named_task() {
        let registry = TaskRegistry::new();
        let task = registry
            .start("task-a", TaskKind::Scan)
            .expect("空注册表应能登记");

        assert_eq!(
            registry.request_cancel("task-b"),
            RequestOutcome::NotCurrent,
            "非当前任务的取消请求必须被拒绝"
        );
        assert!(!task.is_cancelled(), "被拒绝的请求不得改动当前任务的状态");

        assert_eq!(
            registry.request_cancel("task-a"),
            RequestOutcome::Accepted {
                kind: TaskKind::Scan
            }
        );
        assert!(task.is_cancelled(), "命中当前任务才置位取消标志");
    }

    /// 已经结束的任务不能再被取消（前端浮窗的竞态窗口：任务恰好收尾）。
    #[test]
    fn finished_task_is_no_longer_cancellable() {
        let registry = TaskRegistry::new();
        let task = registry.start("task-a", TaskKind::Unmount).expect("应能登记");
        registry.finish("task-a");

        assert_eq!(registry.request_cancel("task-a"), RequestOutcome::NotCurrent);
        assert!(!task.is_cancelled());
        assert!(!registry.is_busy());
        assert!(registry.snapshot().is_none());
    }

    /// 旧任务的收尾不得抹掉新任务的控制块（否则新任务会立刻变成"不可控制"）。
    #[test]
    fn stale_finish_does_not_clear_a_newer_task() {
        let registry = TaskRegistry::new();
        registry.start("task-a", TaskKind::Scan).expect("应能登记");
        registry.finish("task-a");

        let newer = registry.start("task-b", TaskKind::Scan).expect("应能登记");
        registry.finish("task-a"); // 迟到的旧收尾

        assert!(registry.is_busy(), "迟到的旧收尾不得注销新任务");
        assert_eq!(
            registry.snapshot().map(|s| s.task_id),
            Some("task-b".to_string())
        );
        assert_eq!(
            registry.request_cancel("task-b"),
            RequestOutcome::Accepted {
                kind: TaskKind::Scan
            }
        );
        assert!(newer.is_cancelled());
    }

    /// 单任务闸门：同一时刻至多一条长任务。
    #[test]
    fn single_task_gate_rejects_a_second_task() {
        let registry = TaskRegistry::new();
        assert!(registry.start("task-a", TaskKind::Scan).is_some());
        assert!(
            registry.start("task-b", TaskKind::Scan).is_none(),
            "已有任务在跑时不得再登记"
        );
        registry.finish("task-a");
        assert!(
            registry.start("task-c", TaskKind::Unmount).is_some(),
            "前一条结束后应能再登记"
        );
    }

    /// 暂停/恢复只对**扫描**成立；卸载任务明确报 `Unsupported`，而不是静默成功。
    #[test]
    fn pause_and_resume_are_scan_only() {
        let registry = TaskRegistry::new();
        registry.start("scan-1", TaskKind::Scan).expect("应能登记");
        assert_eq!(
            registry.request_pause("scan-1"),
            RequestOutcome::Accepted {
                kind: TaskKind::Scan
            }
        );
        assert_eq!(
            registry.request_resume("scan-1"),
            RequestOutcome::Accepted {
                kind: TaskKind::Scan
            }
        );
        registry.finish("scan-1");

        registry.start("unmount-1", TaskKind::Unmount).expect("应能登记");
        assert_eq!(
            registry.request_pause("unmount-1"),
            RequestOutcome::Unsupported {
                kind: TaskKind::Unmount
            }
        );
        assert_eq!(
            registry.request_pause("scan-1"),
            RequestOutcome::NotCurrent,
            "旧 id 不再是当前任务"
        );
    }

    /// 契约里的 `kind` 字符串是稳定接口，不要随重构改名。
    #[test]
    fn kind_strings_are_stable() {
        assert_eq!(TaskKind::Scan.as_str(), "scan");
        assert_eq!(TaskKind::Analyze.as_str(), "analyze");
        assert_eq!(TaskKind::Unmount.as_str(), "unmount");
        assert!(TaskKind::Scan.is_pausable());
        // 单文件分析没有暂停点（一口气做完），只有扫描可暂停。
        assert!(!TaskKind::Analyze.is_pausable());
        assert!(!TaskKind::Unmount.is_pausable());
    }

    /// 单文件分析也有取消（`task.cancel` 命中即受理），只是不可暂停。
    #[test]
    fn analyze_task_supports_cancel_but_not_pause() {
        let registry = TaskRegistry::new();
        let task = registry
            .start("analyze-1", TaskKind::Analyze)
            .expect("应能登记");

        assert_eq!(
            registry.request_pause("analyze-1"),
            RequestOutcome::Unsupported {
                kind: TaskKind::Analyze
            },
            "分析任务必须明确报 Unsupported，而不是假装可暂停"
        );
        assert_eq!(
            registry.request_cancel("analyze-1"),
            RequestOutcome::Accepted {
                kind: TaskKind::Analyze
            }
        );
        assert!(task.is_cancelled());
    }
}
