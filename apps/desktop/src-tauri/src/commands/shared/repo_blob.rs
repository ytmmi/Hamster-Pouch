//! 按仓库读写的「不透明 JSON 文本项」（界面页分组 D124、面板标记 D134）。
//!
//! **D213（2026-11-15）**：这两个命令族原本各自 62 / 64 行、逐段同形——同一段
//! 「校验 repoId → 取全局库 → 拼 `{prefix}.{repoId}` 键 → 读/写 → 空白当未设置」
//! 被抄了两遍，连注释都在互相指认（`interface_pages.rs` 说「对照 D54」，
//! `panel_marks.rs` 说「对照 D124」）。同一件事写两遍，规则就会各自漂移：
//! 「空串算清空还是算值」「写入要不要 trim」「空白读回算不算未设置」三处口径
//! 一旦分叉，前端拿到的就是两套语义。
//!
//! 语义边界仍然不变：桥接层**不解析**内容，分组 / 标记的形状与校验都在前端
//! （`shared/interfacePages.ts`、`shared/panelMarks.ts`）；这里只负责**存哪儿**
//! 与**什么算空**。落点仍是全局库的 `app_settings`（观感状态，不需要事务与迁移）。

use super::prelude::*;
use super::with_global;

/// 设置键：`{prefix}.{repoId}`。空 repoId 无法定位键，直接按非法参数拒绝。
///
/// 前缀是「哪种 UI 状态」（`interfacePages` / `panelMarks`），不是注册表里的命名空间，
/// 因此不需要集中登记；新增一类状态只传自己的前缀。
fn repo_blob_key(prefix: &str, repo_id: &str) -> HpResult<String> {
    let trimmed = repo_id.trim();
    if trimmed.is_empty() {
        return Err(HpError::InvalidArgument("repoId 不能为空".to_string()));
    }
    Ok(format!("{prefix}.{trimmed}"))
}

/// 读一份仓库级文本项：**空白与「未设置」同义**（前端解析空串本来就会落回空状态）。
pub(crate) fn get_repo_blob(
    state: &AppState,
    prefix: &str,
    repo_id: &str,
) -> HpResult<Option<String>> {
    let key = repo_blob_key(prefix, repo_id)?;
    with_global(state, |g| {
        Ok(g.get_setting(&key)?.filter(|v| !v.trim().is_empty()))
    })
}

/// 覆盖写入一份仓库级文本项（空串 = 清空）：写入前 trim，避免两侧空白让「同值不写」失效。
pub(crate) fn set_repo_blob(
    state: &AppState,
    prefix: &str,
    repo_id: &str,
    value: &str,
) -> HpResult<()> {
    let key = repo_blob_key(prefix, repo_id)?;
    with_global(state, |g| g.set_setting(&key, value.trim()))
}
