//! `book` 的封面覆盖层：`book.cover*` 命令与图片落盘 / 清理。

use super::prelude::*;

use crate::commands::shared::{with_repo, with_repo_mut};

/// 封面图片允许的扩展名（按 magic bytes 判定，不信任用户文件的后缀名）。
pub(crate) const COVER_IMAGE_EXTS: [&str; 6] = ["jpg", "png", "gif", "webp", "bmp", "svg"];

/// 把库里的封面记录转成命令返回体（图片拼成**当前**绝对路径，并确认文件在盘上）。
pub(crate) fn cover_to_result(cover: Option<hp_core::FileCover>) -> BookCoverResult {
    let Some(cover) = cover else {
        return BookCoverResult {
            kind: None,
            value: None,
        };
    };
    match cover.kind {
        hp_core::CoverKind::Color => BookCoverResult {
            kind: Some("color".into()),
            value: Some(cover.value),
        },
        hp_core::CoverKind::Image => {
            // 文件不在盘上（被手工删了 / 换了数据目录）→ 当作**没有覆盖**，
            // 让面板回落默认封面，而不是显示一个坏图。
            let path = crate::commands::shared::user_covers_dir()
                .map(|dir| dir.join(&cover.value))
                .ok()
                .filter(|p| p.exists());
            match path {
                Some(p) => BookCoverResult {
                    kind: Some("image".into()),
                    value: Some(p.to_string_lossy().to_string()),
                },
                None => BookCoverResult {
                    kind: None,
                    value: None,
                },
            }
        }
    }
}

/// `book.covers`：**批量**读一组文件的封面覆盖（只返回**真有覆盖**的那些）。
///
/// **为什么是批量**：图书预览面板一页可能列几百本，逐本发一次 `book.cover`
/// 就是几百次 IPC 往返（与"只为需要内嵌封面的书发 `book.meta`"是同一类浪费，
/// 但封面这里**每本书都可能有**，所以只能靠批量而不是靠跳过）。
/// 调用方按**一页**（≤ `FILE_QUERY_MAX_LIMIT`）传 id，`IN (...)` 的长度因此有界。
///
/// 没有覆盖的书**不出现在结果里**（面板按默认封面渲染），因此返回体大小与
/// "用户设过多少封面"成正比，而不是与"列了多少本书"成正比。
#[tauri::command]
pub(crate) async fn book_covers(
    repo_id: String,
    file_ids: Vec<String>,
    state: State<'_, AppState>,
) -> ApiAsync<Vec<BookCoverItem>> {
    let outcome = with_repo(&state, &repo_id, |db| {
        let covers = db.covers_for_files(&file_ids)?;
        let mut out: Vec<BookCoverItem> = covers
            .into_values()
            .filter_map(|cover| {
                let file_id = cover.file_id.clone();
                // 图片的绝对路径在这里拼（库里的 `value` 只是文件名）；
                // 图片文件不在盘上时 `cover_to_result` 给出 `None` → 整条不返回。
                let resolved = cover_to_result(Some(cover));
                Some(BookCoverItem {
                    file_id,
                    kind: resolved.kind?,
                    value: resolved.value?,
                })
            })
            .collect();
        // 顺序稳定（便于断言与 diff）：按 `file_id` 升序。
        out.sort_by(|a, b| a.file_id.cmp(&b.file_id));
        Ok(out)
    });
    api_async(api_from_hp(outcome))
}

/// `book.cover`：读**单个**文件的封面覆盖（两个字段为 `null` = 没有覆盖）。
///
/// 批量接口（[`book_covers`]）覆盖面板的主路径；本命令服务"菜单打开时确认当前状态"
/// 这类单点查询（改完之后立刻回读一次，不必刷新整页）。
#[tauri::command]
pub(crate) async fn book_cover(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let outcome = with_repo(&state, &repo_id, |db| {
        Ok(cover_to_result(db.get_file_cover(&file_id)?))
    });
    api_async(api_from_hp(outcome))
}

