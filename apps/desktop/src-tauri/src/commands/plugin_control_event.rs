//! **控件事件回传链**命令桥接（`docs/spec/control-standard.md` 第 6 节 / D63）：
//! 前端 → 宿主的通用命令 `plugin.controlEvent`，宿主 → 插件仍发契约的字面方法名
//! `plugin.{pluginId}.{eventId}`（[`control_event_method`]）。
//!
//! 归属校验与受监督调用复用 `plugin_control_channel.rs` 的地基。

use hp_core::{ControlEvent, HpError, HpResult};
use hp_plugin_host::{
    control_event_method, ExternalProcessQuery, SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT,
};
use serde::Serialize;
use tauri::State;

use crate::commands::plugin_control_channel::{panel_owner_enabled, supervised_call};
use crate::commands::shared::{api_from_hp, ensure_global, ApiResponse};
use crate::AppState;

/// `plugin.controlEvent` 的确认载荷（诊断用）。
#[derive(Serialize)]
pub(crate) struct ControlEventAck {
    panel_id: String,
    plugin_id: String,
    control_id: String,
    /// 宿主谓词表里的事件名（`click` / `double_click` / …）。
    event: String,
    /// 插件在 manifest `events` 里声明的**事件 id**（schema 的 `on` 映射的右侧）。
    event_id: String,
    /// 实际发给插件的插件侧方法名（= `plugin.{pluginId}.{eventId}`）。
    method: String,
}

/// 控件事件的**插件侧**请求参数：字段与控件标准第 6 节逐字一致。
///
/// 事件 id **不在这里**——它由方法名承载（[`control_event_method`]），
/// 因此本结构就是规范声明的那份载荷，没有额外扩展。
#[derive(Serialize)]
struct ControlEventParams<'a> {
    panel_id: &'a str,
    control_id: &'a str,
    event: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<&'a str>,
}

/// plugin.controlEvent：把控件交互回传给插件（控件标准第 6 节 / D63）。
///
/// **回传载荷由宿主构造**，插件不得自定义结构。命令在「前端 → 宿主」这一段是**通用**的
/// （Tauri 命令静态注册，无法按 `{pluginId}.{eventId}` 动态注册），而「宿主 → 插件」那一段
/// 仍按契约的字面方法名 `plugin.{pluginId}.{eventId}` 发送：**插件侧看到的协议与规范一致**，
/// 偏差只落在宿主命令这一层，且已写进契约。
///
/// **fail-closed 校验**（全部在宿主侧，不靠前端自证）：
/// - 面板必须由已安装插件声明，且该插件在该仓库已启用并已获 `ui.panel`（复用 `panel_owner_enabled`）；
/// - 事件名必须是宿主谓词表里的**六个**之一（`cancel` 留给后续模态变体，不在表内）；
/// - 事件 id 必须在插件 manifest 的 `events` 里**声明过**；
/// - `value` 只收标量（对象/数组 → `validation`，同 D32/D76 口径）。
///
/// 事件名 → 事件 id 的映射（schema 的 `on`）由调用方按已解析的 schema 求出后传入；
/// **未在 `on` 里声明的事件不应调用本命令**——调用方先判映射，缺失即忽略并记一次诊断
/// （规范第 6 节："宿主记录一次忽略事件"）。
///
/// **交付方式如实说明**：沿用 `external-process` 的**一次一问一答**——每次点击起一个
/// 插件进程。常驻进程与重启退避/不健康标记（`external-process` **监督**）仍是未实现项，
/// 这里不假装已经做了监督（`docs/spec/plugin-standard.md` 第 10 节）。
///
/// 失败语义：插件未启用/未获能力 → `permission`；面板无归属 → `not_found`；
/// 事件名非法、事件 id 未声明、`value` 非标量 → `validation`；
/// 入口缺失、超时、输出超限、JSON-RPC error → `plugin`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn plugin_control_event(
    repo_id: String,
    panel_id: String,
    control_id: String,
    event: String,
    event_id: String,
    value: Option<serde_json::Value>,
    target: Option<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<ControlEventAck> {
    let outcome = (|| -> HpResult<ControlEventAck> {
        ensure_global(&state, &app)?;

        // 事件名：宿主谓词表（闭集六项）。
        let parsed = ControlEvent::from_str(&event)
            .ok_or_else(|| HpError::InvalidArgument(format!("未知控件事件: {event}")))?;
        if let Some(v) = &value {
            if !(v.is_string() || v.is_number() || v.is_boolean()) {
                return Err(HpError::InvalidArgument(
                    "控件事件 value 只能是字符串 / 数值 / 布尔".into(),
                ));
            }
        }

        let owner = panel_owner_enabled(&state, &repo_id, &panel_id)?;
        if !owner.declared_events.iter().any(|e| e == &event_id) {
            return Err(HpError::InvalidArgument(format!(
                "插件 {} 未声明事件 id: {event_id}",
                owner.plugin_id
            )));
        }
        let entry = owner.entry_path.clone().ok_or_else(|| {
            HpError::Plugin("注册表缺少插件安装目录（source_ref），无法定位入口".into())
        })?;
        if !entry.is_file() {
            return Err(HpError::Plugin(format!("插件入口不存在: {}", entry.display())));
        }

        // 交付期间**不持任何锁**：这里可能阻塞到超时（D61 默认 2s）。
        let pid_sup = owner.plugin_id.clone();
        let pid_for_closure = owner.plugin_id.clone();
        let entry_clone = entry.clone();
        let panel_id_clone = panel_id.clone();
        let control_id_clone = control_id.clone();
        let event_str = parsed.as_str().to_string();
        let value_clone = value.clone();
        let target_clone = target.clone();
        let event_id_clone = event_id.clone();
        supervised_call(&state, pid_sup, move || {
            let params = ControlEventParams {
                panel_id: &panel_id_clone,
                control_id: &control_id_clone,
                event: &event_str,
                value: value_clone.as_ref(),
                target: target_clone.as_deref(),
            };
            ExternalProcessQuery::for_entry(entry_clone).call(
                &control_event_method(&pid_for_closure, &event_id_clone),
                &params,
                SCHEMA_QUERY_TIMEOUT,
                SCHEMA_MAX_BYTES,
            ).map(|_| String::new())
        })?;

        let ack_method = control_event_method(&owner.plugin_id, &event_id);
        Ok(ControlEventAck {
            panel_id,
            plugin_id: owner.plugin_id,
            control_id,
            event,
            event_id,
            method: ack_method,
        })
    })();
    api_from_hp(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 插件侧载荷必须与控件标准第 6 节逐字一致：蛇形字段、`value`/`target` 缺省即省略、
    /// **不含** `event_id`（它由插件侧方法名承载）。
    #[test]
    fn control_event_params_match_the_spec_payload() {
        let params = ControlEventParams {
            panel_id: "plugin.p.panel",
            control_id: "colors",
            event: "double_click",
            value: None,
            target: Some("row-7"),
        };
        let value = serde_json::to_value(&params).expect("序列化失败");
        assert_eq!(
            value,
            serde_json::json!({
                "panel_id": "plugin.p.panel",
                "control_id": "colors",
                "event": "double_click",
                "target": "row-7",
            })
        );
        assert!(
            value.get("event_id").is_none(),
            "事件 id 由方法名承载，不进载荷"
        );
        assert!(value.get("value").is_none(), "value 缺省必须省略而不是 null");
    }
}
