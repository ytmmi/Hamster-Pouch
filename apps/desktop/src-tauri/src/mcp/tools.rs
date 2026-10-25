//! MCP 工具表：定义（`tools/list`）与执行（`tools/call`）。
//!
//! ## 与 Tauri 命令的关系
//!
//! 这里**不重写业务逻辑**：每个工具都是对既有 `#[tauri::command]` 函数的
//! 直接调用（`#[tauri::command]` 只生成胶水代码，原函数本身照常可调）。
//! 因此 MCP 与界面看到的是**同一套语义、同一套错误串**，
//! 不会出现"界面能改、MCP 改出另一种结果"的漂移。
//!
//! 唯一的例外是 `file_query`：它的过滤参数类型字段私有，
//! 这里用 `serde_json::from_value` 构造（该类型 `rename_all = "camelCase"`），
//! 仍然走同一个命令函数。
//!
//! ## 字段命名
//!
//! 工具**入参**用 camelCase（与前端 `invoke` 口径一致），
//! 工具**结果**是既有命令返回体的原样 JSON，即 snake_case
//! （`docs/spec/shared-types.md` 的跨层 DTO 约定）。
//!
//! ## 读写分档
//!
//! [`ToolSpec::write`] 为 `true` 的工具只有在设置项 `mcp.allowWrite` 打开时
//! 才可执行；只读工具不受该开关影响（但仍需 `mcp.enabled` + token）。

use serde_json::{Value, json};
use tauri::Manager;

use super::jsonrpc::{INTERNAL_ERROR, INVALID_PARAMS, RpcError};
use crate::AppState;
use crate::commands::shared::ApiResponse;

/// 一个工具的定义。
pub(crate) struct ToolSpec {
    /// 工具名（LLM 可见，全局唯一）。
    pub(crate) name: &'static str,
    /// 人类可读标题。
    pub(crate) title: &'static str,
    /// 用途说明（LLM 靠它决定何时调用，必须写清副作用）。
    pub(crate) description: &'static str,
    /// 是否属于写操作（受 `mcp.allowWrite` 约束）。
    pub(crate) write: bool,
    /// JSON Schema 形状的入参声明。
    pub(crate) schema: Value,
}

/// 组装一个 `type: object` 的入参声明。
fn object(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
        "additionalProperties": false,
    })
}

/// 字符串参数声明。
fn string(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

/// 字符串数组参数声明。
fn string_array(desc: &str) -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": desc })
}

/// 正整数参数声明。
fn integer(desc: &str) -> Value {
    json!({ "type": "integer", "description": desc })
}

