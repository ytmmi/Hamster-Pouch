/**
 * 媒体显示 URL 的**唯一**策略入口：一张图、一段视频、一首歌该用哪个 URL 显示。
 *
 * 这条策略原先分住在图像查看器（`resolveImageUrl` 那一支）与查看器面板（内联的
 * `needsPreview ? previewGet : filePath` 分支，注释里自己都写着「属既有重复，本次未动」），
 * 视频/音频面板则各自把 `api.filePath` + `convertFileSrc` 再抄一遍。只要再加一个
 * 「显示某个文件」的地方，就会多出一份会各自漂移的分支——尤其 HEIC 这类必须走
 * 后端转码的格式，抄漏一处就是一片坏图或一次白做的全分辨率解码。
 *
 * ## 策略（与缺陷 0019 的既定口径一致）
 *
 * | 类型 | 取法 | 理由 |
 * | --- | --- | --- |
 * | 图片 · Chromium 原生可渲染 | `file.path` 直接加载**原图** | 零转码，能 100% 检视细节 |
 * | 图片 · 其余（HEIC/HEIF、TIFF、JPEG 2000、JPEG XL、PSD…） | 后端 `preview.get`（**全分辨率** JPEG） | WebView2/Chromium 渲染不了 |
 * | 视频 / 音频 / 其余 | `file.path` 直接交给 `<video>` / `<audio>` | 播放器自己解码，没有「预览」这一步 |
 *
 * **判据是白名单取反**（见 `./previewUrl` 的 `needsPreview`）：新格式漏项时失败方向是
 * 「多一次后端转码」，而不是「画出一片坏图」。
 *
 * ## 缓存口径
 *
 * 三类结果都按 `repoId + fileId`（图片另带格式与路径）缓存并合并在途请求，机制在
 * `./urlCache`：换图来回、面板重建、**预加载与当前图**同时请求，都只发一次 IPC。
 * 缓存是**进程级模块级**的：文件内容变更后旧 URL 仍会命中，直到重新分析
 * （`file.reanalyze`）刷新后端缓存——与媒体预览面板既有行为一致。
 *
 * ## 为什么还要区分失败
 *
 * 面板需要给出**不同**的状态提示（既有行为，不能悄悄退化）：
 *
 * - 「不可用」：命令正常返回但没有路径（非图片 / 生成失败）；
 * - 「读取失败」：命令本身报错（要带上 `{err}` 供诊断）。
 *
 * 因此 [`resolveMediaUrlOutcome`] 返回 `{ url, error }`；只关心成不成的地方用
 * [`resolveMediaUrl`]，播放器这类需要「失败就抛」的用 [`resolveSourceUrl`]。
 */

import * as api from "./api";
import { assetUrl } from "./assetUrl";
import { needsPreview, resolvePreviewUrl } from "./previewUrl";
import { createUrlResolver } from "./urlCache";

/**
 * 一次 URL 解析的结果。
 *
 * - `url` 非空 = 可直接用于 `<img src>` / `<video src>`；
 * - `url === null` 且 `error === null` = **不可用**（命令成功但无路径）；
 * - `url === null` 且 `error !== null` = **读取失败**（命令抛错，`error` 供诊断）。
 */
export interface MediaUrlOutcome {
  url: string | null;
  error: unknown | null;
}

/**
 * 直接播放用的源 URL（视频/音频，以及元数据探针这类要拿**原文件**的场合）。
 *
 * 失败会**抛错**且不缓存（调用方要按「读不到文件」报错或静默降级），成功按
 * `repoId + fileId` 复用——同一个文件反复打开只发一次 `file.path`。
 */
const sourceUrls = createUrlResolver<[string, string], string>(
  (repoId, fileId) => `${repoId}/${fileId}`,
  (repoId, fileId) => api.filePath({ repoId, fileId }).then(assetUrl),
);

/** 解析可直接播放/探测的源 URL（失败抛错）。 */
export function resolveSourceUrl(repoId: string, fileId: string): Promise<string> {
  return sourceUrls.resolve(repoId, fileId);
}

const mediaUrls = createUrlResolver<[string, string, string, string], MediaUrlOutcome>(
  (repoId, fileId, relativePath, mediaType) => [repoId, fileId, mediaType, relativePath].join("\u0000"),
  async (repoId, fileId, relativePath, mediaType): Promise<MediaUrlOutcome> => {
    if (mediaType === "image" && needsPreview(relativePath)) {
      // 需要后端转码的格式：复用 `previewUrl` 的缓存与去重，预加载与当前图命中**同一份**，
      // 否则两边各生成一次，后端白做一遍全分辨率解码。
      return { url: await resolvePreviewUrl(repoId, fileId), error: null };
    }
    try {
      return { url: await resolveSourceUrl(repoId, fileId), error: null };
    } catch (error) {
      return { url: null, error };
    }
  },
);

/**
 * 解析某个文件的显示 URL 的**完整结果**（含失败原因）。
 *
 * `mediaType` 缺省按 `"image"`：图像查看器与预加载只服务图片，省得每处都写第四个参数。
 * 非图片类型（视频/音频）不会走 `needsPreview`——`preview.get` 对它们一律返回 `null`，
 * 拿去判视频会把「能播的视频」变成「不可用」。
 *
 * 永不抛错：失败一律表达在 [`MediaUrlOutcome`] 里（取图不是关键路径，不该让面板因此崩）。
 */
export function resolveMediaUrlOutcome(
  repoId: string,
  fileId: string,
  relativePath: string,
  mediaType: string = "image",
): Promise<MediaUrlOutcome> {
  return mediaUrls.resolve(repoId, fileId, relativePath, mediaType);
}

/**
 * 解析显示 URL（便捷形式：只关心能不能用）。
 *
 * `null` = 不可用**或**读取失败；需要区分时用 [`resolveMediaUrlOutcome`]。
 */
export function resolveMediaUrl(
  repoId: string,
  fileId: string,
  relativePath: string,
  mediaType: string = "image",
): Promise<string | null> {
  return resolveMediaUrlOutcome(repoId, fileId, relativePath, mediaType).then((outcome) => outcome.url);
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearMediaUrlCache(): void {
  mediaUrls.clear();
  sourceUrls.clear();
}
