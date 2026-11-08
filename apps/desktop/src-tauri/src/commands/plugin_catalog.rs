//! 「扩展」菜单的**已安装插件目录**通道（`plugin.catalog`）。
//!
//! 从 `commands/plugin.rs` 拆出：该文件已越过 1200 行的文件规则上限
//! （`tools/check-line-count.mjs`）。目录通道与 `plugin.contributions`（注册表口径）
//! 是**两条不同口径**、自成一体的展示职责，拆开后两边都更好读
//! （与 `plugin_panel_data.rs` 同一处置方式）。
//!
//! 目录里**每个插件一行**，面板是内嵌列表（可为空）：
//! - `stateless = false`：有启用语义 → 界面给启用开关；`panels` 里的每一项给"打开"按钮；
//! - `stateless = true`：**纯数据扩展包**（RFC 0008 D36.1，装完即生效，D36.9）
//!   → 界面**只列不给开关**。
//!
//! 早期实现是「面板目录」：一行一个面板、无面板的插件用 `panel = null` 哨兵硬塞，
//! 于是随包的 `python-core`（无面板但有启用语义）被误判为纯数据扩展。现在
//! 「能否打开面板」与「能否启用插件」彻底拆开，仅按 `stateless` 归组。
//! 排序由 `hp_plugin_host::PluginHost::plugin_catalog` 保证：有启用语义的在前、
//! **纯数据扩展整组在最后**（用户要求把数据扩展放在「扩展」菜单最底下）。

use hp_core::HpResult;
use hp_plugin_host::PluginHost;
use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::commands::shared::{ApiResponse, api_from_hp, ensure_global, global, lock_global};

/// 「扩展」菜单用的一行：**一个已安装插件**（均含**未启用**的）。
///
/// 与 `plugin.contributions` 的分工：那个**只含已启用**的（注册表的安全口径），
/// 本项额外把 `enabled` 报出来，界面才能把"装了但没启用"显示成灰显 + 开关。
///
/// `panels` 可为空——例如随包系统插件 `python-core` 不贡献任何面板，
/// 但它**有启用语义**（`stateless = false`），仍应出现在上组并带开关。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCatalogItem {
    plugin_id: String,
    /// 插件显示名（`manifest.name`）。
    plugin_name: String,
    trust_level: String,
    /// 运行时形态（`static-data` / `external-process` / …），界面用作类型标记。
    runtime_kind: String,
    /// **该仓库**是否已启用（`stateless` 的行上该字段无意义，界面不得据此画开关）。
    enabled: bool,
    /// **无启用语义**：纯数据包装完即生效，宿主不据启用状态做任何事（RFC 0008 D36.9）。
    stateless: bool,
    /// manifest 声明的能力，界面据此发起启用（**不得硬编码** `repo.read`）。
    capabilities: Vec<String>,
    /// 该插件贡献的面板（可为空）；界面据此给"打开"按钮。
    panels: Vec<PluginCatalogPanelItem>,
}

/// 「扩展」菜单里插件贡献的一个面板声明。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginCatalogPanelItem {
    id: String,
    /// 面板标题的 i18n 键（插件语言资源未落地时界面原样显示键名）。
    title_key: String,
}

/// plugin.catalog：「扩展」菜单的**已安装插件目录**，**含未启用**。
///
/// 与 `plugin.contributions` 是**两条不同的口径**，不要合并：
/// - `plugin.contributions` 只报**该仓库已启用**的插件（注册表用；启用即授权，属安全口径）；
/// - 本命令报**全部已安装**的，附带 `enabled`，让界面能把"装了但没启用"显示出来。
///
/// 起因是一个真实缺陷：装完插件后「扩展」菜单里什么都不出现、界面也无任何提示，
/// 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
/// 纯数据扩展包（D36.1，`contributions: []`）重演过一次，于是补了"无面板也占一行"。
/// 再往后，随包系统插件 `python-core`（`external-process` + `contributions: []`）
/// 又暴露出"面板目录"这个职责错配：它无面板但**有启用语义**，却被归进纯数据扩展、
/// 贴「安装即启用」且不给开关。现重构为**插件目录**——每插件一行、面板内嵌，
/// 只按 `stateless` 归组，并带上声明能力供界面按实启用。
#[tauri::command]
pub(crate) fn plugin_catalog(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<PluginCatalogItem>> {
    let outcome = (|| -> HpResult<Vec<PluginCatalogItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let db = global(&guard)?;
        Ok(PluginHost
            .plugin_catalog(db, &repo_id)?
            .into_iter()
            .map(|e| PluginCatalogItem {
                plugin_id: e.plugin_id,
                plugin_name: e.plugin_name,
                trust_level: e.trust_level,
                runtime_kind: e.runtime_kind,
                enabled: e.enabled,
                stateless: e.stateless,
                capabilities: e.capabilities,
                panels: e
                    .panels
                    .into_iter()
                    .map(|p| PluginCatalogPanelItem {
                        id: p.id,
                        title_key: p.title_key,
                    })
                    .collect(),
            })
            .collect())
    })();
    api_from_hp(outcome)
}
