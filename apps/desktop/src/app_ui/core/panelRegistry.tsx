/**
 * 面板注册表 — 面板 id / 标题 / 渲染函数，供 dockview 与菜单共用。
 *
 * **内置 14 个面板**的组件表在 `PANEL_DEFS`（行为与 RFC 0010 之前完全一致）；
 * **插件注册的面板**（`docs/spec/panel-standard.md`）走 `allPanelDefs()` 的动态路径：
 * 宿主按注册表里的声明生成面板项，内部 UI 仍由控件 schema 与宿主白名单决定
 * （`docs/spec/control-standard.md`），插件不得创建自由 React 组件（D44/RFC 0010 决策 2）。
 */

import { useMemo, useSyncExternalStore, type FC } from "react";
import type { IDockviewPanelProps } from "dockview-react";

import {
  panelsRevision,
  pluginRegisteredPanels,
  subscribePanels,
  type PanelSpec,
} from "@hamster-pouch/config";

import type { Translate, TranslationKey } from "../i18n";
import { AlbumPanel } from "../panels/AlbumPanel";
import { BlueprintPanel } from "../panels/BlueprintPanel";
import { ColorPanel } from "../panels/ColorPanel";
import { ImageViewerPanel } from "../panels/imageviewer/ImageViewerPanel";
import { MediaPlayerPanel } from "../panels/MediaPlayerPanel";
import { MediaPreviewPanel } from "../panels/MediaPreviewPanel";
import { MetadataPanel } from "../panels/MetadataPanel";
import { PluginPanel } from "../panels/PluginPanel";
import { PluginPanelHost } from "../panels/PluginPanelHost";
import { RepoPanel } from "../panels/RepoPanel";
import { SourcePanel } from "../panels/SourcePanel";
import { TagRatingPanel } from "../panels/TagRatingPanel";
import { TagTablePanel } from "../panels/TagTablePanel";
import { TaskPanel } from "../panels/TaskPanel";
import { ViewerPanel } from "../panels/ViewerPanel";

/**
 * 面板渲染所需的 dockview 运行时信息。
 *
 * 需要「自己是不是当前激活标签」的面板（如媒体播放器：原生渲染子窗口必须随面板
 * 显隐）不能只靠 React 挂载/卸载判断——dockview 会把非激活标签的组件继续留在 DOM
 * 里，`useEffect` 的清理函数因此不会执行。
 */
export interface PanelRenderCtx {
  /** dockview 面板 API（订阅 `onDidActiveChange` 等）。 */
  api: IDockviewPanelProps["api"];
}

export interface PanelDef {
  id: string;
  titleKey: TranslationKey;
  render: (ctx: PanelRenderCtx) => JSX.Element;
}

/** 宿主内置 14 个面板（顺序与 `PANEL_IDS` 一致）。 */
export const PANEL_DEFS: PanelDef[] = [
  { id: "repo", titleKey: "panel.repo", render: () => <RepoPanel /> },
  { id: "sources", titleKey: "panel.sources", render: () => <SourcePanel /> },
  { id: "albums", titleKey: "panel.albums", render: () => <AlbumPanel /> },
  // 媒体预览需要 dockview 面板 API：面板设置（缺省视图/排序）的第 4 条热加载触发源
  // 「面板从后台标签回到前台时补读一次」靠它可达（与 `viewer` 同款）。
  { id: "media", titleKey: "panel.media", render: (ctx) => <MediaPreviewPanel api={ctx.api} /> },
  // 查看器持有面板设置（`viewer.infoBarEnabled`），需要激活状态才凑齐四条热加载触发源。
  { id: "viewer", titleKey: "panel.viewer", render: (ctx) => <ViewerPanel api={ctx.api} /> },
  { id: "imageviewer", titleKey: "panel.imageviewer", render: (ctx) => <ImageViewerPanel api={ctx.api} /> },
  // 元数据面板消费宿主设置（体积单位 / 日期格式），同样需要激活状态凑齐四条热加载触发源。
  { id: "metadata", titleKey: "panel.metadata", render: (ctx) => <MetadataPanel api={ctx.api} /> },
  { id: "tags", titleKey: "panel.tags", render: () => <TagRatingPanel /> },
  { id: "tagtable", titleKey: "panel.tagtable", render: () => <TagTablePanel /> },
  // 色彩参考持有面板设置（`color.valueFormat`），同样需要激活状态才凑齐四条热加载触发源。
  { id: "color", titleKey: "panel.color", render: (ctx) => <ColorPanel api={ctx.api} /> },
  // 媒体播放器持有**原生**渲染子窗口（libmpv，D14），必须知道激活状态才能显隐。
  { id: "player", titleKey: "panel.player", render: (ctx) => <MediaPlayerPanel api={ctx.api} /> },
  { id: "tasks", titleKey: "panel.tasks", render: () => <TaskPanel /> },
  { id: "plugins", titleKey: "panel.plugins", render: () => <PluginPanel /> },
  { id: "blueprint", titleKey: "panel.blueprint", render: () => <BlueprintPanel /> },
];

