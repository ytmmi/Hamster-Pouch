/**
 * dockview 的默认首屏布局（无默认仓库 / 无已存布局时的兜底界面）。
 *
 * 只负责**建面板**：左侧功能栏 + 中央媒体预览 + 右侧检查器。默认仓库的布局套用
 * 属于 `workspaceBootstrap.ts`（本模块不碰仓库与持久化）。
 */

import type { DockviewApi } from "dockview-react";
import { PANEL_MIN_SIZE } from "@hamster-pouch/config";

import type { Translate } from "../i18n";
import { panelTitle } from "./panelRegistry";

/** 建立默认布局（首次启动、或默认仓库没有可用布局时保留的界面）。 */
export function addDefaultPanels(dv: DockviewApi, t: Translate): void {
  // 默认布局：左侧功能栏 + 中央媒体预览 + 右侧检查器
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "repo",
    component: "repo",
    title: panelTitle("repo", t),
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "sources",
    component: "sources",
    title: panelTitle("sources", t),
    position: { referencePanel: "repo", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "albums",
    component: "albums",
    title: panelTitle("albums", t),
    position: { referencePanel: "sources", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "media",
    component: "media",
    title: panelTitle("media", t),
    // 保持 DOM（即使 tab 未激活），切回媒体预览时滚动位置不丢失
    renderer: "always",
    position: { referencePanel: "repo", direction: "right" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "viewer",
    component: "viewer",
    title: panelTitle("viewer", t),
    position: { referencePanel: "media", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "metadata",
    component: "metadata",
    title: panelTitle("metadata", t),
    position: { referencePanel: "media", direction: "right" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "tags",
    component: "tags",
    title: panelTitle("tags", t),
    position: { referencePanel: "metadata", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "color",
    component: "color",
    title: panelTitle("color", t),
    position: { referencePanel: "tags", direction: "within" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "tagtable",
    component: "tagtable",
    title: panelTitle("tagtable", t),
    position: { referencePanel: "tags", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "player",
    component: "player",
    title: panelTitle("player", t),
    position: { referencePanel: "tagtable", direction: "below" },
  });
  dv.addPanel({
    ...PANEL_MIN_SIZE,
    id: "tasks",
    component: "tasks",
    title: panelTitle("tasks", t),
    position: { referencePanel: "player", direction: "within" },
  });
}
