/**
 * 蓝图图编辑动作接线（RFC 0007 决策 7 / D31）——画布与属性面板发出的"改图"动作。
 *
 * 一个域：新增节点（避开已占用槽位、归属当前层）、改节点字段、软删除节点、删边、
 * 连线后自动落引用字段、一键整理。算法都在纯模块里（`blueprintNodeFactory` /
 * `blueprintDelete` / `blueprintArrange` / `blueprintSlots`），本文件只把它们接到
 * 编辑器状态与提示上。
 */

import { useCallback } from "react";

import {
  effectiveLayers,
  interfaceOfLayer,
  type BlueprintEdge,
  type BlueprintGraph,
  type BlueprintNode,
  type BlueprintNodeType,
} from "@hamster-pouch/config";

import { useApp } from "../core/AppContext";
import { arrangeTree } from "./blueprintArrange";
import { applyConnect } from "./blueprintConnect";
import { softRemove, softRemoveMany } from "./blueprintDelete";
import { ensureInterface } from "./blueprintLayers";
import { appendNode, parentHintFor } from "./blueprintNodeFactory";
import { canvasCenter, freeSlotPosition } from "./blueprintSlots";
import type { BlueprintEditorState } from "./useBlueprintEditorState";

/** 图编辑动作的依赖：编辑器状态、新增层、静默落库。 */
export interface BlueprintGraphEditDeps {
  state: BlueprintEditorState;
  /** 新增层（D51：「界面」节点在有根的层里改为新开一层）。 */
  addNewLayer: () => void;
  /** 静默落库（一键整理后自动保存）。 */
  persistDoc: (doc: BlueprintGraph) => void;
}

/** 画布与属性面板要用的图编辑动作。 */
export interface BlueprintGraphEdits {
  addNode: (type: BlueprintNodeType) => void;
  updateNode: (key: string, patch: Partial<BlueprintNode>) => void;
  /** 删除节点（**软删除**）：只删这个节点和挂在它身上的边，关联节点保留。 */
  removeNode: (key: string) => void;
  /**
   * 一次划线删除**多处**（右键直线刀痕放开时）：节点 key 列表 + 整文档边下标列表，
   * **原子应用一次**（分多次调用会各自基于同一份旧文档、只剩最后一次生效）。
   */
  removeBladeHits: (nodeKeys: string[], edgeIndexes: number[]) => void;
  /** 删除一条边（画布刀痕删除用）。 */
  removeEdgeAt: (index: number) => void;
  /** 连线后自动把子节点的引用字段落好（用户不手填 key）。 */
  onConnect: (edge: { from: string; to: string; kind: BlueprintEdge["kind"] }) => void;
  /** 一键整理：以选中节点为根树状展开（纯算法在 `blueprintArrange`），随后静默落库。 */
  onArrange: () => void;
}

