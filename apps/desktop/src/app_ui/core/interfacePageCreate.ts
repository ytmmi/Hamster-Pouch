/**
 * 新建「界面」——即在**生效蓝图里加一层**，并把结果落库 + 热更新（D124-R3）。
 *
 * 为什么必须走蓝图而不是只改前端分组结构：界面页的每个标签**恒等于蓝图的一层**
 * （D51/D53/D54/D55/D60/D67）。只在前端凭空加一个标签，切过去会没有层可套用布局；
 * 反之写进蓝图后，蓝图编辑器、层切换、布局按层保存全部自动对齐——"新页面同步进蓝图"
 * 是这条不变式的必然结果，不是额外做的同步。
 *
 * 「往哪份蓝图写、怎么写回去」与删除界面（`interfacePageDelete.ts`）共用
 * `interfacePageBlueprint.ts`：两条路径只有"改哪一步"不同，落库管道必须同一份。
 */

import { parseBlueprintDocument } from "@hamster-pouch/config";

import { addLayer } from "../panels/blueprintLayers";
import {
  resolveInterfacePageTarget,
  saveInterfacePageBlueprint,
} from "./interfacePageBlueprint";

/** 新建成功后的定位信息（用于分组归属与状态栏提示）。 */
export interface CreatedInterfacePage {
  /** 新层的 key（= 标签条上的界面 key）。 */
  layerKey: string;
  /** 新层的显示名（蓝图里可能已自动去重）。 */
  name: string;
}

/**
 * 在生效蓝图里新建一层并落库，返回新界面的 key 与名称。
 *
 * 失败一律抛异常（由调用方转成状态栏错误提示）：这里没有"静默成功"的分支——
 * 标签条若以为建成功了、蓝图里却没有，用户切过去就是空白页。
 */
export async function createInterfacePage(
  repoId: string,
  name?: string,
): Promise<CreatedInterfacePage> {
  const target = await resolveInterfacePageTarget(repoId);
  const doc = parseBlueprintDocument(target.json);
  if (!doc) throw new Error("蓝图解析失败");
  const { doc: withLayer, layer } = addLayer(doc, name);
  await saveInterfacePageBlueprint(repoId, target.id, withLayer);
  return { layerKey: layer.key, name: layer.name };
}
