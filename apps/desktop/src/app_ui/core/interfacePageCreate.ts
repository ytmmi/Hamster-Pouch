/**
 * 新建「界面」——即在**生效蓝图里加一层**，并把结果落库 + 热更新（D124-R3）。
 *
 * 为什么必须走蓝图而不是只改前端分组结构：界面页的每个标签**恒等于蓝图的一层**
 * （D51/D53/D54/D55/D60/D67）。只在前端凭空加一个标签，切过去会没有层可套用布局；
 * 反之写进蓝图后，蓝图编辑器、层切换、布局按层保存全部自动对齐——"新页面同步进蓝图"
 * 是这条不变式的必然结果，不是额外做的同步。
 *
 * 写盘路径照抄编辑器保存（`useBlueprintDocuments.save`）：
 * `normalizeLayersForSave` → `blueprintValidate`（有硬错误就不写）→ `blueprintSave`
 * → `notifyBlueprintChangedLocally`（热更新，标签条随之重建）。
 */

import {
  forUserSave,
  normalizeLayersForSave,
  parseBlueprintDocument,
} from "@hamster-pouch/config";

import { addLayer } from "../panels/blueprintLayers";
import * as api from "../shared/api";
import {
  activeBlueprintId,
  notifyBlueprintChangedLocally,
} from "../shared/blueprintRuntime";

/** 新建成功后的定位信息（用于分组归属与状态栏提示）。 */
export interface CreatedInterfacePage {
  /** 新层的 key（= 标签条上的界面 key）。 */
  layerKey: string;
  /** 新层的显示名（蓝图里可能已自动去重）。 */
  name: string;
}

/**
 * 解析"该往哪个蓝图里写"。
 *
 * 生效蓝图可能是**指定的某份**，也可能是**仓库默认蓝图**——后者运行时用 `activeId = null`
 * 表示，所以这里要回落到"列表里 is_default 的那份"，不能直接拿 `activeBlueprintId()` 当 id。
 */
async function resolveTarget(
  repoId: string,
): Promise<{ id: string; json: string }> {
  const activeId = activeBlueprintId();
  if (activeId) {
    const json = await api.blueprintGet({ repoId, blueprintId: activeId });
    // 生效蓝图被外部删掉时会读回 null：此时回落到默认蓝图，而不是直接失败。
    if (json) return { id: activeId, json };
  }
  const [json, list] = await Promise.all([
    api.blueprintGetDefault({ repoId }),
    api.blueprintList({ repoId }),
  ]);
  const fallback = list.find((item) => item.is_default);
  if (json && fallback) return { id: fallback.id, json };
  throw new Error("当前仓库没有可写入的蓝图");
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
  const target = await resolveTarget(repoId);
  const doc = parseBlueprintDocument(target.json);
  if (!doc) throw new Error("蓝图解析失败");
  const { doc: withLayer, layer } = addLayer(doc, name);
  const prepared = normalizeLayersForSave(withLayer);
  const check = await api.blueprintValidate({
    repoId,
    blueprintJson: JSON.stringify(prepared),
  });
  if (check.errors.length > 0) {
    throw new Error(check.errors[0] ?? "蓝图校验未通过");
  }
  await api.blueprintSave({
    repoId,
    blueprintId: target.id,
    // 不传 name：保留蓝图原名（新建界面不该顺手改名）。
    blueprintJson: JSON.stringify(forUserSave(prepared)),
  });
  notifyBlueprintChangedLocally({ id: target.id, graph: prepared });
  return { layerKey: layer.key, name: layer.name };
}
