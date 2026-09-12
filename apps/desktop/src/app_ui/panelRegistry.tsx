/**
 * 面板注册表 — 面板 id / 标题 / 渲染函数，供 dockview 与菜单共用。
 */

import type { FC } from "react";
import type { IDockviewPanelProps } from "dockview-react";

import { AlbumPanel } from "./panels/AlbumPanel";
import { ColorPanel } from "./panels/ColorPanel";
import { MediaPlayerPanel } from "./panels/MediaPlayerPanel";
import { MediaPreviewPanel } from "./panels/MediaPreviewPanel";
import { MetadataPanel } from "./panels/MetadataPanel";
import { RepoPanel } from "./panels/RepoPanel";
import { SourcePanel } from "./panels/SourcePanel";
import { TagRatingPanel } from "./panels/TagRatingPanel";
import { TaskPanel } from "./panels/TaskPanel";
import { ViewerPanel } from "./panels/ViewerPanel";

export interface PanelDef {
  id: string;
  title: string;
  render: () => JSX.Element;
}

export const PANEL_DEFS: PanelDef[] = [
  { id: "repo", title: "仓库", render: () => <RepoPanel /> },
  { id: "sources", title: "图像源", render: () => <SourcePanel /> },
  { id: "albums", title: "相册", render: () => <AlbumPanel /> },
  { id: "media", title: "媒体预览", render: () => <MediaPreviewPanel /> },
  { id: "viewer", title: "查看器", render: () => <ViewerPanel /> },
  { id: "metadata", title: "元数据", render: () => <MetadataPanel /> },
  { id: "tags", title: "标签/评分", render: () => <TagRatingPanel /> },
  { id: "color", title: "色彩参考", render: () => <ColorPanel /> },
  { id: "player", title: "媒体播放", render: () => <MediaPlayerPanel /> },
  { id: "tasks", title: "任务", render: () => <TaskPanel /> },
];

export function panelTitle(id: string): string {
  return PANEL_DEFS.find((p) => p.id === id)?.title ?? id;
}

export function panelRender(id: string): JSX.Element | null {
  const def = PANEL_DEFS.find((p) => p.id === id);
  return def ? def.render() : null;
}

/** dockview 组件表：id → React 组件。 */
export const DOCK_COMPONENTS: Record<string, FC<IDockviewPanelProps>> =
  Object.fromEntries(
    PANEL_DEFS.map((def) => {
      const Component: FC<IDockviewPanelProps> = () => <>{def.render()}</>;
      Component.displayName = `DockPanel_${def.id}`;
      return [def.id, Component];
    }),
  );
