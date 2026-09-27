/**
 * M6：蓝图命令封装（RFC 0007 / D28-D32）。
 *
 * **D76 迁移状态：已包装**（批次 `blueprint`，2026-09）。全部命令返回
 * `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的领域值，
 * 失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
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
import { unwrapApi, type ApiResponse } from "./response";

/** 列出仓库全部蓝图（最新在前）。 */
export function blueprintList(args: BlueprintListArgs): Promise<BlueprintItem[]> {
  return invoke<ApiResponse<BlueprintItem[]>>("blueprint_list", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 读取蓝图文档 JSON；不存在返回 null。 */
export function blueprintGet(args: BlueprintGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("blueprint_get", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  }).then(unwrapApi);
}

/** 读取仓库默认蓝图文档；未设置默认返回 null（消费层回退内置默认）。 */
export function blueprintGetDefault(
  args: BlueprintGetDefaultArgs,
): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("blueprint_get_default", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 新建蓝图（可从模板复制或直接以文档初始化）。 */
export function blueprintCreate(args: BlueprintCreateArgs): Promise<BlueprintItem> {
  return invoke<ApiResponse<BlueprintItem>>("blueprint_create", {
    repoId: args.repoId,
    name: args.name,
    fromTemplateId: args.fromTemplateId ?? null,
    blueprintJson: args.blueprintJson ?? null,
  }).then(unwrapApi);
}

/** 整文档保存（校验后，可改名）。 */
export function blueprintSave(args: BlueprintSaveArgs): Promise<BlueprintItem> {
  return invoke<ApiResponse<BlueprintItem>>("blueprint_save", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
    name: args.name ?? null,
    blueprintJson: args.blueprintJson,
  }).then(unwrapApi);
}

/** 删除蓝图（删默认后回退内置默认）。 */
export function blueprintDelete(args: BlueprintDeleteArgs): Promise<void> {
  return invoke<ApiResponse<void>>("blueprint_delete", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  }).then(unwrapApi);
}

/** 设为仓库默认蓝图。 */
export function blueprintSetDefault(args: BlueprintSetDefaultArgs): Promise<void> {
  return invoke<ApiResponse<void>>("blueprint_set_default", {
    repoId: args.repoId,
    blueprintId: args.blueprintId,
  }).then(unwrapApi);
}

/**
 * 校验图文档，返回错误与未接通软告警。
 *
 * **`ok: true` 不等于文档有效**：硬错误在 `data.errors` 里（这是"服务端复算结果"，
 * 不是命令级失败），调用方必须自己看 `errors`。
 */
export function blueprintValidate(
  args: BlueprintValidateArgs,
): Promise<BlueprintValidateResult> {
  return invoke<ApiResponse<BlueprintValidateResult>>("blueprint_validate", {
    repoId: args.repoId,
    blueprintJson: args.blueprintJson,
  }).then(unwrapApi);
}

/** 读取某仓库的当前层 key（D54：按仓库持久化）；未设置返回 null。 */
export function blueprintCurrentLayerGet(repoId: string): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("blueprint_current_layer_get", {
    repoId,
  }).then(unwrapApi);
}

/** 记住某仓库的当前层（D54：多窗口读同一记录，后写覆盖）。 */
export function blueprintCurrentLayerSet(
  repoId: string,
  layerKey: string,
): Promise<void> {
  return invoke<ApiResponse<void>>("blueprint_current_layer_set", {
    repoId,
    layerKey,
  }).then(unwrapApi);
}

/** 列出应用级共享的蓝图模板。 */
export function blueprintTemplateList(): Promise<BlueprintTemplateItem[]> {
  return invoke<ApiResponse<BlueprintTemplateItem[]>>("blueprint_template_list").then(
    unwrapApi,
  );
}

/** 把模板复制进仓库蓝图（复制后与模板脱离）。 */
export function blueprintTemplateInstall(
  args: BlueprintTemplateInstallArgs,
): Promise<BlueprintItem> {
  return invoke<ApiResponse<BlueprintItem>>("blueprint_template_install", {
    repoId: args.repoId,
    templateId: args.templateId,
    name: args.name ?? null,
  }).then(unwrapApi);
}
