/**
 * M4：评分命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `tag`，2026-09；`rating.*` 与 `tag.*` 同属契约 §3.5）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { RatingGetArgs, RatingSetArgs } from "../types";
import { unwrapApi, type ApiResponse } from "./response";

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
