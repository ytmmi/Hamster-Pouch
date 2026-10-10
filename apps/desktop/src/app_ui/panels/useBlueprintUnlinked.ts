/**
 * 未接通节点的面板侧派生（RFC 0007 / D55 / RFC 0010 决策 6）。
 *
 * 判定本身是纯函数 `analyzeUnlinked`（`app_ui/shared/blueprintLint.ts`，由
 * `tools/blueprint-delete-check.mjs` 脱离宿主验证）；本文件只把"当前编辑文档"
 * 喂给它，并整理成画布灰显与顶部提示要用的 key 集合。**不落库**：未接通是派生状态。
 *
 * `refreshKey`：工具栏「刷新」按钮的计数。文档引用不变时也要能强制重算一次
 * （用户反馈"连线后节点状态没刷新"），因此把它并入依赖。
 */

import { useMemo } from "react";

import type { BlueprintGraph } from "@hamster-pouch/config";

import { analyzeUnlinked } from "../shared/blueprintLint";

/** 当前编辑文档里"未接通"的节点 key 集合（画布灰显用）。 */
export function useBlueprintUnlinked(
  doc: BlueprintGraph,
  refreshKey = 0,
): ReadonlySet<string> {
  const unlinked = useMemo(() => analyzeUnlinked(doc), [doc, refreshKey]);
  return useMemo(() => new Set(Object.keys(unlinked)), [unlinked]);
}
