/**
 * M4-7：面板布局持久化命令封装（panel_layouts，D1）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { LayoutGetArgs, LayoutItem, LayoutListArgs, LayoutSaveArgs } from "../types";

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
