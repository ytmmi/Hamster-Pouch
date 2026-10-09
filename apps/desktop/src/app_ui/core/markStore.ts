/**
 * 标记清单的 **React 订阅视图**（D102）。
 *
 * 与 `panelStore.ts` 同一个理由单独成文件：属性面板（`BlueprintInspector`）需要读
 * **当前可用的标记清单**来渲染下拉候选，而清单是**可注册**的（内置 `book` / `manga`
 * + 宿主/插件登记项）——注册表变化时必须自动重渲染，否则用户装了插件也看不到新标记。
 *
 * 本文件只依赖 `@hamster-pouch/config` 的纯数据，不带任何组件依赖。
 */

import { useMemo, useSyncExternalStore } from "react";

import { allMarkKinds, marksRevision, subscribeMarks } from "@hamster-pouch/config";

/** 当前全部可用标记 id（内置 + 登记项）；清单变化时自动重渲染。 */
export function useAllMarks(): readonly string[] {
  const revision = useSyncExternalStore(subscribeMarks, marksRevision, marksRevision);
  return useMemo(() => allMarkKinds(), [revision]);
}
