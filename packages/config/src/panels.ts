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
  "blueprint",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/**
 * 面板 ID → 标题翻译键（供蓝图编辑器等展示中文面板名）。
 * 需与 app_ui 面板注册表（panelRegistry）的 titleKey 保持一致，新增面板时同步。
 */
export const PANEL_TITLES: Record<PanelId, string> = {
  repo: "panel.repo",
  sources: "panel.sources",
  albums: "panel.albums",
  media: "panel.media",
  viewer: "panel.viewer",
  metadata: "panel.metadata",
  tags: "panel.tags",
  tagtable: "panel.tagtable",
  color: "panel.color",
  player: "panel.player",
  tasks: "panel.tasks",
  plugins: "panel.plugins",
  blueprint: "panel.blueprint",
};

/**
 * 面板标签条高度（与 CSS 变量 `--dv-tabs-and-actions-container-height` 一致）。
 */
export const PANEL_HEADER_HEIGHT = 16;

/** 正文内容最小尺寸（近乎隐藏）。 */
export const PANEL_CONTENT_MIN = 6;

/**
 * 面板最小尺寸：**标签条保留且始终可见，6px 只约束正文**。
 *
 * dockview 默认最小为 100×100；此处放宽：
 * - 最小宽度 = 正文 6px（标签条在顶部，不占宽度）；
 * - 最小高度 = 标签条高度 16px + 正文 6px = 22px，使压扁后标签条仍可见、可再展开。
 */
export const PANEL_MIN_SIZE = {
  minimumWidth: PANEL_CONTENT_MIN,
  minimumHeight: PANEL_HEADER_HEIGHT + PANEL_CONTENT_MIN,
} as const;
