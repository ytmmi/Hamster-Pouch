//! M4-7 / RFC 0011：布局预设与仓库绑定命令桥接。
//!
//! 职责边界：只做参数校验、状态装配、调用 `hp-store`；业务在 crate 层。
//!
//! 模型（RFC 0011）：
//! - 应用级预设 `layout_presets`：一份布局 = 一行，各层装在 `layers_json` 内；
//! - 仓库覆盖 `layout_bindings`：`repo_id` → 预设（无行 = 走应用级默认）；
//! - 三层解析链：仓库绑定 → `app_settings['layout.default']` → 代码内建形状。
//!   `layout.getDefault(repoId)` 返回**该仓库生效**的预设名（绑定优先），
//!   省略 `repoId` 则只读应用级默认。
//!
//! **D76 迁移状态：已包装**（批次 `repo/layout`，2026-09；RFC 0011 改为应用级）。
//! 全部命令返回 `{ ok, data?, error? }`；前端 `api/layout.ts` 经 `unwrapApi` 解包。

use std::collections::BTreeMap;
use std::path::PathBuf;

use hp_core::{HpError, HpResult};
use hp_store::{LayoutPresetRow, SeedOutcome};
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::State;

use crate::AppState;
use crate::commands::shared::{
    ApiResponse, api_from_hp, ensure_global, global, global_mut, lock_global,
};

/// 布局预设列表项（返回前端）。
#[derive(Serialize)]
pub struct LayoutItem {
    id: String,
    name: String,
    /// 该预设内含的层 key（含 `""` 层无关快照）。
    layer_keys: Vec<String>,
    /// 布局绑定的蓝图 ID 列表（预设级）。
    blueprint_ids: Vec<String>,
    /// `user` | `seeded`（出厂播种）。
    origin: String,
    updated_at: String,
}

fn to_item(preset: LayoutPresetRow) -> LayoutItem {
    let layer_keys = preset.layer_keys();
    LayoutItem {
        id: preset.id,
        name: preset.name,
        layer_keys,
        blueprint_ids: preset.blueprint_ids,
        origin: preset.origin,
        updated_at: preset.updated_at,
    }
}

/// 出厂播种结果。
#[derive(Serialize)]
pub struct SeedResult {
    seeded: bool,
    replaced: bool,
    name: Option<String>,
}

impl From<SeedOutcome> for SeedResult {
    fn from(o: SeedOutcome) -> Self {
        Self {
            seeded: o.seeded,
            replaced: o.replaced,
            name: o.name,
        }
    }
}

fn invalid(message: impl Into<String>) -> HpError {
    HpError::InvalidArgument(message.into())
}

/// 导出 / 导入的格式标识（RFC 0011 决策 6）。
const EXPORT_FORMAT: &str = "hamster-pouch.layout";
const EXPORT_VERSION: u64 = 1;

/// 读取导出 / 导入的文本：`path` 优先，其次 `inline`。
fn text_of(inline: &str, path: Option<&str>, what: &str) -> HpResult<String> {
    match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => std::fs::read_to_string(PathBuf::from(path))
            .map_err(|e| HpError::Io(format!("读取{what}失败: {path}: {e}"))),
        None => {
            if inline.trim().is_empty() {
                return Err(invalid(format!("{what}内容为空")));
            }
            Ok(inline.to_string())
        }
    }
}

/// 结构校验：与 `tools/layout-check.mjs` 的布局不变量同口径（RFC 0011 决策 6）。
fn validate_layout(layout: &Value) -> HpResult<()> {
    let mut problems: Vec<String> = Vec::new();
    let grid = layout
        .get("grid")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("缺少 grid"))?;
    let root = grid.get("root").ok_or_else(|| invalid("grid.root 缺失"))?;
    if root.get("type").and_then(Value::as_str) != Some("branch") {
        problems.push("grid.root.type 必须是 branch".into());
    }
    let Some(panels) = layout.get("panels").and_then(Value::as_object) else {
        return Err(invalid("panels 为空"));
    };
    if panels.is_empty() {
        return Err(invalid("panels 为空"));
    }
    for (key, panel) in panels {
        let Some(p) = panel.as_object() else {
            problems.push(format!("panels.{key} 不是对象"));
            continue;
        };
        if p.get("id").and_then(Value::as_str) != Some(key.as_str()) {
            problems.push(format!("panels.{key}.id 与键不一致"));
        }
        for field in ["contentComponent", "title"] {
            match p.get(field).and_then(Value::as_str) {
                Some(v) if !v.is_empty() => {}
                _ => problems.push(format!("panels.{key} 缺少 {field}")),
            }
        }
    }

    let mut seen: Vec<String> = Vec::new();
    walk_layout_node(root, "grid.root", panels, &mut seen, &mut problems);
    for key in panels.keys() {
        if !seen.contains(key) {
            problems.push(format!("面板 {key} 没有被任何 leaf 引用"));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(invalid(format!("布局结构不合法：{}", problems.join("; "))))
    }
}

