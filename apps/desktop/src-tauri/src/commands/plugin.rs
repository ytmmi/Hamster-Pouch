//! M5：插件命令桥接（plugin.*，RFC 0004 / commands-events.md §3.11）。

use std::path::{Path, PathBuf};

use hp_core::{
    Capability, ControlEvent, ControlSchema, ControlValidateCtx, ControlValidateResult, HpError,
    HpResult, PluginRegistryRow, RuntimeKind, CONTROL_API_VERSION,
};
use hp_plugin_host::{
    control_event_method, discover_packages, ExternalProcessQuery, InstallSource, PanelOwner,
    PanelSchemaKey, PanelSchemaParams, PluginHost, PluginInstaller, SupervisionStatus, MANIFEST_FILE,
    SCHEMA_MAX_BYTES, SCHEMA_QUERY_TIMEOUT,
};
use serde::Serialize;
use tauri::{Emitter, State};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::shared::{
    api_from_hp, bundled_plugins_dir, ensure_global, global, global_mut, lock_global, ApiResponse,
};
use crate::AppState;

/// 广播插件注册表变化（`plugin.changed`）：前端据此重建三张注册表的插件部分
/// （RFC 0010 决策 3/4/5/7）。
///
/// 注册项**不落库**，因此事件只带"哪个仓库的启用状态变了"；启用/禁用插件后，
/// 蓝图里由该插件注册的面板与节点类型立即变为「未接通」或自动恢复。
fn emit_plugin_changed(app: &tauri::AppHandle, repo_id: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginChanged {
        repo_id: String,
    }
    let _ = app.emit(
        "plugin.changed",
        PluginChanged {
            repo_id: repo_id.to_string(),
        },
    );
}

#[derive(Serialize)]
pub(crate) struct PluginItem {
    id: String,
    name: String,
    version: String,
    trust_level: String,
    source_kind: String,
    source_ref: Option<String>,
    runtime_kind: String,
    installed_at: String,
}

#[derive(Serialize)]
pub(crate) struct DiscoveredPlugin {
    id: String,
    name: String,
    version: String,
}

#[derive(Serialize)]
pub(crate) struct PluginStateItem {
    plugin_id: String,
    repo_id: String,
    enabled: bool,
    grants: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct PluginLoadItem {
    plugin_id: String,
    repo_id: String,
    runtime_kind: String,
    api_version: u32,
    grants: Vec<String>,
}

/// 面板贡献项（前端登记进面板注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelContributionItem {
    plugin_id: String,
    id: String,
    title_key: String,
    category: String,
    has_class: bool,
    blueprint_node: String,
    settings: Vec<hp_core::PanelSettingDecl>,
    read_only: bool,
    mount: hp_core::PanelMount,
}

/// 设置分节贡献项（前端登记进设置注册表）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsSectionItem {
    plugin_id: String,
    title_key: String,
    category: String,
    settings: Vec<hp_core::PanelSettingDecl>,
}

/// 蓝图节点类型贡献项（前端登记进节点类型注册表）。
///
/// `plugin_id` 与声明字段**平铺**：前端拿到的每一项都是一份可直接登记的纯声明
/// （`type` 已是 `plugin.<plugin_id>.<local_id>`）。
#[derive(Serialize)]
pub(crate) struct NodeContributionItem {
    plugin_id: String,
    #[serde(flatten)]
    node: hp_core::BlueprintNodeDecl,
}

/// 三张注册表的插件注册视图。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginContributions {
    panels: Vec<PanelContributionItem>,
    /// 蓝图节点类型声明（`type` 已由宿主校验为 `plugin.<plugin_id>.<local_id>`）。
    node_types: Vec<NodeContributionItem>,
    settings_sections: Vec<SettingsSectionItem>,
}

/// 「扩展」菜单用的一行：**已安装**插件的面板（含**未启用**的）。
///
/// 与 `panel.contributions` 的分工：那个**只含已启用**的（注册表的安全口径），
/// 本项额外把 `enabled` 报出来，界面才能把"装了但没启用"显示成灰显 + 开关。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelCatalogItem {
    plugin_id: String,
    /// 插件显示名（`manifest.name`），界面上说明"这个面板来自哪个插件"。
    plugin_name: String,
    trust_level: String,
    panel_id: String,
    /// 面板标题的 i18n 键（插件语言资源未落地时界面原样显示键名）。
    title_key: String,
    /// **该仓库**是否已启用。
    enabled: bool,
}

