/**
 * test_ui M4：评分命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。调用统一走 `invokeApi`（`app_ui/shared/api/call.ts`），
 * 裸 `invoke<T>` 会把信封当数据用。
 */

import { invokeApi } from "../../app_ui/shared/api/call";

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
