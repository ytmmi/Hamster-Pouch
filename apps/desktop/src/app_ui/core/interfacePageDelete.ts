/**
 * 删除「界面」——即从**生效蓝图里删掉一层**，并把结果落库 + 热更新（D124-R5）。
 *
 * 为什么必须走蓝图：界面页的每个标签**恒等于蓝图的一层**（D124 ②）。只在前端藏掉一个标签，
 * 蓝图层还在——下一次热更新/切仓库，标签条按蓝图重建，被"删掉"的界面立刻回来；
 * 而且它的布局、节点、对账都没变，删除语义没兑现。所以"删除界面"只有一条实现：
 * 删蓝图的层（`removeLayer`，D55：直接删除、不是软删除），标签条随后由运行时广播自然重建。
 *
 * 约束：**至少保留一层**（`blueprintDelete.removeLayer` 的 `last-layer`）。这一条不是 UI 顺手
 * 挡一下，而是没有层就没有界面可导航（切层、每层布局、蓝图对账都以"当前层"为前提）。
 */

import { effectiveLayers, parseBlueprintDocument } from "@hamster-pouch/config";

import { removeLayer } from "../panels/blueprintDelete";
import {
  resolveInterfacePageTarget,
  saveInterfacePageBlueprint,
} from "./interfacePageBlueprint";

/** 删除成功后的定位信息（用于状态栏提示）。 */
export interface DeletedInterfacePage {
  /** 被删掉的层 key（= 标签条上的界面 key）。 */
  layerKey: string;
  /** 被删掉层的显示名（蓝图里的名字，不是标签条推导的）。 */
  name: string;
}

/**
 * 删除生效蓝图里的某一层，返回被删界面的 key 与名称。
 *
 * 失败一律抛异常（由调用方转成状态栏错误提示）：`last-layer` 与 `missing-layer` 都不是
 * "可以忽略"的情况——前者说明调用方没挡住最后一个界面，后者说明标签条与蓝图已经不同步，
 * 静默返回会让用户以为删掉了。
 */
export async function deleteInterfacePage(
  repoId: string,
  layerKey: string,
): Promise<DeletedInterfacePage> {
  const target = await resolveInterfacePageTarget(repoId);
  const doc = parseBlueprintDocument(target.json);
  if (!doc) throw new Error("蓝图解析失败");
  // 先取名字：删掉之后图里就没有这一层了。
  const name = effectiveLayers(doc).find((layer) => layer.key === layerKey)?.name ?? layerKey;
  const result = removeLayer(doc, layerKey);
  if (result.rejected === "last-layer") {
    throw new Error("至少保留一层，无法删除最后一层");
  }
  if (result.rejected) {
    throw new Error(`蓝图里没有界面「${layerKey}」`);
  }
  await saveInterfacePageBlueprint(repoId, target.id, result.doc);
  return { layerKey, name };
}