fn row_to_item(r: PluginRegistryRow) -> PluginItem {
    PluginItem {
        id: r.id.as_str().to_string(),
        name: r.name,
        version: r.version,
        trust_level: r.trust_level.as_str().to_string(),
        source_kind: r.source_kind.as_str().to_string(),
        source_ref: r.source_ref,
        runtime_kind: r.runtime_kind.as_str().to_string(),
        installed_at: r.installed_at,
    }
}

fn state_to_item(st: hp_core::PluginRepoState) -> PluginStateItem {
    PluginStateItem {
        plugin_id: st.plugin_id.as_str().to_string(),
        repo_id: st.repo_id.as_str().to_string(),
        enabled: st.enabled,
        grants: st.grants.iter().map(|c| c.as_str().to_string()).collect(),
    }
}

fn parse_grants(raw: &[String]) -> HpResult<Vec<Capability>> {
    raw.iter()
        .map(|s| {
            Capability::from_str(s)
                .ok_or_else(|| HpError::InvalidArgument(format!("未知插件能力: {s}")))
        })
        .collect()
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| String::new())
}

/// plugin.list：列出已安装插件。
#[tauri::command]
pub(crate) fn plugin_list(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Vec<PluginItem>> {
    let outcome = (|| -> HpResult<Vec<PluginItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let rows = g.list_plugins()?;
        Ok(rows.into_iter().map(row_to_item).collect())
    })();
    api_from_hp(outcome)
}

/// plugin.discover：扫描目录下的插件包（不安装）。
#[tauri::command]
pub(crate) fn plugin_discover(dir: String) -> ApiResponse<Vec<DiscoveredPlugin>> {
    let outcome = (|| -> HpResult<Vec<DiscoveredPlugin>> {
        let packages = discover_packages(std::path::Path::new(&dir))?;
        Ok(packages
            .into_iter()
            .map(|p| DiscoveredPlugin {
                id: p.manifest.id.as_str().to_string(),
                name: p.manifest.name,
                version: p.manifest.version,
            })
            .collect())
    })();
    api_from_hp(outcome)
}

