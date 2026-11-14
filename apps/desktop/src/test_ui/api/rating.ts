/**
 * test_ui M4：评分命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。写成裸 `invoke<T>` 会把信封当数据用，靠 `unwrapApi` 的守卫
 * 才不至于静默出错。
 */

import { invoke } from "@tauri-apps/api/core";

import { unwrapApi, type ApiResponse } from "../../app_ui/shared/api/response";

import type { RatingGetArgs, RatingSetArgs } from "../types";

/** 设置文件评分（0-5） */
export function ratingSet(args: RatingSetArgs): Promise<void> {
  return invoke<ApiResponse<void>>("rating_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    rating: args.rating,
  }).then(unwrapApi);
}

/** 读取文件评分 */
export function ratingGet(args: RatingGetArgs): Promise<number | null> {
  return invoke<ApiResponse<number | null>>("rating_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  }).then(unwrapApi);
}
