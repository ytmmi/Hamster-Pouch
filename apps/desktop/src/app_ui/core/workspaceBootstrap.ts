/**
 * 启动时的默认仓库装载：若设置了默认仓库，自动打开它并把它的**当前层**布局套到 dockview。
 *
 * 失败一律忽略（没有默认仓库 / 没有布局 / 打开失败都保留 `defaultWorkspaceLayout` 建好的
 * 默认界面）。`onRepoOpened` 由宿主持有：仓库 id 必须在布局套用**之前**上报，让插件的
 * 注册表重建与工作区状态同步尽早开始（D53/D54 分层）。
 */

import type { DockviewApi } from "dockview-react";

import * as api from "../shared/api";
import {
  activeBlueprintId,
  loadActiveBlueprint,
  loadCurrentLayer,
  reconcileAfterLayoutApplied,
} from "../shared/blueprintRuntime";
import { normalizeLayoutJson } from "../shared/panelLayout";

/** 打开默认仓库并套用其当前层布局（无默认仓库时什么都不做）。 */
export async function bootstrapDefaultRepo(
  dv: DockviewApi,
  onRepoOpened: (repoId: string) => void,
): Promise<void> {
  try {
    const defRepo = await api.repoGetDefault();
    if (!defRepo) {
      return;
    }
    const opened = await api.repoOpen({ repoId: defRepo });
    onRepoOpened(opened.id);
    // 分层（D53/D54）：先装载生效蓝图 → 读出该仓库的当前层 → 套用**当前层**那一份布局。
    await loadActiveBlueprint(opened.id, activeBlueprintId());
    const layer = await loadCurrentLayer(opened.id);
    const defLayout = await api.layoutGetDefault({ repoId: opened.id });
    if (!defLayout) {
      return;
    }
    const raw = await api.layoutGet({
      repoId: opened.id,
      name: defLayout,
      layerKey: layer ?? undefined,
    });
    const applied =
      raw ??
      // 该层没有专属行时按层无关行兼容（旧预设）。
      (await api.layoutGet({ repoId: opened.id, name: defLayout }));
    if (!applied) {
      return;
    }
    const layout = JSON.parse(applied);
    // 补齐最小尺寸约束并保持媒体预览 DOM（renderer=always）。
    dv.fromJSON(normalizeLayoutJson(layout));
    // 套用布局后按蓝图语义对账一次（D29：防止显隐/收起状态漂移）。
    reconcileAfterLayoutApplied(dv);
  } catch {
    /* 无默认仓库/布局或打开失败：保留默认布局 */
  }
}
