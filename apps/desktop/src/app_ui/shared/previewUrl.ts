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
 * 判据是**白名单取反**：只列出 WebView2（Chromium）**原生渲染得了**的格式，
 * 其余一律走后端预览。取反而不是列黑名单，是**故意的失败方向**——
 * 新格式默认落到"多一次后端转码"，而不是"画出一个坏图占位"。
 *
 * > **2026-10-11 改白名单取反**：此前是黑名单（只列 `heic` / `heif`）。扩容图片格式
 * > 后黑名单会**静默漏项**：扫描器新收的 `jp2` / `jxl` / `psd` / `pcx` / `tga` /
 * > `dds` / `exr` / `qoi` / `pnm` 家族等 Chromium 一律渲染不了，漏一个就是一片坏图；
 * > 而白名单漏一个只是"本来能直接显示的格式多走一次后端"，两者代价不对称。
 * > 白名单本身很小且**极稳定**（Chromium 支持的图片格式多年未变），维护成本更低。
 *
 * `tiff` / `tif` 同样在这里（Chromium 不支持 TIFF）：此前靠"先加载原图 → `onError`
 * 回退预览"兜底，现在直接走预览，省掉一次必然失败的加载。
 *
 * 判断只看扩展名，大小写不敏感。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "./api";

/**
 * Chromium `<img>` **原生渲染得了**的图片扩展名（白名单）。
 *
 * 只收实测能在 WebView2 里直接显示的格式：JPEG / PNG（含 APNG）/ GIF / WebP /
 * AVIF / BMP / ICO / SVG。**其余一律走后端预览**——包括 **SVGZ**（gzip 压缩的
 * SVG，Chromium **不**原生渲染，后端 `preview.get` 会解压 + 栅格化成 JPEG）、
 * TIFF、HEIC/HEIF，以及 `hp-scanner` 2026-10-11 新收的 JPEG 2000 / JPEG XL / PSD /
 * PCX / SGI / Sun Raster / DPX / FITS / WBMP / XBM / XPM / JPEG-LS / PFM / DIB / TGA /
 * DDS / EXR / HDR / QOI / farbfeld / Netpbm 家族。
 *
 * > **SVG 与 SVGZ 必须分开**（D112）：两者都是矢量，但 Chromium 只认 `image/svg+xml`
 * > 的**未压缩**形式（`<img src>` 直接解析 XML）。`svgz` 是 gzip 流，浏览器拿到的是
 * > 二进制而非 XML → 画不出来。因此 `svg` 进白名单、`svgz` 不进——
 * > 漏一个方向就会变成"SVGZ 一片空白"（白名单取反的失败方向是"多走一次后端"）。
 */
const NATIVE_RENDER_EXTS = [
  "jpg",
  "jpeg",
  "jfif",
  "png",
  "apng",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
];

/**
 * 该文件是否必须走后端预览（按 `relative_path` 扩展名判定，大小写不敏感）。
 *
 * **取反口径**：不在白名单里（含没有扩展名）→ 需要预览。
 */
export function needsPreview(relativePath: string): boolean {
  const dot = relativePath.lastIndexOf(".");
  if (dot < 0) return true;
  return !NATIVE_RENDER_EXTS.includes(relativePath.slice(dot + 1).toLowerCase());
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
