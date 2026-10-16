/**
 * 图书阅读器：**阅读批注**（书签 / 笔记 / 高亮）的取数与增删。
 *
 * 三者是同一件事的三种形态（见 `hp_core::annotation` 的模块文档），因此只有一份
 * 取数与一份删除；新建时用 `kind` 区分。落库在仓库库的 `reader_annotations`
 * （迁移 0011），按 `file_id` 存——重扫 / 重新分析都不会让批注丢失。
 *
 * ## 位置口径与跳转
 *
 * 每条批注的 `cursor` 与 `book.content` 的游标**同语义**，因此"点批注跳回去"就是把
 * 它原样交给 `reader.jumpTo`（进而交给 `book.content`）——前端**不做换算**
 * （与目录项同一条口径，D113 ④）。
 *
 * ## 换书即重取
 *
 * 依赖只看 `repoId` + `fileId`：`app` 在每次选中变化时都会换身份，把它放进依赖会让
 * "点一下别处"就重跑一次查询。取数世代号负责丢弃换书后晚到的旧响应。
 *
 * ## 新增后**回读**而不是本地拼装
 *
 * `id` / `created_at` 由后端生成（UUID 与 ISO 时间）。本地拼一条假的再合并，
 * 会出现"界面上的 id 与库里的不一致"——紧接着的删除就会失败。
 * 因此新增成功后**重新列一次**（一本书的批注量是几十条量级，一次查询足够便宜）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { useApp } from "../../core/AppContext";
import type { ReaderAnnotationItem, ReaderAnnotationKind } from "../../shared/types";

/** 新建一条批注要提供的内容（位置与进度由调用方从当前阅读状态取）。 */
export interface AnnotationDraft {
  kind: ReaderAnnotationKind;
  /** 位置游标（与 `book.content` 同语义）。 */
  cursor: string;
  /** 保存时的阅读进度（0–10000）。 */
  progress: number;
  /** 位置标题（章节名 / 目录项）；取不到给空串。 */
  title: string;
  /** 高亮的选中原文快照；书签 / 笔记给空串。 */
  excerpt: string;
  /** 笔记正文 / 高亮的批注；书签给空串。 */
  note: string;
}

/** 批注的取数与增删句柄。 */
export interface ReaderAnnotationsHandle {
  /** 全部批注（按创建时间升序，后端保证）。 */
  items: ReaderAnnotationItem[];
  loading: boolean;
  /** 上一次操作的失败原因（已翻译）；`null` = 没有失败。 */
  error: string | null;
  /** 新建一条；成功返回 `true`（调用方据此清空输入框）。 */
  add: (draft: AnnotationDraft) => Promise<boolean>;
  /** 删除一条（按 id；幂等）。 */
  remove: (id: string) => Promise<void>;
  /** 重新列一次（外部改动后手动刷新用）。 */
  reload: () => void;
}

export function useReaderAnnotations(): ReaderAnnotationsHandle {
  const app = useApp();
  const repoId = app.repoId;
  const fileId = app.selectedFile?.id ?? null;

  const [items, setItems] = useState<ReaderAnnotationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 取数世代号：换书后晚到的旧响应自行丢弃（否则会把上一本的批注列在下一本上）。 */
  const generationRef = useRef(0);
  const tRef = useRef(app.t);
  tRef.current = app.t;

  const load = useCallback(
    async (generation: number) => {
      if (!repoId || !fileId) return;
      setLoading(true);
      try {
        const list = await api.readerAnnotations(repoId, fileId);
        if (generationRef.current !== generation) return;
        setItems(list);
        setError(null);
      } catch (e) {
        if (generationRef.current !== generation) return;
        setError(errorTextOf(tRef.current, e));
      } finally {
        if (generationRef.current === generation) setLoading(false);
      }
    },
    [repoId, fileId],
  );

  // 换书 / 换仓库：清空并重新列一次。
  useEffect(() => {
    generationRef.current += 1;
    setItems([]);
    setError(null);
    void load(generationRef.current);
  }, [repoId, fileId, load]);

  const reload = useCallback(() => {
    generationRef.current += 1;
    void load(generationRef.current);
  }, [load]);

  const add = useCallback(
    async (draft: AnnotationDraft): Promise<boolean> => {
      if (!repoId || !fileId) return false;
      try {
        await api.readerAddAnnotation({ repoId, fileId, ...draft });
        // 回读而不是本地拼装：`id` / `created_at` 由后端生成，拼假的会让删除失败。
        generationRef.current += 1;
        await load(generationRef.current);
        return true;
      } catch (e) {
        setError(errorTextOf(tRef.current, e));
        return false;
      }
    },
    [repoId, fileId, load],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!repoId) return;
      try {
        await api.readerDeleteAnnotation(repoId, id);
        generationRef.current += 1;
        await load(generationRef.current);
      } catch (e) {
        setError(errorTextOf(tRef.current, e));
      }
    },
    [repoId, load],
  );

  return { items, loading, error, add, remove, reload };
}
