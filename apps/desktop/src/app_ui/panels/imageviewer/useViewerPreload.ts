/**
 * 图像查看器：**相邻图像预加载**。
 *
 * 取哪些邻居、取多少由纯函数 `viewerPreload.ts` 决定（门禁直接断言），
 * 本文件只负责"取"这件事的三段成本：
 *
 * | 段 | 手段 | 谁受益 |
 * | --- | --- | --- |
 * | 解析 URL（IPC） | `shared/imageUrl.ts` 的结果缓存 + in-flight 去重 | 全部格式 |
 * | **后端生成**预览 | `resolveImageUrl` 内部触发 `preview.get` | HEIC/HEIF（实测 102 MP 需 0.8 s） |
 * | 读盘 + 解码 | `new Image()` 预热浏览器图像缓存 | JPEG/PNG 等原图 |
 *
 * ## 三条边界（都不是可选项）
 *
 * 1. **面板不在前台就不预加载**：dockview 会把后台标签留在 DOM 里，隐藏时预加载
 *    纯属浪费（用户看不到，还占磁盘与内存）。判据用 `usePanelForeground`
 *    （只看 `isVisible`，理由见该文件）。
 * 2. **大图只"解析 + 生成"，不"解码预热"**：解码后的位图按**像素**占内存
 *    （100 MP ≈ 400 MB），而索引里没有图片尺寸（`media_info_json` 只覆盖视频），
 *    只能用**字节数**当代理。超过 `PRELOAD_DECODE_MAX_BYTES` 的文件仍会触发后端
 *    生成（HEIC 的主要成本在那里，且落盘后换图即秒开），但**不**用 `new Image()`
 *    把解码位图留在内存里——宁可换图时多一次解码，也不把内存吃光。
 * 3. **同一张只预热一次**（`warmedRef`）：避免每次渲染/每次 `files` 换身份都重造
 *    `Image` 对象。序列本身变了（换相册/换源）才重置。
 */

import { useEffect, useRef } from "react";

import { resolveImageUrl } from "../../shared/imageUrl";
import type { FileItem } from "../../shared/types";
import { preloadTargets } from "./viewerPreload";

/**
 * 参与"解码预热"的**文件字节**上限（64 MiB）。
 *
 * 这是内存护栏，不是功能开关：超过它的图像照样解析 URL 并触发后端预览生成，
 * 只是不把解码结果预先留在浏览器里。取 64 MiB 是因为它已覆盖绝大多数相机原图
 * （典型 20–40 MP JPEG 在 5–20 MiB），同时把"几张超大图同时驻留"的风险挡在门外。
 */
export const PRELOAD_DECODE_MAX_BYTES = 64 * 1024 * 1024;

export interface ViewerPreloadOptions {
  /** 是否允许预加载（面板在前台 + 有仓库）。`false` 时立即停止并清空预热记录。 */
  enabled: boolean;
  repoId: string | null;
  /** 当前浏览序列（与胶片栏同一份，顺序即换图顺序）。 */
  files: readonly FileItem[];
  /** 当前项在 `files` 中的下标；`-1` = 不在序列内（不预加载）。 */
  index: number;
  /** 预加载半径（已由面板夹紧；`0` = 关闭）。 */
  radius: number;
}

/**
 * 预加载当前项的相邻图像。
 *
 * 无返回值：这是纯副作用（缓存预热），结果由后续真实加载受益，
 * 期间**不**改任何可见状态、**不**报错（预加载失败对用户不可见，也不该打扰）。
 */
export function useViewerPreload({
  enabled,
  repoId,
  files,
  index,
  radius,
}: ViewerPreloadOptions): void {
  /** 已预热过的 fileId（避免重复造 `Image`；换序列时清空）。 */
  const warmedRef = useRef<Set<string>>(new Set());
  /** 上一次看到的序列身份（`files` 数组换身份即视为换序列）。 */
  const filesRef = useRef<readonly FileItem[] | null>(null);

  useEffect(() => {
    if (!enabled || !repoId) {
      // 关掉时一并清空记录：再次开启（切回前台）应当重新评估，而不是
      // 因为"曾经预热过"而跳过——期间的设置/序列可能已经变了。
      warmedRef.current.clear();
      filesRef.current = null;
      return;
    }
    if (filesRef.current !== files) {
      filesRef.current = files;
      warmedRef.current.clear();
    }

    const targets = preloadTargets(index, files.length, radius);
    if (targets.length === 0) return;

    for (const position of targets) {
      const file = files[position];
      if (!file || file.media_type !== "image") continue;
      if (warmedRef.current.has(file.id)) continue;
      // **先登记、再取**：`warmedRef` 是"已安排过"而不是"已完成"，
      // 因此重跑本 effect 不会对同一张重复安排。
      warmedRef.current.add(file.id);

      // 解析 URL：HEIC/HEIF 会在这一步触发后端**全分辨率生成**（缓存命中即秒回），
      // 其余格式只是一次 `file.path`。失败降级为 `null`，此处静默忽略。
      void resolveImageUrl(repoId, file.id, file.relative_path).then((url) => {
        if (!url) return;
        // 大图只到"生成/解析"为止（见文件头第 2 条边界）。
        if (file.size > PRELOAD_DECODE_MAX_BYTES) return;
        const image = new Image();
        // 异步解码：不阻塞主线程，也不与当前图的渲染抢帧。
        image.decoding = "async";
        image.src = url;
        // 不持有引用：解码结果交由浏览器图像缓存管理（内存压力下可被回收）。
      });
    }
    // **刻意没有"effect 重跑就取消在途预热"的清理**：本 effect 只创建 `Image`
    // 对象、不改任何状态，因此取消既不能避免"卸载后 setState"，也没有别的好处；
    // 反而会**丢掉刚登记过的那几张的解码预热**——它们在 `warmedRef` 里已被标记，
    // 于是永远不会重试（表现为"预加载登记了却没预热"）。在途预热是有界且幂等的
    // （每张图一次、URL 解析已去重），让它跑完即可。
  }, [enabled, repoId, files, index, radius]);
}
