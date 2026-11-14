//! 仓库句柄 OpenRepo 的装卸与取用（含 repoId 校验），以及文件路径解析。

use super::prelude::*;

/// 解析文件绝对路径：源本地路径 + 相对路径。
pub(crate) fn resolve_file_path(db: &RepoDb, file: &FileIndexRow) -> HpResult<PathBuf> {
    let source = db
        .get_source(file.source_id.as_str())?
        .ok_or_else(|| HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str())))?;
    Ok(PathBuf::from(source.local_path).join(&file.relative_path))
}

// ===== 打开的仓库库：取用/加锁助手（D76），D192 起单真值 =====

/// 当前打开的仓库句柄：id / 库文件路径 / 连接**同时存在或同时不存在**。
///
/// **为什么合成一个值（D192）**：这三项原先是三个独立 `Mutex`，开库要连加三次锁，
/// 且赋值处用 `if let Ok(..)` 吞掉毒化错误——于是"库开了、id 还是旧仓库"这种中间态
/// 在代码上完全可能，三把锁之间也没有约定顺序。合成一个 `Option<OpenRepo>` 后，
/// 装/卸都是**一次** `*guard = ...`，没有中间态可观察。
/// 字段 `path` 仍单独保留：后台任务要开**独立连接**（`RepoDb` 不可 `Clone`，
/// 且大视频扫描不能长时间占着命令线程共用的那把锁）。
pub(crate) struct OpenRepo {
    /// 全局库 `repos` 行里的仓库 ID（`repo.delete` 判断"是否当前仓库"用）。
    pub(crate) id: String,
    /// 仓库库文件路径（后台任务据此另开连接）。
    pub(crate) path: PathBuf,
    /// 命令线程共用的仓库库连接。
    pub(crate) db: RepoDb,
}

/// 未打开仓库 → `HpError::NotFound`（"目标上下文不存在"）。
///
/// `HpError::code()` 的闭集里没有"前置条件"这一类，最贴近的是 `not_found`：
/// 请求要作用的仓库上下文不存在。**不要**把它写成 `Store`/`Io`——那会把
/// "用户还没打开仓库"误报成读写故障。
pub(crate) fn open_repo<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<OpenRepo>>,
) -> HpResult<&'g RepoDb> {
    guard
        .as_ref()
        .map(|repo| &repo.db)
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 同 [`open_repo`]，可变借用（写操作）。
pub(crate) fn open_repo_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<OpenRepo>>,
) -> HpResult<&'g mut RepoDb> {
    guard
        .as_mut()
        .map(|repo| &mut repo.db)
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}

/// 锁住当前仓库句柄（毒锁 → `Store`）。
pub(crate) fn lock_repo(state: &AppState) -> HpResult<std::sync::MutexGuard<'_, Option<OpenRepo>>> {
    state
        .repo
        .lock()
        .map_err(|_| HpError::Store("仓库锁中毒".into()))
}

/// 装入当前仓库句柄：**一次写入 id / 路径 / 连接**（毒锁 → `Store`）。
pub(crate) fn set_open_repo(state: &AppState, repo: OpenRepo) -> HpResult<()> {
    *lock_repo(state)? = Some(repo);
    Ok(())
}

/// 卸下当前仓库句柄，返回被卸下的那一份（调用方负责 `close`；毒锁 → `Store`）。
pub(crate) fn take_open_repo(state: &AppState) -> HpResult<Option<OpenRepo>> {
    Ok(lock_repo(state)?.take())
}

/// 只在**句柄 id 匹配**时卸下当前仓库句柄（D199）：判断与卸下在同一次持锁内。
///
/// 分开写会有一个窗口：先读 `current_repo_id` 判断，再 `take_open_repo`——两步之间
/// 别的命令换成另一个库，这一刀就切在别人身上（repo.delete 会关错库、还可能删错文件）。
pub(crate) fn take_open_repo_if(state: &AppState, repo_id: &str) -> HpResult<Option<OpenRepo>> {
    let mut guard = lock_repo(state)?;
    if guard.as_ref().is_some_and(|repo| repo.id == repo_id) {
        return Ok(guard.take());
    }
    Ok(None)
}