/// plugin.installLocal：安装本地路径插件包并注册。
///
/// **来源与信任由宿主判定**：注册表行的 `source_kind` / `trust_level` 同源于
/// `InstallSource::LocalPath`（本地路径恒为 `local-dev`），manifest 里自称的
/// `source.kind` 一律忽略（RFC 0009「来源与信任判定」/ 缺陷 0008）。
#[tauri::command]
pub(crate) fn plugin_install_local(
    path: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginItem> {
    let outcome = (|| -> HpResult<PluginItem> {
        let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
        let row = installer.install_registry_row(
            &InstallSource::LocalPath(std::path::PathBuf::from(&path)),
            now_iso(),
        )?;

        ensure_global(&state, &app)?;
        let mut guard = lock_global(&state)?;
        let g = global_mut(&mut guard)?;
        PluginHost.register(g, &row)?;
        Ok(row_to_item(row))
    })();
    api_from_hp(outcome)
}

// ===== 随包（system）插件播种 =====
//
// `InstallSource::Bundled` 此前**没有任何生产调用方**：`plugin.installLocal` 恒为
// `LocalPath`，启动期只 `create_dir_all`，于是随包分发的 `plugins/system/*` 在应用里
// 永远进不了注册表、`system` 等级不可达（`docs/rfc/0009-plugin-distribution.md`）。
// 下面的命令就是那条缺失的生产路径。

/// 单个随包插件的播种结果。
#[derive(Serialize)]
pub(crate) struct BundledInstallItem {
    /// 随包目录名（`plugins/system/<name>`）。
    name: String,
    plugin_id: Option<String>,
    version: Option<String>,
    /// `installed`（本次新装）/ `alreadyInstalled`（复用既有版本目录）/
    /// `skipped`（目录内没有清单）/ `failed`（读取、安装或登记失败）。
    status: String,
    /// 诊断串。界面文案按 `status` 走 i18n，**不直显**（D27）。
    message: Option<String>,
}

/// `plugin.installBundled` 的报告。
#[derive(Serialize)]
pub(crate) struct BundledInstallReport {
    /// 实际使用的随包根目录（诊断用）。
    root: String,
    items: Vec<BundledInstallItem>,
}

/// 一个随包候选目录。
#[derive(Debug)]
struct BundledCandidate {
    name: String,
    dir: PathBuf,
}

/// 枚举随包根下的**直接子目录**（按名字排序，保证结果确定）。
///
/// 只认直接子目录：不递归、不接受调用方给路径。**命令不接受路径参数是有意的**——
/// 一个能指定安装位置的 `system` 安装入口，等于把缺陷 0008（本地目录自封 system）
/// 从后门放回来。
fn bundled_candidates(root: &Path) -> HpResult<Vec<BundledCandidate>> {
    if !root.is_dir() {
        return Err(HpError::NotFound(format!(
            "随包插件目录不存在: {}（打包运行需由 tauri.conf.json 的 bundle.resources 一并分发 \
             plugins/system，或用 HP_BUNDLED_PLUGINS_DIR 指定）",
            root.display()
        )));
    }
    let entries =
        std::fs::read_dir(root).map_err(|e| HpError::Io(format!("读取随包插件目录失败: {e}")))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| HpError::Io(format!("读取随包插件目录项失败: {e}")))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        out.push(BundledCandidate { name, dir: path });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 播种单个随包目录：安装（或复用同版本目录）并构造注册表行。**不落库、不广播事件**。
fn install_bundled_candidate(
    installer: &PluginInstaller,
    candidate: &BundledCandidate,
    installed_at: &str,
) -> (BundledInstallItem, Option<PluginRegistryRow>) {
    let skipped = |message: String| BundledInstallItem {
        name: candidate.name.clone(),
        plugin_id: None,
        version: None,
        status: "skipped".into(),
        message: Some(message),
    };
    if !candidate.dir.join(MANIFEST_FILE).is_file() {
        return (
            skipped(format!("目录内没有 {MANIFEST_FILE}（随包源码或占位目录）")),
            None,
        );
    }

    // 来源**固定**为随包（→ `system`），不是 `LocalPath`：本命令不接收路径参数。
    let source = InstallSource::Bundled(candidate.dir.clone());
    match installer.install_or_reuse_registry_row(&source, installed_at.to_string()) {
        Ok((row, reused)) => (
            BundledInstallItem {
                name: candidate.name.clone(),
                plugin_id: Some(row.id.as_str().to_string()),
                version: Some(row.version.clone()),
                status: if reused {
                    "alreadyInstalled".into()
                } else {
                    "installed".into()
                },
                message: None,
            },
            Some(row),
        ),
        Err(e) => (
            BundledInstallItem {
                name: candidate.name.clone(),
                plugin_id: None,
                version: None,
                status: "failed".into(),
                message: Some(e.to_string()),
            },
            None,
        ),
    }
}

/// plugin.installBundled：把**随应用分发**的 system 插件包（`plugins/system/*`）装进
/// 应用数据目录下的插件根，并登记全局注册表。
///
/// **来源与信任由宿主判定**：注册表行的 `source_kind` / `trust_level` 同源于
/// `InstallSource::Bundled`（恒为 `system`），manifest 自称一律不参与（RFC 0009 /
/// 缺陷 0008）。命令**不带参数**——既不接受路径也不接受插件 id，因此不存在"由调用方
/// 决定把什么装成 system"的入口。
///
/// **幂等**：同版本目录已存在则复用（`alreadyInstalled`），不覆盖、不报错——版本目录按
/// RFC 0004 不可变。单个插件失败**不**阻塞其余插件（逐项 `failed` 且带诊断串）。
///
/// 安装本身**不广播** `plugin.changed`：刚装上的插件尚未按仓库启用，其注册项本就缺席
/// （与 `plugin.installLocal` 同口径，见 `docs/spec/commands-events.md` §4）。
#[tauri::command]
pub(crate) fn plugin_install_bundled(
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<BundledInstallReport> {
    let outcome = (|| -> HpResult<BundledInstallReport> {
        ensure_global(&state, &app)?;
        let root = bundled_plugins_dir().ok_or_else(|| {
            HpError::NotFound(
                "未找到随包插件目录 plugins/system（可用 HP_BUNDLED_PLUGINS_DIR 指定；\
                 打包运行需补 tauri.conf.json 的 bundle.resources）"
                    .into(),
            )
        })?;
        let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
        let candidates = bundled_candidates(&root)?;

        // 阶段一：磁盘安装。**不持库锁**——复制是慢操作，不该挡住其它命令。
        let now = now_iso();
        let mut items = Vec::new();
        let mut pending: Vec<(usize, PluginRegistryRow)> = Vec::new();
        for candidate in &candidates {
            let (item, row) = install_bundled_candidate(&installer, candidate, &now);
            if let Some(row) = row {
                pending.push((items.len(), row));
            }
            items.push(item);
        }

        // 阶段二：登记注册表（短暂持锁）。单项失败只标该项，不掀翻整批。
        if !pending.is_empty() {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            for (idx, row) in &pending {
                if let Err(e) = PluginHost.register(g, row) {
                    items[*idx].status = "failed".into();
                    items[*idx].message = Some(format!("登记注册表失败: {e}"));
                }
            }
        }

        Ok(BundledInstallReport {
            root: root.to_string_lossy().to_string(),
            items,
        })
    })();
    api_from_hp(outcome)
}

/// plugin.enable：按仓库启用并授权能力。
#[tauri::command]
pub(crate) fn plugin_enable(
    repo_id: String,
    plugin_id: String,
    grants: Vec<String>,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginStateItem> {
    let outcome = (|| -> HpResult<PluginStateItem> {
        let requested = parse_grants(&grants)?;
        ensure_global(&state, &app)?;
        let st = {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            PluginHost.enable_for_repo(g, &plugin_id, &repo_id, &requested)?
        };
        emit_plugin_changed(&app, &repo_id);
        Ok(state_to_item(st))
    })();
    api_from_hp(outcome)
}

/// plugin.disable：按仓库禁用插件。
#[tauri::command]
pub(crate) fn plugin_disable(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<()> {
    let outcome = (|| -> HpResult<()> {
        ensure_global(&state, &app)?;
        {
            let mut guard = lock_global(&state)?;
            let g = global_mut(&mut guard)?;
            PluginHost.disable_for_repo(g, &plugin_id, &repo_id)?;
        }
        emit_plugin_changed(&app, &repo_id);
        Ok(())
    })();
    api_from_hp(outcome)
}

/// plugin.state：查询插件在某仓库的启用与授权状态。
#[tauri::command]
pub(crate) fn plugin_state(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<Option<PluginStateItem>> {
    let outcome = (|| -> HpResult<Option<PluginStateItem>> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let st = g.get_plugin_repo_state(&plugin_id, &repo_id)?;
        Ok(st.map(state_to_item))
    })();
    api_from_hp(outcome)
}

/// 广播 `plugin.loaded`：某插件在某仓库**加载完成**（契约 §4）。
///
/// 语义：校验通过、`LoadOutcome` 已产出即算加载完成（**生命周期骨架**，
/// 不代表常驻进程已拉起——那属 `external-process` 监督，仍未实现）。
fn emit_plugin_loaded(app: &tauri::AppHandle, repo_id: &str, plugin_id: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginLoaded {
        plugin_id: String,
        repo_id: String,
    }
    let _ = app.emit(
        "plugin.loaded",
        PluginLoaded {
            plugin_id: plugin_id.to_string(),
            repo_id: repo_id.to_string(),
        },
    );
}

/// plugin.load：加载插件（生命周期骨架）。
#[tauri::command]
pub(crate) fn plugin_load(
    repo_id: String,
    plugin_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginLoadItem> {
    let outcome = (|| -> HpResult<PluginLoadItem> {
        ensure_global(&state, &app)?;
        let guard = lock_global(&state)?;
        let g = global(&guard)?;
        let outcome = PluginHost.load(g, &plugin_id, &repo_id)?;
        Ok(PluginLoadItem {
            plugin_id: outcome.plugin_id,
            repo_id: outcome.repo_id,
            runtime_kind: outcome.runtime_kind.as_str().to_string(),
            api_version: outcome.api_version,
            grants: outcome.grants.iter().map(|c| c.as_str().to_string()).collect(),
        })
    })();
    // 只在**加载成功后**广播：失败是命令级错误，不该伴随"已加载"事件。
    if let Ok(item) = &outcome {
        emit_plugin_loaded(&app, &item.repo_id, &item.plugin_id);
    }
    api_from_hp(outcome)
}

/// plugin.contributions：某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节
/// （RFC 0010 决策 3/4/5/7）。
///
/// 注册项**不落库**：宿主按当前安装与启用状态实时构造，前端据此登记到三张注册表。
/// 插件未安装 / 未启用 / 宿主 API 不兼容时，其注册项**缺席**——蓝图侧对这类
/// `type` / `panel_id` 按「未接通」处理（软告警 + 灰显 + 允许保存 + 恢复后自动恢复），
/// 见 `docs/spec/panel-standard.md` 第 7.2 节与 RFC 0010 决策 6。
/// plugin.panelCatalog：「扩展」菜单的**面板目录**——已安装插件声明的面板，**含未启用**。
///
/// 与 `plugin.contributions` 是**两条不同的口径**，不要合并：
/// - `plugin.contributions` 只报**该仓库已启用**的插件（注册表用；启用即授权，属安全口径）；
/// - 本命令报**全部已安装**的，附带 `enabled`，让界面能把"装了但没启用"显示出来。
///
/// 起因是一个真实缺陷：装完插件后「扩展」菜单里什么都不出现、界面也无任何提示，
/// 用户只能得出"装了没反应"的结论（`hello` / `control-demo` 都踩过）。
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
                panel_id: e.panel_id,
                title_key: e.title_key,
                enabled: e.enabled,
            })
            .collect())
    })();
    api_from_hp(outcome)
}

