//! external-process 常驻进程监督（重启退避 + 不健康标记）。
//!
//! 插件标准第 10 节要求宿主对 `external-process` 形态的插件进程实施监督：
//!
//! - **退避重启**：启动失败或通信超时后按指数退避（1s → 2s → 4s → 8s → 16s → 32s 封顶）
//!   等待后再允许重试；
//! - **不健康标记**：连续失败超过 [`MAX_CONSECUTIVE_FAILURES`] 次后标记为 `Unhealthy`，
//!   不再自动重启（需用户手动重新启用插件）；
//! - **健康判定**：一次成功的 RPC 调用即重置失败计数为 0。
//!
//! 本模块不改变 `channel.rs` 的"一次一问一答"模型（每个 query 仍独立启动子进程），
//! 而是在每次调用前后记录健康状态，按失败历史决定是否允许启动新进程。这样
//! `channel.rs` 的进程生命周期逻辑不受影响，监督逻辑按"横切"方式叠加。

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// 连续失败次数上限：超过此阈值后标记为 `Unhealthy`，不再自动重启。
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// 指数退避上限（32 秒）。
const MAX_BACKOFF: Duration = Duration::from_secs(32);

/// 基础退避（1 秒）。
const BASE_BACKOFF: Duration = Duration::from_secs(1);

/// 监督状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisionStatus {
    /// 健康：上次调用成功（或从未失败）。
    Healthy,
    /// 降级：连续失败 N 次（1 ≤ N < MAX_CONSECUTIVE_FAILURES），下次重试前需等待退避。
    Degraded {
        /// 当前连续失败次数。
        consecutive_failures: u32,
    },
    /// 退避中：正在等待退避超时到期才能重试。
    RestartBackoff {
        /// 退避持续时间。
        backoff: Duration,
        /// 退避开始的时刻。
        since: Instant,
    },
    /// 不健康：连续失败次数达到上限，不再自动重启。
    Unhealthy {
        /// 最终连续失败次数。
        consecutive_failures: u32,
    },
}

impl SupervisionStatus {
    /// 当前是否允许发起一次新调用。
    pub fn allow_retry(&self) -> bool {
        match self {
            SupervisionStatus::Healthy => true,
            SupervisionStatus::Degraded { .. } => true,
            SupervisionStatus::RestartBackoff { backoff, since } => since.elapsed() >= *backoff,
            SupervisionStatus::Unhealthy { .. } => false,
        }
    }

    /// 返回是否需要人工介入。
    pub fn is_unhealthy(&self) -> bool {
        matches!(self, SupervisionStatus::Unhealthy { .. })
    }
}

/// external-process 插件进程监督器。
///
/// 每个插件实例对应一个监督器，记录其连续失败计数与当前状态。
#[derive(Debug, Clone)]
pub struct ProcessSupervisor {
    /// 插件 id（诊断用）。
    plugin_id: String,
    /// 当前连续失败次数。
    consecutive_failures: u32,
    /// 上一次失败是否触发了退避。
    in_backoff: bool,
    /// 退避的起始时刻（`in_backoff = true` 时有效）。
    backoff_start: Option<Instant>,
}

