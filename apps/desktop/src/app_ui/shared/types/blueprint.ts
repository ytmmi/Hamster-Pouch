/**
 * M6：蓝图（RFC 0007）API 参数与返回类型。
 *
 * 返回类型来自 @hamster-pouch/shared-types（hp-dto 生成）；
 * 命令参数键使用 camelCase（Tauri v2 自动映射）。
 */

import type {
  BlueprintItem,
  BlueprintTemplateItem,
  BlueprintValidateResult,
} from "@hamster-pouch/shared-types";

export type { BlueprintItem, BlueprintTemplateItem, BlueprintValidateResult };

export interface BlueprintListArgs {
  repoId: string;
}

export interface BlueprintGetArgs {
  repoId: string;
  blueprintId: string;
}

export interface BlueprintGetDefaultArgs {
  repoId: string;
}

export interface BlueprintCreateArgs {
  repoId: string;
  name: string;
  fromTemplateId?: string;
  /** 直接以文档 JSON 初始化（种子默认蓝图用）。 */
  blueprintJson?: string;
}

export interface BlueprintSaveArgs {
  repoId: string;
  blueprintId: string;
  name?: string;
  blueprintJson: string;
}

export interface BlueprintDeleteArgs {
  repoId: string;
  blueprintId: string;
}

export interface BlueprintSetDefaultArgs {
  repoId: string;
  blueprintId: string;
}

export interface BlueprintValidateArgs {
  repoId: string;
  blueprintJson: string;
}

export interface BlueprintTemplateInstallArgs {
  repoId: string;
  templateId: string;
  name?: string;
}

/** blueprint.list 返回元素（重导出，供面板直接引用）。 */
export type { BlueprintItem as BlueprintListItem };