/**
 * 插件面板 → 面板项：渲染体是宿主侧的**受控宿主组件**（不是插件代码）。
 *
 * `title_key` 来自插件的语言资源，宿主 i18n 里没有该键时 `t()` 原样返回键名
 * （不静默变成空白，也不内联文案）。
 */
function pluginPanelDef(spec: PanelSpec): PanelDef {
  return {
    id: spec.id,
    titleKey: spec.titleKey as TranslationKey,
    render: () => <PluginPanelHost panelId={spec.id} />,
  };
}

/** 全部面板项（内置 14 个 + 当前已注册的插件面板）。 */
export function allPanelDefs(): PanelDef[] {
  const pluginSpecs = pluginRegisteredPanels();
  return pluginSpecs.length === 0
    ? PANEL_DEFS
    : [...PANEL_DEFS, ...pluginSpecs.map(pluginPanelDef)];
}

/** 全部面板项（React 订阅版：插件注册表变化时自动重渲染）。 */
export function useAllPanelDefs(): PanelDef[] {
  const revision = useSyncExternalStore(subscribePanels, panelsRevision, panelsRevision);
  // `revision` 是唯一依赖：注册表变化即重建面板项清单。
  return useMemo(() => allPanelDefs(), [revision]);
}

/** 面板标题键（未注册返回 `undefined`）。 */
function titleKeyOf(id: string): TranslationKey | undefined {
  const def = allPanelDefs().find((p) => p.id === id);
  return def?.titleKey;
}

export function panelTitle(id: string, t: Translate): string {
  const key = titleKeyOf(id);
  return key ? t(key) : id;
}

/** 面板渲染（无 dockview 上下文；供独立窗口 `SinglePanelHost` 等宿主使用）。 */
export function panelRender(id: string, ctx: PanelRenderCtx): JSX.Element | null {
  const def = allPanelDefs().find((p) => p.id === id);
  return def ? def.render(ctx) : null;
}

/** dockview 组件表（内置 14 个；与 `PANEL_DEFS` 一一对应）。 */
export const DOCK_COMPONENTS: Record<string, FC<IDockviewPanelProps>> = buildComponents(
  PANEL_DEFS,
);

/** dockview 组件表（React 订阅版：含插件面板项）。 */
export function useDockComponents(): Record<string, FC<IDockviewPanelProps>> {
  const defs = useAllPanelDefs();
  return useMemo(() => buildComponents(defs), [defs]);
}

function buildComponents(defs: PanelDef[]): Record<string, FC<IDockviewPanelProps>> {
  return Object.fromEntries(
    defs.map((def) => {
      // dockview 把面板 API 交给组件；这里透传给 `render`，让需要感知
      // 「自己是不是当前激活标签」的面板（媒体播放器）能正确显隐原生子窗口。
      const Component: FC<IDockviewPanelProps> = (props) => (
        <>{def.render({ api: props.api })}</>
      );
      Component.displayName = `DockPanel_${def.id}`;
      return [def.id, Component];
    }),
  );
}
