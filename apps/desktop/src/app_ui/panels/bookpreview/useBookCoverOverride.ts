/**
 * 单本书的**封面覆盖**读取（面板侧，同步 + 订阅版本号）。
 *
 * 数据由面板**批量**拉取（`bookCoverCache.loadBookCovers`），单元这里只做两件事：
 * 同步读缓存、订阅版本号以便"批量拉回来的那一刻重渲一次"。
 *
 * 与 `useBookMeta` 的差别：那个要按书发命令（所以只在 `epub` 上发），
 * 这个**不发命令**——发命令是面板的事，单元只读已经拉回来的结果。
 */

import { useEffect, useState } from "react";

import {
  coverOverrideOf,
  getBookCoverVersion,
  subscribeBookCovers,
  type BookCoverOverride,
} from "./bookCoverCache";

/** 读取某本书的封面覆盖；没有覆盖返回 `null`。 */
export function useBookCoverOverride(
  repoId: string | null,
  fileId: string,
): BookCoverOverride | null {
  // 版本号入 state：批量拉取落地时重渲一次（缓存是模块级的，本身不触发渲染）。
  const [version, setVersion] = useState(getBookCoverVersion);
  useEffect(() => subscribeBookCovers(() => setVersion(getBookCoverVersion())), []);
  // `version` 只是订阅用的触发器，读值走缓存（`void` 表明这是有意的）。
  void version;
  return coverOverrideOf(repoId, fileId);
}