/// 只在**句柄 id 匹配**时对当前仓库句柄做一次可变操作（D199）。
///
/// 返回 `None` 表示「当前打开的不是这个仓库」，调用方据此决定要不要做后续动作；
/// 与 [`take_open_repo_if`] 一样，匹配判断与动作用的是同一次持锁。
pub(crate) fn with_open_repo_mut<T>(
    state: &AppState,
    repo_id: &str,
    body: impl FnOnce(&mut OpenRepo) -> HpResult<T>,
) -> HpResult<Option<T>> {
    let mut guard = lock_repo(state)?;
    match guard.as_mut() {
        Some(repo) if repo.id == repo_id => Ok(Some(body(repo)?)),
        _ => Ok(None),
    }
}

/// 仓库 id 与当前句柄的一致性校验（D200）。
///
/// 前端把当前仓库 id 带在**每个**命令上，但桥接层过去一律 `let _ = repo_id;` 把它丢掉：
/// 于是「另一个仓库的 id」会被当成当前仓库去查（静默拿到空列表）或直接落库。
/// 这里至少校验一次——不一致说明前端拿的是旧快照，宁可让它重载，也不给语义模糊的结果。
/// 空 id 视为「没带」，沿用当前句柄（兼容只关心「当前仓库」的旧调用）。
fn check_repo_id(open_id: &str, repo_id: &str) -> HpResult<()> {
    if repo_id.is_empty() || repo_id == open_id {
        return Ok(());
    }
    Err(HpError::NotFound(format!(
        "仓库已切换（请求 {repo_id}，当前 {open_id}），请重新加载后再试"
    )))
}

/// 在**一次持锁内**跑完一段仓库库读操作（D200）：`lock_repo` + `open_repo`
/// + id 校验三行合一。
///
/// 与 [`with_global`] 同理：借出的 `&RepoDb` 出闭包即随 guard 落回，
/// 「拿着句柄跨 `await` / 在临界区里做慢 IO」在结构上就写不出来。
pub(crate) fn with_repo<T>(
    state: &AppState,
    repo_id: &str,
    body: impl FnOnce(&RepoDb) -> HpResult<T>,
) -> HpResult<T> {
    let guard = lock_repo(state)?;
    if let Some(open) = guard.as_ref() {
        check_repo_id(&open.id, repo_id)?;
    }
    let db = open_repo(&guard)?;
    body(db)
}

/// 同 [`with_repo`]，可变借用（写操作）。
pub(crate) fn with_repo_mut<T>(
    state: &AppState,
    repo_id: &str,
    body: impl FnOnce(&mut RepoDb) -> HpResult<T>,
) -> HpResult<T> {
    let mut guard = lock_repo(state)?;
    if let Some(open) = guard.as_ref() {
        check_repo_id(&open.id, repo_id)?;
    }
    let db = open_repo_mut(&mut guard)?;
    body(db)
}

/// 只校验仓库绑定、不取用句柄（D200）：后台任务把它提前到命令边界，
/// 让「拿着旧 repoId 起任务」在起线程之前就失败，而不是在后台线程里查空。
pub(crate) fn ensure_repo_binding(state: &AppState, repo_id: &str) -> HpResult<()> {
    with_repo(state, repo_id, |_| Ok(()))
}

/// 当前仓库 ID 的快照（未打开 / 毒锁 → `None`：只读判断，不报错）。
pub(crate) fn current_repo_id(state: &AppState) -> Option<String> {
    state
        .repo
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|repo| repo.id.clone()))
}

/// 当前仓库库文件路径的快照（未打开 / 毒锁 → `None`）。
pub(crate) fn current_repo_path(state: &AppState) -> Option<PathBuf> {
    state
        .repo
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|repo| repo.path.clone()))
}

/// 需要仓库库路径才能继续的任务：未打开 → `not_found`，毒锁 → `store`。
pub(crate) fn require_repo_path(state: &AppState) -> HpResult<PathBuf> {
    let guard = lock_repo(state)?;
    guard
        .as_ref()
        .map(|repo| repo.path.clone())
        .ok_or_else(|| HpError::NotFound("未打开仓库".into()))
}
