/**
 * 单本书的元数据读取（面板侧）：**只有需要内嵌封面的书才会发命令**。
 *
 * 判定走纯函数 `usesEmbeddedCover`（子类型 `book` / 旧行按扩展名兜底）；
 * `txt` / `md` 直接返回 `null`，一个 IPC 都不发。命令的结果由
 * `bookMetaCache` 做进程级缓存与 in-flight 去重，因此"卡片模式 + 封面模式"
 * 同时显示同一本书时也只取一次。
 */

import { useEffect, useState } from "react";

import type { FileItem } from "../../shared/types";
import { loadBookMeta, type BookDisplayMeta } from "./bookMetaCache";
import { usesEmbeddedCover } from "./bookPreviewView";

/** 读取并缓存一本书的展示用元数据；不需要内嵌封面时恒为 `null`。 */
export function useBookMeta(repoId: string | null, item: FileItem): BookDisplayMeta | null {
  const [meta, setMeta] = useState<BookDisplayMeta | null>(null);
  const wants = usesEmbeddedCover(item);

  useEffect(() => {
    if (!repoId || !wants) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    void loadBookMeta(repoId, item.id).then((loaded) => {
      if (!cancelled) setMeta(loaded);
    });
    return () => {
      cancelled = true;
    };
    // 依赖用"能改变判定结果的字段"而不是整个 `item`：条目对象每次取数都会重建。
  }, [repoId, wants, item.id]);

  return meta;
}
