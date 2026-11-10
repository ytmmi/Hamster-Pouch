/**
 * RFC 0011：布局预设与仓库绑定命令封装（应用级预设 + 可选仓库覆盖）。
 *
 * **D76 迁移状态：已包装**（批次 `repo/layout`，2026-09；RFC 0011 改为应用级，2026-11）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  LayoutBindRepoArgs,
  LayoutBlueprintsArgs,
  LayoutDeleteArgs,
  LayoutEnsureSeedArgs,
  LayoutExportArgs,
  LayoutGetArgs,
  LayoutGetDefaultArgs,
  LayoutImportArgs,
  LayoutItem,
  LayoutRenameArgs,
  LayoutSaveArgs,
  LayoutSeedResult,
  LayoutSetDefaultArgs,
} from "../types";
import { unwrapApi, type ApiResponse } from "./response";

/** 保存当前层布局到应用级预设（预设不存在则新建）；`blueprintIds` 给定则覆盖绑定。 */
export function layoutSave(args: LayoutSaveArgs): Promise<LayoutItem> {
  return invoke<ApiResponse<LayoutItem>>("layout_save", {
    name: args.name,
    layoutJson: args.layoutJson,
    layerKey: args.layerKey ?? null,
    blueprintIds: args.blueprintIds ?? null,
  }).then(unwrapApi);
}

/** 读取某预设绑定的蓝图 ID 列表。 */
export function layoutBlueprints(args: LayoutBlueprintsArgs): Promise<string[]> {
  return invoke<ApiResponse<string[]>>("layout_blueprints", {
    name: args.name,
  }).then(unwrapApi);
}

/** 列出全部应用级预设（最新在前）。 */
export function layoutList(): Promise<LayoutItem[]> {
  return invoke<ApiResponse<LayoutItem[]>>("layout_list").then(unwrapApi);
}

/** 读取某预设内某一层的布局 JSON；该层与 `""` 都缺失时返回 null（不跨预设兜底）。 */
export function layoutGet(args: LayoutGetArgs): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("layout_get", {
    name: args.name,
    layerKey: args.layerKey ?? null,
  }).then(unwrapApi);
}

/** 重命名预设（默认指针与仓库绑定按 id 存，自动跟随）。 */
export function layoutRename(args: LayoutRenameArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_rename", {
    name: args.name,
    newName: args.newName,
  }).then(unwrapApi);
}

/** 删除预设；命中应用级默认或任一仓库绑定时后端拒绝。 */
export function layoutDelete(args: LayoutDeleteArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_delete", {
    name: args.name,
  }).then(unwrapApi);
}

/** 设为应用级默认。 */
export function layoutSetDefault(args: LayoutSetDefaultArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_set_default", {
    name: args.name,
  }).then(unwrapApi);
}

/** 读取生效的预设名：给 `repoId` 时绑定优先，否则应用级默认；都没有返回 null。 */
export function layoutGetDefault(args: LayoutGetDefaultArgs = {}): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("layout_get_default", {
    repoId: args.repoId ?? null,
  }).then(unwrapApi);
}

/** 设 / 清仓库覆盖（`name` 省略 = 清除，回到应用级默认）。 */
export function layoutBindRepo(args: LayoutBindRepoArgs): Promise<void> {
  return invoke<ApiResponse<void>>("layout_bind_repo", {
    repoId: args.repoId,
    name: args.name ?? null,
  }).then(unwrapApi);
}

/** 导出预设为 `hamster-pouch.layout` JSON；给 `path` 时同时落盘，返回 JSON 文本。 */
export function layoutExport(args: LayoutExportArgs): Promise<string> {
  return invoke<ApiResponse<string>>("layout_export", {
    name: args.name,
    path: args.path ?? null,
  }).then(unwrapApi);
}

/** 导入预设 JSON（`path` 优先）；重名自动加后缀，不覆盖、不改绑定。 */
export function layoutImport(args: LayoutImportArgs): Promise<LayoutItem> {
  return invoke<ApiResponse<LayoutItem>>("layout_import", {
    json: args.json ?? "",
    path: args.path ?? null,
  }).then(unwrapApi);
}

/** 出厂播种：库内无预设时把内建形状写成 `origin='seeded'` 的应用级默认。 */
export function layoutEnsureSeed(args: LayoutEnsureSeedArgs): Promise<LayoutSeedResult> {
  return invoke<ApiResponse<LayoutSeedResult>>("layout_ensure_seed", {
    name: args.name,
    layersJson: args.layersJson,
    blueprintIds: args.blueprintIds ?? null,
  }).then(unwrapApi);
}
