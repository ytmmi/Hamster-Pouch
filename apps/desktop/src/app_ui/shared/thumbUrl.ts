/**
 * 缩略图 URL 解析（媒体预览面板与图像查看器**共用**）。
 *
 * 后端 `thumb.get` 按需生成并缓存缩略图；前端只负责把返回的绝对路径转成
 * asset URL（`./assetUrl`，全仓唯一一处 `convertFileSrc`）。这里做两件事，两者都是
 * "每张图每档只做一次"：
 *
 * 1. **结果缓存**（`fileId@档 ← url | null`）：面板重建或胶片栏来回滚动时不重复请求；
 * 2. **in-flight 去重**（同一个键 → Promise）：同一张图被多个单元同时请求时只发一次。
 *
 * 两件事都由 `./urlCache` 的骨架负责（D208）——本文件只提供「键怎么拼」与「失败怎么
 * 表达」（缩略图不是关键路径：失败一律降级成 `null`，并且会被缓存，不反复重试）。
 *
 * **缓存键带分辨率档**（缺陷 0046）：媒体预览的"图片宽度"可以放大，缩略图随之
 * 请求更高一档；只按 fileId 缓存会让放大后的单元一直复用第一档的糊图。
 * 档梯见 `./thumbSize`（与后端 `IMAGE_THUMB_DIM_LADDER` 同源）。
 *
 * 缓存是**进程级模块级**的：文件内容变更后旧缩略图仍会命中，直到重新分析
 * （`file.reanalyze`）刷新后端缓存。这与媒体预览面板既有行为一致。
 */

import * as api from "./api";
import { assetUrlOrNull } from "./assetUrl";
import { THUMB_DIM_BASE, thumbBucket, thumbCacheKey } from "./thumbSize";
import { createUrlResolver } from "./urlCache";

/** 键是「fileId@档」，结果是换好的 asset URL；`null` = 后端明确不可用（无缩略图）。 */
const thumbUrls = createUrlResolver<[string, string, number], string | null>(
  (_repoId, fileId, size) => thumbCacheKey(fileId, thumbBucket(size)),
  (repoId, fileId, size) =>
    api
      .thumbGet({ repoId, fileId, size: thumbBucket(size) })
      .then((path): string | null => assetUrlOrNull(path))
      .catch((): null => null),
);

/**
 * 解析文件缩略图 URL。
 *
 * `size` 是该单元**实际需要的设备像素长边**（图片宽度 × 视图倍率 × DPR）；
 * 省略表示"不知道该多大"，按首档（旧口径 320）请求 —— 图像查看器胶片栏、
 * 音频波形图这类单尺寸用途就该走缺省档。
 *
 * 返回 `null` 表示后端没有可用缩略图（不是异常）：调用方按"不可用"占位渲染。
 * 网络/命令失败同样降级为 `null`，不向界面抛错（缩略图不是关键路径）。
 */
export function resolveThumbUrl(
  repoId: string,
  fileId: string,
  size: number = THUMB_DIM_BASE,
): Promise<string | null> {
  return thumbUrls.resolve(repoId, fileId, size);
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearThumbUrlCache(): void {
  thumbUrls.clear();
}
