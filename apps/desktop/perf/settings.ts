/**
 * 性能夹具：**面板设置的写入路径**。
 *
 * 夹具不直接改 React state（那会绕过面板真实的设置解析），而是复刻「全部设置」浮层
 * 写入一项设置后的**两步**：
 * 1. 值落到 `settingOverrides`（`setting_get` 桩从这里读）；
 * 2. `publishSettingChanged(落库键)` 广播——面板的 `useStoredSetting` 收到后重读。
 *
 * 这与生产路径一致（`settingChangeStore.ts` 的说明：同窗口写完即本地广播）。
 */

import { panelSettingStorageKey, PANEL_IDS } from "@hamster-pouch/config";

import { publishSettingChanged } from "../src/app_ui/core/settingChangeStore";
import { settingOverrides } from "./stubs/tauri-core";

/** 媒体预览面板的 id（与 `packages/config` 的注册表一致）。 */
export const MEDIA_PANEL_ID = "media";

/** 面板设置落库键前缀（`panel.<id>.`）。 */
export const PANEL_SETTING_PREFIX = `panel.${MEDIA_PANEL_ID}.`;

/**
 * 写入一项媒体预览面板设置并广播。
 *
 * `key` 用**短名**（`view` / `imageSize` / `showFileName` / `sortKey` / `sortDir`），
 * 与 `packages/config/src/panels.ts` 的声明一致。
 */
export function writePanelSetting(key: string, value: unknown): void {
  const storageKey = panelSettingStorageKey(MEDIA_PANEL_ID, key);
  settingOverrides.set(storageKey, value);
  publishSettingChanged(storageKey);
}

/** 夹具可用的面板 id（防止拼错导致"设置了没反应"）。 */
export const KNOWN_PANEL_IDS = PANEL_IDS;
