/**
 * M4：色彩参考命令封装（仅图片，D18）。
 *
 * **D76 迁移状态：已包装**（批次 `repo/layout/color`，2026-09）。
 */

import { invokeApi } from "./call";

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
