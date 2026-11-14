//! 文件命令族：元数据 / 查询 / 路径 / 重命名 / 回收站 / 标记 / 复核（本文件）、
//! 缩略图与预览取数（preview）、重分析与回填两条长任务（task）。
//!
//! D76 迁移状态：已包装（批次 file，2026-09）。全部命令返回
//! { ok, data?, error? }，错误为结构化 HpError（code 取闭集
//! validation / not_found / permission / plugin / io / conflict）；
//! 前端 api/file.ts 经 invokeApi 解包，界面按 code 走 i18n（D27）。
//!
//! 为什么是目录（D217）：原单文件 1032 行，把三件互不相干的事塞在一起——
//! 缩略图/预览的取数策略（白名单、原图回退的三条判据）、两条长任务的线程骨架、
//! 以及一批只读写库的命令。距 check:line-count 的 1200 行上限只剩 168 行，
//! 三类改动的理由又各不相同（改取图策略不该动任务线程）。现在拆成三份：
//! preview 只管取图，task 只管经 task_shell 起线程并映射三态事件，
//! 本文件留着其余命令与两个回归用例。

pub(crate) mod preview;
pub(crate) mod task;

pub(crate) use task::start_backfill;

use crate::AppState;
use crate::commands::shared::{
    AlbumFileItem, ApiResponse, api_from_hp, file_to_item, resolve_file_path, with_repo,
    with_repo_mut,
};
use hp_core::{HpError, HpResult, MediaType};
use hp_media::extract_exif;
use hp_scanner::ScanOptions;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub(crate) struct FileMetadataResult {
    id: String,
    source_id: String,
    relative_path: String,
    media_type: String,
    /// 文件的**标记集合**（D102：可多值、与类目正交）。
    marks: Vec<String>,
    content_hash: Option<String>,
    size: i64,
    mtime: String,
    verify_status: String,
    media_info_json: Option<String>,
    exif_json: Option<String>,
    /// 图片的**显示宽高**（EXIF 方向已应用，0043）；`None` = 非图片或未回填。
    width: Option<u32>,
    height: Option<u32>,
}

