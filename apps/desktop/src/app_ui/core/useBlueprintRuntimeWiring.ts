/**
 * 蓝图引擎的宿主接线（RFC 0007）：注入执行器、装载生效蓝图、订阅热更新、上报回退提示。
 *
 * 引擎本身在 `blueprintEngine.ts`（纯求值），装载与对账在 `shared/blueprintRuntime.ts`；
 * 本模块只负责把它们挂到宿主生命周期上（仓库切换 / 保存 / 语言变化 / 关闭）。
 */

import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";

import type { Translate } from "../i18n";
import {
  activeBlueprintId,
  activeStateConflicts,
  loadActiveBlueprint,
  loadCurrentLayer,
  reconcileActiveBlueprint,
  setBlueprintFallbackNotifier,
  subscribeBlueprintHotReload,
} from "../shared/blueprintRuntime";
import type { StatusType } from "../shared/types";
import { blueprintEngine, type BlueprintExecutor } from "./blueprintEngine";

/** 接线依赖：执行器、当前仓库、状态栏文案与 dockview 访问。 */
export interface BlueprintRuntimeWiringInput {
  executor: BlueprintExecutor;
  repoId: string | null;
  refreshKey: number;
  getDockview: () => DockviewApi | null;
  status: (message: string, type?: StatusType) => void;
  t: Translate;
}

/** 把蓝图引擎接到宿主生命周期：注入执行器、装载、热更新、回退提示。 */
export function useBlueprintRuntimeWiring(input: BlueprintRuntimeWiringInput): void {
  const { executor, repoId, refreshKey, getDockview, status, t } = input;

  // 装配引擎：executor 变更时注入。
  useEffect(() => {
    blueprintEngine.setExecutor(executor);
  }, [executor]);

  // 蓝图装载回退提示（RFC 0007 决策 3：无效文档回退内置默认时**必须提示用户**）。
  useEffect(() => {
    setBlueprintFallbackNotifier((reason) => {
      status(
        t(
          reason === "invalid-document"
            ? "blueprint.fallbackInvalid"
            : "blueprint.fallbackFailed",
        ),
        "error",
      );
    });
    return () => setBlueprintFallbackNotifier(null);
  }, [status, t]);

  // 仓库切换：装载生效蓝图（无默认 → 种子内置默认，保证零回归）；装载后把蓝图语义
  // 对账到当前布局（默认可见标签 + 组收起/展开）。
  // 注意：依赖里不含 `t`——蓝图文档与语言无关，刷新不重装，避免热更新被语言变化打断；
  // 语言变化只由下面的标题 effect 触发一次重新对账。
  useEffect(() => {
    if (!repoId) {
      blueprintEngine.setGraph(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // 重新装载"当前生效蓝图"（可能是布局绑定的蓝图，而非仓库默认）。
      await loadActiveBlueprint(repoId, activeBlueprintId());
      if (cancelled) {
        return;
      }
      // 当前层（D54）：按仓库持久化；记录缺失/失效时回退生效蓝图的第一个层。
      await loadCurrentLayer(repoId);
      if (cancelled) {
        return;
      }
      reconcileActiveBlueprint(getDockview());
      // 状态冲突（同界面同对象同触发多状态，节点标准第 6 节）：库存里可能有历史遗留文档
      // （规则上线前保存的），装载后提示一次，避免"某次交互同时触发互斥状态"却毫无提示。
      const conflicts = activeStateConflicts();
      if (conflicts.length > 0) {
        status(t("blueprint.stateConflict", { count: conflicts.length }), "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, refreshKey]);

  // 蓝图热更新：保存/设为默认/删除（本窗口或其它窗口）→ 重载生效蓝图并对账布局。
  useEffect(
    () =>
      subscribeBlueprintHotReload(
        () => repoId,
        getDockview,
      ),
    [repoId, getDockview],
  );
}
