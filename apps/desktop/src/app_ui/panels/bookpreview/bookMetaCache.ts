/**
 * 图书元数据的**模块级缓存 + in-flight 去重**（与 `shared/thumbUrl.ts` 同一套形状）。
 *
 * 三件事，每件事都只在"每本书第一次显示"时发生一次：
 * 1. 结果缓存（`fileId → 结果 | null`）；
 * 2. in-flight 去重（同一本书被两个视图/两次渲染同时请求时只发一次命令）；
 * 3. 封面路径 → asset URL 的转换（`convertFileSrc` 只在这里做一次）。
 *
 * **只对需要封面的书发命令**（`usesEmbeddedCover`）：`txt` / `md` 没有元数据，
 * 为它们各发一次 IPC 是纯浪费——那是面板端就能判定的事，不该让后端白跑一趟。
 * **PDF 走这条**：它的封面是第一页栅格化出来的（后端 `hp-pdf`），
 * 与 EPUB 的内嵌封面在前端**没有区别**——都是一张落到盘上的图。
 *
 * 缓存是**进程级**的：文件内容变了旧值仍会命中，直到重新分析（`file.reanalyze`）
 * ——与缩略图缓存同口径（见 `thumbUrl.ts` 的说明）。
 */


import * as api from "../../shared/api";
import { assetUrlOrNull } from "../../shared/assetUrl";
import { createUrlResolver } from "../../shared/urlCache";

/** 面板只需用到的三样（封面已转成 asset URL）。 */
export interface BookDisplayMeta {
  author: string | null;
  description: string | null;
  /** 可直接放进 `<img src>`；`null` = 这本书没有内嵌封面。 */
  coverUrl: string | null;
}

/** 无元数据（`txt` / 解析失败）时的统一取值。 */
const EMPTY_META: BookDisplayMeta = { author: null, description: null, coverUrl: null };

/**
 * 键是 `repoId/fileId`；读不到元数据时**降级为 `EMPTY_META` 并缓存**——一本书没有
 * 元数据不该让面板进错误态（按文字封面渲染），也不必每次重试。
 *
 * 「命中 / 合并在途 / 落缓存 / 清空」由 `../../shared/urlCache` 的骨架负责（D208）。
 */
const metas = createUrlResolver<[string, string], BookDisplayMeta>(
  (repoId, fileId) => `${repoId}/${fileId}`,
  (repoId, fileId) =>
    api
      .bookMeta({ repoId, fileId })
      .then(
        (result): BookDisplayMeta => ({
          author: result.author,
          description: result.description,
          coverUrl: assetUrlOrNull(result.cover_path),
        }),
      )
      .catch((): BookDisplayMeta => EMPTY_META),
);

/** 读取一本书的元数据（带缓存与去重）；任何失败都降级为"没有元数据"。 */
export function loadBookMeta(repoId: string, fileId: string): Promise<BookDisplayMeta> {
  return metas.resolve(repoId, fileId);
}

/** 清空缓存（仓库切换后旧 fileId 恒失效；目前仅供诊断与测试使用）。 */
export function clearBookMetaCache(): void {
  metas.clear();
}