/// file.metadata：读取文件元数据（图片附 EXIF，视频附 ffprobe 缓存）。
#[tauri::command]
pub(crate) fn file_metadata(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<FileMetadataResult> {
    let outcome = with_repo(&state, &repo_id, |db| {
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;

        let exif_json = if file.media_type == MediaType::Image {
            resolve_file_path(db, &file)
                .ok()
                .and_then(|path| extract_exif(&path).ok())
                .map(|e| e.raw_json)
        } else {
            None
        };

        Ok(FileMetadataResult {
            id: file.id.as_str().to_string(),
            source_id: file.source_id.as_str().to_string(),
            relative_path: file.relative_path,
            media_type: file.media_type.as_str().to_string(),
            marks: file.marks.iter().map(|m| m.as_str().to_string()).collect(),
            content_hash: file.content_hash,
            size: file.size,
            mtime: file.mtime,
            verify_status: file.verify_status.as_str().to_string(),
            media_info_json: file.media_info_json,
            exif_json,
            width: file.width,
            height: file.height,
        })
    });
    api_from_hp(outcome)
}

/// `file.query` 的过滤条件（契约里的 `filter` 对象）。
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileQueryFilterArgs {
    /// 只返回这些媒体类型（`image` / `video` / `audio` / `text` / `pdf`）；缺省或空数组 = 不筛。
    ///
    /// **集合语义**（D95）：媒体预览的「全部」= 图片/视频/音频这三个，
    /// 图书预览 = 文本 + PDF 这两个。
    /// 取值不在闭集内一律 `validation`（歧义即拒绝，不静默回落"不筛"）。
    media_types: Option<Vec<String>>,
    source_id: Option<String>,
    dir_prefix: Option<String>,
}

/// `file.query` 的返回体：本页 + 下一页游标（`null` = 已到末页）。
///
/// **`next_cursor` 必须序列化成驼峰 `nextCursor`**（缺陷 0042，2026-11-09）：
/// 契约（`docs/spec/commands-events.md` 的 `file.query` 行）、前端类型
/// （`shared/types/file.ts`）与 `drainPages`（`mediaPreviewPaging.ts`）读的都是
/// `nextCursor`；此前这里**没有** `rename_all`/`rename`，serde 按字段名出蛇形，
/// `page.nextCursor` 恒为 `undefined` → **真机上永远认为第一页就是末页**，
/// 后台翻页停在 500 张——正是缺陷 0018 的"只能看到 300 张"同一族观感。
/// （夹具测不到：Vite alias 的桩直接返回驼峰字面量。）
/// `book.content` 一族刻意保留蛇形 `next_cursor`（前端类型同为蛇形，契约文档已写明），
/// 与本字段**不同口径**，改动只限 file.query / album.members 这两个分页体。
#[derive(Serialize)]
pub(crate) struct FileQueryPage {
    items: Vec<AlbumFileItem>,
    #[serde(rename(serialize = "nextCursor"))]
    next_cursor: Option<String>,
}

/// file.query：按仓库**游标分页**查询文件索引（D78）。
///
/// - 请求 `{ repoId, filter?, cursor?, limit? }`：`limit` 只是**页大小**；
/// - 响应 `{ items, nextCursor }`：把 `nextCursor` 原样回传即可续页，`null` 表示末页；
/// - **排序键**：`(relative_path, source_id, id)` 升序（见 `hp_repo::FileQueryFilter` 的文档）；
/// - 游标是**键集游标**：翻页途中库内容变动不会漏项/重复（原 `offset` 分页会）。
#[tauri::command]
pub(crate) fn file_query(
    repo_id: String,
    filter: Option<FileQueryFilterArgs>,
    cursor: Option<String>,
    limit: Option<i64>,
    state: State<AppState>,
) -> ApiResponse<FileQueryPage> {
    let outcome = (|| -> HpResult<FileQueryPage> {
        let filter = filter.unwrap_or_default();
        // 媒体类型集合：**逐个校验**，出现未知取值即拒（不静默丢掉那一项，
        // 否则"选了没生效"会被伪装成"筛出来是空的"）。
        let media_types: Vec<MediaType> = filter
            .media_types
            .unwrap_or_default()
            .iter()
            .map(|s| {
                MediaType::from_str(s)
                    .ok_or_else(|| HpError::InvalidArgument(format!("未知媒体类型: {s}")))
            })
            .collect::<HpResult<Vec<_>>>()?;
        let parsed_cursor = match cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(hp_repo::FileQueryCursor::decode(raw)?),
        };
        with_repo(&state, &repo_id, |db| {
            let (rows, next) = db.query_files(
                &repo_id,
                &hp_repo::FileQueryFilter {
                    media_types: &media_types,
                    source_id: filter.source_id.as_deref(),
                    dir_prefix: filter.dir_prefix.as_deref(),
                },
                parsed_cursor.as_ref(),
                limit.unwrap_or(500),
            )?;
            Ok(FileQueryPage {
                items: rows.into_iter().map(file_to_item).collect(),
                next_cursor: next.map(|c| c.encode()),
            })
        })
    })();
    api_from_hp(outcome)
}

/// file.path：返回文件绝对路径（供前端 `convertFileSrc` 预览）。
#[tauri::command]
pub(crate) fn file_path(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<String> {
    let outcome = with_repo(&state, &repo_id, |db| {
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let path = resolve_file_path(db, &file)?;
        Ok(path.to_string_lossy().to_string())
    });
    api_from_hp(outcome)
}

/// file.rename：重命名文件（磁盘重命名 + 更新索引相对路径）。
#[tauri::command]
pub(crate) fn file_rename(
    repo_id: String,
    file_id: String,
    new_name: String,
    state: State<AppState>,
) -> ApiResponse<AlbumFileItem> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(HpError::InvalidArgument("文件名不能为空".into()));
        }
        if new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".."
        {
            return Err(HpError::InvalidArgument("文件名非法".into()));
        }

        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let old_path = resolve_file_path(db, &file)?;
        let parent = old_path
            .parent()
            .ok_or_else(|| HpError::Io("无法解析文件父目录".into()))?;
        let target = parent.join(new_name);
        if target.exists() {
            return Err(HpError::AlreadyExists(format!(
                "目标文件已存在: {new_name}"
            )));
        }
        std::fs::rename(&old_path, &target).map_err(|e| HpError::Io(format!("重命名失败: {e}")))?;

        // 新相对路径 = 原目录部分 + 新文件名
        let new_rel = match file.relative_path.rsplit_once(['/', '\\']) {
            Some((dir, _)) => format!("{dir}/{new_name}"),
            None => new_name.to_string(),
        };
        db.update_file_path(&file_id, file.source_id.as_str(), &new_rel)?;
        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(file_to_item(updated))
    });
    api_from_hp(outcome)
}

