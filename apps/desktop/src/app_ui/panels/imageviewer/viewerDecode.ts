/**
 * 图像查看器：换图前的**解码**（把"浏览器解码这张图"的成本挪到换图之前）。
 *
 * ## 为什么需要它（缺陷 0028）
 *
 * 换图链路的耗时大头是**浏览器解码**（实测 1648×3664 的 JPEG 在 WebView 里约
 * 200–400 ms）。原实现是"先把 `<img>` 换成新 URL，再等 `onLoad`"——于是这段时间里
 * DOM 里挂着一张**还没有位图**的图：
 *
 * - 画面可能先停在**上一张**（合成器保留旧图层）或闪成**空白**（旧元素被卸载/新图层无内容）；
 * - 旧图层若被复用，其光栅会被拉伸到新盒子上（"从上一张的大小拉伸到当前的大小"）；
 * - 尺寸只能等 `onLoad` 才知道，于是"换图那一帧"永远要事后补救。
 *
 * 先解码则相反：**解码完成后再把 url 与尺寸一起换掉**，换图只发生**一帧**，
 * 且那一帧里新图的位图已就绪、几何已知——上面三种形态在结构上都不可能出现。
 *
 * 本模块碰 DOM（`new Image()`），因此**不是**纯逻辑模块：几何与判据仍在
 * `viewerZoom.ts`，这里只负责"要一个尺寸，或者给不出"。
 */

import type { Size } from "./viewerZoom";

/**
 * 预解码 `url` 并返回原图像素尺寸。
 *
 * - 成功 → `{ width, height }`（调用方据此**同批**设置 url 与尺寸）；
 * - 失败 / 超时 → `null`（调用方退回"先挂载、等 `onLoad`"的老路——那条路上
 *   `.iv-image-pending` 兜底，且**不写入错误的几何**）。
 *
 * 超时不是"取消解码"（浏览器继续解，缓存照样热）：只是**不无限期地把画面卡在上一张**。
 */
export async function decodeImageSize(url: string, timeoutMs = 10000): Promise<Size | null> {
  try {
    const probe = new Image();
    // 需要的是"解码完成"而不是"取到字节"，故用 decode()；decoding 提示同步解码。
    probe.decoding = "sync";
    probe.src = url;
    const decoded = probe.decode();
    if (timeoutMs > 0) {
      await Promise.race([
        decoded,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } else {
      await decoded;
    }
    if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
      return { width: probe.naturalWidth, height: probe.naturalHeight };
    }
    return null;
  } catch {
    // 解码失败（格式不支持等）：交给调用方的兜底路径，不在本模块里重试。
    return null;
  }
}
