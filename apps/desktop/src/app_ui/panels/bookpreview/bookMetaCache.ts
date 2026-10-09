/**
 * 图书元数据的**模块级缓存 + in-flight 去重**（与 `shared/thumbUrl.ts` 同一套形状）。
 *
 * 三件事，每件事都只在"每本书第一次显示"时发生一次：
 * 1. 结果缓存（`fileId → 结果 | null`）；
 * 2. in-flight 去重（同一本书被两个视图/两次渲染同时请求时只发一次命令）；
 * 3. 封面路径 → asset URL 的转换（`convertFileSrc` 只在这里做一次）。
 *
 * **只对需要内嵌封面的书发命令**（`usesEmbeddedCover`）：`txt` / `md` 没有元数据，
 * 为它们各发一次 IPC 是纯浪费——那是面板端就能判定的事，不该让后端白跑一趟。
 *
 * 缓存是**进程级**的：文件内容变了旧值仍会命中，直到重新分析（`file.reanalyze`）
 * ——与缩略图缓存同口径（见 `thumbUrl.ts` 的说明）。
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import * as api from "../../shared/api";

/** 面板只需用到的三样（封面已转成 asset URL）。 */
export interface BookDisplayMeta {
  author: string | null;
  description: string | null;
  /** 可直接放进 `<img src>`；`null` = 这本书没有内嵌封面。 */
  coverUrl: string | null;
}

/** 无元数据（`txt` / 解析失败）时的统一取值。 */
const EMPTY_META: BookDisplayMeta = { author: null, description: null, coverUrl: null };

const metaCache = new Map<string, BookDisplayMeta>();
const inflight = new Map<string, Promise<BookDisplayMeta>>();

/** 读取一本书的元数据（带缓存与去重）；任何失败都降级为"没有元数据"。 */
export function loadBookMeta(repoId: string, fileId: string): Promise<BookDisplayMeta> {
  const cached = metaCache.get(fileId);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(fileId);
  if (pending) return pending;

  const promise = api
    .bookMeta({ repoId, fileId })
    .then((result): BookDisplayMeta => {
      const meta: BookDisplayMeta = {
        author: result.author,
        description: result.description,
        coverUrl: result.cover_path ? convertFileSrc(result.cover_path) : null,
      };
      metaCache.set(fileId, meta);
      return meta;
    })
    .catch((): BookDisplayMeta => {
      // 一本书的元数据读不到不该让面板进错误态：按"没有元数据"渲染（文字封面）。
      metaCache.set(fileId, EMPTY_META);
      return EMPTY_META;
    })
    .finally(() => {
      inflight.delete(fileId);
    });

  inflight.set(fileId, promise);
  return promise;
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearBookMetaCache(): void {
  metaCache.clear();
  inflight.clear();
}