/// file.trash：将文件批量移入系统回收站，并从索引移除；返回成功数。
#[tauri::command]
pub(crate) fn file_trash(
    repo_id: String,
    file_ids: Vec<String>,
    state: State<AppState>,
) -> ApiResponse<u32> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        let mut removed: Vec<String> = Vec::new();
        for id in &file_ids {
            let Some(file) = db.get_file(id)? else {
                continue;
            };
            if let Ok(path) = resolve_file_path(db, &file)
                && path.exists()
            {
                trash::delete(&path).map_err(|e| HpError::Io(format!("移入回收站失败: {e}")))?;
            }
            removed.push(id.clone());
        }
        db.delete_files(&removed)?;
        Ok(removed.len() as u32)
    });
    api_from_hp(outcome)
}

/// file.setMarks：**增删**一组文件的标记（D102 用户口径："book 为标记，标记可以交叉"）。
///
/// 标记是**可多值**的（一个文件可以同时带 `book` 与 `manga`），因此接口是"加哪些、
/// 减哪些"而不是"设成什么"：`add` / `remove` 各自幂等，重复点击不会累积重复行。
///
/// `marks` 的取值是**可注册清单**的 id；这里只校验**命名规则**（与"插件缺失的节点类型"
/// 同口径）——未注册的标记**允许写入**（清单可注册，注册后自动生效），不静默丢弃。
///
/// 与 `file.rename` / `file.trash` 同一形状（`repoId` 只作上下文，实际库由当前打开的
/// 仓库决定）；返回实际改动的文件数（不存在的 id 静默跳过，与 `file.trash` 同口径）。
#[tauri::command]
pub(crate) fn file_set_marks(
    repo_id: String,
    file_ids: Vec<String>,
    add: Option<Vec<String>>,
    remove: Option<Vec<String>>,
    state: State<AppState>,
) -> ApiResponse<u32> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        let add = add.unwrap_or_default();
        let remove = remove.unwrap_or_default();
        // 标记 id 必须命名合法（不合规则的才拒绝；未注册的允许写入，见命令文档）。
        for mark in add.iter().chain(remove.iter()) {
            if !hp_core::is_valid_namespaced_id(mark) {
                return Err(HpError::InvalidArgument(format!(
                    "标记命名不合规则: {mark}"
                )));
            }
        }
        // 只写**存在**的 id：不存在的静默跳过（与 trash 同口径）。
        let existing: Vec<String> = file_ids
            .into_iter()
            .filter(|id| matches!(db.get_file(id), Ok(Some(_))))
            .collect();
        let changed = db.set_file_marks(&existing, &add, &remove)?;
        Ok(changed as u32)
    });
    api_from_hp(outcome)
}

/// file.reverify：重新校验单个文件（重算内容哈希与状态），返回校验状态。
#[tauri::command]
pub(crate) fn file_reverify(
    repo_id: String,
    file_id: String,
    state: State<AppState>,
) -> ApiResponse<String> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        let file = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        let source = db
            .get_source(file.source_id.as_str())?
            .ok_or_else(|| HpError::NotFound("媒体源不存在".into()))?;

        let options = ScanOptions {
            full: true,
            ffmpeg_bin: state.ffmpeg_bin.as_ref().clone(),
            ffprobe_bin: state.ffprobe_bin.as_ref().clone(),
            thumbnail_cache: Some((*state.thumb_cache).clone()),
            ..ScanOptions::default()
        };
        state
            .scanner
            .rescan_file(db, &source, &file.relative_path, &options, None)?;

        let updated = db
            .get_file(&file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))?;
        Ok(updated.verify_status.as_str().to_string())
    });
    api_from_hp(outcome)
}

#[cfg(test)]
mod wire_shape_tests {
    //! 缺陷 0042 的回归钉子：**分页游标在 JSON 上必须是 `nextCursor`**。    //!
    //! 真机验证（2026-11-09）发现 `FileQueryPage` 没有 `rename_all`/`rename` 时
    //! serde 出蛇形 `next_cursor`，而契约（`docs/spec/commands-events.md` 的
    //! `file.query` 行）、前端类型（`shared/types/file.ts`）与 `drainPages`
    //! 读的都是 `nextCursor` —— 真机上第一页永远被当成末页，后台翻页停在 500 张。
    //! 夹具（Vite alias 桩）直接返回驼峰字面量，所以这条断裂**只有真机能看见**；
    //! 这里把"序列化出来的键名"钉成断言，让它不再依赖人工。

    use super::*;

    #[test]
    fn file_query_page_serializes_cursor_as_camel_case() {
        let page = FileQueryPage {
            items: vec![],
            next_cursor: Some("cursor-value".into()),
        };
        let json = serde_json::to_value(&page).expect("序列化应成功");
        let obj = json.as_object().expect("返回体应是对象");
        assert!(
            obj.contains_key("nextCursor"),
            "键名必须是 nextCursor，实际 {obj:?}"
        );
        assert!(!obj.contains_key("next_cursor"), "不得再出蛇形键");
    }
}
