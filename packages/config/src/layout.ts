/**
 * 面板布局类型（按仓库持久化到全局配置库，决策 D1）。
 */

/** 命名面板布局行（`panel_layouts` 表视图）。 */
export interface PanelLayout {
  id: string;
  repo_id: string;
  /** 命名布局标识（布局名）。 */
  workspace: string;
  /** 面板位置/大小/可见性 JSON。 */
  layout_json: string;
  updated_at: string;
}