fn walk_layout_node(
    node: &Value,
    path: &str,
    panels: &Map<String, Value>,
    seen: &mut Vec<String>,
    problems: &mut Vec<String>,
) {
    let Some(obj) = node.as_object() else {
        problems.push(format!("{path} 不是对象"));
        return;
    };
    if let Some(size) = obj.get("size")
        && !size.as_f64().is_some_and(|s| s > 0.0)
    {
        problems.push(format!("{path}.size 必须为正数"));
    }
    match obj.get("type").and_then(Value::as_str) {
        Some("branch") => {
            let Some(data) = obj.get("data").and_then(Value::as_array) else {
                problems.push(format!("{path}.data 必须是非空数组"));
                return;
            };
            if data.is_empty() {
                problems.push(format!("{path}.data 必须是非空数组"));
                return;
            }
            for (i, child) in data.iter().enumerate() {
                walk_layout_node(child, &format!("{path}.data[{i}]"), panels, seen, problems);
            }
        }
        Some("leaf") => {
            let Some(data) = obj.get("data").and_then(Value::as_object) else {
                problems.push(format!("{path}.data 缺失"));
                return;
            };
            let Some(views) = data.get("views").and_then(Value::as_array) else {
                problems.push(format!("{path}.data.views 必须是非空数组"));
                return;
            };
            if views.is_empty() {
                problems.push(format!("{path}.data.views 必须是非空数组"));
                return;
            }
            if data
                .get("id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                problems.push(format!("{path}.data.id 缺失"));
            }
            let active = data.get("activeView").and_then(Value::as_str).unwrap_or("");
            if !views.iter().any(|v| v.as_str() == Some(active)) {
                problems.push(format!("{path}.data.activeView 不在 views 内"));
            }
            for view in views {
                let Some(view) = view.as_str() else {
                    problems.push(format!("{path}.data.views 含非字符串项"));
                    continue;
                };
                if !seen.iter().any(|s| s == view) {
                    seen.push(view.to_string());
                }
                if !panels.contains_key(view) {
                    problems.push(format!("{path} 引用了未登记的面板 {view}"));
                }
            }
        }
        other => problems.push(format!(
            "{path}.type={}（只允许 branch / leaf）",
            other.unwrap_or("缺失")
        )),
    }
}

/// layout.save：保存当前层布局到应用级预设（预设不存在则新建）。
///
/// `layerKey` 缺省 = `""`（层无关快照）；`blueprintIds` 给定则覆盖该预设的蓝图绑定。
#[tauri::command]
pub fn layout_save(
    name: String,
    layout_json: String,
    layer_key: Option<String>,
    blueprint_ids: Option<Vec<String>>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<LayoutItem> {
    let outcome = (|| -> HpResult<LayoutItem> {
        ensure_global(&state, &app)?;
        let layer_key = layer_key.unwrap_or_default();
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.save_layout_layer(&name, &layer_key, &layout_json)?;
        if let Some(ids) = blueprint_ids {
            g.set_layout_blueprints(&name, &ids)?;
        }
        let preset = g
            .get_layout_preset(&name)?
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        Ok(to_item(preset))
    })();
    api_from_hp(outcome)
}

/// layout.list：列出全部应用级预设（最新在前）。
#[tauri::command]
pub fn layout_list(state: State<AppState>, app: tauri::AppHandle) -> ApiResponse<Vec<LayoutItem>> {
    let outcome = (|| -> HpResult<Vec<LayoutItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        Ok(g.list_layout_presets()?.into_iter().map(to_item).collect())
    })();
    api_from_hp(outcome)
}

/// layout.get：读取某预设内某一层的布局 JSON（当前层 → `""` → 无）。
///
/// **不跨预设**兜底：调用方按解析链继续往下试。
#[tauri::command]
pub fn layout_get(
    name: String,
    layer_key: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_global(&state, &app)?;
        let layer_key = layer_key.unwrap_or_default();
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        g.get_layout_layer(&name, &layer_key)
    })();
    api_from_hp(outcome)
}

/// layout.rename：重命名预设（默认指针与绑定按 id 存，自动跟随）。
#[tauri::command]
pub fn layout_rename(
    name: String,
    new_name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(invalid("布局名不能为空"));
        }
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.rename_layout_preset(&name, new_name)
    })();
    api_from_hp(outcome)
}

/// layout.delete：删除预设；命中应用级默认或任一仓库绑定时拒绝（决策 11）。
#[tauri::command]
pub fn layout_delete(
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.delete_layout_preset(&name)
    })();
    api_from_hp(outcome)
}

/// layout.setDefault：设为应用级默认。
#[tauri::command]
pub fn layout_set_default(
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        g.set_default_layout(&name)
    })();
    api_from_hp(outcome)
}

