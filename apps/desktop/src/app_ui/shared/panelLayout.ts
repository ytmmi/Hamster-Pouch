/**
 * 面板布局 JSON 工具。
 *
 * 背景：dockview 面板组的约束来自布局 JSON（`panels[id].minimumWidth/minimumHeight`）。
 * 旧布局未记录该字段时，加载会回退到 dockview 默认最小 100×100，导致 `PANEL_MIN_SIZE`
 * （标签条保留 + 正文 6px）失效。套用布局前统一补齐约束即可。
 */

import { PANEL_MIN_SIZE } from "@hamster-pouch/config";

/** 媒体预览面板需保持 DOM（renderer=always），否则 tab 切换会丢失滚动位置。 */
const MEDIA_PANEL_ID = "media";

/** 布局 JSON 中的单个面板状态（只列用到的字段）。 */
interface LayoutPanelState {
  minimumWidth?: number;
  minimumHeight?: number;
  renderer?: string;
}

interface LayoutJson {
  panels?: Record<string, LayoutPanelState>;
}

/**
 * 规范化布局 JSON：
 * - 每个面板补齐 `minimumWidth` / `minimumHeight`（保证最小尺寸约束生效）；
 * - 媒体预览面板强制 `renderer = "always"`。
 *
 * 入参与返回值类型一致（就地修改），便于直接交给 `dockview.fromJSON`。
 */
export function normalizeLayoutJson<T>(layout: T): T {
  const panels = (layout as LayoutJson | null)?.panels;
  if (panels && typeof panels === "object") {
    for (const key of Object.keys(panels)) {
      const panel = panels[key];
      if (!panel || typeof panel !== "object") {
        continue;
      }
      panel.minimumWidth = PANEL_MIN_SIZE.minimumWidth;
      panel.minimumHeight = PANEL_MIN_SIZE.minimumHeight;
      if (key === MEDIA_PANEL_ID) {
        panel.renderer = "always";
      }
    }
  }
  return layout;
}
