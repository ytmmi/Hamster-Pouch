/**
 * 一本书的**封面**（两种视图共用的同一块画面）。
 *
 * 结构是"**文字封面打底 + 内嵌封面盖上**"，两个好处：
 * 1. 加载期间（首次要解一次 epub）看到的是这本书的文字封面，不是空白或灰色占位，
 *    也没有布局跳动——图片解码完成后直接盖上去；
 * 2. 图片加载失败（路径失效 / 格式 Chromium 不认）时把图摘掉即可，
 *    自然回落到打底的文字封面，不需要第二套错误态。
 *
 * 尺寸只由 `--bp-cover-size`（面板下发）决定；封面按 `2/3` 的书形框 + `contain`
 * 完整显示（**不裁剪**：裁掉书名是书封最不能接受的一种"好看"）。
 */

import { useEffect, useState } from "react";

import { BookTextCover } from "./BookTextCover";

export interface BookCoverArtProps {
  /** 作品名（文字封面与 `alt` 用）。 */
  name: string;
  /** 内嵌封面 URL；`null` = 这本书没有内嵌封面。 */
  coverUrl: string | null;
}

export function BookCoverArt({ name, coverUrl }: BookCoverArtProps): JSX.Element {
  const [failed, setFailed] = useState(false);

  // 换书（URL 变化）时重置失败标记，否则上一本的失败会把这一本的封面也压住。
  useEffect(() => {
    setFailed(false);
  }, [coverUrl]);

  const showImage = Boolean(coverUrl) && !failed;
  return (
    <div className="bp-art">
      <BookTextCover name={name} />
      {showImage && (
        <img
          className="bp-art-img"
          src={coverUrl ?? ""}
          alt={name}
          // 封面是本地文件、解码很快，但一屏可能几十本：交给浏览器排队即可。
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
