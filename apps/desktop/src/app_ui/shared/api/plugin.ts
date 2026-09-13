/**
 * M5：插件命令封装（plugin.*，RFC 0004）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  DiscoveredPlugin,
  PluginItem,
  PluginLoadItem,
  PluginStateItem,
} from "@hamster-pouch/shared-types";

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
