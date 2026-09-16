/**
 * 蓝图节点画布槽位（防止节点堆叠）。
 *
 * 蓝图文档的节点 `position {x,y}` 是画布世界坐标（D30 随文档落库）。旧文档或
 * 经 JSON 视图批量编辑产生的节点可能缺 `position`，或新增节点时随手落在同一处，
 * 表现为"节点堆叠在一起"。本模块只按**近似卡片占位**在固定网格上找空槽：
 * 已有 `position` 的节点一律保持原位（尊重用户摆放），只给缺失/新增的节点分配
 * 不冲突的槽位。
 */

import type { BlueprintGraph, BlueprintNode } from "@hamster-pouch/config";

/** 画布槽位尺寸（近似节点卡片占位 + 间距）。 */
export const SLOT_W = 260;
export const SLOT_H = 130;
/** 槽位原点（与默认蓝图坐标基准一致）。 */
const ORIGIN = 40;

/** 槽位列数（按已有节点横向范围取整，至少 6 列）。 */
function slotColumns(nodes: BlueprintNode[]): number {
  let maxX = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.position?.x ?? 0);
  }
  return Math.max(6, Math.ceil((maxX + SLOT_W - ORIGIN) / SLOT_W));
}

/** 该槽位是否与任何已放置节点冲突（按卡片近似占位判定，可忽略指定节点自身）。 */
function slotFree(
  nodes: BlueprintNode[],
  x: number,
  y: number,
  ignoreKey?: string,
): boolean {
  return !nodes.some((n) => {
    if (n.key === ignoreKey) {
      return false;
    }
    const p = n.position;
    if (!p) {
      return false;
    }
    return Math.abs(p.x - x) < SLOT_W && Math.abs(p.y - y) < SLOT_H;
  });
}

/** 把已分配槽位转成占位节点，供后续冲突判定使用。 */
function assignedNodes(
  assigned: Map<string, { x: number; y: number }>,
): BlueprintNode[] {
  return [...assigned.entries()].map(([key, position]) => ({
    key,
    type: "control",
    position,
  }));
}

/** 距给定基准点最近的空闲槽位（新增节点不堆叠）。 */
export function freeSlotPosition(
  nodes: BlueprintNode[],
  base: { x: number; y: number },
  ignoreKey?: string,
): { x: number; y: number } {
  const cols = slotColumns(nodes);
  const baseCol = Math.max(0, Math.round((base.x - ORIGIN) / SLOT_W));
  for (let i = 0; i < 400; i += 1) {
    // 从基准列起，逐行向下、向右绕圈找空槽。
    const col = (baseCol + (i % cols)) % cols;
    const row = Math.floor(i / cols);
    const x = ORIGIN + col * SLOT_W;
    const y = base.y + row * SLOT_H;
    if (slotFree(nodes, x, y, ignoreKey)) {
      return { x, y };
    }
  }
  return { x: base.x, y: base.y + 400 * SLOT_H };
}

/** 画布中心附近（供新增节点起始搜索）。 */
export function canvasCenter(nodes: BlueprintNode[]): { x: number; y: number } {
  if (nodes.length === 0) {
    return { x: ORIGIN, y: ORIGIN };
  }
  let maxX = 0;
  for (const n of nodes) {
    maxX = Math.max(maxX, n.position?.x ?? 0);
  }
  return { x: ORIGIN + Math.floor(maxX / SLOT_W / 2) * SLOT_W, y: ORIGIN };
}

/**
 * 为缺失 `position` 的节点分配互不重叠的网格槽位（自左上起逐列铺开）。
 * 已有 `position` 的节点保持原位；无缺失时原样返回（引用不变，便于调用方跳过落库）。
 */
export function normalizePositions(doc: BlueprintGraph): BlueprintGraph {
  const missing = doc.nodes.filter((n) => !n.position);
  if (missing.length === 0) {
    return doc;
  }
  const placed = doc.nodes.filter((n) => n.position);
  const cols = slotColumns(doc.nodes);
  let cursor = 0;
  const assigned = new Map<string, { x: number; y: number }>();
  for (const node of missing) {
    let pos = { x: ORIGIN, y: ORIGIN };
    for (;;) {
      const col = cursor % cols;
      const row = Math.floor(cursor / cols);
      const x = ORIGIN + col * SLOT_W;
      const y = ORIGIN + row * SLOT_H;
      cursor += 1;
      if (slotFree([...placed, ...assignedNodes(assigned)], x, y)) {
        pos = { x, y };
        break;
      }
    }
    assigned.set(node.key, pos);
  }
  const occupied = [...placed, ...assignedNodes(assigned)];
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.position) {
        return n;
      }
      const wanted = assigned.get(n.key) ?? { x: ORIGIN, y: ORIGIN };
      const position = slotFree(occupied, wanted.x, wanted.y, n.key)
        ? wanted
        : freeSlotPosition(occupied, wanted, n.key);
      return { ...n, position };
    }),
  };
}
