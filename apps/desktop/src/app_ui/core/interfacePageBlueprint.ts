/**
 * 「界面页」写蓝图的公共管道（D124-R3 / D124-R5）。
 *
 * 界面页的每个标签**恒等于生效蓝图的一层**（D124 ②的不变式），所以"新建界面"与
 * "删除界面"本质是同一类动作：改蓝图 → 校验 → 落库 → 热更新。两条路径只差"改哪一步"，
 * 而"往哪份蓝图写、怎么写回去"必须**完全一致**——否则新建与删除可能落在不同的蓝图上
 * （生效蓝图可能是被指定的某一份，也可能回落到仓库默认蓝图，见 `resolveInterfacePageTarget`）。
 *
 * 写盘路径照抄编辑器保存（`useBlueprintDocuments.save`）：
 * `normalizeLayersForSave` → `blueprintValidate`（有硬错误就不写）→ `blueprintSave`
 * → `notifyBlueprintChangedLocally`（热更新，标签条随蓝图重建）。
 */

import type { BlueprintGraph } from "@hamster-pouch/config";
import { forUserSave, normalizeLayersForSave } from "@hamster-pouch/config";

import * as api from "../shared/api";
import {
  activeBlueprintId,
  notifyBlueprintChangedLocally,
} from "../shared/blueprintRuntime";

/** 本次要写入的蓝图：id + 当前 JSON（已读出来的那一份）。 */
export interface InterfacePageTarget {
  /** 蓝图 id（删除/新建都要落到这一份上）。 */
  id: string;
  /** 读回来的蓝图 JSON 原文（交给 `parseBlueprintDocument` 解析）。 */
  json: string;
}

/**
 * 解析"该往哪个蓝图里写"。
 *
 * 生效蓝图可能是**指定的某份**，也可能是**仓库默认蓝图**——后者运行时用 `activeId = null`
 * 表示，所以这里要回落到"列表里 is_default 的那份"，不能直接拿 `activeBlueprintId()` 当 id。
 */
export async function resolveInterfacePageTarget(
  repoId: string,
): Promise<InterfacePageTarget> {
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
 * 把改好的图落库并热更新。
 *
 * 校验有硬错误就**不写**并抛异常：这里没有"静默成功"的分支——标签条若以为改成功了、
 * 蓝图里却没有，用户点过去就是空白页（或者在标签条上看到幽灵界面）。
 */
export async function saveInterfacePageBlueprint(
  repoId: string,
  targetId: string,
  doc: BlueprintGraph,
): Promise<void> {
  const prepared = normalizeLayersForSave(doc);
  const check = await api.blueprintValidate({
    repoId,
    blueprintJson: JSON.stringify(prepared),
  });
  if (check.errors.length > 0) {
    throw new Error(check.errors[0] ?? "蓝图校验未通过");
  }
  await api.blueprintSave({
    repoId,
    blueprintId: targetId,
    // 不传 name：保留蓝图原名（加/删界面都不该顺手改名）。
    blueprintJson: JSON.stringify(forUserSave(prepared)),
  });
  notifyBlueprintChangedLocally({ id: targetId, graph: prepared });
}