#[tauri::command]
pub(crate) fn plugin_contributions(
    repo_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PluginContributions> {
    let outcome = (|| -> HpResult<PluginContributions> {
        ensure_global(&state, &app)?;
        let entries = {
            let guard = lock_global(&state)?;
            let g = global(&guard)?;
            PluginHost.repo_contributions(g, &repo_id)?
        };

    let mut panels = Vec::new();
    let mut node_types = Vec::new();
    let mut settings_sections = Vec::new();
    for entry in entries {
        if let Some(panel) = entry.panel {
            panels.push(PanelContributionItem {
                plugin_id: entry.plugin_id.clone(),
                id: panel.id.clone(),
                title_key: panel.title_key.clone().unwrap_or_default(),
                category: panel.category.clone().unwrap_or_else(|| "other".into()),
                has_class: panel.has_class.unwrap_or(false),
                blueprint_node: panel.blueprint_node.clone().unwrap_or_default(),
                settings: panel.settings.clone(),
                read_only: panel.resolved_read_only(),
                mount: panel.mount.unwrap_or_default(),
            });
        }
        if let Some(node) = entry.node {
            node_types.push(NodeContributionItem {
                plugin_id: entry.plugin_id.clone(),
                node,
            });
        }
        if let Some(section) = entry.settings_section {
            settings_sections.push(SettingsSectionItem {
                plugin_id: entry.plugin_id.clone(),
                title_key: section.title_key,
                category: section.category,
                settings: section.settings,
            });
        }
    }
        Ok(PluginContributions {
            panels,
            node_types,
            settings_sections,
        })
    })();
    api_from_hp(outcome)
}

/// plugin.versions：列出某插件已安装版本。
#[tauri::command]
pub(crate) fn plugin_versions(
    plugin_id: String,
    state: State<AppState>,
) -> ApiResponse<Vec<String>> {
    let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
    api_from_hp(installer.list_versions(&plugin_id))
}

/// plugin.rollback：回滚到指定已安装版本（目录切换，不依赖网络）。
#[tauri::command]
pub(crate) fn plugin_rollback(
    plugin_id: String,
    version: String,
    state: State<AppState>,
) -> ApiResponse<String> {
    let outcome = (|| -> HpResult<String> {
        let installer = PluginInstaller::new(state.plugin_root.as_ref().clone());
        let dir = installer.rollback(&plugin_id, &version)?;
        Ok(dir.to_string_lossy().to_string())
    })();
    api_from_hp(outcome)
}

// ===== 控件 schema 运行时通道（`docs/spec/control-standard.md` 第 2/7 节，D61/D62）=====

/// 广播 `plugin.error`：某个面板的 schema 查询失败。
///
/// 语义（控件标准第 2 节）：**该面板**渲染错误态，**不阻塞其它面板**。
/// `error` 是诊断串（不面向用户显示）；界面文案由前端按结构化 `code` 走 i18n（D27）。
pub(crate) fn emit_plugin_error(app: &tauri::AppHandle, repo_id: &str, plugin_id: &str, error: &str) {
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PluginError {
        plugin_id: String,
        repo_id: String,
        error: String,
    }
    let _ = app.emit(
        "plugin.error",
        PluginError {
            plugin_id: plugin_id.to_string(),
            repo_id: repo_id.to_string(),
            error: error.to_string(),
        },
    );
}

/// 面板 schema 查询结果（`plugin.panelSchema`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelSchemaItem {
    panel_id: String,
    plugin_id: String,
    plugin_version: String,
    api_version: u32,
    /// 插件返回的 schema 文本：**原样**带回，解析层校验在前端（控件标准第 7 节）。
    schema_json: String,
    /// 本次是否命中 `(plugin_id, panel_id, plugin_version)` 缓存（诊断用）。
    cached: bool,
}

