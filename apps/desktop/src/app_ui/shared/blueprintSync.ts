/**
 * 布局 ↔ 蓝图同步（用户需求：布局内调整组后，蓝图自动生成对应节点）。
 *
 * 保存布局时，把当前 dockview 组结构合并进仓库默认蓝图：
 * - 布局里出现、但蓝图中缺失的面板 → 自动补 `control` 节点（panel_id=面板 id）；
 * - 含多个面板的 dockview 组 → 自动补 `group` 节点（独立组）+ 各成员的 `memberOf` 边；
 * - 只做增量合并（不动用户已有的节点/边），合并后保存蓝图。
 */

import type { BlueprintGraph, BlueprintNode, BlueprintEdge } from "@hamster-pouch/config";
import { makeEmptyBlueprint, PANEL_TITLES } from "@hamster-pouch/config";
import type { DockviewApi } from "dockview-react";

import * as api from "./api";

/** 由当前 dockview 结构推导需要补进蓝图的控件/组节点与边。 */
export function diffLayoutIntoBlueprint(
  dv: DockviewApi,
  doc: BlueprintGraph,
): BlueprintGraph {
  const groups = dv.groups;
  const existingKeys = new Set(doc.nodes.map((n) => n.key));
  const panelIdSet = new Set(
    doc.nodes
      .filter((n) => n.type === "control")
      .map((n) => n.panel_id)
      .filter((v): v is string => !!v),
  );

  const nodes = [...doc.nodes];
  const edges = [...doc.edges];

  /** 确保控件节点存在（panel_id 维度去重）。 */
  const ensureControl = (panelId: string): string | null => {
    if (!panelId || panelIdSet.has(panelId)) {
      return null;
    }
    const base = `c_${panelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    let key = base;
    let i = 1;
    while (existingKeys.has(key)) {
      i += 1;
      key = `${base}_${i}`;
    }
    const node: BlueprintNode = {
      key,
      type: "control",
      panel_id: panelId,
      ...(PANEL_TITLES[panelId as keyof typeof PANEL_TITLES]
        ? { title_key: PANEL_TITLES[panelId as keyof typeof PANEL_TITLES] }
        : {}),
      position: { x: 60 + nodes.length * 20, y: 60 + nodes.length * 20 },
    };
    existingKeys.add(key);
    panelIdSet.add(panelId);
    nodes.push(node);
    return key;
  };

  for (const group of groups) {
    const panelIds = Object.keys(group.panels);
    if (panelIds.length === 0) {
      continue;
    }
    // 单面板组：只确保控件节点存在。
    if (panelIds.length === 1) {
      ensureControl(panelIds[0]);
      continue;
    }
    // 多面板组：确保标签组节点 + 成员 memberOf 边。
    const base = `g_layout_${String(group.id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    let groupKey = base;
    let i = 1;
    while (existingKeys.has(groupKey)) {
      i += 1;
      groupKey = `${base}_${i}`;
    }
    const groupNode: BlueprintNode = {
      key: groupKey,
      type: "group",
      mode: "independent",
      default_visible: [],
      position: { x: 60 + nodes.length * 20, y: 60 + nodes.length * 20 },
    };
    existingKeys.add(groupKey);
    nodes.push(groupNode);
    for (const panelId of panelIds) {
      const controlKey = ensureControl(panelId) ?? findControlKey(doc, panelId);
      if (!controlKey) {
        continue;
      }
      // 结构：标签组包含控件（contains 组→控件）
      const exists = edges.some(
        (e) => e.from === groupKey && e.to === controlKey && e.kind === "contains",
      );
      if (!exists) {
        edges.push({
          from: groupKey,
          to: controlKey,
          kind: "contains",
          order: edges.length + 1,
        });
      }
    }
  }

  return { ...doc, nodes, edges };
}

/** 在图中按 panel_id 找控件节点 key。 */
function findControlKey(doc: BlueprintGraph, panelId: string): string | null {
  const n = doc.nodes.find(
    (x) => x.type === "control" && x.panel_id === panelId,
  );
  return n ? n.key : null;
}

/**
 * 把当前布局同步进仓库默认蓝图（无默认则取内置默认起步），并保存蓝图；
 * 返回绑定到布局的蓝图 ID（= 默认蓝图 ID）。
 */
export async function syncBlueprintFromLayout(
  repoId: string,
  dv: DockviewApi,
): Promise<string | null> {
  try {
    let docJson = await api.blueprintGetDefault({ repoId });
    let doc: BlueprintGraph = docJson
      ? (JSON.parse(docJson) as BlueprintGraph)
      : makeEmptyBlueprint();
    doc = diffLayoutIntoBlueprint(dv, doc);

    let defaultItem = (await api.blueprintList({ repoId })).find(
      (i) => i.is_default,
    );
    if (!defaultItem) {
      // 无默认蓝图 → 先种子内置默认再同步。
      const created = await api.blueprintCreate({
        repoId,
        name: "默认蓝图",
        blueprintJson: JSON.stringify(makeEmptyBlueprint()),
      });
      await api.blueprintSetDefault({ repoId, blueprintId: created.id });
      defaultItem = (await api.blueprintList({ repoId })).find(
        (i) => i.is_default,
      );
      if (!defaultItem) {
        return null;
      }
      doc = diffLayoutIntoBlueprint(dv, doc);
    }
    await api.blueprintSave({
      repoId,
      blueprintId: defaultItem.id,
      name: defaultItem.name,
      blueprintJson: JSON.stringify(doc),
    });
    return defaultItem.id;
  } catch {
    return null;
  }
}
