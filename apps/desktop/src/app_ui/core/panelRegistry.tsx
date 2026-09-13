/**
 * 面板注册表 — 面板 id / 标题 / 渲染函数，供 dockview 与菜单共用。
 */

import type { FC } from "react";
import type { IDockviewPanelProps } from "dockview-react";

import type { Translate, TranslationKey } from "../i18n";
import { AlbumPanel } from "../panels/AlbumPanel";
import { ColorPanel } from "../panels/ColorPanel";
import { MediaPlayerPanel } from "../panels/MediaPlayerPanel";
import { MediaPreviewPanel } from "../panels/MediaPreviewPanel";
import { MetadataPanel } from "../panels/MetadataPanel";
import { PluginPanel } from "../panels/PluginPanel";
import { RepoPanel } from "../panels/RepoPanel";
import { SourcePanel } from "../panels/SourcePanel";
import { TagRatingPanel } from "../panels/TagRatingPanel";
import { TaskPanel } from "../panels/TaskPanel";
import { ViewerPanel } from "../panels/ViewerPanel";

export interface PanelDef {
  id: string;
  titleKey: TranslationKey;
  render: () => JSX.Element;
}

export const PANEL_DEFS: PanelDef[] = [
  { id: "repo", titleKey: "panel.repo", render: () => <RepoPanel /> },
  { id: "sources", titleKey: "panel.sources", render: () => <SourcePanel /> },
  { id: "albums", titleKey: "panel.albums", render: () => <AlbumPanel /> },
  { id: "media", titleKey: "panel.media", render: () => <MediaPreviewPanel /> },
  { id: "viewer", titleKey: "panel.viewer", render: () => <ViewerPanel /> },
  { id: "metadata", titleKey: "panel.metadata", render: () => <MetadataPanel /> },
  { id: "tags", titleKey: "panel.tags", render: () => <TagRatingPanel /> },
  { id: "color", titleKey: "panel.color", render: () => <ColorPanel /> },
  { id: "player", titleKey: "panel.player", render: () => <MediaPlayerPanel /> },
  { id: "tasks", titleKey: "panel.tasks", render: () => <TaskPanel /> },
  { id: "plugins", titleKey: "panel.plugins", render: () => <PluginPanel /> },
];

export function panelTitle(id: string, t: Translate): string {
  const def = PANEL_DEFS.find((p) => p.id === id);
  return def ? t(def.titleKey) : id;
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
