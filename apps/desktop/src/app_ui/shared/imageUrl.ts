/**
 * 图像 asset URL 解析（图像查看器面板与它的**预加载**共用一份）。
 *
 * 把「一张**图像**该用哪个 URL 显示」这条策略收敛到**一处**，因为它此前在图像查看器
 * 面板里是内联的 `needsPreview(...) ? previewGet(...) : filePath(...)`——加预加载时若再抄
 * 一遍，就成了两份会各自漂移的分支，而且预加载与当前图会各发一次 IPC（HEIC 更糟：
 * 两次全分辨率生成）。
 *
 * > **范围**：本模块只服务**图像**（`media_type = image`）。`ViewerPanel.tsx` 里
 * > 仍有一份同形的内联分支（它还兼管视频/音频的 `filePath`），属**既有**重复，
 * > 本次未动；要收敛时把它一并接过来即可（届时模块名与注释需按"通用显示 URL"改写）。
 *
 * ## 策略（与缺陷 0019 的既定口径一致）
 *
 * | 格式 | 取图方式 | 理由 |
 * | --- | --- | --- |
 * | HEIC / HEIF | 后端 `preview.get`（**全分辨率** JPEG） | WebView2/Chromium 无法原生解码 |
 * | 其余（JPEG/PNG/WebP/AVIF/GIF/BMP…） | `file.path` 直接加载**原图** | 零转码，且能 100% 检视细节 |
 *
 * ## 缓存口径
 *
 * 与 `thumbUrl.ts` / `previewUrl.ts` 同款，两者都是"每张图只做一次"：
 * 1. **结果缓存**（`fileId → outcome`）：换图来回、面板重建、**预加载与当前图**
 *    同时请求，都只发一次 IPC；
 * 2. **in-flight 去重**（`fileId → Promise`）：并发请求合并。
 *
 * 缓存是**进程级模块级**的：文件内容变更后旧 URL 仍会命中，直到重新分析
 * （`file.reanalyze`）刷新后端缓存——与媒体预览面板既有行为一致。
 *
 * ## 为什么不只是 `string | null`
 *
 * 面板需要区分两种失败并给出**不同**的状态提示（既有行为，不能悄悄退化）：
 * - 「不可用」：命令正常返回但没有路径（非图片 / 生成失败）；
 * - 「读取失败」：命令本身报错（要带上 `{err}` 供诊断）。
 *
 * 因此缓存的是 [`ImageUrlOutcome`]（含错误），两个导出分别服务这两类调用方：
 * 面板要诊断细节 → `resolveImageUrlOutcome`；预加载只关心成不成 → `resolveImageUrl`。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "./api";
import { needsPreview, resolvePreviewUrl } from "./previewUrl";

/**
 * 一次 URL 解析的结果。
 *
 * - `url` 非空 = 可直接用于 `<img src>`；
 * - `url === null` 且 `error === null` = **不可用**（命令成功但无路径）；
 * - `url === null` 且 `error !== null` = **读取失败**（命令抛错，`error` 供诊断）。
 */
export interface ImageUrlOutcome {
  url: string | null;
  error: unknown | null;
}

/** 已解析的结果（按 fileId）。 */
const imageUrlCache = new Map<string, ImageUrlOutcome>();
/** 正在进行的请求（按 fileId 去重）。 */
const imagePromiseCache = new Map<string, Promise<ImageUrlOutcome>>();

/**
 * 解析图像显示 URL 的**完整结果**（含失败原因）。
 *
 * 永不抛错：失败一律表达在 `ImageUrlOutcome` 里（预览不是关键路径，
 * 不该让面板因取图失败而崩）。
 */
export function resolveImageUrlOutcome(
  repoId: string,
  fileId: string,
  relativePath: string,
): Promise<ImageUrlOutcome> {
  const cached = imageUrlCache.get(fileId);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = imagePromiseCache.get(fileId);
  if (inflight) return inflight;

  // HEIC/HEIF 复用 `previewUrl.ts` 的缓存与去重（两个入口必须命中**同一份**缓存，
  // 否则预加载与当前图会各生成一次，后端白做一遍全分辨率解码）。
  const promise: Promise<ImageUrlOutcome> = (
    needsPreview(relativePath)
      ? resolvePreviewUrl(repoId, fileId).then((url): ImageUrlOutcome => ({ url, error: null }))
      : api
          .filePath({ repoId, fileId })
          .then((path): ImageUrlOutcome => ({ url: path ? convertFileSrc(path) : null, error: null }))
          .catch((error: unknown): ImageUrlOutcome => ({ url: null, error }))
  )
    .then((outcome) => {
      imageUrlCache.set(fileId, outcome);
      return outcome;
    })
    .finally(() => {
      imagePromiseCache.delete(fileId);
    });

  imagePromiseCache.set(fileId, promise);
  return promise;
}

/**
 * 解析图像显示 URL（便捷形式：只关心能不能用）。
 *
 * `null` = 不可用**或**读取失败；需要区分时用 [`resolveImageUrlOutcome`]。
 * 预加载走这一条（它不报告错误）。
 */
export function resolveImageUrl(
  repoId: string,
  fileId: string,
  relativePath: string,
): Promise<string | null> {
  return resolveImageUrlOutcome(repoId, fileId, relativePath).then((outcome) => outcome.url);
}

/**
 * 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。
 *
 * **不**清 `previewUrl.ts` 的缓存（两者生命周期独立：那份由 `clearPreviewUrlCache` 管）。
 */
export function clearImageUrlCache(): void {
  imageUrlCache.clear();
  imagePromiseCache.clear();
}