/// 全部工具（顺序即 `tools/list` 的展示顺序：先只读、后写）。
pub(crate) fn list() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "repo_list",
            title: "列出仓库",
            description: "列出本机已注册的全部仓库（含各自的库路径与最后打开时间）。无参数。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "repo_current",
            title: "当前仓库",
            description: "返回当前在仓鼠颊里打开的仓库；未打开时 repo_id 为 null。MCP 的其它工具默认作用在当前仓库上。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "file_query",
            title: "查询文件",
            description: "按媒体类型 / 媒体源 / 目录前缀筛选当前仓库的已索引文件，游标分页。返回 items 与 next_cursor（把 next_cursor 原样回传即可续页，null 表示末页）。",
            write: false,
            schema: object(
                json!({
                    "mediaTypes": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["image", "video", "audio", "text", "pdf"] },
                        "description": "媒体类型集合；缺省或空数组表示不筛。",
                    },
                    "sourceId": string("只查某个媒体源（source_list 里的 id）。"),
                    "dirPrefix": string("只查某个目录前缀，例如 \"2024/旅行\"。"),
                    "cursor": string("上一页返回的 next_cursor，原样回传。"),
                    "limit": integer("页大小，缺省 200，上限 1000。"),
                }),
                &[],
            ),
        },
        ToolSpec {
            name: "file_metadata",
            title: "文件详情",
            description: "返回单个文件的完整索引信息：相对路径、媒体类型、标记、内容哈希、大小、修改时间、校验状态、ffprobe 媒体信息与 EXIF。",
            write: false,
            schema: object(json!({ "fileId": string("文件 ID。") }), &["fileId"]),
        },
        ToolSpec {
            name: "file_path",
            title: "文件绝对路径",
            description: "把文件 ID 解析成本机绝对路径（媒体源本地路径 + 相对路径）。给需要直接读盘或交给其它工具的场合用。",
            write: false,
            schema: object(json!({ "fileId": string("文件 ID。") }), &["fileId"]),
        },
        ToolSpec {
            name: "source_list",
            title: "列出媒体源",
            description: "列出当前仓库已挂载的媒体源（本地目录）。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "source_tree",
            title: "媒体源目录树",
            description: "返回当前仓库各媒体源的目录树（含每个目录下的文件数），用于了解仓库结构。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "tag_list",
            title: "列出 tag",
            description: "列出当前仓库的全部人工 tag。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "tag_tree",
            title: "tag 层级树",
            description: "返回 tag 的层级树（父子关系 + 每个 tag 关联的文件数）。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "file_tags",
            title: "文件的 tag",
            description: "返回单个文件关联的人工 tag 与自动 tag（自动 tag 带置信度）。",
            write: false,
            schema: object(json!({ "fileId": string("文件 ID。") }), &["fileId"]),
        },
        ToolSpec {
            name: "album_list",
            title: "列出相册",
            description: "列出当前仓库的全部相册（含成员数与媒体属性）。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "album_members",
            title: "相册成员",
            description: "游标分页列出相册的可见成员文件（按相册的有效媒体属性过滤）。",
            write: false,
            schema: object(
                json!({
                    "albumId": string("相册 ID。"),
                    "cursor": string("上一页返回的 next_cursor，原样回传。"),
                    "limit": integer("页大小，缺省 200，上限 1000。"),
                }),
                &["albumId"],
            ),
        },
        ToolSpec {
            name: "book_meta",
            title: "图书元数据",
            description: "返回电子书（epub / txt / md / pdf）的作者、简介与封面图路径。非图书类型返回全 null（不是错误）。",
            write: false,
            schema: object(json!({ "fileId": string("文件 ID。") }), &["fileId"]),
        },
        ToolSpec {
            name: "book_toc",
            title: "图书目录",
            description: "返回电子书的目录（章节标题 + 层级 + 游标）。把游标交给 book_content 即可跳转到该章节。",
            write: false,
            schema: object(json!({ "fileId": string("文件 ID。") }), &["fileId"]),
        },
        ToolSpec {
            name: "book_content",
            title: "图书正文",
            description: "按游标读取电子书的一页正文（类型化块，不是 HTML）。游标缺省表示第一页；返回里的 next_cursor 用于续读。",
            write: false,
            schema: object(
                json!({
                    "fileId": string("文件 ID。"),
                    "cursor": string("目录项或上一页给出的 next_cursor；缺省为第一页。"),
                }),
                &["fileId"],
            ),
        },
        ToolSpec {
            name: "setting_list",
            title: "列出设置",
            description: "列出全局库 app_settings 里的全部键值（含内部键，不过滤）。",
            write: false,
            schema: object(json!({}), &[]),
        },
        ToolSpec {
            name: "file_rename",
            title: "重命名文件",
            description: "把文件在其所在目录内改名，并同步更新索引。会真的改磁盘上的文件名。",
            write: true,
            schema: object(
                json!({
                    "fileId": string("文件 ID。"),
                    "newName": string("新文件名（不含路径分隔符）。"),
                }),
                &["fileId", "newName"],
            ),
        },
        ToolSpec {
            name: "file_trash",
            title: "移入回收站",
            description: "把文件移入系统回收站并从索引里删除。可恢复（回收站里还有），但索引记录会消失。",
            write: true,
            schema: object(
                json!({ "fileIds": string_array("要移入回收站的文件 ID 列表。") }),
                &["fileIds"],
            ),
        },
        ToolSpec {
            name: "file_set_marks",
            title: "设置文件标记",
            description: "批量增删文件标记（标记是命名空间字符串，如 hp.favorite）。返回实际改动的文件数。",
            write: true,
            schema: object(
                json!({
                    "fileIds": string_array("要改标记的文件 ID 列表。"),
                    "add": string_array("要添加的标记；缺省表示不添加。"),
                    "remove": string_array("要移除的标记；缺省表示不移除。"),
                }),
                &["fileIds"],
            ),
        },
        ToolSpec {
            name: "file_copy",
            title: "复制文件",
            description: "把文件复制到另一个媒体源 / 目标目录，并把新文件纳入索引。磁盘上会真的多出副本。",
            write: true,
            schema: object(
                json!({
                    "fileIds": string_array("要复制的文件 ID 列表。"),
                    "targetSourceId": string("目标媒体源 ID。"),
                    "targetPath": string("目标源内的相对目录；缺省表示源根目录。"),
                }),
                &["fileIds", "targetSourceId"],
            ),
        },
        ToolSpec {
            name: "file_move",
            title: "移动文件",
            description: "把文件移动到另一个媒体源 / 目标目录并更新索引。原位置的文件会消失。",
            write: true,
            schema: object(
                json!({
                    "fileIds": string_array("要移动的文件 ID 列表。"),
                    "targetSourceId": string("目标媒体源 ID。"),
                    "targetPath": string("目标源内的相对目录；缺省表示源根目录。"),
                }),
                &["fileIds", "targetSourceId"],
            ),
        },
        ToolSpec {
            name: "tag_add",
            title: "给文件打 tag",
            description: "给一批文件打上指定名称的人工 tag（同名 tag 不存在时自动创建）。",
            write: true,
            schema: object(
                json!({
                    "fileIds": string_array("文件 ID 列表。"),
                    "tagName": string("tag 名称。"),
                }),
                &["fileIds", "tagName"],
            ),
        },
        ToolSpec {
            name: "tag_remove",
            title: "摘掉文件 tag",
            description: "把指定 tag 从一批文件上摘掉（tag 实体本身保留）。",
            write: true,
            schema: object(
                json!({
                    "fileIds": string_array("文件 ID 列表。"),
                    "tagName": string("tag 名称。"),
                }),
                &["fileIds", "tagName"],
            ),
        },
        ToolSpec {
            name: "rating_set",
            title: "设置评分",
            description: "给文件设置 0–5 星评分（0 表示清空）。",
            write: true,
            schema: object(
                json!({
                    "fileId": string("文件 ID。"),
                    "rating": integer("评分，0–5。"),
                }),
                &["fileId", "rating"],
            ),
        },
        ToolSpec {
            name: "album_add_members",
            title: "加入相册",
            description: "把一批文件加进相册。",
            write: true,
            schema: object(
                json!({
                    "albumId": string("相册 ID。"),
                    "fileIds": string_array("文件 ID 列表。"),
                }),
                &["albumId", "fileIds"],
            ),
        },
        ToolSpec {
            name: "album_remove_members",
            title: "移出相册",
            description: "把一批文件从相册里移出（不影响磁盘文件与索引）。",
            write: true,
            schema: object(
                json!({
                    "albumId": string("相册 ID。"),
                    "fileIds": string_array("文件 ID 列表。"),
                }),
                &["albumId", "fileIds"],
            ),
        },
    ]
}