/// 反查面板归属并校验可用性（持库锁期间只做纯查询，绝不跨进程等待）。
pub(crate) fn panel_owner_enabled(
    state: &AppState,
    repo_id: &str,
    panel_id: &str,
) -> HpResult<PanelOwner> {
    let guard = state
        .global_db
        .lock()
        .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
    let db = guard
        .as_ref()
        .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
    // 归属由**注册表反查**决定，不靠 panel_id 字符串切分（plugin_id 自身含点）。
    let owner = PluginHost
        .find_panel_owner(db, panel_id)?
        .ok_or_else(|| HpError::NotFound(format!("没有已安装插件声明该面板: {panel_id}")))?;
    // 可用性：插件必须在该仓库已启用且已获 `ui.panel`（RFC 0004；panel-standard 第 6 节）。
    PluginHost.check_capability(db, &owner.plugin_id, repo_id, Capability::UiPanel)?;
    Ok(owner)
}

/// 执行一次受监督的插件外部进程查询。
///
/// 1. 检查监督状态（退避中 / 不健康 → 拒绝）
/// 2. 执行查询（不持任何锁）
/// 3. 记录 success / failure
pub(crate) fn supervised_call(
    state: &AppState,
    plugin_id: String,
    run: impl FnOnce() -> HpResult<String>,
) -> HpResult<String> {
    // 步骤 1：监督检查
    {
        let mut guard = state
            .supervision
            .lock()
            .map_err(|_| HpError::Store("监督注册表锁中毒".into()))?;
        // 自动注册监督器（首次调用某插件时）
        if guard.get_mut(&plugin_id).is_none() {
            guard.register(&plugin_id);
        }
        let sup = guard.get_mut(&plugin_id);
        if let Some(s) = sup {
            match s.status() {
                SupervisionStatus::Unhealthy { .. } => {
                    return Err(HpError::Plugin(format!(
                        "插件 {plugin_id} 已被标记为不健康（连续失败），请重新启用后重试"
                    )));
                }
                _ => {
                    if let Err(remaining) = s.on_call_start() {
                        return Err(HpError::Plugin(format!(
                            "插件 {plugin_id} 退避中，还需等待 {}ms 才能重试",
                            remaining.as_millis()
                        )));
                    }
                }
            }
        } // 未注册监督器的插件（非 external-process）不检查
    }

    // 步骤 2：执行查询
    let result = run();

    // 步骤 3：记录结果
    {
        let mut guard = state
            .supervision
            .lock()
            .map_err(|_| HpError::Store("监督注册表锁中毒".into()))?;
        if let Some(s) = guard.get_mut(&plugin_id) {
            match &result {
                Ok(_) => s.on_success(),
                Err(_) => { s.on_failure(); }
            }
        }
    }

    result
}

