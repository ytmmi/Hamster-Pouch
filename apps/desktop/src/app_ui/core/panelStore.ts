/**
 * 面板注册表的 **React 订阅视图**（RFC 0010 决策 4）。
 *
 * 单独成文件的原因：面板组件表（`core/panelRegistry.tsx`）import 了全部面板组件，
 * 而属性面板等**面板内部**的模块也需要读注册表——若它们直接 import `panelRegistry`
 * 就会形成 `panelRegistry → 面板 → 属性面板 → panelRegistry` 的循环。
 * 本文件只依赖 `@hamster-pouch/config` 的纯数据，不带任何组件依赖。
 */

import { useMemo, useSyncExternalStore } from "react";

import {
  allPanels,
  panelsRevision,
  subscribePanels,
  type PanelSpec,
} from "@hamster-pouch/config";

/** 全部已注册面板（内置 14 个 + 插件项）；注册表变化时自动重渲染。 */
export function useAllPanels(): readonly PanelSpec[] {
  const revision = useSyncExternalStore(subscribePanels, panelsRevision, panelsRevision);
  return useMemo(() => allPanels(), [revision]);
}

/** 按 id 取面板声明（未注册 = 插件缺失时的「未接通」）。 */
export function usePanelSpec(id: string | undefined): PanelSpec | undefined {
  const panels = useAllPanels();
  return useMemo(() => (id ? panels.find((p) => p.id === id) : undefined), [panels, id]);
}
