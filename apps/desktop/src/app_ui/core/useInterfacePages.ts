/**
 * 垂直「界面页」标签条的状态与动作（D124 / D124-R3 / D124-R4）。
 *
 * 三层职责分清，避免"标签条自己攒一份真相"：
 * 1. **有哪些界面 / 当前是哪个** —— 一律现取蓝图运行时（`currentLayers()` /
 *    `currentLayerKey()`），并订阅运行时广播刷新；标签条**不缓存层列表**。
 * 2. **分组结构 + 界面顺序** —— 纯前端状态，按仓库持久化在 `app_settings`
 *    （`interfacePages.<repoId>`），读写走 `shared/interfacePages.ts` 的容错解析。
 * 3. **切界面** —— 复用 `switchLayer`（持久化当前层 + 套用该层布局 + 蓝图对账），
 *    与编辑器层工具条走同一条路径，不新开第二条切层实现。
 *
 * **界面页的标签恒等于蓝图的一层**，所以"新建界面""删除界面"都是**写蓝图**的操作
 * （`interfacePageCreate.ts` / `interfacePageDelete.ts`），前端不另存一份界面清单；
 * 删除之后还要把前端分组结构里的残留归属与顺序位清掉（`removePage`）。
 *
 * 两个"删除"粒度不同、都必须问一次用户（D124-R5）：
 * - **删除页面组**：只删 `app_settings` 里的一条组记录，组内界面回到「未分组」，**蓝图不动**；
 * - **删除界面**：删蓝图的一层（D55 直接删除、不是软删除），**不可撤销**，且至少保留一层。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BlueprintLayer } from "@hamster-pouch/config";

import { useApp } from "./AppContext";
import { createInterfacePage } from "./interfacePageCreate";
import { deleteInterfacePage } from "./interfacePageDelete";
import * as api from "../shared/api";
import {
  currentLayerKey,
  currentLayers,
  subscribeBlueprintRuntime,
  switchLayer,
} from "../shared/blueprintRuntime";
import {
  addGroup as addGroupPure,
  assignPage as assignPagePure,
  clearGroupAssignment as clearGroupAssignmentPure,
  dropPageOnGroup as dropPageOnGroupPure,
  dropPageOnPage as dropPageOnPagePure,
  emptyInterfacePagesState,
  movePageBefore as movePageBeforePure,
  orderedPages,
  parseInterfacePagesState,
  removeGroup as removeGroupPure,
  removePage as removePagePure,
  renameGroup as renameGroupPure,
  serializeInterfacePagesState,
  setGroupColor as setGroupColorPure,
  toggleGroupCollapsed as toggleGroupCollapsedPure,
  type InterfacePageGroup,
  type InterfacePagesState,
} from "../shared/interfacePages";

/**
 * 新建界面后等待运行时装载到新层的上限。
 *
 * 写蓝图 → 热更新广播 → 运行时重载是**异步**的（IPC + 解析 + 对账）。若不等待就直接
 * 切层，`switchLayer` 会因为运行时里还没有这一层而套不到布局（表现为点了新标签没反应）。
 * 轮询而非固定 sleep：正常路径通常 1~2 帧就绪，等待成本可忽略。
 */
const LAYER_READY_TIMEOUT_MS = 3000;
const LAYER_READY_POLL_MS = 60;