/// layout.getDefault：读取生效的预设名。
///
/// 给 `repoId` 时按解析链取该仓库生效值（绑定优先，其次应用级默认）；
/// 省略时只读应用级默认。
#[tauri::command]
pub fn layout_get_default(
    repo_id: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<String>> {
    let outcome = (|| -> HpResult<Option<String>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        match repo_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
        {
            Some(repo_id) => match g.layout_binding_name(&repo_id)? {
                Some(name) => Ok(Some(name)),
                None => g.default_layout_name(),
            },
            None => g.default_layout_name(),
        }
    })();
    api_from_hp(outcome)
}

/// layout.blueprints：读取预设绑定的蓝图 ID 列表。
#[tauri::command]
pub fn layout_blueprints(
    name: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<String>> {
    let outcome = (|| -> HpResult<Vec<String>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let preset = g
            .get_layout_preset(&name)?
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        Ok(preset.blueprint_ids)
    })();
    api_from_hp(outcome)
}

/// layout.bindRepo：设 / 清仓库覆盖（`name` 省略 = 清除，回到应用级默认）。
#[tauri::command]
pub fn layout_bind_repo(
    repo_id: String,
    name: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        g.bind_layout_repo(&repo_id, name.as_deref())
    })();
    api_from_hp(outcome)
}

/// layout.export：导出一份预设为 `hamster-pouch.layout` JSON。
///
/// 给 `path` 时同时落盘（UTF-8 无 BOM；前端用系统保存对话框取得路径）。
#[tauri::command]
pub fn layout_export(
    name: String,
    path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<String> {
    let outcome = (|| -> HpResult<String> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let preset = g
            .get_layout_preset(&name)?
            .ok_or_else(|| HpError::NotFound(format!("布局不存在: {name}")))?;
        let doc = json!({
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "name": preset.name,
            "layers": preset.layers,
            "blueprintIds": preset.blueprint_ids,
        });
        let text = serde_json::to_string_pretty(&doc)
            .map_err(|e| HpError::Store(format!("序列化导出布局失败: {e}")))?;
        if let Some(path) = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
            std::fs::write(PathBuf::from(&path), text.as_bytes())
                .map_err(|e| HpError::Io(format!("写入布局文件失败: {path}: {e}")))?;
        }
        Ok(text)
    })();
    api_from_hp(outcome)
}

/// layout.import：导入 `hamster-pouch.layout` JSON（文件名 / 文本二选一）。
///
/// 结构不合法 → `validation`；重名追加 `-2`、`-3`…，不覆盖、不改绑定（决策 6）。
#[tauri::command]
pub fn layout_import(
    json: String,
    path: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<LayoutItem> {
    let outcome = (|| -> HpResult<LayoutItem> {
        let text = text_of(&json, path.as_deref(), "布局文件")?;
        let doc: Value = serde_json::from_str(&text)
            .map_err(|e| invalid(format!("布局文件不是合法 JSON: {e}")))?;
        let obj = doc
            .as_object()
            .ok_or_else(|| invalid("布局文件顶层必须是 JSON 对象"))?;
        if obj.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT) {
            return Err(invalid(format!("format 必须是 {EXPORT_FORMAT}")));
        }
        if obj.get("version").and_then(Value::as_u64) != Some(EXPORT_VERSION) {
            return Err(invalid(format!("version 必须是 {EXPORT_VERSION}")));
        }
        let base_name = obj
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .ok_or_else(|| invalid("缺少预设名 name"))?;
        let layers_value = obj
            .get("layers")
            .ok_or_else(|| invalid("缺少 layers"))?
            .clone();
        let layers: BTreeMap<String, Value> = serde_json::from_value(layers_value)
            .map_err(|e| invalid(format!("layers 必须是层 key → 布局对象: {e}")))?;
        if layers.is_empty() {
            return Err(invalid("layers 不能为空"));
        }
        for (layer_key, layout) in &layers {
            if !layout.is_object() {
                return Err(invalid(format!("layers[{layer_key}] 必须是对象")));
            }
            validate_layout(layout)?;
        }
        let blueprint_ids: Vec<String> = match obj.get("blueprintIds") {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|e| invalid(format!("blueprintIds 必须是字符串数组: {e}")))?,
            None => Vec::new(),
        };

        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        let mut name = base_name.to_string();
        let mut suffix = 2;
        while g.get_layout_preset(&name)?.is_some() {
            name = format!("{base_name}-{suffix}");
            suffix += 1;
        }
        let preset = g.import_layout_preset(&name, layers, &blueprint_ids)?;
        Ok(to_item(preset))
    })();
    api_from_hp(outcome)
}

/// layout.ensureSeed：出厂播种（决策 5）。
///
/// 库内没有任何预设时把代码内建形状播种为 `origin='seeded'` 的应用级预设并设为默认；
/// 已有未被用户改动的 seed 预设时用新形状替换。
#[tauri::command]
pub fn layout_ensure_seed(
    name: String,
    layers_json: String,
    blueprint_ids: Option<Vec<String>>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<SeedResult> {
    let outcome = (|| -> HpResult<SeedResult> {
        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        let ids = blueprint_ids.unwrap_or_default();
        g.ensure_seeded_layout(&name, &layers_json, &ids)
            .map(SeedResult::from)
    })();
    api_from_hp(outcome)
}
