//! AI 打标服务门面：提交任务、驱动队列、回写结果（D6 / D17）。

use std::path::Path;

use hp_core::{
    AiProviderConfigId, AiTaggingInput, AiTaggingOutput, FileId, HpError, HpResult, MediaType,
};
use hp_store::RepoDb;

use crate::provider::AiTaggingProvider;
use crate::task::AiTaskQueue;
use crate::writeback::{writeback, WritebackOutcome};

/// 单个任务执行成果。
#[derive(Debug, Clone, PartialEq)]
pub struct AiRunOutcome {
    pub task_id: String,
    pub file_id: FileId,
    pub output: AiTaggingOutput,
    pub writeback: WritebackOutcome,
}

/// AI 打标服务（内存队列 + 回写）。
#[derive(Debug, Default)]
pub struct AiTaggingService {
    queue: AiTaskQueue,
}

impl AiTaggingService {
    pub fn new() -> Self {
        Self {
            queue: AiTaskQueue::new(),
        }
    }

    /// 只读访问任务队列。
    pub fn queue(&self) -> &AiTaskQueue {
        &self.queue
    }

    /// 提交打标任务；第一期仅图片（D17），非图片返回 `validation`。
    pub fn submit(
        &mut self,
        db: &RepoDb,
        repo_id: &str,
        file_ids: &[String],
        provider_config_id: &str,
        options_json: &str,
    ) -> HpResult<Vec<String>> {
        let mut ids = Vec::new();
        for file_id in file_ids {
            let file = db
                .get_file(file_id)?
                .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
            if file.media_type != MediaType::Image {
                return Err(HpError::InvalidArgument(format!(
                    "第一期 AI 打标仅支持图片: {file_id}"
                )));
            }
            let id = self.queue.enqueue(
                repo_id,
                file.id.clone(),
                AiProviderConfigId::from_raw(provider_config_id),
                options_json,
            );
            ids.push(id);
        }
        Ok(ids)
    }

    /// 执行下一个任务并回写结果；队列为空返回 `None`。
    pub fn run_next(
        &mut self,
        db: &mut RepoDb,
        provider: &dyn AiTaggingProvider,
    ) -> HpResult<Option<AiRunOutcome>> {
        let Some(task) = self.queue.take_next() else {
            return Ok(None);
        };

        let file = db
            .get_file(task.file_id.as_str())?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {}", task.file_id.as_str())))?;
        if file.media_type != MediaType::Image {
            self.queue.mark_failed(&task.id);
            return Err(HpError::InvalidArgument("第一期 AI 打标仅支持图片".into()));
        }

        let source = db
            .get_source(file.source_id.as_str())?
            .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str())))?;
        let image_path = Path::new(&source.local_path).join(&file.relative_path);

        let input = AiTaggingInput {
            file_id: file.id.clone(),
            provider_config_id: task.provider_config_id.clone(),
            options_json: task.options_json.clone(),
        };

        match provider.tag_image(&input, &image_path) {
            Ok(output) => {
                let outcome =
                    writeback(db, &task.repo_id, task.file_id.as_str(), &output)?;
                self.queue.mark_done(&task.id);
                Ok(Some(AiRunOutcome {
                    task_id: task.id,
                    file_id: file.id,
                    output,
                    writeback: outcome,
                }))
            }
            Err(e) => {
                self.queue.mark_failed(&task.id);
                Err(e)
            }
        }
    }

    /// 执行队列中全部任务。
    pub fn run_all(
        &mut self,
        db: &mut RepoDb,
        provider: &dyn AiTaggingProvider,
    ) -> HpResult<Vec<AiRunOutcome>> {
        let mut out = Vec::new();
        while let Some(run) = self.run_next(db, provider)? {
            out.push(run);
        }
        Ok(out)
    }
}