impl ProcessSupervisor {
    /// 创建一个新监督器：插件启动前状态为 `Healthy`。
    pub fn new(plugin_id: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            consecutive_failures: 0,
            in_backoff: false,
            backoff_start: None,
        }
    }

    /// 当前监督状态。
    pub fn status(&self) -> SupervisionStatus {
        // Unhealthy 优先级最高：连续失败超限后即使还在退避窗口也视作不健康。
        if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            return SupervisionStatus::Unhealthy {
                consecutive_failures: self.consecutive_failures,
            };
        }
        if let Some(start) = self.backoff_start {
            let backoff = backoff_duration(self.consecutive_failures);
            return SupervisionStatus::RestartBackoff { backoff, since: start };
        }
        match self.consecutive_failures {
            0 => SupervisionStatus::Healthy,
            n => SupervisionStatus::Degraded { consecutive_failures: n },
        }
    }

    /// 是否允许发起一次新 RPC 调用。
    pub fn allow_retry(&self) -> bool {
        self.status().allow_retry()
    }

    /// 插件 id（只读诊断用）。
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// 记录一次调用开始（退出退避状态）。
    ///
    /// 在发起实际进程启动前调用。如果当前处于 `RestartBackoff` 且退避尚未到期，
    /// 返回 `Err` 包含还需等待的时长。
    pub fn on_call_start(&mut self) -> Result<(), Duration> {
        if let Some(start) = self.backoff_start {
            let backoff = backoff_duration(self.consecutive_failures);
            let elapsed = start.elapsed();
            if elapsed < backoff {
                return Err(backoff - elapsed);
            }
        }
        self.in_backoff = false;
        self.backoff_start = None;
        Ok(())
    }

    /// 记录一次调用成功：重置失败计数为 0，回到健康状态。
    pub fn on_success(&mut self) {
        self.consecutive_failures = 0;
        self.in_backoff = false;
        self.backoff_start = None;
    }

    /// 记录一次调用失败：增加失败计数，进入退避状态。
    ///
    /// 返回变更后的状态。连续失败达到上限后永久标记为 `Unhealthy`。
    pub fn on_failure(&mut self) -> SupervisionStatus {
        self.consecutive_failures += 1;
        self.in_backoff = true;
        self.backoff_start = Some(Instant::now());

        if self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            SupervisionStatus::Unhealthy {
                consecutive_failures: self.consecutive_failures,
            }
        } else {
            SupervisionStatus::RestartBackoff {
                backoff: backoff_duration(self.consecutive_failures),
                since: self.backoff_start.unwrap(),
            }
        }
    }

    /// 重置不健康状态（用户手动重新启用插件时调用）。
    pub fn reset_unhealthy(&mut self) {
        self.consecutive_failures = 0;
        self.in_backoff = false;
        self.backoff_start = None;
    }

    /// 当前连续失败次数（诊断用）。
    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }
}

/// 按当前失败次数计算退避时间（指数退避，≤ 32s 封顶）。
fn backoff_duration(failures: u32) -> Duration {
    let secs = BASE_BACKOFF.as_secs() * (1u64 << failures.saturating_sub(1));
    Duration::from_secs(secs.min(MAX_BACKOFF.as_secs()))
}

/// 监督注册表：按 plugin_id 索引的进程监督器集合。
///
/// 本寄存器由桥接层持有（`AppState`），插件启用时注册、禁用时移除。
#[derive(Debug, Clone, Default)]
pub struct SupervisionRegistry {
    supervisors: HashMap<String, ProcessSupervisor>,
}

