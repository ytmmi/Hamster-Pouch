//! M5：插件包命令桥接（安装 / 发现 / 版本回滚；RFC 0004 / commands-events.md §3.11）。
//!
//! 同域的其它文件（同一 `plugin.*` 域的桥接按**职责**分文件，`file-structure.md`）：
//!
//! - `plugin_lifecycle.rs`：按仓库启用/禁用/状态/加载（`plugin.enable` / `disable` / `state` / `load`）；
//! - `plugin_contributions.rs`：三张注册表的插件注册视图（`plugin.contributions`）；
//! - `plugin_control_channel.rs`：控件通道地基与 schema / 业务级校验命令（控件标准第 2/7 节）；
//! - `plugin_control_event.rs`：控件事件回传链（控件标准第 6 节 / D63）；
//! - `plugin_catalog.rs` / `plugin_panel_data.rs`：「扩展」目录与面板受控取数两条通道。

use std::path::{Path, PathBuf};

use hp_core::{HpError, HpResult, PluginRegistryRow};
use hp_plugin_host::{
    discover_packages, parse_manifest, InstallSource, PluginHost, PluginInstaller, MANIFEST_FILE,
};
use serde::Serialize;
use tauri::State;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::commands::shared::{
    api_from_hp, bundled_plugins_dir, ensure_global, global, global_mut, lock_global, ApiResponse,
};
use crate::AppState;

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
    /// 插件**声明**的能力列表（`plugin.manifest` 的 `capabilities`）。
    ///
    /// 前端启用插件时只能请求这里的子集——`enable_for_repo` 会拒绝未声明的能力。
    /// 纯数据扩展包（`static-data`）声明为空，因此启用时**不应请求任何能力**
    /// （此前前端硬编码 `["repo.read"]`，导致这类包启用报「请求内容不合法」）。
    capabilities: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct DiscoveredPlugin {
    id: String,
    name: String,
    version: String,
}

fn row_to_item(r: PluginRegistryRow) -> PluginItem {
    // 声明能力从注册表里的 manifest_json 解析（安装时原样存入，是权威清单）。
    // 解析失败不致命：退回空列表（前端将不请求任何能力，等价于只读启用）。
    let capabilities = parse_manifest(&r.manifest_json)
        .map(|m| m.capabilities.iter().map(|c| c.as_str().to_string()).collect())
        .unwrap_or_default();
    PluginItem {
        id: r.id.as_str().to_string(),
        name: r.name,
        version: r.version,
        trust_level: r.trust_level.as_str().to_string(),
        source_kind: r.source_kind.as_str().to_string(),
        source_ref: r.source_ref,
        runtime_kind: r.runtime_kind.as_str().to_string(),
        installed_at: r.installed_at,
        capabilities,
    }
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
        drop(guard);
        // tag 扩展装完即重装配（数据是应用级共享，不依赖仓库启用状态）
        crate::commands::tagdict::reload(&state);
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
        // D40+：随包插件有签名文件时信任为 System；测试夹具无签名文件 → Community。
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
