/**
 * test_ui M4：tag 命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。写成裸 `invoke<T>` 会把信封当数据用，靠 `unwrapApi` 的守卫
 * 才不至于静默出错。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "../../app_ui/shared/api/response";

import type {
  TagAddArgs,
  TagForFileArgs,
  TagItem,
  TagListArgs,
  TagRemoveArgs,
} from "../types";

/** 给文件批量添加 tag */
export function tagAdd(args: TagAddArgs): Promise<void> {
  return invoke<ApiResponse<void>>("tag_add", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  }).then(unwrapApi);
}

/** 从文件批量移除 tag */
export function tagRemove(args: TagRemoveArgs): Promise<void> {
  return invoke<ApiResponse<void>>("tag_remove", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  }).then(unwrapApi);
}

/** 列出仓库内全部 tag */
export function tagList(args: TagListArgs): Promise<TagItem[]> {
  return invoke<ApiResponse<TagItem[]>>("tag_list", { repoId: args.repoId }).then(unwrapApi);
}

/** 列出文件已关联的 tag */
export function tagForFile(args: TagForFileArgs): Promise<TagItem[]> {
  return invoke<ApiResponse<TagItem[]>>("tag_for_file", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
