/**
 * 全分辨率预览 URL 解析（图像查看器 / 查看器面板**共用**，缺陷 0019）。
 *
 * 后端 `preview.get` 按需生成并缓存**全分辨率 JPEG**（原始尺寸、质量 90，不缩放）；
 * 前端只负责把返回的绝对路径转成 `convertFileSrc` 可用的 asset URL。这里与
 * `thumbUrl.ts` 同款做两件事，两者都是"每张图只做一次"：
 * 1. **结果缓存**（`fileId → url | null`）：面板重建或来回切换时不重复请求；
 * 2. **in-flight 去重**（`fileId → Promise`）：同一张图被多处同时请求时只发一次。
 *
 * ## 什么时候用预览而不是原图（`needsPreview`）
 *
 * WebView2（Chromium）原生可解 AVIF / JPEG / PNG / WebP / GIF / BMP，查看器直接
 * 加载**原图**（`file.path` + `convertFileSrc`，零转码）；HEIC/HEIF 无法原生解码，
 * 必须走后端预览。判断只看扩展名（`heic` / `heif`），大小写不敏感。
 *
 * 缓存是**进程级模块级**的：文件内容变更后旧预览仍会命中，直到重新分析
 * （`file.reanalyze`）刷新后端缓存——与媒体预览面板既有行为一致。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "./api";

/** 需要后端有界预览的扩展名（Chromium `<img>` 无法原生解码的图片）。 */
const PREVIEW_EXTS = ["heic", "heif"];

/** 该文件是否必须走有界预览（按 `relative_path` 扩展名判定，大小写不敏感）。 */
export function needsPreview(relativePath: string): boolean {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return false;
  return PREVIEW_EXTS.includes(relativePath.slice(dot + 1).toLowerCase());
}

/** 已解析的预览 URL；`null` = 后端明确不可用（生成失败 / 非图片）。 */
const previewUrlCache = new Map<string, string | null>();
/** 正在进行的请求（按 fileId 去重）。 */
const previewPromiseCache = new Map<string, Promise<string | null>>();

/**
 * 解析文件**全分辨率预览** URL。
 *
 * 返回 `null` 表示后端没有可用预览（不是异常）：调用方按"不可用"占位渲染。
 * 网络/命令失败同样降级为 `null`，不向界面抛错（预览不是关键路径）。
 */
export function resolvePreviewUrl(repoId: string, fileId: string): Promise<string | null> {
  const cached = previewUrlCache.get(fileId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const inflight = previewPromiseCache.get(fileId);
  if (inflight) {
    return inflight;
  }
  const promise = api
    .previewGet({ repoId, fileId })
    .then((path): string | null => {
      const url = path ? convertFileSrc(path) : null;
      previewUrlCache.set(fileId, url);
      return url;
    })
    .catch((): null => {
      previewUrlCache.set(fileId, null);
      return null;
    })
    .finally(() => {
      previewPromiseCache.delete(fileId);
    });
  previewPromiseCache.set(fileId, promise);
  return promise;
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearPreviewUrlCache(): void {
  previewUrlCache.clear();
  previewPromiseCache.clear();
}
