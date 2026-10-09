/**
 * 一本书的**封面**（三种视图共用的同一块画面）。
 *
 * 结构是"**文字封面打底 + 内嵌封面盖上**"，两个好处：
 * 1. 加载期间（首次要解一次 epub）看到的是这本书的文字封面，不是空白或灰色占位，
 *    也没有布局跳动——图片解码完成后直接盖上去；
 * 2. 图片加载失败（路径失效 / 格式 Chromium 不认）时把图摘掉即可，
 *    自然回落到打底的文字封面，不需要第二套错误态。
 *
 * ## 封面覆盖的优先级（用户 2026-10-09 口径："txt 右键可以更换封面颜色或自定义图片"）
 *
 * 1. **自定义图片**（覆盖 `kind = image`）——直接盖在最上面，压过一切；
 * 2. **自定义颜色**（覆盖 `kind = color`）——文字封面改用该底色，且**压过内嵌封面**：
 *    否则对 `epub` 设颜色将毫无效果（图盖在上面），用户会以为功能坏了；
 * 3. 没有覆盖时：`epub` 用内嵌封面，其余用按作品名派生的文字封面。
 *
 * 尺寸只由 `--bp-cover-size`（面板下发）决定；封面按 `2/3` 的书形框 + `contain`
 * 完整显示（**不裁剪**：裁掉书名是书封最不能接受的一种"好看"）。
 */

import { useState } from "react";

import type { BookCoverOverride } from "./bookCoverCache";
import { BookTextCover } from "./BookTextCover";

export interface BookCoverArtProps {
  /** 作品名（文字封面与 `alt` 用）。 */
  name: string;
  /** 内嵌封面 URL；`null` = 这本书没有内嵌封面。 */
  coverUrl: string | null;
  /** 用户设的封面覆盖；`null` = 没有覆盖（走默认封面）。 */
  override?: BookCoverOverride | null;
}

export function BookCoverArt({
  name,
  coverUrl,
  override = null,
}: BookCoverArtProps): JSX.Element {
  /**
   * **哪一个**图源加载失败了（而不是一个布尔）。
   *
   * 用 src 本身做标记，是因为这本封面有两个可能的图源（自定义图片 / 内嵌封面）：
   * 一个布尔说不清"失败的是哪张"，于是"内嵌封面失败"会误压住"用户设的图片"，
   * 反之亦然。换图源时旧值自然不相等，等于自动重置（不再需要 `useEffect` 清标记）。
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  // 覆盖是**图片**时，它就是这张封面的图源；覆盖是**颜色**时不出图（只换底色）。
  const overrideImage = override?.kind === "image" ? override.value : null;
  // 颜色覆盖压过内嵌封面（见文件头的优先级说明）。
  const embedded = override === null && coverUrl ? coverUrl : null;
  const candidate = overrideImage ?? embedded;
  // 当前候选图源失败过 → 摘掉图，自然回落到打底的文字封面（不需要第二套错误态）。
  const imageSrc = candidate !== null && candidate !== failedSrc ? candidate : null;

  return (
    <div className={`bp-art${imageSrc ? " bp-art-loaded" : ""}`}>
      <BookTextCover
        name={name}
        colorOverride={override?.kind === "color" ? override.value : null}
      />
      {imageSrc && (
        <img
          className="bp-art-img"
          src={imageSrc}
          alt={name}
          // 封面是本地文件、解码很快，但一屏可能几十本：交给浏览器排队即可。
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(imageSrc)}
        />
      )}
    </div>
  );
}
