/**
 * M4-7：面板布局持久化命令封装（panel_layouts，D1）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  LayoutDeleteArgs,
  LayoutGetArgs,
  LayoutGetDefaultArgs,
  LayoutItem,
  LayoutListArgs,
  LayoutRenameArgs,
  LayoutSaveArgs,
  LayoutSetDefaultArgs,
} from "../types";

/** 保存（同 (repoId, name) 覆盖）某仓库下的命名布局 */
export function layoutSave(args: LayoutSaveArgs): Promise<LayoutItem> {
  return invoke<LayoutItem>("layout_save", {
    repoId: args.repoId,
    name: args.name,
    layoutJson: args.layoutJson,
  });
}

/** 列出某仓库下全部命名布局（最新在前） */
export function layoutList(args: LayoutListArgs): Promise<LayoutItem[]> {
  return invoke<LayoutItem[]>("layout_list", { repoId: args.repoId });
}

/** 读取某仓库下单个命名布局 JSON；不存在返回 null */
export function layoutGet(args: LayoutGetArgs): Promise<string | null> {
  return invoke<string | null>("layout_get", { repoId: args.repoId, name: args.name });
}

/** 重命名布局预设 */
export function layoutRename(args: LayoutRenameArgs): Promise<void> {
  return invoke<void>("layout_rename", {
    repoId: args.repoId,
    name: args.name,
    newName: args.newName,
  });
}

/** 删除布局预设 */
export function layoutDelete(args: LayoutDeleteArgs): Promise<void> {
  return invoke<void>("layout_delete", { repoId: args.repoId, name: args.name });
}

/** 设为默认布局 */
export function layoutSetDefault(args: LayoutSetDefaultArgs): Promise<void> {
  return invoke<void>("layout_set_default", { repoId: args.repoId, name: args.name });
}

/** 读取默认布局名；未设置返回 null */
export function layoutGetDefault(args: LayoutGetDefaultArgs): Promise<string | null> {
  return invoke<string | null>("layout_get_default", { repoId: args.repoId });
}
