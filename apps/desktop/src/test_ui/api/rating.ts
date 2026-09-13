/**
 * test_ui M4：评分命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type { RatingGetArgs, RatingSetArgs } from "../types";

/** 设置文件评分（0-5） */
export function ratingSet(args: RatingSetArgs): Promise<void> {
  return invoke<void>("rating_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    rating: args.rating,
  });
}

/** 读取文件评分 */
export function ratingGet(args: RatingGetArgs): Promise<number | null> {
  return invoke<number | null>("rating_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