impl SupervisionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个插件的监督器（通常在其启用时调用）。
    pub fn register(&mut self, plugin_id: impl Into<String>) {
        let plugin_id = plugin_id.into();
        if !self.supervisors.contains_key(&plugin_id) {
            self.supervisors
                .insert(plugin_id.clone(), ProcessSupervisor::new(plugin_id));
        }
    }

    /// 移除一个插件的监督器（禁用/卸载插件时调用）。
    pub fn unregister(&mut self, plugin_id: &str) {
        self.supervisors.remove(plugin_id);
    }

    /// 获取监督器：`None` 表示该插件未注册监督（非 external-process 或未启用）。
    pub fn get(&self, plugin_id: &str) -> Option<&ProcessSupervisor> {
        self.supervisors.get(plugin_id)
    }

    /// 可变引用获取监督器。
    pub fn get_mut(&mut self, plugin_id: &str) -> Option<&mut ProcessSupervisor> {
        self.supervisors.get_mut(plugin_id)
    }

    /// 记录一次调用成功（重置失败计数）。
    pub fn on_success(&mut self, plugin_id: &str) {
        if let Some(s) = self.supervisors.get_mut(plugin_id) {
            s.on_success();
        }
    }

    /// 记录一次调用失败（递增失败计数，进入退避）。
    pub fn on_failure(&mut self, plugin_id: &str) {
        if let Some(s) = self.supervisors.get_mut(plugin_id) {
            s.on_failure();
        }
    }

    /// 当前注册的插件数量。
    pub fn len(&self) -> usize {
        self.supervisors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.supervisors.is_empty()
    }

    /// 列出全部不健康插件。
    pub fn unhealthy_plugins(&self) -> Vec<String> {
        self.supervisors
            .iter()
            .filter(|(_, s)| s.status().is_unhealthy())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// 列出当前全部的监督状态。
    pub fn all_statuses(&self) -> HashMap<String, SupervisionStatus> {
        self.supervisors
            .iter()
            .map(|(id, s)| (id.clone(), s.status()))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_healthy() {
        let s = ProcessSupervisor::new("p1");
        assert_eq!(s.status(), SupervisionStatus::Healthy);
        assert!(s.allow_retry());
    }

    #[test]
    fn one_failure_starts_backoff() {
        let mut s = ProcessSupervisor::new("p1");
        let status = s.on_failure();
        assert!(matches!(status, SupervisionStatus::RestartBackoff { .. }));
        assert_eq!(s.consecutive_failures(), 1);
    }

    #[test]
    fn success_resets_to_healthy() {
        let mut s = ProcessSupervisor::new("p1");
        s.on_failure();
        s.on_failure();
        assert_eq!(s.consecutive_failures(), 2);
        s.on_success();
        assert_eq!(s.status(), SupervisionStatus::Healthy);
        assert_eq!(s.consecutive_failures(), 0);
    }

    #[test]
    fn max_failures_reaches_unhealthy() {
        let mut s = ProcessSupervisor::new("p1");
        for i in 1..MAX_CONSECUTIVE_FAILURES {
            s.on_failure();
            assert!(matches!(s.status(), SupervisionStatus::RestartBackoff { .. }),
                "第 {i} 次失败后应为 Degraded");
        }
        let status = s.on_failure(); // 第 MAX 次
        assert_eq!(status, SupervisionStatus::Unhealthy { consecutive_failures: MAX_CONSECUTIVE_FAILURES });
        assert!(!s.allow_retry());
    }

    #[test]
    fn unhealthy_can_be_reset() {
        let mut s = ProcessSupervisor::new("p1");
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            s.on_failure();
        }
        assert!(s.status().is_unhealthy());
        s.reset_unhealthy();
        assert_eq!(s.status(), SupervisionStatus::Healthy);
        assert!(s.allow_retry());
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_duration(1), Duration::from_secs(1));
        assert_eq!(backoff_duration(2), Duration::from_secs(2));
        assert_eq!(backoff_duration(3), Duration::from_secs(4));
        assert_eq!(backoff_duration(4), Duration::from_secs(8));
        assert_eq!(backoff_duration(5), Duration::from_secs(16));
        assert_eq!(backoff_duration(6), Duration::from_secs(32));
        assert_eq!(backoff_duration(7), Duration::from_secs(32));
    }

    #[test]
    fn call_start_rejects_early_retry() {
        let mut s = ProcessSupervisor::new("p1");
        s.on_failure(); // 进入退避
        let result = s.on_call_start();
        assert!(result.is_err(), "退避期间不应允许重试");
        assert!(result.unwrap_err() > Duration::ZERO);
    }

    #[test]
    fn call_start_passes_if_retry_allowed() {
        let mut s = ProcessSupervisor::new("p1");
        assert!(s.on_call_start().is_ok(), "健康状态下应允许");
        s.on_failure();
        s.on_success();
        assert!(s.on_call_start().is_ok(), "成功恢复后可重试");
    }

    #[test]
    fn display_restart_backoff_has_duration() {
        let mut s = ProcessSupervisor::new("p1");
        let status = s.on_failure();
        if let SupervisionStatus::RestartBackoff { backoff, .. } = status {
            assert!(backoff >= Duration::from_secs(1));
        } else {
            panic!("应为 RestartBackoff");
        }
    }
}
