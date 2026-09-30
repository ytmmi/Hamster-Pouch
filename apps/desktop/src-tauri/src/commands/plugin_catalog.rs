//! 「扩展」菜单的**目录**通道（`plugin.panelCatalog`）。
//!
//! 从 `commands/plugin.rs` 拆出：该文件已越过 1200 行的文件规则上限
//! （`tools/check-line-count.mjs`）。目录通道与 `plugin.contributions`（注册表口径）
//! 是**两条不同口径**、自成一体的展示职责，拆开后两边都更好读
//! （与 `plugin_panel_data.rs` 同一处置方式）。
//!
//! 目录里有两类行：
//! - `panel = Some(..)`：插件贡献的**面板**——界面可"打开" + 给启用开关；
//! - `panel = None`：**纯数据扩展包**（RFC 0008 D36.1）——不贡献面板，且**无启用语义**
//!   （`stateless = true`，装完即生效，D36.9），界面**只列不给开关**。
//!
//! 排序由 `hp_plugin_host::PluginHost::panel_catalog` 保证：带面板的在前、
//! **无面板的整组在最后**（用户要求把数据扩展放在「扩展」菜单最底下）。

use hp_core::HpResult;
use hp_plugin_host::PluginHost;
use serde::Serialize;
use tauri::State;

use crate::commands::shared::{api_from_hp, ensure_global, global, lock_global, ApiResponse};
use crate::AppState;

/// 「扩展」菜单用的一行：**已安装**插件的面板**或纯数据扩展**（均含**未启用**的）。
///
/// 与 `plugin.contributions` 的分工：那个**只含已启用**的（注册表的安全口径），
/// 本项额外把 `enabled` 报出来，界面才能把"装了但没启用"显示成灰显 + 开关。
///
/// 两种行：
/// - `panel = Some(..)` —— 该插件贡献的面板，界面可"打开"并给启用开关；
/// - `panel = None` —— 该插件**不贡献面板**（纯数据扩展包，RFC 0008 D36.1），
///   界面只列出来、**不提供打开**；它的 `stateless = true`，**也不得有启用开关**
///   （装完即生效，D36.9）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelCatalogItem {
    plugin_id: String,
    /// 插件显示名（`manifest.name`），界面上说明"这个面板来自哪个插件"。
    plugin_name: String,
    trust_level: String,
    /// 运行时形态（`static-data` / `external-process` / …），界面用作类型标记。
    runtime_kind: String,
    /// 面板声明；`None` = 该插件不贡献面板（纯数据扩展）。
    panel: Option<PanelCatalogPanelItem>,
    /// **该仓库**是否已启用（`stateless` 的行上该字段无意义，界面不得据此画开关）。
    enabled: bool,
    /// **无启用语义**：纯数据包装完即生效，宿主不据启用状态做任何事（RFC 0008 D36.9）。
    stateless: bool,
}

/// 「扩展」菜单里一行所对应面板的声明。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelCatalogPanelItem {
    id: String,
    /// 面板标题的 i18n 键（插件语言资源未落地时界面原样显示键名）。
    title_key: String,
}

/// plugin.panelCatalog：「扩展」菜单的目录——已安装插件贡献的面板**或**纯数据扩展，
/// **含未启用**。
///
/// 与 `plugin.contributions` 是**两条不同的口径**，不要合并：
/// - `plugin.contributions` 只报**该仓库已启用**的插件（注册表用；启用即授权，属安全口径）；
/// - 本命令报**全部已安装**的，附带 `enabled`，让界面能把"装了但没启用"显示出来。
///
/// 起因是一个真实缺陷：装完插件后「扩展」菜单里什么都不出现、界面也无任何提示，
/// 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
/// **同一个缺陷在纯数据扩展包上重演过一次**：这类包按 D36.1 声明
/// `contributions: []`，只按面板过滤就永远不出现，于是装了 128–162MB 的词典扩展
/// 菜单里照样什么都没有。现已改为**无面板的插件也占一行**（`panel = null`），
/// 整组排在带面板的之后（界面据此放到菜单最底下），并带 `stateless = true`
/// ——数据扩展**无状态、安装即启用**，界面不得给它启用开关（RFC 0008 D36.9）。
#[tauri::command]
pub(crate) fn plugin_panel_catalog(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<PanelCatalogItem>> {
    let outcome = (|| -> HpResult<Vec<PanelCatalogItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let db = global(&guard)?;
        Ok(PluginHost
            .panel_catalog(db, &repo_id)?
            .into_iter()
            .map(|e| PanelCatalogItem {
                plugin_id: e.plugin_id,
                plugin_name: e.plugin_name,
                trust_level: e.trust_level,
                runtime_kind: e.runtime_kind,
                panel: e.panel.map(|p| PanelCatalogPanelItem {
                    id: p.id,
                    title_key: p.title_key,
                }),
                enabled: e.enabled,
                stateless: e.stateless,
            })
            .collect())
    })();
    api_from_hp(outcome)
}
