//! 宿主级状态（全局库、面板 schema 缓存、监督注册表、AI 队列、tag 库）的唯一加锁入口。

use super::events::diag_log;
use super::paths::global_db_path;
use super::prelude::*;

/// 懒加载全局配置库（幂等；**不碰 `AppHandle`**——D195 之前这个参数是死的）。
pub(crate) fn ensure_global(state: &AppState) -> HpResult<()> {
    {
        let mut guard = lock_global(state)?;
        if guard.is_none() {
            let path = global_db_path().map_err(HpError::Io)?;
            *guard = Some(GlobalDb::open(&path)?);
        }
    }
    crate::commands::plugin::seed_bundled_plugins_once(state);
    Ok(())
}

/// 取全局库句柄的**唯一入口**（D195）：先确保已初始化，再取锁。
///
/// 顺序是结构性的——调用方不可能先锁后初始化，也就不需要记住这条规矩。
/// 其余模块不得直接 `lock_global`（`pnpm check:db-boundary` 有一条反向断言守着）。
pub(crate) fn global_guard(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<GlobalDb>>> {
    ensure_global(state)?;
    lock_global(state)
}

/// 锁住全局库（毒锁 → `Store`）。只允许 [`global_guard`] 与 `shared.rs` 内部使用。
pub(crate) fn lock_global(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<GlobalDb>>> {
    state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))
}

/// 取全局库（未初始化 → `not_found`：全局库还没打开）。
pub(crate) fn global<'g, 'a>(
    guard: &'g std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g GlobalDb> {
    guard
        .as_ref()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 同 [`global`]，可变借用（写操作）。
pub(crate) fn global_mut<'g, 'a>(
    guard: &'g mut std::sync::MutexGuard<'a, Option<GlobalDb>>,
) -> HpResult<&'g mut GlobalDb> {
    guard
        .as_mut()
        .ok_or_else(|| HpError::NotFound("全局库未初始化".into()))
}

/// 在**一次持锁内**跑完一段全局库读操作（D198）：`global_guard` + `global` 两行合一。
///
/// 存在的理由不是省行数，是让「借出 `&GlobalDb` 之后忘了释放 / 在临界区里做慢 IO」
/// 在结构上更难写出来：闭包一出作用域，guard 就落回。返回 `HpResult<T>` 而非
/// `ApiResponse<T>`，好让调用方在成功之后再做**锁外**的后处理（例如 `layout.export`
/// 的落盘）。
pub(crate) fn with_global<T>(
    state: &AppState,
    body: impl FnOnce(&GlobalDb) -> HpResult<T>,
) -> HpResult<T> {
    let guard = global_guard(state)?;
    let db = global(&guard)?;
    body(db)
}

/// 同 [`with_global`]，可变借用（写操作）。
pub(crate) fn with_global_mut<T>(
    state: &AppState,
    body: impl FnOnce(&mut GlobalDb) -> HpResult<T>,
) -> HpResult<T> {
    let mut guard = global_guard(state)?;
    let db = global_mut(&mut guard)?;
    body(db)
}

/// 其余宿主级状态的**唯一**加锁入口（D194）。
///
/// 锁序约定（全文只在这里写一次）：`state` 级互斥量先取、仓库句柄锁后取；
/// `state` 级之间不嵌套。各命令模块不得直接 `state.xxx.lock()`——否则毒锁策略
/// 会重新散开（`pnpm check:db-boundary` 有一条反向断言守着）。
///
/// 毒锁一律映射成 `HpError::Store("…锁中毒")`：宁可让这条命令明确失败，
/// 也不要在"锁已中毒"时假装成功（毒锁通常意味着持锁线程 panic 过，状态已不可信）。
pub(crate) fn lock_panel_schema(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, PanelSchemaCache>> {
    state
        .panel_schema_cache
        .lock()
        .map_err(|_| HpError::Store("面板 schema 缓存锁中毒".into()))
}

/// external-process 进程监督注册表（D40）：重启退避 + 不健康标记。
pub(crate) fn lock_supervision(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, SupervisionRegistry>> {
    state
        .supervision
        .lock()
        .map_err(|_| HpError::Store("监督注册表锁中毒".into()))
}

/// AI 打标队列（D6/D17，内存队列）。
pub(crate) fn lock_ai(state: &AppState) -> HpResult<std::sync::MutexGuard<'_, AiTaggingService>> {
    state
        .ai
        .lock()
        .map_err(|_| HpError::Store("AI 队列锁中毒".into()))
}

/// 内置 tag 基底库（RFC 0008 四库，延迟加载；未装配时是 `None`）。
pub(crate) fn lock_tag_lib(
    state: &AppState,
) -> HpResult<std::sync::MutexGuard<'_, Option<TagLibSet>>> {
    state
        .tag_lib
        .lock()
        .map_err(|_| HpError::Store("tag 库锁中毒".into()))
}

/// 替换已装配的 tag 库（启动装配 / tag 扩展变更后重装配）。
///
/// 返回 `false` = 毒锁；调用方自己决定是否记日志（启动路径不该因此起不来）。
pub(crate) fn set_tag_lib(state: &AppState, set: TagLibSet) -> bool {
    match state.tag_lib.lock() {
        Ok(mut guard) => {
            *guard = Some(set);
            true
        }
        Err(_) => false,
    }
}

/// 全局库的**降级**读取口：未初始化或毒锁时返回 `None`（并记一条日志）。
///
/// 只给"读不到就按缺省"的路径用（MCP 配置读取：缺省关闭，失败不会误开服务）；
/// 其余命令一律用 [`lock_global`]，把毒锁变成明确错误。
pub(crate) fn try_global<T>(state: &AppState, read: impl FnOnce(&GlobalDb) -> T) -> Option<T> {
    let guard = match state.global_db.lock() {
        Ok(guard) => guard,
        Err(_) => {
            diag_log("全局库锁中毒：本次读按缺省处理");
            return None;
        }
    };
    guard.as_ref().map(read)
}
