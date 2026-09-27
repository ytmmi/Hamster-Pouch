/**
 * M4-7：面板布局持久化命令封装（panel_layouts，D1）。
 *
 * **D76 迁移状态：已包装**（批次 `repo/layout`，2026-09）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  LayoutBlueprintsArgs,
  LayoutDeleteArgs,
  LayoutGetArgs,
  LayoutGetDefaultArgs,
  LayoutItem,
  LayoutListArgs,
  LayoutRenameArgs,
  LayoutSaveArgs,
  LayoutSetDefaultArgs,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 保存（同 (repoId, name, layerKey) 覆盖）某仓库下、某一层的命名布局；可选绑定蓝图 ID 列表 */
export function layoutSave(args: LayoutSaveArgs): Promise<LayoutItem> {
  return invoke<ApiResponse<LayoutItem>>("layout_save", {
    repoId: args.repoId,
    name: args.name,
    layoutJson: args.layoutJson,
    layerKey: args.layerKey ?? null,
    blueprintIds: args.blueprintIds ?? null,
  }).then(unwrapApi);
}

/** 读取某布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。 */
export function layoutBlueprints(args: LayoutBlueprintsArgs): Promise<string[]> {
  return invoke<ApiResponse<string[]>>("layout_blueprints", {
    repoId: args.repoId,
    name: args.name,
  }).then(unwrapApi);
}

/** 列出某仓库下全部命名布局层行（最新在前；同一布局名在每个层各一行） */
export function layoutList(args: LayoutListArgs): Promise<LayoutItem[]> {
  return invoke<ApiResponse<LayoutItem[]>>("layout_list", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 读取某仓库下某一层的命名布局 JSON；不存在返回 null（该层无行时按层无关行兜底） */
export function layoutGet(args: LayoutGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("layout_get", {
    repoId: args.repoId,
    name: args.name,
    layerKey: args.layerKey ?? null,
  }).then(unwrapApi);
}

/** 重命名布局预设 */
export function layoutRename(args: LayoutRenameArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_rename", {
    repoId: args.repoId,
    name: args.name,
    newName: args.newName,
  }).then(unwrapApi);
}

/** 删除布局预设 */
export function layoutDelete(args: LayoutDeleteArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_delete", {
    repoId: args.repoId,
    name: args.name,
  }).then(unwrapApi);
}

/** 设为默认布局 */
export function layoutSetDefault(args: LayoutSetDefaultArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_set_default", {
    repoId: args.repoId,
    name: args.name,
  }).then(unwrapApi);
}

/** 读取默认布局名；未设置返回 null */
export function layoutGetDefault(args: LayoutGetDefaultArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("layout_get_default", {
    repoId: args.repoId,
  }).then(unwrapApi);
}
