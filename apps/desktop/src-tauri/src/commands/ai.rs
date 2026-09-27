//! M5：AI 打标命令桥接（ai.*，D6/D17 / commands-events.md §3.8）。
//!
//! 第一期仅图片；具体推理由外部进程插件提供，宿主先提供接口骨架与占位提供方。

use std::path::Path;

use hp_ai::AiTaggingProvider;
use hp_core::{AiProviderConfig, AiTaggingInput, AiTaggingOutput, HpError, HpResult};
use serde::Serialize;
use tauri::State;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::shared::{
    api_from_hp, ensure_global, global, global_mut, lock_global, lock_repo, open_repo,
    open_repo_mut, ApiResponse,
};
use crate::AppState;

#[derive(Serialize)]
pub(crate) struct AiConfigItem {
    id: String,
    provider: String,
    model: Option<String>,
    config_json: String,
    created_at: String,
}

#[derive(Serialize)]
pub(crate) struct AiTaskItem {
    task_id: String,
    status: String,
}

#[derive(Serialize)]
pub(crate) struct AiRunSummary {
    processed: usize,
    written: usize,
    overwritten: usize,
    undo_ids: Vec<String>,
}

fn config_to_item(c: AiProviderConfig) -> AiConfigItem {
    AiConfigItem {
        id: c.id.as_str().to_string(),
        provider: c.provider,
        model: c.model,
        config_json: c.config_json,
        created_at: c.created_at,
    }
}

/// 占位提供方：M5 骨架阶段返回空候选；真实推理由外部进程插件注入。
struct PlaceholderProvider;

impl AiTaggingProvider for PlaceholderProvider {
    fn name(&self) -> &str {
        "placeholder"
    }
    fn model(&self) -> &str {
        "placeholder"
    }
    fn tag_image(&self, _input: &AiTaggingInput, _image_path: &Path) -> HpResult<AiTaggingOutput> {
        Ok(AiTaggingOutput {
            tags: Vec::new(),
            source_model: self.model().to_string(),
            generated_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| String::new()),
        })
    }
}

/// ai.config.create：创建 AI 提供方配置引用（不保存密钥明文）。
#[tauri::command]
pub(crate) fn ai_config_create(
    provider: String,
    model: Option<String>,
    config_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<AiConfigItem> {
    let outcome = (|| -> HpResult<AiConfigItem> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        let cfg = g.create_ai_provider_config(&provider, model.as_deref(), &config_json)?;
        Ok(config_to_item(cfg))
    })();
    api_from_hp(outcome)
}

/// ai.config.list：列出 AI 提供方配置。
#[tauri::command]
pub(crate) fn ai_config_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<AiConfigItem>> {
    let outcome = (|| -> HpResult<Vec<AiConfigItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let rows = g.list_ai_provider_configs()?;
        Ok(rows.into_iter().map(config_to_item).collect())
    })();
    api_from_hp(outcome)
}

/// ai.config.remove：删除 AI 提供方配置。
#[tauri::command]
pub(crate) fn ai_config_remove(
    config_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.remove_ai_provider_config(&config_id)
    })();
    api_from_hp(outcome)
}

/// ai.tagging.submit：提交 AI 打标任务（仅图片，D17），返回任务 ID 列表。
#[tauri::command]
pub(crate) fn ai_tagging_submit(
    repo_id: String,
    file_ids: Vec<String>,
    provider_config_id: String,
    options: Option<String>,
    state: State<AppState>,
) -> ApiResponse<Vec<String>> {
    let outcome = (|| -> HpResult<Vec<String>> {
        let options = options.unwrap_or_else(|| "{}".to_string());
        let mut ai = state
            .ai
            .lock()
            .map_err(|_| HpError::Store("AI 队列锁中毒".into()))?;
        let guard = lock_repo(&state)?;
        let db = open_repo(&guard)?;
        ai.submit(db, &repo_id, &file_ids, &provider_config_id, &options)
    })();
    api_from_hp(outcome)
}

/// ai.tagging.status：查询任务状态。
#[tauri::command]
pub(crate) fn ai_tagging_status(
    task_id: String,
    state: State<AppState>,
) -> ApiResponse<Option<AiTaskItem>> {
    let outcome = (|| -> HpResult<Option<AiTaskItem>> {
        let ai = state
            .ai
            .lock()
            .map_err(|_| HpError::Store("AI 队列锁中毒".into()))?;
        Ok(ai.queue().get(&task_id).map(|t| AiTaskItem {
            task_id: t.id.clone(),
            status: t.status.as_str().to_string(),
        }))
    })();
    api_from_hp(outcome)
}

/// ai.tagging.run：执行队列中的打标任务（骨架阶段用占位提供方，不产生候选 tag）。
#[tauri::command]
pub(crate) fn ai_tagging_run(state: State<AppState>) -> ApiResponse<AiRunSummary> {
    let outcome = (|| -> HpResult<AiRunSummary> {
        let mut ai = state
            .ai
            .lock()
            .map_err(|_| HpError::Store("AI 队列锁中毒".into()))?;
        let mut guard = lock_repo(&state)?;
        let db = open_repo_mut(&mut guard)?;

        let runs = ai.run_all(db, &PlaceholderProvider)?;
        let mut summary = AiRunSummary {
            processed: runs.len(),
            written: 0,
            overwritten: 0,
            undo_ids: Vec::new(),
        };
        for run in runs {
            summary.written += run.writeback.written;
            summary.overwritten += run.writeback.overwritten;
            summary.undo_ids.extend(run.writeback.undo_ids);
        }
        Ok(summary)
    })();
    api_from_hp(outcome)
}
