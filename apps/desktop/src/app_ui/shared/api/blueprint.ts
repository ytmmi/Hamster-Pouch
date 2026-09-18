/**
 * M6：蓝图命令封装（RFC 0007 / D28-D32）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  BlueprintCreateArgs,
  BlueprintDeleteArgs,
  BlueprintGetArgs,
  BlueprintGetDefaultArgs,
  BlueprintItem,
  BlueprintListArgs,
  BlueprintSaveArgs,
  BlueprintSetDefaultArgs,
  BlueprintTemplateInstallArgs,
  BlueprintTemplateItem,
  BlueprintValidateArgs,
  BlueprintValidateResult,
} from "../types";

/** 列出仓库全部蓝图（最新在前）。 */
export function blueprintList(args: BlueprintListArgs): Promise<BlueprintItem[]> {
  return invoke<BlueprintItem[]>("blueprint_list", { repoId: args.repoId });
}

/** 读取蓝图文档 JSON；不存在返回 null。 */
export function blueprintGet(args: BlueprintGetArgs): Promise<string | null> {
  return invoke<string | null>("blueprint_get", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  });
}

/** 读取仓库默认蓝图文档；未设置默认返回 null（消费层回退内置默认）。 */
export function blueprintGetDefault(
  args: BlueprintGetDefaultArgs,
): Promise<string | null> {
  return invoke<string | null>("blueprint_get_default", { repoId: args.repoId });
}

/** 新建蓝图（可从模板复制或直接以文档初始化）。 */
export function blueprintCreate(args: BlueprintCreateArgs): Promise<BlueprintItem> {
  return invoke<BlueprintItem>("blueprint_create", {
    repoId: args.repoId,
    name: args.name,
    fromTemplateId: args.fromTemplateId ?? null,
    blueprintJson: args.blueprintJson ?? null,
  });
}

/** 整文档保存（校验后，可改名）。 */
export function blueprintSave(args: BlueprintSaveArgs): Promise<BlueprintItem> {
  return invoke<BlueprintItem>("blueprint_save", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
    name: args.name ?? null,
    blueprintJson: args.blueprintJson,
  });
}

/** 删除蓝图（删默认后回退内置默认）。 */
export function blueprintDelete(args: BlueprintDeleteArgs): Promise<void> {
  return invoke<void>("blueprint_delete", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  });
}

/** 设为仓库默认蓝图。 */
export function blueprintSetDefault(args: BlueprintSetDefaultArgs): Promise<void> {
  return invoke<void>("blueprint_set_default", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  });
}

/** 校验图文档，返回错误列表（空 = 有效）。 */
export function blueprintValidate(
  args: BlueprintValidateArgs,
): Promise<BlueprintValidateResult> {
  return invoke<BlueprintValidateResult>("blueprint_validate", {
    repoId: args.repoId,
    blueprintJson: args.blueprintJson,
  });
}

/** 读取某仓库的当前层 key（D54：按仓库持久化）；未设置返回 null。 */
export function blueprintCurrentLayerGet(repoId: string): Promise<string | null> {
  return invoke<string | null>("blueprint_current_layer_get", { repoId });
}

/** 记住某仓库的当前层（D54：多窗口读同一记录，后写覆盖）。 */
export function blueprintCurrentLayerSet(
  repoId: string,
  layerKey: string,
): Promise<void> {
  return invoke<void>("blueprint_current_layer_set", { repoId, layerKey });
}

/** 列出应用级共享的蓝图模板。 */
export function blueprintTemplateList(): Promise<BlueprintTemplateItem[]> {
  return invoke<BlueprintTemplateItem[]>("blueprint_template_list");
}

/** 把模板复制进仓库蓝图（复制后与模板脱离）。 */
export function blueprintTemplateInstall(
  args: BlueprintTemplateInstallArgs,
): Promise<BlueprintItem> {
  return invoke<BlueprintItem>("blueprint_template_install", {
    repoId: args.repoId,
    templateId: args.templateId,
    name: args.name ?? null,
  });
}
