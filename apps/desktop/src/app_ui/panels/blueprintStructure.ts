/**
 * 蓝图结构骨架生成（RFC 0007）：从**当前布局**推导「布局块 → 标签组 → 控件」三层结构，
 * 作为新建蓝图的基础。
 *
 * 为什么需要：新建蓝图若从空图起步，用户得先把布局结构（左/中/右栏、哪些面板同属一个
 * 标签组）手工搭一遍——而这些信息 dockview 里本来就有。这里把当前布局**读**成结构节点，
 * 用户随后只需补规则（对象→操作→状态）。
 *
 * 口径与内置默认蓝图一致：
 * - 每个 dockview 组 → 一个**布局块**（顶层区域）；
 * - 组内多个面板 → 一个**标签组**（成员由 contains 边表示），布局块只连标签组；
 * - 组内单个面板 → 布局块直接连该**控件**；
 * - 每个面板 → 一个控件节点（panel_id + 本地化标题键）。
 */

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";
import { makeEmptyBlueprint, PANEL_TITLES, type PanelId } from "@hamster-pouch/config";
import type { DockviewApi } from "dockview-react";

import { uniqueKey } from "./blueprintNodeFactory";

/** 结构骨架的列宽/行高（按列铺开，互不重叠；用户可再拖拽）。 */
const COL_W = 300;
const ROW_H = 130;
const ORIGIN = 40;

/** 由当前 dockview 布局生成结构骨架图文档（空布局 → 空图）。 */
export function structureBlueprint(dv: DockviewApi): BlueprintGraph {
  const doc = makeEmptyBlueprint();
  const nodes: BlueprintNode[] = [...doc.nodes];
  const edges: BlueprintEdge[] = [...doc.edges];

  const add = (node: BlueprintNode): string => {
    nodes.push(node);
    return node.key;
  };
  const connect = (from: string, to: string): void => {
    edges.push({ from, to, kind: "contains", order: edges.length + 1 });
  };

  const groups = dv.groups.filter((g) => g.api.location.type !== "floating");
  groups.forEach((group, col) => {
    const panelIds = group.panels.map((p) => p.id);
    if (panelIds.length === 0) {
      return;
    }
    const x = ORIGIN + col * COL_W;
    const blockKey = add({
      key: uniqueKey(nodes, `blk_${group.id}`),
      type: "layout_block",
      name: `区域 ${col + 1}`,
      position: { x, y: ORIGIN },
    });

    const controlKey = (index: number): string =>
      add({
        key: uniqueKey(nodes, `c_${panelIds[index]}`),
        type: "control",
        panel_id: panelIds[index],
        ...(PANEL_TITLES[panelIds[index] as PanelId]
          ? { title_key: PANEL_TITLES[panelIds[index] as PanelId] }
          : {}),
        position: { x: x + COL_W, y: ORIGIN + (index + 1) * ROW_H },
      });

    if (panelIds.length === 1) {
      // 单面板组：布局块直接含控件（没有标签组语义）。
      connect(blockKey, controlKey(0));
      return;
    }
    // 多面板组：布局块只连标签组，成员由标签组 contains（与默认蓝图口径一致）。
    const groupKey = add({
      key: uniqueKey(nodes, `g_${group.id}`),
      type: "group",
      mode: "exclusive",
      position: { x: x + COL_W, y: ORIGIN },
    });
    connect(blockKey, groupKey);
    panelIds.forEach((_, index) => {
      const key = controlKey(index);
      edges.push({
        from: groupKey,
        to: key,
        kind: "contains",
        order: edges.length + 1,
      });
    });
  });

  return { ...doc, nodes, edges };
}
