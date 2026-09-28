/**
 * M5：插件命令封装（plugin.*，RFC 0004）。
 *
 * **D76 迁移状态：已包装**（批次 `plugin`，2026-09）。本域全部命令（含两条控件通道命令）
 * 均返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的
 * 领域值，失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
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
  return invoke<ApiResponse<PluginItem[]>>("plugin_list").then(unwrapApi);
}

/** 扫描目录下的插件包（不安装） */
export function pluginDiscover(dir: string): Promise<DiscoveredPlugin[]> {
  return invoke<ApiResponse<DiscoveredPlugin[]>>("plugin_discover", { dir }).then(unwrapApi);
}

/** 安装本地路径插件包并注册 */
export function pluginInstallLocal(path: string): Promise<PluginItem> {
  return invoke<ApiResponse<PluginItem>>("plugin_install_local", { path }).then(unwrapApi);
}

/**
 * `plugin.installBundled` 的逐项结果。
 *
 * 字段是**蛇形**，与本域管理命令（`plugin.list` 的 `PluginItem`）同口径：命令返回值
 * 不是事件载荷，不受 D77 的驼峰约束。
 */
export interface BundledInstallItem {
  /** 随包目录名（`plugins/system/<name>`）。 */
  name: string;
  plugin_id: string | null;
  version: string | null;
  /** `installed` / `alreadyInstalled` / `skipped` / `failed`。 */
  status: string;
  /** 诊断串；界面文案按 `status` 走 i18n，**不直显**（D27）。 */
  message: string | null;
}

/** `plugin.installBundled` 的报告。 */
export interface BundledInstallReport {
  /** 实际使用的随包根目录（诊断用）。 */
  root: string;
  items: BundledInstallItem[];
}

/**
 * 把**随应用分发**的 system 插件包（`plugins/system/*`）装进插件根并登记注册表。
 *
 * **无参数**：命令既不接受路径也不接受插件 id，因此不存在"由调用方决定把什么装成
 * `system`"的入口（缺陷 0008 的边界）。来源与信任由宿主判定，恒为 `system`。
 * **幂等**：同版本目录已存在 → 该项 `alreadyInstalled`，不覆盖、不报错。
 */
export function pluginInstallBundled(): Promise<BundledInstallReport> {
  return invoke<ApiResponse<BundledInstallReport>>("plugin_install_bundled").then(unwrapApi);
}

/** 按仓库启用并授权能力 */
export function pluginEnable(
  repoId: string,
  pluginId: string,
  grants: string[],
): Promise<PluginStateItem> {
  return invoke<ApiResponse<PluginStateItem>>("plugin_enable", { repoId, pluginId, grants }).then(unwrapApi);
}

/** 按仓库禁用插件 */
export function pluginDisable(repoId: string, pluginId: string): Promise<void> {
  return invoke<ApiResponse<void>>("plugin_disable", { repoId, pluginId }).then(unwrapApi);
}

/** 查询插件在某仓库的启用与授权状态 */
export function pluginState(
  repoId: string,
  pluginId: string,
): Promise<PluginStateItem | null> {
  return invoke<ApiResponse<PluginStateItem | null>>("plugin_state", { repoId, pluginId }).then(unwrapApi);
}

/** 加载插件（生命周期骨架） */
export function pluginLoad(repoId: string, pluginId: string): Promise<PluginLoadItem> {
  return invoke<ApiResponse<PluginLoadItem>>("plugin_load", { repoId, pluginId }).then(unwrapApi);
}

/** 列出某插件已安装版本 */
export function pluginVersions(pluginId: string): Promise<string[]> {
  return invoke<ApiResponse<string[]>>("plugin_versions", { pluginId }).then(unwrapApi);
}

/** 回滚到指定已安装版本 */
export function pluginRollback(pluginId: string, version: string): Promise<string> {
  return invoke<ApiResponse<string>>("plugin_rollback", { pluginId, version }).then(unwrapApi);
}

/**
 * 某仓库当前**已启用**插件注册的面板 / 蓝图节点类型 / 设置分节（RFC 0010）。
 *
 * 注册项**不落库**：宿主按当前安装与启用状态实时构造。插件未安装 / 未启用 / 宿主 API
 * 不兼容时其注册项缺席 —— 蓝图侧按「未接通」处理（软告警、允许保存、恢复后自动恢复）。
 */
export function pluginContributions(repoId: string): Promise<PluginContributions> {
  return invoke<ApiResponse<PluginContributions>>("plugin_contributions", { repoId }).then(unwrapApi);
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