/** 标签条需要的全部数据与动作。 */
export interface InterfacePagesController {
  /** 当前生效蓝图里的全部界面（层），顺序即蓝图顺序。 */
  layers: BlueprintLayer[];
  /** 当前界面 key（未装载时为 `null`）。 */
  currentLayer: string | null;
  /** 分组结构 + 界面顺序（按仓库）。 */
  state: InterfacePagesState;
  /** 切到某个界面；失败时状态栏提示。 */
  switchTo: (layerKey: string) => void;
  /** 新建一个界面（= 给生效蓝图加一层）并切过去；`groupId` 非空时顺带放进该组。 */
  createPage: (groupId?: string | null) => void;
  /**
   * 新建页面组并**立即把这个界面放进去**（Edge 的「Add tab to new group」），
   * 返回新组（名称为空则不建）；`colorIndex` 为该组的色板索引。
   *
   * 注意：组名与组色都由右键弹窗里的输入框 / 色带给定（D124-R4 ①），
   * 这里合成**一次**落库——分两步写会先落一个空组，界面反而留在「未分组」里。
   */
  createGroupWithPage: (
    layerKey: string,
    name: string,
    colorIndex?: number,
  ) => InterfacePageGroup | null;
  renameGroup: (groupId: string, name: string) => void;
  /** 把界面放进某个组；`null` = 移出分组。 */
  movePage: (layerKey: string, groupId: string | null) => void;
  toggleCollapsed: (groupId: string) => void;
  /** 拖拽排序：把界面挪到 `beforeKey` 之前（`null` = 挪到末尾）。 */
  reorderPage: (layerKey: string, beforeKey: string | null) => void;
  /** 拖到另一个界面上：归入它所在的组并排到它前面。 */
  dropOnPage: (draggedKey: string, targetKey: string) => void;
  /** 拖到组上：归入该组。 */
  dropOnGroup: (draggedKey: string, groupId: string) => void;
  /** 拖到「未分组」区 / 列表空白处：移出分组并排到末尾。 */
  dropToUngrouped: (draggedKey: string) => void;
  setGroupColor: (groupId: string, index: number) => void;
  /** 「取消组合」：组内界面全部移出分组，组本身保留。 */
  clearGroupAssignment: (groupId: string) => void;
  /**
   * 「删除页面组」（D124-R5）：删掉组记录，组内界面回到「未分组」——**界面本身不删**，
   * 所以这是无损操作，确认弹窗要如实这么说（不弹假警告）。
   */
  deleteGroup: (groupId: string) => void;
  /**
   * 「删除界面」（D124-R5）：删**蓝图的一层**（连带层内节点，不可撤销），前端不提供撤销。
   * 只剩一层时不允许（没有界面可导航）——菜单项会置灰，这里再拦一次，两处同一口径。
   */
  deletePage: (layerKey: string) => void;
}

/** 读运行时快照（层列表 + 当前层），供订阅回调判重。 */
function snapshot(): { layers: BlueprintLayer[]; current: string | null } {
  return { layers: currentLayers(), current: currentLayerKey() };
}

/** 运行时里是否已经有这个层（新建界面后等热更新装载完再切层）。 */
function hasLayer(layerKey: string): boolean {
  return currentLayers().some((layer) => layer.key === layerKey);
}

/**
 * 界面页标签条控制器。
 *
 * 只在标签条**已启用**时挂载（关闭时由宿主整块不渲染），因此不必在这里判断开关：
 * 开关关闭期间不读库、不订阅，省掉一份无人使用的状态。
 */
