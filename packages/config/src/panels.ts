/**
 * 面板注册表类型与规范面板 ID 列表（布局持久化 D1 用）。
 *
 * 面板实现由 apps/desktop 提供；本包只承载跨面板共享的 id 与描述类型。
 */

/** 面板描述（id + 标题翻译键）。 */
export interface PanelDescriptor {
  id: string;
  titleKey: string;
}

/** 规范面板 ID 列表（与 app_ui 面板注册表保持一致）。 */
export const PANEL_IDS = [
  "repo",
  "sources",
  "albums",
  "media",
  "viewer",
  "metadata",
  "tags",
  "tagtable",
  "color",
  "player",
  "tasks",
  "plugins",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];
