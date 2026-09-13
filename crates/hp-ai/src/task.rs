//! AI 打标任务队列（内存队列；长任务由宿主推进并发出进度事件）。

use hp_core::{AiProviderConfigId, FileId};
use uuid::Uuid;

/// AI 打标任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiTaskStatus {
    /// 已入队，等待执行。
    Pending,
    /// 执行中。
    Running,
    /// 已完成。
    Done,
    /// 执行失败。
    Failed,
}

impl AiTaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AiTaskStatus::Pending => "pending",
            AiTaskStatus::Running => "running",
            AiTaskStatus::Done => "done",
            AiTaskStatus::Failed => "failed",
        }
    }
}

/// 单个 AI 打标任务。
#[derive(Debug, Clone, PartialEq)]
pub struct AiTask {
    pub id: String,
    pub repo_id: String,
    pub file_id: FileId,
    pub provider_config_id: AiProviderConfigId,
    pub options_json: String,
    pub status: AiTaskStatus,
}

/// 内存任务队列（FIFO）。
#[derive(Debug, Default)]
pub struct AiTaskQueue {
    tasks: Vec<AiTask>,
}

impl AiTaskQueue {
    pub fn new() -> Self {
        Self { tasks: Vec::new() }
    }

    /// 入队并返回任务 ID。
    pub fn enqueue(
        &mut self,
        repo_id: &str,
        file_id: FileId,
        provider_config_id: AiProviderConfigId,
        options_json: &str,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        self.tasks.push(AiTask {
            id: id.clone(),
            repo_id: repo_id.to_string(),
            file_id,
            provider_config_id,
            options_json: options_json.to_string(),
            status: AiTaskStatus::Pending,
        });
        id
    }

    /// 取出下一个待执行任务并标记为执行中。
    pub fn take_next(&mut self) -> Option<AiTask> {
        let task = self
            .tasks
            .iter_mut()
            .find(|t| t.status == AiTaskStatus::Pending)?;
        task.status = AiTaskStatus::Running;
        Some(task.clone())
    }

    /// 标记任务完成。
    pub fn mark_done(&mut self, id: &str) {
        self.set_status(id, AiTaskStatus::Done);
    }

    /// 标记任务失败。
    pub fn mark_failed(&mut self, id: &str) {
        self.set_status(id, AiTaskStatus::Failed);
    }

    /// 按 ID 查询任务。
    pub fn get(&self, id: &str) -> Option<&AiTask> {
        self.tasks.iter().find(|t| t.id == id)
    }

    /// 待执行任务数。
    pub fn pending_count(&self) -> usize {
        self.tasks
            .iter()
            .filter(|t| t.status == AiTaskStatus::Pending)
            .count()
    }

    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn set_status(&mut self, id: &str, status: AiTaskStatus) {
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) {
            task.status = status;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_fifo_and_tracks_status() {
        let mut q = AiTaskQueue::new();
        let a = q.enqueue("repo", FileId::from_raw("f1"), AiProviderConfigId::generate(), "{}");
        let _b = q.enqueue("repo", FileId::from_raw("f2"), AiProviderConfigId::generate(), "{}");
        assert_eq!(q.len(), 2);
        assert_eq!(q.pending_count(), 2);

        let first = q.take_next().expect("应有任务");
        assert_eq!(first.id, a);
        assert_eq!(first.status, AiTaskStatus::Running);
        assert_eq!(q.pending_count(), 1);

        q.mark_done(&a);
        assert_eq!(q.get(&a).expect("任务应存在").status, AiTaskStatus::Done);

        let second = q.take_next().expect("应有第二个任务");
        q.mark_failed(&second.id);
        assert_eq!(
            q.get(&second.id).expect("任务应存在").status,
            AiTaskStatus::Failed
        );
        assert!(q.take_next().is_none());
    }
}
