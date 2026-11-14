/**
 * test_ui M4：色彩参考命令封装（仅图片）。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。调用统一走 `invokeApi`（`app_ui/shared/api/call.ts`），
 * 裸 `invoke<T>` 会把信封当数据用。
 */

import { invokeApi } from "../../app_ui/shared/api/call";

import type { ColorExtractArgs, ColorGetArgs, ColorSetArgs } from "../types";

/** 读取文件色彩参考 */
export function colorGet(args: ColorGetArgs): Promise<string | null> {
  return invokeApi<string | null>("color_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 手动设置文件色彩参考 */
export function colorSet(args: ColorSetArgs): Promise<void> {
  return invokeApi<void>("color_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    colorJson: args.colorJson,
  });
}

/** 提取图片调色板（后台执行，返回 taskId） */
export function colorExtract(args: ColorExtractArgs): Promise<string> {
  return invokeApi<string>("color_extract", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}
