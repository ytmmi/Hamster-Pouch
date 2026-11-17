//! 文件命令族里的两条长任务：重分析（file.reanalyze）与回填（file.backfill）。
//!
//! 线程骨架与三态事件的映射位置都在 commands/task_shell.rs（D196）：本文件只写闭包体
//! 与事件载荷，不得自己 spawn_blocking、不得自己 catch_unwind。

use crate::AppState;
use crate::commands::shared::{
    ApiAsync, ApiResponse, EmitHp, api_async, api_from_hp, diag_log, ensure_repo_binding,
};
use crate::commands::source::{ScanCompletedEvent, ScanErrorEvent, ScanProgressEvent};
use crate::tasks::{TaskControl, TaskKind};
use hp_core::{HpError, HpResult};
use hp_dto::{FileBackfillCompletedPayload, FileBackfillProgressPayload};
use hp_repo::RepoDb;
use hp_scanner::ScanOptions;
use tauri::State;

/// file.reanalyze：重新分析单个文件（重算哈希 / 缩略图 / 媒体信息 / **调色板**）并更新索引。
///
/// **与源扫描同款的后台任务**（用户口径 2026-09："右键分析文件，分析时要和源全量时同款弹窗"）：
/// 命令**立即返回 `taskId`**，进度浮窗、取消按钮、完成后的状态与刷新全部复用 `scan.*` 事件族
/// ——前端 `core/taskStore.ts` 只认事件、不认命令，因此"同款浮窗"就是"发同一族事件"。
///
/// 三处与整源扫描一致的约束（都抄自 `source_scan`，理由相同）：
/// - **独立仓库库连接**（`RepoDb::open`）：不持有仓库句柄锁（D192 起是 `AppState::repo`），分析大视频时界面别的命令
///   不会排队（旧实现是同步命令 + 主连接，界面会卡住且没有任何进度）；
/// - **单任务闸门**：已有长任务在跑时明确报错，而不是堆叠并行写；
/// - **必定发一条终止事件**（completed / error，含 panic 收敛），否则前端浮窗永远停在原地。
#[tauri::command]
pub(crate) async fn file_reanalyze(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiAsync<String> {
    let st = state.inner().clone();
    let body_app = app.clone();
    // 起线程之前先把仓库绑定校验掉：旧 repoId 不该等到后台线程里才查空（D200）。
    let outcome = ensure_repo_binding(&state, &repo_id).and_then(|()| {
        crate::commands::task_shell::spawn_repo_task(
            &state,
            &app,
            TaskKind::Analyze,
            crate::commands::task_shell::BUSY_CANCELLABLE,
            move |control, repo_path| run_reanalyze(&st, &body_app, &control, &file_id, &repo_path),
            move |app_handle, task_id, result| match result {
                Ok(Ok((source_id, outcome))) => app_handle.emit_hp(
                    "scan.completed",
                    ScanCompletedEvent {
                        task_id: task_id.to_string(),
                        source_id,
                        indexed: outcome.indexed,
                        changed: outcome.changed,
                        missing: outcome.missing,
                        removed: outcome.removed,
                        skipped: outcome.skipped,
                        cancelled: outcome.cancelled,
                    },
                ),
                Ok(Err((source_id, error))) => app_handle.emit_hp(
                    "scan.error",
                    ScanErrorEvent {
                        task_id: task_id.to_string(),
                        source_id,
                        error: error.to_string(),
                    },
                ),
                Err(_) => app_handle.emit_hp(
                    "scan.error",
                    ScanErrorEvent {
                        task_id: task_id.to_string(),
                        source_id: String::new(),
                        error: "分析线程异常终止".into(),
                    },
                ),
            },
        )
    });
    api_async(api_from_hp(outcome))
}

/// 在后台线程执行单文件分析（独立连接，不占用主连接锁）。
///
/// **进度**只发一帧：`total = 0`（总数未知 → 浮窗按不定进度显示）+ `pausable = false`
/// （分析没有暂停点）。这一帧的作用是让浮窗**立刻出现**并显示正在分析的文件名，
/// 随后由 `scan.completed` 收起。
///
/// **取消的边界**：`cancel` 只在开工前被检查（`Scanner::rescan_file` 的入口），
/// 一旦开始哈希/抽帧/提调色板就不可中断——与源扫描"每个文件之间检查"是同一口径，
/// 不假装能中途停下。因此"开工后到达的取消"仍会把该文件的产物落库，事件按
/// `cancelled: true` 上报（取消 = 已停止继续做，不是"什么都没做"）。
fn run_reanalyze(
    state: &AppState,
    app: &tauri::AppHandle,
    control: &TaskControl,
    file_id: &str,
    repo_path: &std::path::Path,
) -> Result<(String, hp_scanner::ScanOutcome), (String, HpError)> {
    let mut db = match RepoDb::open(repo_path) {
        Ok(db) => db,
        Err(e) => return Err((String::new(), e)),
    };
    let file = match db.get_file(file_id) {
        Ok(Some(file)) => file,
        Ok(None) => {
            return Err((
                String::new(),
                HpError::NotFound(format!("文件不存在: {file_id}")),
            ));
        }
        Err(e) => return Err((String::new(), e)),
    };
    // 从这里起错误都带上 source_id：终止事件需要它（浮窗/状态按源归位）。
    let source_id = file.source_id.to_string();
    let source = match db.get_source(file.source_id.as_str()) {
        Ok(Some(source)) => source,
        Ok(None) => return Err((source_id, HpError::NotFound("媒体源不存在".into()))),
        Err(e) => return Err((source_id, e)),
    };

    app.emit_hp(
        "scan.progress",
        ScanProgressEvent {
            task_id: control.task_id().to_string(),
            source_id: source_id.clone(),
            processed: 0,
            total: 0,
            phase: "indexing".into(),
            current: Some(file.relative_path.clone()),
            pausable: false,
        },
    );

    let options = ScanOptions {
        full: true,
        ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
        ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
        thumbnail_cache: Some((*state.thumb_cache).clone()),
        ..ScanOptions::default()
    };
    let cancel = control.cancel_flag();
    match state.scanner.rescan_file(
        &mut db,
        &source,
        &file.relative_path,
        &options,
        Some(&cancel),
    ) {
        Ok(outcome) => Ok((source_id, outcome)),
        Err(e) => Err((source_id, e)),
    }
}

// ───────────────────────── 图片尺寸回填（缺陷 0043 阶段 2）─────────────────────────

/// 每批回填的行数。64 行足够摊薄一次 `RepoDb::open` 之外的开销，又不会让"取消"
/// 在长批次后面等太久（每行只是一次读头，远小于一次解码）。
const BACKFILL_BATCH: i64 = 64;
/// 进度事件的节流间隔。回填是后台任务，不需要 80 ms 那种实时性；
/// 一秒钟几帧已经够浮窗的进度条动了，再多只是白耗 IPC。
const BACKFILL_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// 回填一轮的结果（也用于给前端发收尾事件）。
struct BackfillOutcome {
    filled: u64,
    failed: u64,
    cancelled: bool,
}

/// 启动一轮图片尺寸回填；返回任务 ID。
///
/// 供两处调用：命令 `file.backfill`（用户在设置里手动触发）与 `repo.open` 之后
/// 的自动触发。**闸门与扫描共用**（`TaskRegistry` 单任务）：已有任务在跑时直接返回
/// `AlreadyExists`，调用方（自动触发那条路径）按"本轮跳过"处理，不排队——
/// 排队会让"打开仓库后不久又开扫描"变成一条看不见的队列。
pub(crate) fn start_backfill(
    app: &tauri::AppHandle,
    state: &AppState,
    repo_path: std::path::PathBuf,
) -> HpResult<String> {
    let body_app = app.clone();
    crate::commands::task_shell::spawn_task_at(
        state,
        app,
        TaskKind::Backfill,
        crate::commands::task_shell::BUSY_CANCELLABLE,
        repo_path,
        move |control, repo_path| run_backfill(&body_app, &control, &repo_path),
        move |app_handle, task_id, result| match result {
            Ok(Ok(outcome)) => app_handle.emit_hp(
                "file.backfill.completed",
                FileBackfillCompletedPayload {
                    task_id: task_id.to_string(),
                    filled: outcome.filled,
                    failed: outcome.failed,
                    cancelled: outcome.cancelled,
                    error: None,
                },
            ),
            Ok(Err(e)) => {
                diag_log(&format!("[backfill] 中止：{e}"));
                app_handle.emit_hp(
                    "file.backfill.completed",
                    FileBackfillCompletedPayload {
                        task_id: task_id.to_string(),
                        filled: 0,
                        failed: 0,
                        cancelled: false,
                        error: Some(e.to_string()),
                    },
                );
            }
            Err(_) => {
                diag_log("[backfill] 线程 panic");
                app_handle.emit_hp(
                    "file.backfill.completed",
                    FileBackfillCompletedPayload {
                        task_id: task_id.to_string(),
                        filled: 0,
                        failed: 0,
                        cancelled: false,
                        error: Some("回填线程异常终止".into()),
                    },
                );
            }
        },
    )
}

/// 回填主体：**键集分页**遍历 `width IS NULL` 的图片行，逐行读头写显示尺寸。
///
/// 两条刻意的取舍：
/// - **读头失败只记数，不写 NULL 之外的东西**：文件可能只是暂时不可达（移动硬盘没插），
///   把它标成"失败"会让下次不再尝试；保持 `NULL` 就是"还没成功过"。**唯一的例外**是
///   「父目录在、文件不在」——那是删掉了，记 `missing_status = 1` 并跳过（D223），扫描
///   重新看到这个文件时 upsert 会把 `missing_status` 写回 0，所以这条标记会自愈。
/// - **每行之间让一下**：回填是后台任务，扫描/浏览正在同时跑，`sleep(1ms)` 让 OS
///   把 CPU 让给前台；节流进度也只按时间，不按行数。
fn run_backfill(
    app: &tauri::AppHandle,
    control: &TaskControl,
    repo_path: &std::path::Path,
) -> HpResult<BackfillOutcome> {
    let mut db = RepoDb::open(repo_path)?;
    let total = db.count_pending_dimensions()?.max(0) as u64;
    let task_id = control.task_id().to_string();
    let mut processed: u64 = 0;
    let mut filled: u64 = 0;
    let mut failed: u64 = 0;
    let mut cancelled = false;
    let mut cursor: Option<String> = None;
    let mut last_emit = std::time::Instant::now();

    let mut emit = |processed: u64, force: bool| {
        if !force && last_emit.elapsed() < BACKFILL_EMIT_INTERVAL {
            return;
        }
        last_emit = std::time::Instant::now();
        app.emit_hp(
            "file.backfill.progress",
            FileBackfillProgressPayload {
                task_id: task_id.clone(),
                processed,
                total,
            },
        );
    };

    if total == 0 {
        return Ok(BackfillOutcome {
            filled: 0,
            failed: 0,
            cancelled: false,
        });
    }
    emit(0, true);

    loop {
        if control.is_cancelled() {
            cancelled = true;
            break;
        }
        let batch = db.next_pending_dimensions(cursor.as_deref(), BACKFILL_BATCH)?;
        if batch.is_empty() {
            break;
        }
        for row in &batch {
            if control.is_cancelled() {
                cancelled = true;
                break;
            }
            cursor = Some(row.file_id.clone());
            let abs = std::path::Path::new(&row.local_path).join(
                row.relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            // 文件确实不在了（**父目录还在**）→ 记缺失并跳过本轮：缺失行不再参与回填，
            // 否则每次打开仓库都要重试一批永远读不到的文件，状态栏永远挂着「失败 N」。
            // 父目录也不在 = 源离线（移动硬盘没插），只算失败、保持 NULL，下次插上再试。
            if !abs.exists() {
                if abs.parent().map(|dir| dir.exists()).unwrap_or(false) {
                    db.set_file_missing(&row.file_id, 1)?;
                    processed += 1;
                    emit(processed, false);
                    continue;
                }
                failed += 1;
                processed += 1;
                emit(processed, false);
                continue;
            }
            match hp_media::display_dimensions(&abs) {
                Some((w, h)) => {
                    if db.backfill_dimensions(&row.file_id, w, h)? {
                        filled += 1;
                    }
                }
                None => failed += 1,
            }
            processed += 1;
            emit(processed, false);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        if cancelled {
            break;
        }
    }
    emit(processed, true);
    Ok(BackfillOutcome {
        filled,
        failed,
        cancelled,
    })
}

/// file.backfill：手动触发一轮图片尺寸回填（设置页/诊断用）。
#[tauri::command]
pub(crate) fn file_backfill(state: State<AppState>, app: tauri::AppHandle) -> ApiResponse<String> {
    let outcome = (|| -> HpResult<String> {
        let repo_path = crate::commands::shared::require_repo_path(&state)?;
        start_backfill(&app, &state, repo_path)
    })();
    api_from_hp(outcome)
}
