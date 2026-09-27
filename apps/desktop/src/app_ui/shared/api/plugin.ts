/**
 * M5：插件命令封装（plugin.*，RFC 0004）。
 *
 * **D76 迁移状态**：`plugin.*` 整体属 D76 批次里的 `plugin` 批（**尚未迁移**，下表命令
 * 仍裸返回）；本域**新增**的两条控件通道命令（`plugin.panelSchema` /
 * `plugin.validateControl`）按 D76「新增命令一律按新口径」直接返回
 * `{ ok, data?, error? }`，因此经 [`unwrapApi`] 解包。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  DiscoveredPlugin,
  PluginItem,
  PluginLoadItem,
  PluginStateItem,
} from "@hamster-pouch/shared-types";

import type { ControlValidateResult } from "@hamster-pouch/config";

import type { PluginContributions } from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 列出已安装插件 */
export function pluginList(): Promise<PluginItem[]> {
  return invoke<PluginItem[]>("plugin_list");
}

/** 扫描目录下的插件包（不安装） */
export function pluginDiscover(dir: string): Promise<DiscoveredPlugin[]> {
  return invoke<DiscoveredPlugin[]>("plugin_discover", { dir });
}

/** 安装本地路径插件包并注册 */
export function pluginInstallLocal(path: string): Promise<PluginItem> {
  return invoke<PluginItem>("plugin_install_local", { path });
}

/** 按仓库启用并授权能力 */
export function pluginEnable(
  repoId: string,
  pluginId: string,
  grants: string[],
): Promise<PluginStateItem> {
  return invoke<PluginStateItem>("plugin_enable", { repoId, pluginId, grants });
}

/** 按仓库禁用插件 */
export function pluginDisable(repoId: string, pluginId: string): Promise<void> {
  return invoke<void>("plugin_disable", { repoId, pluginId });
}

/** 查询插件在某仓库的启用与授权状态 */
export function pluginState(
  repoId: string,
  pluginId: string,
): Promise<PluginStateItem | null> {
  return invoke<PluginStateItem | null>("plugin_state", { repoId, pluginId });
}

/** 加载插件（生命周期骨架） */
export function pluginLoad(repoId: string, pluginId: string): Promise<PluginLoadItem> {
  return invoke<PluginLoadItem>("plugin_load", { repoId, pluginId });
}

/** 列出某插件已安装版本 */
export function pluginVersions(pluginId: string): Promise<string[]> {
  return invoke<string[]>("plugin_versions", { pluginId });
}

/** 回滚到指定已安装版本 */
export function pluginRollback(pluginId: string, version: string): Promise<string> {
  return invoke<string>("plugin_rollback", { pluginId, version });
}

/**
 * 某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节（RFC 0010）。
 *
 * 注册项**不落库**：宿主按当前安装与启用状态实时构造。插件未安装 / 未启用 / 宿主 API
 * 不兼容时其注册项缺席 —— 蓝图侧按「未接通」处理（软告警、允许保存、恢复后自动恢复）。
 */
export function pluginContributions(repoId: string): Promise<PluginContributions> {
  return invoke<PluginContributions>("plugin_contributions", { repoId });
}

/** `plugin.panelSchema` 的返回项（D76 已包装）。 */
export interface PanelSchemaItem {
  panelId: string;
  pluginId: string;
  pluginVersion: string;
  apiVersion: number;
  /** 插件返回的 schema 文本：解析层校验在前端（控件标准第 7 节）。 */
  schemaJson: string;
  /** 本次是否命中 `(plugin_id, panel_id, plugin_version)` 缓存（诊断用）。 */
  cached: boolean;
}

/**
 * 向插件查询面板控件 schema（请求名 `ui.panel.schema`，控件标准第 2 节 / D61）。
 *
 * 失败（超时/输出超限/协议错/插件未启用）→ 抛 [`HpApiFailure`]，由界面把**该面板**
 * 降级为错误态；其它面板不受影响。后端同时广播 `plugin.error`。
 */
export function pluginPanelSchema(
  repoId: string,
  panelId: string,
): Promise<PanelSchemaItem> {
  return invoke<ApiResponse<PanelSchemaItem>>("plugin_panel_schema", {
    repoId,
    panelId,
  }).then(unwrapApi);
}

/**
 * 业务级控件校验（Rust `ControlSchema::validate`，控件标准第 7 节 / D62）。
 *
 * 返回 `{ errors, warnings }`：解析层问题也在这里复算，因此**命令成功不等于 schema 可用**，
 * 调用方必须自己看 `errors`。
 */
export function pluginValidateControl(
  panelId: string,
  schemaJson: string,
): Promise<ControlValidateResult> {
  return invoke<ApiResponse<ControlValidateResult>>("plugin_validate_control", {
    panelId,
    schemaJson,
  }).then(unwrapApi);
}