/// 把命令的 [`ApiResponse`] 摊平成 `Result<T, String>`。
///
/// MCP 里"业务失败"不是协议错误：它会被包成 `isError: true` 的工具结果，
/// 这样模型能看到错误码与原因并自行决定下一步，而不是让整个调用链断掉。
fn flatten<T>(resp: ApiResponse<T>) -> Result<T, String> {
    if resp.ok {
        resp.data
            .ok_or_else(|| "命令报告成功但没有返回数据".to_string())
    } else {
        let err = resp.error.unwrap_or(crate::commands::shared::ApiError {
            code: "io".into(),
            message: "命令失败但没有给出原因".into(),
            details: None,
        });
        Err(format!("{}: {}", err.code, err.message))
    }
}

/// 取一个必填字符串参数。
fn req_str(args: &Value, key: &str) -> Result<String, RpcError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("缺少参数 {key}（字符串）")))
}

/// 取一个必填字符串数组参数。
fn req_str_list(args: &Value, key: &str) -> Result<Vec<String>, RpcError> {
    let array = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("缺少参数 {key}（字符串数组）")))?;
    array
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("{key} 里含有非字符串项")))
        })
        .collect()
}

/// 取一个可选字符串参数（空串按缺省处理）。
fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 取一个可选整数参数。
fn opt_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