export function useBlueprintGraphEdits({
  state,
  addNewLayer,
  persistDoc,
}: BlueprintGraphEditDeps): BlueprintGraphEdits {
  const app = useApp();
  const { doc, mutate, selectedKey, setSelectedKey, viewCenter, layerKey } = state;

  /**
   * 在**当前渲染画布的中心**附近新增节点（避开已占用槽位，节点不堆叠）。
   * key 与引用从上级推导（选中节点的类型决定用谁当上级，见 `blueprintNodeFactory`）。
   */
  const addNode = useCallback(
    (type: BlueprintNodeType) => {
      // 「界面」= 一个页面 = 一个层（D51）：不在当前层里再塞第二个界面节点
      // （那是硬错误"每层至多一个界面"）。
      // - 当前层**还没有**界面节点（无根层，D55）→ 为它补出根（修复未接通）；
      // - 当前层已有根 → 新增一个层（新页面，自动带出界面根节点）。
      if (type === "interface") {
        const current = layerKey ?? effectiveLayers(doc)[0].key;
        if (!interfaceOfLayer(doc, current)) {
          mutate(ensureInterface(doc, current, viewCenter ?? undefined));
          app.status(app.t("blueprint.layer.rootRepaired"), "ok");
          return;
        }
        addNewLayer();
        return;
      }
      // 视口中心（世界坐标）由画布上报；未上报前退回已有节点附近。
      const center = viewCenter ?? canvasCenter(doc.nodes);
      const position = freeSlotPosition(doc.nodes, center);
      const hint = parentHintFor(type, selectedKey, doc, layerKey);
      // **所有类型都可随意创建**（用户口径 2026-10-10）：编辑器只规定**连接方式与层级**，
      // 不限制"能不能建"。缺结构父时引用**留空**（画布灰显「未接通」），由使用者拖线
      // 或在属性面板补上——与 `class` / `object` 同一口径，也与 D84「只追加自身」一致。
      // **新增不建边**（同日口径 / D107）：`appendNode` 只落节点 +（可推导的）引用字段，
      // 返回值里的 `edges` 与传入文档逐项相同——画布上的线一律由使用者从端口拖出来。
      const { doc: next, node } = appendNode(
        doc,
        type,
        position,
        hint,
        // D51：新增节点归属**当前层**。
        layerKey,
      );
      mutate(next);
      setSelectedKey(node.key);
      app.status(
        app.t("blueprint.nodeAdded", { x: position.x, y: position.y }),
        "ok",
      );
    },
    // `addNewLayer` 由 `useBlueprintLayerTools` 提供，是本函数的入参（不再是同作用域
    // 下方声明的 `const`），因此可以直接进依赖数组。
    [doc, mutate, selectedKey, viewCenter, app, layerKey, addNewLayer, setSelectedKey],
  );

  const updateNode = useCallback(
    (key: string, patch: Partial<BlueprintNode>) => {
      // 值为 `undefined` 的补丁字段是**删除该字段**的意图（如把类目从 text 切到
      // image 时要清掉 `format`）。必须真的删键而不是留一个 `format: undefined`：
      // 解析层按 `Object.entries` 逐字段校验，显式 `undefined` 会被判成取值域非法
      // （enum 字段要求 string），从而让整份文档解析失败。
      const cleaned: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(patch)) {
        if (value !== undefined) {
          cleaned[field] = value;
        }
      }
      mutate({
        ...doc,
        nodes: doc.nodes.map((n) => {
          if (n.key !== key) {
            return n;
          }
          const next = { ...n, ...cleaned } as unknown as Record<string, unknown>;
          for (const field of Object.keys(patch)) {
            if ((patch as Record<string, unknown>)[field] === undefined) {
              delete next[field];
            }
          }
          return next as unknown as BlueprintNode;
        }),
      });
    },
    [doc, mutate],
  );

  /**
   * 删除节点（**软删除**）：只删这个节点和挂在它身上的边；**关联节点保留**，
   * 因引用丢失无法工作的部分由画布灰显"未接通"（`softRemove` / `blueprintLint`）。
   */
  const removeNode = useCallback(
    (key: string) => {
      const { doc: next, removed, unlinked } = softRemove(doc, key);
      if (removed.length === 0) {
        return;
      }
      mutate(next);
      setSelectedKey(null);
      if (unlinked.length > 0) {
        app.status(app.t("blueprint.softRemoved", { count: unlinked.length }), "info");
      }
    },
    [doc, mutate, app, setSelectedKey],
  );

  /** 删除一条边（单条：选中后按 Delete，或点击命中单条时用）。 */
  const removeEdgeAt = useCallback(
    (index: number) => {
      const edge = doc.edges[index];
      if (!edge) {
        return;
      }
      mutate({ ...doc, edges: doc.edges.filter((_, i) => i !== index) });
      app.status(app.t("blueprint.edgeRemoved", { kind: edge.kind }), "info");
    },
    [doc, mutate, app],
  );

  /**
   * 一次划线删除**多处**：节点与连线**一并**落一次文档（`softRemoveMany`）。
   *
   * 早前画布对每个命中项各调一次 `removeNode` / `removeEdgeAt`，而两者都从**同一份旧文档**
   * 派生新文档 → 只有最后一次生效，划痕实际"只能删一个"。现在合并为一次原子编辑。
   */
  const removeBladeHits = useCallback(
    (nodeKeys: string[], edgeIndexes: number[]) => {
      const { doc: next, removed, unlinked } = softRemoveMany(doc, nodeKeys, edgeIndexes);
      if (removed.length === 0 && edgeIndexes.length === 0) {
        return;
      }
      mutate(next);
      setSelectedKey(null);
      const params = { nodes: removed.length, edges: edgeIndexes.length };
      if (unlinked.length > 0) {
        app.status(
          app.t("blueprint.bladeRemovedUnlinked", { ...params, count: unlinked.length }),
          "info",
        );
      } else {
        app.status(app.t("blueprint.bladeRemoved", params), "ok");
      }
    },
    [doc, mutate, app, setSelectedKey],
  );

  /**
   * 连线后把**边**与**子节点的引用字段**在**一份文档**上原子落好（用户不手填 key）：
   * 控件→类 写 `class.control`、类→对象 写 `object.class`、类→子类 写 `subclass.subclass`、
   * 面板→标记 写 `mark.control`、对象/类/面板→操作 写 `event.target`…
   *
   * 判据与落库都在**纯模块** `blueprintConnect`（`applyConnect` / `connectPatch`），
   * 因此"连线后该节点不再未接通"这类跨模块结论可以由 `pnpm check:blueprint-nodes` 断言。
   *
   * **为什么必须原子**：画布早前先 `onChange({...doc, edges})` 再回调 `onConnect`，而
   * `onConnect` 又从**同一份调用前的 `doc`** 派生新文档 → 后一次把刚加的边覆盖掉，
   * 表现为"连完线节点状态没变（仍灰显未接通），要刷新一下才对"（真实缺陷）。
   * 现在边与引用字段一次算完，节点状态**连线即刷新**。
   *
   * **为什么引用字段只在连线时落**（D109）：新增节点不再自动挂父级（那会让画布上
   * 看不出绑定的节点"不灰显"）；拖一条线是**唯一的接线动作**，所以边与字段必须同时落好。
   */
  const onConnect = useCallback(
    (edge: { from: string; to: string; kind: BlueprintEdge["kind"] }) => {
      const { doc: next, edge: created } = applyConnect(doc, edge);
      if (!created) {
        return; // 重复边：文档未改动
      }
      mutate(next);
    },
    [doc, mutate],
  );

  /** 一键整理：以选中节点为根树状展开（纯算法在 `blueprintArrange`），随后静默落库。 */
  const onArrange = useCallback(() => {
    const root = selectedKey ?? doc.nodes[0]?.key;
    if (!root) {
      return;
    }
    const next = arrangeTree(doc, root);
    mutate(next);
    persistDoc(next);
  }, [selectedKey, doc, mutate, persistDoc]);

  return { addNode, updateNode, removeNode, removeBladeHits, removeEdgeAt, onConnect, onArrange };
}
