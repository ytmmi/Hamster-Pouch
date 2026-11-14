/**
 * M4：评分命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `tag`，2026-09；`rating.*` 与 `tag.*` 同属契约 §3.5）。
 */

import { invokeApi } from "./call";

import type { RatingGetArgs, RatingSetArgs } from "../types";

/** 设置文件评分（0-5） */
export function ratingSet(args: RatingSetArgs): Promise<void> {
  return invokeApi<void>("rating_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    rating: args.rating,
  });
}

/** 读取文件评分 */
export function ratingGet(args: RatingGetArgs): Promise<number | null> {
  return invokeApi<number | null>("rating_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