/// 把工具结果序列化成 MCP 的 `content` 数组。
fn ok_result(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into());
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": false,
    })
}

/// 把业务失败包成 `isError: true` 的工具结果。
fn err_result(message: &str) -> Value {
    json!({
        "content": [ { "type": "text", "text": message } ],
        "isError": true,
    })
}

/// 当前仓库 ID（未打开时为 `None`）。
fn current_repo(state: &AppState) -> Option<String> {
    state
        .current_repo_id
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// 执行一个工具。
///
/// `Ok(Value)` 是**工具结果**（可能带 `isError: true`）；
/// `Err(RpcError)` 是**协议错误**（未知工具、参数形状不对）。
pub(crate) fn call(
    app: &tauri::AppHandle,
    allow_write: bool,
    name: &str,
    args: &Value,
) -> Result<Value, RpcError> {
    let spec = list().into_iter().find(|spec| spec.name == name);
    let Some(spec) = spec else {
        return Err(RpcError::new(
            super::jsonrpc::METHOD_NOT_FOUND,
            format!("未知工具: {name}"),
        ));
    };
    if spec.write && !allow_write {
        return Ok(err_result(
            "写操作未启用：请在「设置 → MCP → 服务与权限」打开「允许写操作」。",
        ));
    }

    let state = app.state::<AppState>();
    let repo_id = current_repo(&state).unwrap_or_default();
    let args = if args.is_null() {
        json!({})
    } else {
        args.clone()
    };

    // 各工具共用同一个错误收敛点：`Result<Value, String>` → 工具结果。
    let outcome: Result<Value, String> = match name {
        "repo_list" => {
            flatten(crate::commands::repo::repo_list(state, app.clone())).and_then(to_json)
        }
        "repo_current" => {
            let repo_id = current_repo(&state);
            Ok(json!({ "repo_id": repo_id }))
        }
        "file_query" => {
            let filter = match query_filter(&args) {
                Ok(filter) => filter,
                Err(message) => return Ok(err_result(&message)),
            };
            flatten(crate::commands::file::file_query(
                repo_id,
                filter,
                opt_str(&args, "cursor"),
                Some(opt_i64(&args, "limit").unwrap_or(200).clamp(1, 1000)),
                state,
            ))
            .and_then(to_json)
        }
        "file_metadata" => flatten(crate::commands::file::file_metadata(
            repo_id,
            req_str(&args, "fileId")?,
            state,
        ))
        .and_then(to_json),
        "file_path" => flatten(crate::commands::file::file_path(
            repo_id,
            req_str(&args, "fileId")?,
            state,
        ))
        .map(|path| json!({ "path": path })),
        "source_list" => {
            flatten(crate::commands::source::source_list(repo_id, state)).and_then(to_json)
        }
        "source_tree" => {
            flatten(crate::commands::source::source_tree(repo_id, state)).and_then(to_json)
        }
        "tag_list" => flatten(crate::commands::tag::tag_list(repo_id, state)).and_then(to_json),
        "tag_tree" => flatten(crate::commands::tag::tag_tree(repo_id, state)).and_then(to_json),
        "file_tags" => flatten(crate::commands::tag::tag_for_file(
            repo_id,
            req_str(&args, "fileId")?,
            state,
        ))
        .and_then(to_json),
        "album_list" => {
            flatten(crate::commands::album::album_list(repo_id, state)).and_then(to_json)
        }
        "album_members" => flatten(crate::commands::album::album_members(
            repo_id,
            req_str(&args, "albumId")?,
            opt_str(&args, "cursor"),
            Some(opt_i64(&args, "limit").unwrap_or(200).clamp(1, 1000)),
            state,
        ))
        .and_then(to_json),
        "book_meta" => block_on_book(crate::commands::book::book_meta(
            repo_id,
            req_str(&args, "fileId")?,
            state,
        )),
        "book_toc" => block_on_book(crate::commands::book_reader::book_toc(
            repo_id,
            req_str(&args, "fileId")?,
            state,
        )),
        "book_content" => block_on_book(crate::commands::book::book_content(
            repo_id,
            req_str(&args, "fileId")?,
            opt_str(&args, "cursor"),
            state,
        )),
        "setting_list" => {
            flatten(crate::commands::repo::setting_list(state, app.clone())).and_then(to_json)
        }
        "file_rename" => flatten(crate::commands::file::file_rename(
            repo_id,
            req_str(&args, "fileId")?,
            req_str(&args, "newName")?,
            state,
        ))
        .and_then(to_json),
        "file_trash" => flatten(crate::commands::file::file_trash(
            repo_id,
            req_str_list(&args, "fileIds")?,
            state,
        ))
        .map(|count| json!({ "trashed": count })),
        "file_set_marks" => flatten(crate::commands::file::file_set_marks(
            repo_id,
            req_str_list(&args, "fileIds")?,
            args.get("add")
                .and_then(Value::as_array)
                .map(|items| str_vec(items)),
            args.get("remove")
                .and_then(Value::as_array)
                .map(|items| str_vec(items)),
            state,
        ))
        .map(|count| json!({ "affected": count })),
        "file_copy" | "file_move" => {
            let file_ids = req_str_list(&args, "fileIds")?;
            let target_source_id = req_str(&args, "targetSourceId")?;
            let target_path = opt_str(&args, "targetPath");
            let resp = if name == "file_copy" {
                crate::commands::fsops::fsops_copy(
                    repo_id,
                    file_ids,
                    target_source_id,
                    target_path,
                    state,
                )
            } else {
                crate::commands::fsops::fsops_move(
                    repo_id,
                    file_ids,
                    target_source_id,
                    target_path,
                    state,
                )
            };
            flatten(resp).and_then(to_json)
        }
        "tag_add" => flatten(crate::commands::tag::tag_add(
            repo_id,
            req_str_list(&args, "fileIds")?,
            req_str(&args, "tagName")?,
            state,
        ))
        .map(|()| json!({ "ok": true })),
        "tag_remove" => flatten(crate::commands::tag::tag_remove(
            repo_id,
            req_str_list(&args, "fileIds")?,
            req_str(&args, "tagName")?,
            state,
        ))
        .map(|()| json!({ "ok": true })),
        "rating_set" => {
            let Some(rating) = opt_i64(&args, "rating") else {
                return Err(RpcError::new(INVALID_PARAMS, "缺少参数 rating（整数 0–5）"));
            };
            flatten(crate::commands::rating::rating_set(
                repo_id,
                req_str(&args, "fileId")?,
                rating,
                state,
            ))
            .map(|()| json!({ "ok": true }))
        }
        "album_add_members" => flatten(crate::commands::album::album_add_member(
            repo_id,
            req_str(&args, "albumId")?,
            req_str_list(&args, "fileIds")?,
            state,
        ))
        .and_then(to_json),
        "album_remove_members" => flatten(crate::commands::album::album_remove_member(
            repo_id,
            req_str(&args, "albumId")?,
            req_str_list(&args, "fileIds")?,
            state,
        ))
        .and_then(to_json),
        other => {
            return Err(RpcError::new(
                INTERNAL_ERROR,
                format!("工具 {other} 有定义但缺少执行分支"),
            ));
        }
    };

    Ok(match outcome {
        Ok(value) => ok_result(&value),
        Err(message) => err_result(&message),
    })
}

/// `[Value]` → `Vec<String>`（丢弃非字符串项）。
fn str_vec(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// 序列化命令返回体。
fn to_json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("序列化失败: {e}"))
}