/// `book.setCover`：设置封面覆盖。
///
/// 两种取值（`kind`）：
/// - `color`：`value` 必须是 `#rrggbb`（`hp_core::normalize_cover_color` 规范化）；
/// - `image`：`value` 是**源图片的绝对路径**（用户在系统对话框里挑的那张）。
///   桥接层把它**拷贝**进 `data\user\covers\` 并改名成 `<file_id>.<ext>`——
///   为什么是拷贝而不是记住原路径：原图可能被移动/删除，而封面是"这本书的属性"，
///   不该因为用户整理文件就变成坏图。扩展名按 **magic bytes** 判定，不信任后缀名。
#[tauri::command]
pub(crate) async fn book_set_cover(
    repo_id: String,
    file_id: String,
    kind: String,
    value: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        let cover_kind = hp_core::CoverKind::from_str(&kind)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知的封面种类: {kind}")))?;

        // 图片先落盘再落库：落盘失败就不该留下一行指向不存在文件的记录。
        let stored_value = match cover_kind {
            hp_core::CoverKind::Color => value,
            hp_core::CoverKind::Image => copy_cover_image(&file_id, &value)?,
        };

        // 文件必须存在（外键也要求）：给不存在的 file_id 设封面是调用方的错。
        if db.get_file(&file_id)?.is_none() {
            return Err(HpError::NotFound(format!("文件不存在: {file_id}")));
        }
        let cover = db.upsert_file_cover(&file_id, cover_kind, &stored_value)?;
        // 换过图片时把**同一本书的其他扩展名**文件删掉，避免 `covers\` 里越积越多孤儿。
        if matches!(cover_kind, hp_core::CoverKind::Image) {
            prune_other_cover_images(&file_id, &cover.value);
        }
        Ok(cover_to_result(Some(cover)))
    });
    api_async(api_from_hp(outcome))
}

/// `book.clearCover`：清除封面覆盖，回到默认封面（内嵌封面或文字封面）。
///
/// 同时删掉落盘的图片文件（否则 `covers\` 里会留下再也没人引用的文件）。
#[tauri::command]
pub(crate) async fn book_clear_cover(
    repo_id: String,
    file_id: String,
    state: State<'_, AppState>,
) -> ApiAsync<BookCoverResult> {
    let outcome = with_repo_mut(&state, &repo_id, |db| {
        // 先取旧值：删除之后才知道该删哪个文件。
        let previous = db.get_file_cover(&file_id)?;
        db.delete_file_cover(&file_id)?;
        if let Some(hp_core::FileCover {
            kind: hp_core::CoverKind::Image,
            value,
            ..
        }) = previous
            && let Ok(dir) = crate::commands::shared::user_covers_dir()
        {
            let _ = std::fs::remove_file(dir.join(value));
        }
        Ok(BookCoverResult {
            kind: None,
            value: None,
        })
    });
    api_async(api_from_hp(outcome))
}

/// 把用户挑的图片拷进 `data\user\covers\`，返回**落库用的裸文件名**。
///
/// 文件名用 `<file_id>.<ext>`：按文件 id 命名，因此同一本书换图就是**覆盖同一个文件**
/// （除了扩展名变化，见 [`prune_other_cover_images`]），不会每次换图都堆一个新文件。
pub(crate) fn copy_cover_image(file_id: &str, src_path: &str) -> HpResult<String> {
    let src = Path::new(src_path);
    let bytes = std::fs::read(src)
        .map_err(|e| HpError::Io(format!("读取封面图片失败 {}: {e}", src.display())))?;
    // 扩展名按 **magic bytes** 判定：用户可能挑了一个后缀名与内容不符的文件
    // （更常见的是 `.jpeg` / `.JPG` 这类大小写差异），信任后缀名会让前端拿错格式。
    let ext = hp_book::detect_image_ext(&bytes).ok_or_else(|| {
        HpError::InvalidArgument(format!(
            "认不出的图片格式（支持 {}）：{}",
            COVER_IMAGE_EXTS.join(" / "),
            src.display()
        ))
    })?;
    // `file_id` 进文件名前必须确认它本身是安全的（不含分隔符）——它来自前端参数，
    // 直接拼进路径就是一次目录穿越（与 `is_safe_cover_file_name` 同一条边界）。
    let name = format!("{file_id}.{ext}");
    if !hp_core::is_safe_cover_file_name(&name) {
        return Err(HpError::InvalidArgument(format!(
            "文件 ID 不能用作文件名: {file_id}"
        )));
    }
    let dir = crate::commands::shared::user_covers_dir().map_err(HpError::Io)?;
    // 原子落盘：先写临时文件再改名，避免前端在"写了一半"时读到它。
    let target = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| HpError::Io(format!("写入封面失败: {e}")))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        HpError::Io(format!("提交封面失败: {e}"))
    })?;
    Ok(name)
}

/// 删掉同一个 `file_id` 的**其他**封面图片（换扩展名时留下的旧文件）。
///
/// 只删 `<file_id>.<已知图片扩展名>` 这一组名字：不做"扫目录删所有前缀匹配"，
/// 那会误删别的书（`a` 与 `ab` 这类前缀重叠的 id）。
pub(crate) fn prune_other_cover_images(file_id: &str, keep: &str) {
    let Ok(dir) = crate::commands::shared::user_covers_dir() else {
        return;
    };
    for ext in COVER_IMAGE_EXTS {
        let name = format!("{file_id}.{ext}");
        if name != keep {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
}