/// 取（或查询并缓存）面板 schema。
fn fetch_panel_schema(
    state: &AppState,
    owner: &PanelOwner,
    panel_id: &str,
) -> HpResult<PanelSchemaItem> {
    let key = PanelSchemaKey::new(&owner.plugin_id, panel_id, &owner.plugin_version);
    {
        let cache = state
            .panel_schema_cache
            .lock()
            .map_err(|_| HpError::Store("schema 缓存锁中毒".into()))?;
        if let Some(schema_json) = cache.get(&key) {
            return Ok(PanelSchemaItem {
                panel_id: panel_id.to_string(),
                plugin_id: owner.plugin_id.clone(),
                plugin_version: owner.plugin_version.clone(),
                api_version: CONTROL_API_VERSION,
                schema_json,
                cached: true,
            });
        }
    }

    // 三种运行形态共用同一请求名；本轮先落地 `external-process`（示例与系统插件的形态）。
    if owner.runtime_kind != RuntimeKind::ExternalProcess {
        return Err(HpError::Plugin(format!(
            "运行形态 {} 的 schema 通道尚未接入（当前只支持 external-process）",
            owner.runtime_kind.as_str()
        )));
    }
    let entry = owner.entry_path.clone().ok_or_else(|| {
        HpError::Plugin("注册表缺少插件安装目录（source_ref），无法定位入口".into())
    })?;
    if !entry.is_file() {
        return Err(HpError::Plugin(format!("插件入口不存在: {}", entry.display())));
    }

    // 查询期间**不持任何锁**：这里可能阻塞到超时（D61 默认 2s）。
    let plugin_id_for_run = owner.plugin_id.clone();
    let entry_clone = entry.clone();
    let panel_id_clone = panel_id.to_string();
    let schema_json = supervised_call(state, plugin_id_for_run, move || {
        ExternalProcessQuery::for_entry(entry_clone).query(
            &PanelSchemaParams::new(&panel_id_clone, CONTROL_API_VERSION),
            SCHEMA_QUERY_TIMEOUT,
            SCHEMA_MAX_BYTES,
        )
    })?;

    // 只缓存成功结果：失败必须能在下次重开面板时重试。
    if let Ok(mut cache) = state.panel_schema_cache.lock() {
        cache.put(key, schema_json.clone());
    }
    Ok(PanelSchemaItem {
        panel_id: panel_id.to_string(),
        plugin_id: owner.plugin_id.clone(),
        plugin_version: owner.plugin_version.clone(),
        api_version: CONTROL_API_VERSION,
        schema_json,
        cached: false,
    })
}

