/**
 * 面板本地打标状态的**模块级 store**（D207；原先是 `panels/markMenu.tsx` 里的一段）。
 *
 * ## 为什么两个面板必须共享同一份
 *
 * 落库值是**一整个仓库的整包 JSON**（相册 + 源两份 scope 都在里面）。若两个面板各持一份完整
 * 快照再各自整包写回，就会出现真实的覆盖事故——相册面板写回时会带上「它挂载时看到的」源标记，
 * 把源面板刚打的标记整段抹掉（两个面板同时在 dockview 里只是常态，不是边界情况）。共享一份
 * 之后，「谁改哪个 scope」各自独立，整包写回永远基于最新的完整状态。
 *
 * ## 为什么放模块级而不是进 AppContext
 *
 * 打标状态只有这两个面板用；进 context 会让每次勾选都换 `ctxValue` 身份、进而重渲染**所有**
 * 面板（既有面板普遍以 `app` 为 `useCallback` 依赖并触发整棵数据重查，见 `taskStore.ts` 的同类教训）。
 *
 * ## 为什么从视图文件里搬出来（D207）
 *
 * 这段状态原本长在 `panels/markMenu.tsx` 里：一个 450 行的视图文件同时装着渲染树、菜单交互，
 * 以及一段带 IPC 的模块级 store。后果是「状态」没法被单测碰到、也没法被别的入口复用，
 * 而且它自建了一套订阅表（`new Set<() => void>()` + 手写通知循环），与 D205 的骨架并行维护。
 * 现在 store 归 `core/`（与 `taskStore` / `mediaSortStore` 同级），订阅表交给 `createStore`，
 * 视图文件只剩渲染与接线。
 *
 * ## 读/写失败口径（两件事分开，别混成「要么全静默、要么弹窗」）
 *
 * - **读失败**当「没设置过」处理：任何脏值/缺失都该落回可用状态，不能让菜单打不开；
 * - **写失败**由调用方（hook 层，能拿到 `status` / `t`）报状态栏错误，但**不弹确认框**：
 *   勾选是高频轻量动作，一次 IPC 失败就拦一个对话框会把「界面偏好」读成「数据事故」。
 *   内存里的勾选态仍然生效，下一次改动会重试写。
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import {
  emptyPanelMarksState,
  parsePanelMarksState,
  serializePanelMarksState,
  type PanelMarksState,
} from "../shared/panelMarks";
import { useApp } from "./AppContext";
import { createStore } from "./createStore";

/** {@link usePanelMarks} 的返回值。 */
export interface PanelMarksController {
  /** 当前状态。 */
  marks: PanelMarksState;
  /** 写回：状态变化即落库（失败由 {@link usePanelMarks} 报状态栏）。 */
  persist: (next: PanelMarksState) => void;
}

/** store 里的完整记录（对外只暴露 `state`，另外两项是簿记）。 */
interface MarksRecord {
  /** 当前生效的仓库 id（`null` = 未打开仓库）。 */
  repoId: string | null;
  state: PanelMarksState;
  /** 已落库的序列化值：避免「读到什么就原样写回什么」的无谓写入（也防回声）。 */
  persisted: string;
}

const store = createStore<MarksRecord>({
  repoId: null,
  state: emptyPanelMarksState(),
  persisted: "",
});

/**
 * 快照只取 `state`：它只在真正变更时换身份（`createStore` 判等后提前返回），
 * 因此可以直接交给 `useSyncExternalStore`——每次 render 现造对象会让 React 判定「永远在变」。
 */
function marksSnapshot(): PanelMarksState {
  return store.get().state;
}

/**
 * 切到某个仓库：状态先清空（避免读到上一个仓库的标记），再异步补读。
 *
 * 并发挂载由**同步写回 `repoId`** 天然去重：第一次调用把 `repoId` 立刻置好，第二个
 * 面板的调用看到相等即返回，不会读两遍、也不会两次解析各写一份。
 */
function ensureMarksLoaded(repoId: string | null): void {
  if (store.get().repoId === repoId) return;
  store.set({ repoId, state: emptyPanelMarksState(), persisted: "" });
  if (!repoId) return;
  void (async () => {
    let raw: string | null = null;
    try {
      raw = await api.panelMarksGet(repoId);
    } catch {
      // 读失败 = 当没设置过：任何脏值/缺失都该落回可用状态，不能让菜单打不开。
      raw = null;
    }
    if (store.get().repoId !== repoId) {
      // 读回过程中用户又切了仓库：这次结果作废（不能写进新仓库的状态）。
      return;
    }
    store.set({ repoId, state: parsePanelMarksState(raw), persisted: raw ?? "" });
  })();
}

/**
 * 提交新状态：先更新共享内存并广播（UI 立刻响应），再整包写回。
 *
 * 返回的 Promise 只用于让调用方把失败报进状态栏——不解析内容、不做业务校验
 * （那是 `shared/panelMarks.ts` 的职责，桥接层同样不解析）。
 */
function commitMarks(next: PanelMarksState): Promise<void> {
  const { repoId, persisted } = store.get();
  store.set({ repoId, state: next, persisted });
  if (!repoId) return Promise.resolve();
  const serialized = serializePanelMarksState(next);
  if (serialized === persisted) return Promise.resolve();
  store.set({ repoId, state: next, persisted: serialized });
  return api.panelMarksSet(repoId, serialized);
}

/**
 * 面板本地打标状态（两个面板共享同一份模块级 store）。
 *
 * 调用方只需给 `repoId`；切换仓库时 store 自己清空并重读。返回值里的 `persist`
 * 已把写失败接到状态栏（`mark.toggleFailed`，错误级）。
 */
export function usePanelMarks(repoId: string | null): PanelMarksController {
  const app = useApp();
  const { status, t } = app;
  const marks = useSyncExternalStore(store.subscribe, marksSnapshot, marksSnapshot);

  useEffect(() => {
    ensureMarksLoaded(repoId);
  }, [repoId]);

  const persist = useCallback(
    (next: PanelMarksState) => {
      void commitMarks(next).catch((err: unknown) => {
        // 内存里的勾选态照旧可用（用户看到的就是「打上了」）；这里只补一条错误提示。
        status(t("mark.toggleFailed", { err: errorTextOf(t, err) }), "error");
      });
    },
    [status, t],
  );

  return { marks, persist };
}
