/**
 * 图书阅读器：左栏**栏头**的身份信息（封面 / 作者 / 用户自设的封面覆盖）。
 *
 * ## 为什么与 `useReaderBook` 分开
 *
 * `useReaderBook` 取的是**正文与目录**（换书即整段丢弃），栏头要的是**这本书长什么样**。
 * 两者失败面完全不同：正文读不出是"这本书打不开"，封面读不出只是"栏头回到文字封面"
 * ——混在一个 hook 里会让"封面失败"有机会把阅读区一起带进错误态。
 *
 * ## 为什么复用图书预览（`panels/bookpreview/`）的三件东西
 *
 * 栏头与图书预览**必须是同一张封面**，否则同一本书在两个面板里长得不一样：
 *
 * 1. `usesEmbeddedCover`：判据（book 标记）与图书预览逐字一致，`txt` / `md` 因此
 *    **一次 IPC 都不发**（它们本来就没有内嵌封面，栏头直接用文字封面）；
 * 2. `loadBookMeta`：进程级缓存 + in-flight 去重，把封面路径转成 asset URL 也只做一次；
 * 3. `loadBookCovers` / `useBookCoverOverride`：用户右键设过的封面（颜色 / 图片）
 *    **压过**内嵌封面（与 `BookCoverArt` 的优先级一致），并且订阅缓存版本号——
 *    在图书预览里改封面后，这边会跟着变。
 *
 * 渲染同样复用 `BookCoverArt`（"文字封面打底 + 封面图盖上"）：加载期间看到的是文字封面，
 * 图片失败自动回落，没有第二套错误态。
 *
 * ## 没有选中文件时
 *
 * `item` 为 `null`（面板刚打开、或选中的是别的类型）：不发任何命令，返回全 `null`，
 * 栏头由调用方决定**整块不渲染**（显示一个没有书名、没有封面的空壳没有意义）。
 */

import { useEffect, useState } from "react";

import type { FileItem } from "../../shared/types";
import { loadBookCovers, type BookCoverOverride } from "../bookpreview/bookCoverCache";
import { loadBookMeta, type BookDisplayMeta } from "../bookpreview/bookMetaCache";
import { usesEmbeddedCover } from "../bookpreview/bookPreviewView";
import { useBookCoverOverride } from "../bookpreview/useBookCoverOverride";

/** 栏头要用的三样（都已转成可直接渲染的形式）。 */
export interface ReaderBookIdentity {
  /** 作者（EPUB `<dc:creator>` / PDF `/Author`）；`null` = 没有或读不出。 */
  author: string | null;
  /** 内嵌 / 渲染出来的封面 URL；`null` = 这本书没有封面（用文字封面）。 */
  coverUrl: string | null;
  /** 用户自设的封面覆盖（颜色 / 图片）；`null` = 没有覆盖。 */
  override: BookCoverOverride | null;
}

/** 读取当前这本书的栏头信息（换书自动重取）。 */
export function useReaderBookIdentity(
  repoId: string | null,
  item: FileItem | null,
): ReaderBookIdentity {
  const fileId = item?.id ?? null;
  // 与图书预览同一条判据：`txt` / `md` 不取元数据（省一次后端往返）。
  const wantsCover = item !== null && usesEmbeddedCover(item);
  const [meta, setMeta] = useState<BookDisplayMeta | null>(null);

  useEffect(() => {
    if (!repoId || !fileId || !wantsCover) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    void loadBookMeta(repoId, fileId).then((loaded) => {
      if (!cancelled) setMeta(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [repoId, fileId, wantsCover]);

  // 封面覆盖：批量命令的**单元素**用法（结果进图书预览那份模块级缓存，栏头同步读）。
  // 任何一本都可能被用户设过封面，因此这里不按扩展名筛。
  useEffect(() => {
    if (!repoId || !fileId) return;
    void loadBookCovers(repoId, [fileId]);
  }, [repoId, fileId]);

  const override = useBookCoverOverride(repoId, fileId ?? "");

  return { author: meta?.author ?? null, coverUrl: meta?.coverUrl ?? null, override };
}