/// plugin.panelSchema：向插件查询面板控件 schema（请求名 `ui.panel.schema`，D61）。
///
/// 失败语义：命令本身失败 + 广播 `plugin.error`，由前端把**该面板**降级为错误态；
/// 其它面板不受影响。形状遵循 D76（`{ ok, data?, error? }`）。
#[tauri::command]
pub(crate) fn plugin_panel_schema(
    repo_id: String,
    panel_id: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<PanelSchemaItem> {
    let outcome = (|| -> HpResult<PanelSchemaItem> {
        ensure_global(&state, &app)?;
        let owner = panel_owner_enabled(&state, &repo_id, &panel_id)?;
        let result = fetch_panel_schema(&state, &owner, &panel_id);
        if let Err(e) = &result {
            emit_plugin_error(&app, &repo_id, &owner.plugin_id, &e.to_string());
        }
        result
    })();
    api_from_hp(outcome)
}

/// plugin.validateControl：业务级控件校验（控件标准第 7 节 / D62）。
///
/// 返回 `{ errors, warnings }`：**解析层问题也在这里复算**（JSON 不可解析时以
/// `errors` 返回，而不是命令级失败），因此前端拿到的永远是同一形状的判定结果。
/// 面板不由任何已安装插件声明时，声明表为空——任何 `bind` / `on` 都会成为硬错误，
/// 这是 fail-closed 的有意选择（宿主是最终裁决者）。
#[tauri::command]
pub(crate) fn plugin_validate_control(
    panel_id: String,
    schema_json: String,
    state: State<AppState>,
    app: tauri::AppHandle,
) -> ApiResponse<ControlValidateResult> {
    let outcome = (|| -> HpResult<ControlValidateResult> {
        ensure_global(&state, &app)?;
        let (declared_queries, declared_events) = {
            let guard = state
                .global_db
                .lock()
                .map_err(|_| HpError::Store("全局库锁中毒".into()))?;
            let db = guard
                .as_ref()
                .ok_or_else(|| HpError::Store("全局库未初始化".into()))?;
            match PluginHost.find_panel_owner(db, &panel_id)? {
                Some(owner) => (owner.declared_queries, owner.declared_events),
                None => (Vec::new(), Vec::new()),
            }
        };
        let ctx = ControlValidateCtx {
            expected_panel_id: Some(panel_id),
            declared_queries,
            declared_events,
        };
        let schema = match ControlSchema::from_json(&schema_json) {
            Ok(schema) => schema,
            Err(message) => {
                return Ok(ControlValidateResult {
                    errors: vec![message],
                    warnings: Vec::new(),
                })
            }
        };
        Ok(schema.validate(&ctx))
    })();
    api_from_hp(outcome)
}


// ===== 控件事件回传链（`docs/spec/control-standard.md` 第 6 节 / D63）=====

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

        let method = control_event_method(&owner.plugin_id, &event_id);
        let params = ControlEventParams {
            panel_id: &panel_id,
            control_id: &control_id,
            event: parsed.as_str(),
            value: value.as_ref(),
            target: target.as_deref(),
        };

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

        Ok(ControlEventAck {
            panel_id,
            plugin_id: owner.plugin_id,
            control_id,
            event,
            event_id,
            method,
        })
    })();
    api_from_hp(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hp_core::{SourceKind, TrustLevel};

    /// 随包样例清单：请求 `system`，但**来源**由宿主判定（RFC 0009）。
    ///
    /// 它故意不写 `source` 字段，也不创建 `entry` 指向的 `bin/sample.exe`——这正是
    /// `plugins/system/palette` 的现状（只随包分发清单）。安装阶段不校验入口存在，
    /// "入口缺失"是**面板查询时**才降级的事（`plugin.panelSchema` → `plugin.error`）。
    const SAMPLE_MANIFEST: &str = r#"{
        "id": "dev.hamsterpouch.bundled.sample",
        "name": "随包样例",
        "version": "0.1.0",
        "min_host_version": 1,
        "api_version": 1,
        "runtime": { "kind": "external-process" },
        "entry": "bin/sample.exe",
        "capabilities": ["ui.panel"],
        "contributions": [],
        "trust": { "requested": "system" }
    }"#;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hp-bundled-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("建临时目录失败");
        dir
    }

    fn write_package(root: &Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("建随包目录失败");
        std::fs::write(dir.join(MANIFEST_FILE), SAMPLE_MANIFEST).expect("写清单失败");
    }

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

    #[test]
    fn candidates_are_direct_subdirectories_sorted_by_name() {
        let root = temp_root("cand");
        write_package(&root, "zeta");
        write_package(&root, "alpha");
        std::fs::write(root.join("loose.txt"), b"x").expect("写散文件失败");

        let names: Vec<String> = bundled_candidates(&root)
            .expect("枚举失败")
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["alpha", "zeta"], "只取直接子目录且按名字排序");
    }

    #[test]
    fn missing_bundled_root_is_not_found() {
        let root = temp_root("missing").join("nope");
        let err = bundled_candidates(&root).expect_err("不存在的随包根应报错");
        assert!(
            matches!(err, HpError::NotFound(_)),
            "应为 not_found，实得 {err:?}"
        );
    }

    /// **回退即红**：随包候选的来源必须是 `InstallSource::Bundled`（→ `system`）。
    /// 若把它改回 `InstallSource::LocalPath`（缺陷 0008 之前的形态），
    /// `trust_level` 会变成 `local-dev`，本用例立即失败。
    #[test]
    fn bundled_candidate_is_registered_as_system_and_is_idempotent() {
        // D40：无 SHA256SUMS.sig 的系统插件信任降为 Community；待签名正式上线后
        // 本测试应加签名文件。
        let root = temp_root("install");
        write_package(&root, "palette");
        let installer = PluginInstaller::new(temp_root("store"));

        let candidate = bundled_candidates(&root).expect("枚举失败").remove(0);
        let (first, row1) = install_bundled_candidate(&installer, &candidate, "t1");
        assert_eq!(first.status, "installed");
        let row1 = row1.expect("新装应产出注册表行");
        assert_eq!(row1.source_kind, SourceKind::System);
        assert_eq!(row1.trust_level, TrustLevel::Community);
        assert!(!row1.trust_level.allows_dynamic_library());

        // 幂等：同版本再来一次是"复用"，不是错误。
        let (second, row2) = install_bundled_candidate(&installer, &candidate, "t2");
        assert_eq!(second.status, "alreadyInstalled");
        let row2 = row2.expect("复用也要产出注册表行，否则注册表丢失后无法修复");
        assert_eq!(row2.source_kind, SourceKind::System);
        assert_eq!(row2.trust_level, TrustLevel::Community);
    }

    #[test]
    fn directory_without_manifest_is_skipped() {
        let root = temp_root("skip");
        // 与 `plugins/system/python-core` 同形态：只有占位说明、没有清单。
        std::fs::create_dir_all(root.join("python-core")).expect("建目录失败");
        let installer = PluginInstaller::new(temp_root("store-skip"));

        let candidate = bundled_candidates(&root).expect("枚举失败").remove(0);
        let (item, row) = install_bundled_candidate(&installer, &candidate, "t1");
        assert_eq!(item.status, "skipped");
        assert!(row.is_none(), "跳过项不应产出注册表行");
        assert!(item
            .message
            .unwrap_or_default()
            .contains(MANIFEST_FILE));
    }
}
