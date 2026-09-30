/**
 * 蓝图层工具接线（RFC 0007 / D51 / D54 / D55 / D60 / D67）。
 *
 * 把 `blueprintLayers` / `blueprintDelete` 的纯函数接到编辑器状态上：切换当前层
 * （同步运行时当前层并套用该层布局）、新增层、重命名、排序、删除层、设为主界面。
 * 同时给出渲染层工具条所需的派生量：有效层清单与无根层集合。
 *
 * 只做接线，不含层算法本身（算法在 `blueprintLayers` 与 `blueprintDelete`）。
 */

import { useCallback, useMemo } from "react";

import {
  effectiveLayers,
  interfaceOfLayer,
  type BlueprintLayer,
} from "@hamster-pouch/config";

import { useApp } from "../core/AppContext";
import { setCurrentLayerKey, switchLayer } from "../shared/blueprintRuntime";
import { removeLayer } from "./blueprintDelete";
import {
  addLayer,
  moveLayer,
  renameLayer,
  setHomeLayer,
} from "./blueprintLayers";
import type { BlueprintEditorState } from "./useBlueprintEditorState";

/** 层工具条要用的层清单与层命令。 */
export interface BlueprintLayerTools {
  /** 有效层清单（含单层兜底）。 */
  layers: BlueprintLayer[];
  /** 无根层（层内界面节点被软删除 → 未接通软告警，D55）。 */
  rootlessLayers: ReadonlySet<string>;
  /** 切换当前层：编辑器随之换画布；运行时同步套用该层布局（D53/D54）。 */
  switchToLayer: (key: string) => void;
  /** 新增层：自动建出该层的界面节点（否则是无根层）。 */
  addNewLayer: () => void;
  renameCurrentLayer: (key: string, name: string) => void;
  /** 删除层（D55：直接删除，不是软删除；禁止删最后一层）。 */
  removeCurrentLayer: (key: string) => void;
  moveCurrentLayer: (key: string, delta: number) => void;
  /** 设为主界面（D67）：该层成为进入仓库时默认显示的界面。 */
  setCurrentLayerAsHome: (key: string) => void;
}

export function useBlueprintLayerTools(
  state: BlueprintEditorState,
): BlueprintLayerTools {
  const app = useApp();
  const repoId = app.repoId;
  const {
    doc,
    mutate,
    setLayerKey,
    setSelectedKey,
    viewCenter,
  } = state;

  /** 有效层清单（含单层兜底）。 */
  const layers = useMemo(() => effectiveLayers(doc), [doc]);
  /** 无根层（层内界面节点被软删除 → 未接通软告警，D55）。 */
  const rootlessLayers = useMemo(() => {
    const set = new Set<string>();
    for (const layer of layers) {
      if (!interfaceOfLayer(doc, layer.key)) {
        set.add(layer.key);
      }
    }
    return set;
  }, [doc, layers]);

  /** 切换当前层：编辑器随之换画布；运行时同步套用该层布局（D53/D54）。 */
  const switchToLayer = useCallback(
    (key: string) => {
      setLayerKey(key);
      setSelectedKey(null);
      setCurrentLayerKey(key);
      if (!repoId) {
        return;
      }
      void switchLayer(repoId, key, app.getDockview()).then(() => {
        app.status(app.t("layer.switched"), "info");
      });
    },
    [repoId, app, setLayerKey, setSelectedKey],
  );

  /** 新增层：自动建出该层的界面节点（否则是无根层）。 */
  const addNewLayer = useCallback(() => {
    const { doc: next, layer } = addLayer(doc, undefined, viewCenter ?? undefined);
    mutate(next);
    setLayerKey(layer.key);
    setCurrentLayerKey(layer.key);
    app.status(app.t("blueprint.layer.add"), "ok");
  }, [doc, mutate, viewCenter, app, setLayerKey]);

  const renameCurrentLayer = useCallback(
    (key: string, name: string) => {
      mutate(renameLayer(doc, key, name));
    },
    [doc, mutate],
  );

  /** 删除层（D55：直接删除，不是软删除；禁止删最后一层）。 */
  const removeCurrentLayer = useCallback(
    (key: string) => {
      const result = removeLayer(doc, key);
      if (result.rejected === "last-layer") {
        app.status(app.t("blueprint.layer.removeLast"), "error");
        return;
      }
      if (result.rejected) {
        return;
      }
      const remaining = effectiveLayers(result.doc);
      const removedName =
        effectiveLayers(doc).find((l) => l.key === key)?.name ?? key;
      mutate(result.doc);
      const next = remaining[0]?.key ?? null;
      setLayerKey(next);
      setCurrentLayerKey(next);
      setSelectedKey(null);
      app.status(app.t("blueprint.layer.removed", { name: removedName }), "ok");
    },
    [doc, mutate, app, setLayerKey, setSelectedKey],
  );

  const moveCurrentLayer = useCallback(
    (key: string, delta: number) => {
      mutate(moveLayer(doc, key, delta));
    },
    [doc, mutate],
  );

  /**
   * 设为主界面（D67）：该层成为进入仓库时默认显示的界面。
   *
   * 同时把"当前层"也切过去并记忆（`blueprint.currentLayer`），避免"设了主界面却还停在
   * 另一页"的割裂感；下次进入该仓库若没有更近的当前层记录，就会落在主界面。
   */
  const setCurrentLayerAsHome = useCallback(
    (key: string) => {
      mutate(setHomeLayer(doc, key));
      setCurrentLayerKey(key);
      const name = effectiveLayers(doc).find((l) => l.key === key)?.name ?? key;
      app.status(app.t("blueprint.layer.homeSet", { name }), "ok");
    },
    [doc, mutate, app],
  );

  return {
    layers,
    rootlessLayers,
    switchToLayer,
    addNewLayer,
    renameCurrentLayer,
    removeCurrentLayer,
    moveCurrentLayer,
    setCurrentLayerAsHome,
  };
}
