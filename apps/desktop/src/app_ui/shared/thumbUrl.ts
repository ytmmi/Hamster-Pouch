/**
 * 缩略图 URL 解析（媒体预览面板与图像查看器**共用**）。
 *
 * 后端 `thumb.get` 按需生成并缓存缩略图；前端只负责把返回的绝对路径转成
 * `convertFileSrc` 可用的 asset URL。这里做两件事，两者都是"每张图只做一次"：
 *
 * 1. **结果缓存**（`fileId → url | null`）：面板重建或胶片栏来回滚动时不重复请求；
 * 2. **in-flight 去重**（`fileId → Promise`）：同一张图被多个单元同时请求时只发一次。
 *
 * 缓存是**进程级模块级**的：文件内容变更后旧缩略图仍会命中，直到重新分析
 * （`file.reanalyze`）刷新后端缓存。这与媒体预览面板既有行为一致。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "./api";

/** 已解析的缩略图 URL；`null` = 后端明确不可用（无缩略图）。 */
const thumbUrlCache = new Map<string, string | null>();
/** 正在进行的请求（按 fileId 去重）。 */
const thumbPromiseCache = new Map<string, Promise<string | null>>();

/**
 * 解析文件缩略图 URL。
 *
 * 返回 `null` 表示后端没有可用缩略图（不是异常）：调用方按"不可用"占位渲染。
 * 网络/命令失败同样降级为 `null`，不向界面抛错（缩略图不是关键路径）。
 */
export function resolveThumbUrl(repoId: string, fileId: string): Promise<string | null> {
  const cached = thumbUrlCache.get(fileId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const inflight = thumbPromiseCache.get(fileId);
  if (inflight) {
    return inflight;
  }
  const promise = api
    .thumbGet({ repoId, fileId })
    .then((path): string | null => {
      const url = path ? convertFileSrc(path) : null;
      thumbUrlCache.set(fileId, url);
      return url;
    })
    .catch((): null => {
      thumbUrlCache.set(fileId, null);
      return null;
    })
    .finally(() => {
      thumbPromiseCache.delete(fileId);
    });
  thumbPromiseCache.set(fileId, promise);
  return promise;
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearThumbUrlCache(): void {
  thumbUrlCache.clear();
  thumbPromiseCache.clear();
}