export function useInterfacePages(): InterfacePagesController {
  const app = useApp();
  const { repoId, status, t, getDockview, askConfirm } = app;

  const [layers, setLayers] = useState<BlueprintLayer[]>(() => snapshot().layers);
  const [current, setCurrent] = useState<string | null>(() => snapshot().current);
  const [state, setState] = useState<InterfacePagesState>(emptyInterfacePagesState);

  // 已落库的序列化值：避免"读到什么就原样写回什么"的无谓写入（也防回声）。
  const persistedRef = useRef<string>("");

  // 运行时变更（换蓝图 / 切层）→ 刷新层列表与高亮。
  useEffect(() => {
    const refresh = () => {
      const next = snapshot();
      setLayers(next.layers);
      setCurrent(next.current);
    };
    refresh();
    const unsubscribe = subscribeBlueprintRuntime(refresh);
    // 挂载时补一次：订阅之前运行时可能已经装载完（首屏顺序）。
    return unsubscribe;
  }, []);

  // 仓库切换 → 读该仓库的分组结构；读到什么就是什么（任何脏数据都会落回可用状态）。
  useEffect(() => {
    let cancelled = false;
    if (!repoId) {
      persistedRef.current = "";
      setState(emptyInterfacePagesState());
      return;
    }
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await api.interfacePagesGet(repoId);
      } catch {
        raw = null;
      }
      if (cancelled) return;
      persistedRef.current = raw ?? "";
      setState(parseInterfacePagesState(raw));
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  /** 写回：状态变化即落库（失败只打日志，不打断交互）。 */
  const persist = useCallback(
    (next: InterfacePagesState) => {
      setState(next);
      if (!repoId) return;
      const serialized = serializeInterfacePagesState(next);
      if (serialized === persistedRef.current) return;
      persistedRef.current = serialized;
      void api.interfacePagesSet(repoId, serialized).catch(() => {
        // 落库失败：内存里的分组照旧可用，下次改动会重试写。
      });
    },
    [repoId],
  );

  const switchTo = useCallback(
    (layerKey: string) => {
      if (!repoId || layerKey === current) return;
      const layer = layers.find((l) => l.key === layerKey);
      void switchLayer(repoId, layerKey, getDockview())
        .then(() => status(t("iface.switched", { name: layer?.name ?? layerKey }), "ok"))
        .catch((err: unknown) => {
          status(t("iface.switchFailed", { err: String(err) }), "error");
        });
    },
    [current, getDockview, layers, repoId, status, t],
  );

  const createPage = useCallback(
    (groupId?: string | null) => {
      if (!repoId) return;
      void (async () => {
        try {
          const created = await createInterfacePage(repoId);
          // 先把分组归属落库（新界面在蓝图层序里排在最后，不写 order 也会自然出现）。
          if (groupId) persist(assignPagePure(state, created.layerKey, groupId));
          status(t("iface.pageAdded", { name: created.name }), "ok");
          const deadline = Date.now() + LAYER_READY_TIMEOUT_MS;
          while (!hasLayer(created.layerKey) && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, LAYER_READY_POLL_MS);
            });
          }
          if (hasLayer(created.layerKey)) {
            void switchLayer(repoId, created.layerKey, getDockview()).catch(() => undefined);
          }
        } catch (err) {
          status(t("iface.pageAddFailed", { err: String(err) }), "error");
        }
      })();
    },
    [getDockview, persist, repoId, state, status, t],
  );

  const createGroupWithPage = useCallback(
    (
      layerKey: string,
      name: string,
      colorIndex?: number,
    ): InterfacePageGroup | null => {
      const { state: withGroup, group } = addGroupPure(state, name);
      if (!group) return null;
      // 建组 + 上色 + 入组必须一次落库：分两步写会先落一个空组，界面反而留在"未分组"里。
      const colored =
        colorIndex === undefined ? withGroup : setGroupColorPure(withGroup, group.id, colorIndex);
      persist(assignPagePure(colored, layerKey, group.id));
      status(t("iface.groupAdded", { name: group.name }), "ok");
      return group;
    },
    [persist, state, status, t],
  );

  const renameGroup = useCallback(
    (groupId: string, name: string) => persist(renameGroupPure(state, groupId, name)),
    [persist, state],
  );

  const movePage = useCallback(
    (layerKey: string, groupId: string | null) => persist(assignPagePure(state, layerKey, groupId)),
    [persist, state],
  );

  const toggleCollapsed = useCallback(
    (groupId: string) => persist(toggleGroupCollapsedPure(state, groupId)),
    [persist, state],
  );

  const reorderPage = useCallback(
    (layerKey: string, beforeKey: string | null) =>
      persist(movePageBeforePure(state, layers.map((l) => l.key), layerKey, beforeKey)),
    [layers, persist, state],
  );

  const dropOnPage = useCallback(
    (draggedKey: string, targetKey: string) =>
      persist(dropPageOnPagePure(state, layers.map((l) => l.key), draggedKey, targetKey)),
    [layers, persist, state],
  );

  const dropOnGroup = useCallback(
    (draggedKey: string, groupId: string) =>
      persist(dropPageOnGroupPure(state, layers.map((l) => l.key), draggedKey, groupId)),
    [layers, persist, state],
  );

  const dropToUngrouped = useCallback(
    (draggedKey: string) => {
      const keys = layers.map((l) => l.key);
      // 移出分组 + 排到末尾：一次状态变更，避免界面在列表里闪一下。
      persist(movePageBeforePure(assignPagePure(state, draggedKey, null), keys, draggedKey, null));
    },
    [layers, persist, state],
  );

  const setGroupColor = useCallback(
    (groupId: string, index: number) => persist(setGroupColorPure(state, groupId, index)),
    [persist, state],
  );

  const clearGroupAssignment = useCallback(
    (groupId: string) => {
      const group = state.groups.find((g) => g.id === groupId);
      persist(clearGroupAssignmentPure(state, groupId));
      if (group) status(t("iface.groupCleared", { name: group.name }), "ok");
    },
    [persist, state, status, t],
  );

  /**
   * 「删除页面组」（D124-R5）：只动前端分组结构，界面回到「未分组」。
   *
   * 确认弹窗只说真话：这一项**不会**删掉任何界面（删界面是另一个菜单项），
   * 因此不给 `danger` 级红按钮，也不写"不可恢复"之类的话。
   */
  const deleteGroup = useCallback(
    (groupId: string) => {
      const group = state.groups.find((g) => g.id === groupId);
      if (!group) return;
      void (async () => {
        // 提示并进 message 而不用 `warning` 字段：那一行是危险色，与"无损操作"的事实相悖。
        const confirmed = await askConfirm({
          title: t("iface.removeGroup"),
          message: `${t("iface.removeGroupConfirm", { name: group.name })} ${t("iface.removeGroupHint")}`,
          confirmLabel: t("iface.removeGroup"),
        });
        if (!confirmed) return;
        persist(removeGroupPure(state, groupId));
        status(t("iface.groupRemoved", { name: group.name }), "ok");
      })();
    },
    [askConfirm, persist, state, status, t],
  );

  /**
   * 「删除界面」（D124-R5）：删蓝图的一层，连带层内节点，**不可撤销**。
   *
   * 删的是"界面"而不是"标签"：界面页没有"关掉标签"这种语义（标签恒等于层）。
   * 三层收尾必须都做——蓝图（`deleteInterfacePage`）、前端分组状态（`removePage`）、
   * 当前层（删的正是当前界面时切到剩下的第一个，否则画布上停留的还是那个已删除的界面）。
   */
  const deletePage = useCallback(
    (layerKey: string) => {
      if (!repoId) return;
      if (layers.length <= 1) {
        status(t("iface.pageRemoveLast"), "error");
        return;
      }
      const target = layers.find((l) => l.key === layerKey);
      void (async () => {
        const confirmed = await askConfirm({
          title: t("iface.deletePage"),
          message: t("iface.deletePageConfirm", { name: target?.name ?? layerKey }),
          warning: t("iface.deletePageWarning"),
          confirmLabel: t("iface.deletePage"),
          danger: true,
        });
        if (!confirmed) return;
        try {
          const removed = await deleteInterfacePage(repoId, layerKey);
          // 前端分组结构里的残留（归属 / 顺序位）必须跟着清，否则会攒下指向已删层的 key。
          persist(removePagePure(state, layerKey));
          status(t("iface.pageRemoved", { name: removed.name }), "ok");
          // 删的正是当前界面：显式切到剩下的第一个可见界面——运行时的 activate 只会把
          // "已不存在的当前层"回退到**蓝图第一层**，那未必是标签条上的第一个，而且回退发生在
          // 异步重载里；这里主动切一次，无论重载先到还是后到，最终都停在同一个界面上。
          if (current === layerKey) {
            const remaining = orderedPages(state, layers.map((l) => l.key)).filter(
              (key) => key !== layerKey,
            );
            const next = remaining[0];
            if (next) {
              void switchLayer(repoId, next, getDockview()).catch(() => undefined);
            }
          }
        } catch (err) {
          status(t("iface.pageDeleteFailed", { err: String(err) }), "error");
        }
      })();
    },
    [askConfirm, current, getDockview, layers, persist, repoId, state, status, t],
  );

  return useMemo(
    () => ({
      layers,
      currentLayer: current,
      state,
      switchTo,
      createPage,
      createGroupWithPage,
      renameGroup,
      movePage,
      toggleCollapsed,
      reorderPage,
      dropOnPage,
      dropOnGroup,
      dropToUngrouped,
      setGroupColor,
      clearGroupAssignment,
      deleteGroup,
      deletePage,
    }),
    [
      layers,
      current,
      state,
      switchTo,
      createPage,
      createGroupWithPage,
      renameGroup,
      movePage,
      toggleCollapsed,
      reorderPage,
      dropOnPage,
      dropOnGroup,
      dropToUngrouped,
      setGroupColor,
      clearGroupAssignment,
      deleteGroup,
      deletePage,
    ],
  );
}
