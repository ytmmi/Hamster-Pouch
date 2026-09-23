/**
 * 蓝图层操作（RFC 0007 / D51 / D55 / D60）——纯函数，便于脱离宿主验证。
 *
 * 语义：
 * - **一个层 = 一张画布 = 一个界面（页面）**；层名即该层界面的显示名（D51）；
 * - 新增层**同时建出该层的界面根节点**（每层至多一个 `interface`；无根层 = 未接通软告警）；
 * - 层名蓝图内唯一（D60）：重名时自动追加序号；
 * - 排序只影响编辑器里的层顺序（画布标签次序），不影响 JSON 语义；
 * - 删除层见 `blueprintDelete.removeLayer`（直接删除、禁止删最后一层，D55）。
 */

import type { BlueprintGraph, BlueprintLayer, BlueprintNode } from "@hamster-pouch/config";
import {
  effectiveLayers,
  interfaceOfLayer,
  uniqueLayerKey,
  uniqueLayerName,
} from "@hamster-pouch/config";

import { uniqueKey } from "./blueprintNodeFactory";

/** 保证文档是"显式分层"形态（兜底单层实体化），返回新文档。 */
export function withExplicitLayers(doc: BlueprintGraph): BlueprintGraph {
  if ((doc.layers?.length ?? 0) > 0) {
    return doc;
  }
  const [layer] = effectiveLayers(doc);
  return {
    ...doc,
    layers: [layer],
    nodes: doc.nodes.map((n) => ({ ...n, layer: n.layer ?? layer.key })),
  };
}

/** 新建层：返回追加了新层（及其界面根节点）的文档与新层 key。 */
export function addLayer(
  doc: BlueprintGraph,
  name?: string,
  position?: { x: number; y: number },
): { doc: BlueprintGraph; layer: BlueprintLayer; interfaceKey: string } {
  const base = withExplicitLayers(doc);
  const index = (base.layers?.length ?? 0) + 1;
  const key = uniqueLayerKey(base, `l_${index}`);
  const layerName = uniqueLayerName(base, name?.trim() || `界面 ${index}`);
  // 新层默认**不是**主界面（D67）：除非文档原本连一个主界面都没有（这时它顶上）。
  const layer: BlueprintLayer = {
    key,
    name: layerName,
    is_home: (base.layers ?? []).some((l) => l.is_home === true) ? false : true,
  };

  const interfaceKey = uniqueKey(base.nodes, "ui");
  const interfaceNode: BlueprintNode = {
    key: interfaceKey,
    type: "interface",
    layer: key,
    position: position ?? { x: 460, y: 40 },
  };
  return {
    doc: {
      ...base,
      layers: [...(base.layers ?? []), layer],
      nodes: [...base.nodes, interfaceNode],
    },
    layer,
    interfaceKey,
  };
}

/**
 * 把某层设为**主界面**（D67）：该层 `is_home = true`，其余层显式置 `false`。
 *
 * 应用进入该仓库时默认显示主界面（`blueprint.currentLayer` 的"上次所在层"仍优先，
 * 用于重启回到上次页面）。层不存在时原样返回。
 */
export function setHomeLayer(doc: BlueprintGraph, layerKey: string): BlueprintGraph {
  const base = withExplicitLayers(doc);
  if (!(base.layers ?? []).some((l) => l.key === layerKey)) {
    return base;
  }
  return {
    ...base,
    layers: (base.layers ?? []).map((l) => ({
      ...l,
      is_home: l.key === layerKey,
    })),
  };
}

/** 重命名层（层名蓝图内唯一，D60）；层不存在时原样返回。 */
export function renameLayer(
  doc: BlueprintGraph,
  layerKey: string,
  name: string,
): BlueprintGraph {
  const base = withExplicitLayers(doc);
  const wanted = name.trim();
  if (wanted.length === 0) {
    return base;
  }
  const others: BlueprintGraph = {
    ...base,
    layers: (base.layers ?? []).filter((l) => l.key !== layerKey),
  };
  const finalName = uniqueLayerName(others, wanted);
  return {
    ...base,
    layers: (base.layers ?? []).map((l) =>
      l.key === layerKey ? { ...l, name: finalName } : l,
    ),
  };
}

/** 为某层补出界面根节点（无根层 = 未接通，D55）；已有根时原样返回。 */
export function ensureInterface(
  doc: BlueprintGraph,
  layerKey: string,
  position?: { x: number; y: number },
): BlueprintGraph {
  const base = withExplicitLayers(doc);
  if (interfaceOfLayer(base, layerKey)) {
    return base;
  }
  const node: BlueprintNode = {
    key: uniqueKey(base.nodes, `ui_${layerKey}`),
    type: "interface",
    layer: layerKey,
    position: position ?? { x: 460, y: 40 },
  };
  return { ...base, nodes: [...base.nodes, node] };
}

/** 层排序：把 `layerKey` 向前/向后移动一位（`delta` = -1 / +1）。 */
export function moveLayer(doc: BlueprintGraph, layerKey: string, delta: number): BlueprintGraph {
  const base = withExplicitLayers(doc);
  const layers = [...(base.layers ?? [])];
  const from = layers.findIndex((l) => l.key === layerKey);
  if (from < 0) {
    return base;
  }
  const to = Math.min(layers.length - 1, Math.max(0, from + delta));
  if (to === from) {
    return base;
  }
  const [moved] = layers.splice(from, 1);
  layers.splice(to, 0, moved);
  return { ...base, layers };
}

/** 某层的界面节点 key（层的根）；无根层返回 undefined。 */
export function layerInterfaceKey(
  doc: BlueprintGraph,
  layerKey: string,
): string | undefined {
  return interfaceOfLayer(doc, layerKey)?.key;
}