/// 由工具入参构造 `file.query` 的过滤参数。
///
/// `FileQueryFilterArgs` 的字段在本层是私有的，但它实现了 `Deserialize`
/// 且 `rename_all = "camelCase"`，所以用 JSON 中转——这样既不用把字段
/// 改成 `pub(crate)`（保持 `file.rs` 的封装），也不会漏掉任何字段。
fn query_filter(
    args: &Value,
) -> Result<Option<crate::commands::file::FileQueryFilterArgs>, String> {
    let mut object = serde_json::Map::new();
    for key in ["mediaTypes", "sourceId", "dirPrefix"] {
        if let Some(value) = args.get(key)
            && !value.is_null()
        {
            object.insert(key.to_string(), value.clone());
        }
    }
    if object.is_empty() {
        return Ok(None);
    }
    serde_json::from_value(Value::Object(object))
        .map(Some)
        .map_err(|e| format!("查询条件不合法: {e}"))
}

/// 驱动一个 `ApiAsync<T>` 命令（图书类命令内部用 `spawn_blocking` 读盘）。
///
/// MCP 的传输线程是普通 std 线程，不在 tokio 上下文里，因此这里用
/// `tauri::async_runtime::block_on` 把异步命令跑完再返回。
fn block_on_book<T, F>(future: F) -> Result<Value, String>
where
    T: serde::Serialize,
    F: std::future::Future<Output = crate::commands::shared::ApiAsync<T>>,
{
    let response = tauri::async_runtime::block_on(future).map_err(|err| {
        err.error
            .map(|e| format!("{}: {}", e.code, e.message))
            .unwrap_or_else(|| "命令失败但没有给出原因".to_string())
    })?;
    flatten(response).and_then(to_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 工具名必须唯一：重名会让 `tools/call` 只能命中一个，另一个永久不可达。
    #[test]
    fn tool_names_are_unique() {
        let mut names: Vec<&str> = list().iter().map(|spec| spec.name).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total, "工具名有重复");
    }

    /// 每个工具都必须是合法的 snake_case 方法名（MCP 客户端按名字分派）。
    #[test]
    fn tool_names_are_snake_case() {
        for spec in list() {
            assert!(
                spec.name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "工具名 {} 不是 snake_case",
                spec.name
            );
            assert!(!spec.name.is_empty());
        }
    }

    /// 每个工具都必须写清 title 与 description：
    /// 模型靠 description 决定何时调用，空说明等于不可用。
    #[test]
    fn every_tool_documents_itself() {
        for spec in list() {
            assert!(!spec.title.is_empty(), "工具 {} 缺 title", spec.name);
            assert!(
                spec.description.len() >= 8,
                "工具 {} 的 description 太短（模型无法判断何时调用）",
                spec.name
            );
        }
    }

    /// 入参声明必须是 `type: object`，且 `required` 里的键都在 `properties` 中
    /// （否则客户端会认为必填参数无法提供）。
    #[test]
    fn input_schemas_are_self_consistent() {
        for spec in list() {
            assert_eq!(spec.schema["type"], json!("object"), "工具 {}", spec.name);
            let properties = spec.schema["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("工具 {} 缺 properties", spec.name));
            let required = spec.schema["required"]
                .as_array()
                .unwrap_or_else(|| panic!("工具 {} 缺 required", spec.name));
            for key in required {
                let key = key.as_str().expect("required 必须是字符串");
                assert!(
                    properties.contains_key(key),
                    "工具 {} 的必填参数 {key} 不在 properties 里",
                    spec.name
                );
            }
            assert_eq!(
                spec.schema["additionalProperties"],
                json!(false),
                "工具 {} 必须关闭 additionalProperties",
                spec.name
            );
        }
    }

    /// 写工具必须**显式**标注（`write: true`），只读工具不许误标。
    ///
    /// 这条断言盯的是安全边界：漏标一个写工具 = 用户没开写操作也能改数据。
    #[test]
    fn write_tools_are_explicitly_flagged() {
        let write_names: Vec<&str> = list()
            .iter()
            .filter(|spec| spec.write)
            .map(|spec| spec.name)
            .collect();
        // 这些工具会改数据，必须全部在写档里。
        for expected in [
            "file_rename",
            "file_trash",
            "file_set_marks",
            "file_copy",
            "file_move",
            "tag_add",
            "tag_remove",
            "rating_set",
            "album_add_members",
            "album_remove_members",
        ] {
            assert!(
                write_names.contains(&expected),
                "{expected} 会改数据，必须标为写工具"
            );
        }
        // 反过来：只读工具不得出现在写档里。
        for spec in list().iter().filter(|spec| !spec.write) {
            assert!(
                !spec.name.starts_with("file_trash") && spec.name != "tag_add",
                "只读工具 {} 看起来会改数据",
                spec.name
            );
        }
    }

    /// `repo_current` 必须是无参工具（模型第一步就要调它，不该先问参数）。
    #[test]
    fn repo_current_takes_no_arguments() {
        let spec = list()
            .into_iter()
            .find(|spec| spec.name == "repo_current")
            .expect("必须有 repo_current");
        assert_eq!(spec.schema["required"], json!([]));
        assert_eq!(spec.schema["properties"], json!({}));
    }

    /// `file_query` 的媒体类型枚举必须与 `MediaType::as_str` 的五个值一致
    /// （多一个或少一个都会让模型给出无法执行的条件）。
    #[test]
    fn file_query_media_types_match_the_domain_enum() {
        let spec = list()
            .into_iter()
            .find(|spec| spec.name == "file_query")
            .expect("必须有 file_query");
        let enum_values = spec.schema["properties"]["mediaTypes"]["items"]["enum"]
            .as_array()
            .expect("mediaTypes 必须有 enum");
        let actual: Vec<&str> = enum_values.iter().filter_map(Value::as_str).collect();
        assert_eq!(actual, vec!["image", "video", "audio", "text", "pdf"]);
    }

    /// 数组参数助手与 `str_vec` 的配合：非字符串项被丢弃，不 panic。
    #[test]
    fn str_vec_drops_non_strings() {
        let items = vec![json!("a"), json!(1), json!("b"), json!(null)];
        assert_eq!(str_vec(&items), vec!["a".to_string(), "b".to_string()]);
        assert!(str_vec(&[]).is_empty());
    }

    /// 工具执行结果统一包成 MCP 的 `content` 形状，失败标 `isError`
    /// （业务失败不是协议错误：模型要能看到原因并继续）。
    #[test]
    fn results_use_the_mcp_content_shape() {
        let ok = ok_result(&json!({"a": 1}));
        assert_eq!(ok["isError"], json!(false));
        assert_eq!(ok["content"][0]["type"], json!("text"));
        assert!(ok["content"][0]["text"].as_str().unwrap().contains("\"a\""));

        let err = err_result("出错了");
        assert_eq!(err["isError"], json!(true));
        assert_eq!(err["content"][0]["text"], json!("出错了"));
    }

    /// 空过滤条件 → `None`（不筛），不是"筛出空集"。
    #[test]
    fn empty_query_filter_means_no_filter() {
        assert!(query_filter(&json!({})).expect("空对象应合法").is_none());
        assert!(
            query_filter(&json!({"mediaTypes": null}))
                .expect("null 视为未提供")
                .is_none()
        );
        // 只有未知键（一个都不是过滤条件）同样等于不筛。
        assert!(
            query_filter(&json!({"unknown": 1}))
                .expect("未知键应被忽略")
                .is_none()
        );
        // 有真条件时必须给出过滤体，否则会把整库当成筛选结果返回。
        assert!(
            query_filter(&json!({"mediaTypes": ["image"]}))
                .expect("应可构造")
                .is_some()
        );
        assert!(
            query_filter(&json!({"dirPrefix": "a/b"}))
                .expect("应可构造")
                .is_some()
        );
    }

    /// 条件形状不对（媒体类型不是字符串数组）必须报错，不能静默降级成"不筛"。
    #[test]
    fn malformed_query_filter_is_rejected() {
        // 用 match 而非 expect_err：`FileQueryFilterArgs` 没实现 Debug，
        // 而这里要断言的是"它被拒绝"，不是它的内容。
        for bad in [
            json!({"mediaTypes": "image"}),
            json!({"mediaTypes": [1, 2]}),
        ] {
            match query_filter(&bad) {
                Err(err) => assert!(err.contains("查询条件不合法"), "错误串应说明原因: {err}"),
                Ok(_) => panic!("形状不对的条件必须被拒绝: {bad}"),
            }
        }
    }
}
