/**
 * 启动时的默认布局装载（RFC 0011）。
 *
 * 解析链（命中即停）：**仓库绑定 → 应用级默认 → 代码内建形状**。
 * 读取每份预设时先取当前层、再取 `""` 层无关快照；某份预设两层都没有才继续沿链下移
 * （绝不跨预设借旧行）。没有默认仓库时同样套用应用级默认——这是缺陷 0044 的修复点：
 * 发布包不建仓库也要开箱即见既定布局。
 *
 * 失败一律忽略（保留 `defaultWorkspaceLayout` 建好的内建界面）。
 * `onRepoOpened` 由宿主持有：仓库 id 必须在布局套用**之前**上报，让插件的注册表
 * 重建与工作区状态同步尽早开始（D53/D54 分层）。
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
import type { Translate } from "../i18n";

/** 启动装配：出厂播种 → （可选）打开默认仓库 → 套用生效布局。 */
export async function bootstrapDefaultRepo(
  dv: DockviewApi,
  onRepoOpened: (repoId: string) => void,
  t: Translate,
): Promise<void> {
  // 决策 5：首次运行把内建形状播种为应用级预设；用户改动过则永不覆盖。
  try {
    await ensureSeededLayout(dv, t);
  } catch {
    /* 播种失败不阻塞首屏 */
  }

  // 默认仓库可能已不存在（发布包清空 repos 后仍会残留 `repo.default` 指针）：
  // 打开失败按「无默认仓库」处理，**继续套用应用级默认**——缺陷 0044 的修复点。
  let repoId: string | null = null;
  let layer: string | null = null;
  try {
    const defRepo = await api.repoGetDefault();
    if (defRepo) {
      const opened = await api.repoOpen({ repoId: defRepo });
      repoId = opened.id;
      onRepoOpened(opened.id);
      // 分层（D53/D54）：先装载生效蓝图 → 读出该仓库的当前层 → 套用该层布局。
      await loadActiveBlueprint(opened.id, activeBlueprintId());
      layer = await loadCurrentLayer(opened.id);
    }
  } catch {
    /* 默认仓库打不开：回落到应用级默认 */
  }

  try {
    await applyEffectiveLayout(dv, repoId, layer);
  } catch {
    /* 布局不可用：保留内建形状 */
  }
}

/** 出厂播种（RFC 0011 决策 5）：库内无预设时把内建形状写为 `seeded` 预设并设为默认。 */
export async function ensureSeededLayout(dv: DockviewApi, t: Translate): Promise<void> {
  // 一份布局 = 一条记录：内建形状作为 `""` 层无关快照落库。
  const layersJson = JSON.stringify({ "": dv.toJSON() });
  await api.layoutEnsureSeed({ name: t("menubar.layout.seededName"), layersJson });
}

/**
 * 解析链上的候选预设名（有序、去重）：仓库覆盖 → 应用级默认。
 * 两者都缺 = 没有预设，保留内建形状。
 */
export async function layoutChain(repoId: string | null): Promise<string[]> {
  const chain: string[] = [];
  const push = (name: string | null) => {
    if (name && !chain.includes(name)) {
      chain.push(name);
    }
  };
  if (repoId) {
    push(await api.layoutGetDefault({ repoId }));
  }
  push(await api.layoutGetDefault());
  return chain;
}

/**
 * 按解析链套用布局；返回实际生效的预设名（未套用返回 `null`，屏幕保持不动）。
 *
 * 每份预设内：当前层 → `""`；都没有才下移一层候选。
 */
export async function applyEffectiveLayout(
  dv: DockviewApi,
  repoId: string | null,
  layerKey: string | null,
): Promise<string | null> {
  for (const name of await layoutChain(repoId)) {
    const raw =
      (await api.layoutGet({ name, layerKey: layerKey ?? undefined })) ??
      (await api.layoutGet({ name }));
    if (!raw) {
      continue;
    }
    dv.fromJSON(normalizeLayoutJson(JSON.parse(raw)));
    // 套用布局后按蓝图语义对账一次（D29：防止显隐/收起状态漂移）。
    reconcileAfterLayoutApplied(dv);
    return name;
  }
  return null;
}
