/**
 * 标签 / 评分面板 — 评分置顶；人工标签（可编辑输入）在上、自动标签（可折叠）在下（D21）。
 *
 * 仓库 tag 列表已独立为「tag表」组件。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { TagInput } from "../shared/TagInput";
import { useApp } from "../core/AppContext";
import type { FileTagItem } from "../shared/types";

export function TagRatingPanel(): JSX.Element {
  const app = useApp();
  const [manualTags, setManualTags] = useState<FileTagItem[]>([]);
  const [autoTags, setAutoTags] = useState<FileTagItem[]>([]);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [rating, setRating] = useState(0);

  const load = useCallback(async () => {
    if (!app.repoId || !app.selectedFile) {
      setManualTags([]);
      setAutoTags([]);
      setRating(0);
      return;
    }
    try {
      const grouped = await api.tagForFile({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
      });
      setManualTags(grouped.manual);
      setAutoTags(grouped.auto);
      setRating(
        (await api.ratingGet({
          repoId: app.repoId,
          fileId: app.selectedFile.id,
        })) ?? 0,
      );
    } catch (e) {
      app.status(app.t("tag.loadFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.repoId, app.selectedFile, app.refreshKey]);

  const addTag = async (name: string) => {
    if (!app.repoId || !app.selectedFile) return;
    try {
      await api.tagAdd({
        repoId: app.repoId,
        fileIds: [app.selectedFile.id],
        tagName: name,
      });
      app.status(app.t("tag.added"), "ok");
      app.refresh();
    } catch (e) {
      app.status(app.t("tag.addFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const removeTag = async (name: string) => {
    if (!app.repoId || !app.selectedFile) return;
    try {
      await api.tagRemove({
        repoId: app.repoId,
        fileIds: [app.selectedFile.id],
        tagName: name,
      });
      app.status(app.t("tag.removed"), "ok");
      app.refresh();
    } catch (e) {
      app.status(app.t("tag.removeFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  const setRatingValue = async (value: number) => {
    if (!app.repoId || !app.selectedFile) return;
    try {
      await api.ratingSet({
        repoId: app.repoId,
        fileId: app.selectedFile.id,
        rating: value,
      });
      setRating(value);
      app.status(app.t("tag.ratingSet", { value }), "ok");
    } catch (e) {
      app.status(app.t("tag.ratingFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  };

  return (
    <div className="panel">
      {!app.selectedFile && <span className="placeholder">{app.t("common.noSelection")}</span>}
      {app.selectedFile && (
        <>
          {/* 评分（置顶） */}
          <div className="section-title">{app.t("tag.rating")}</div>
          <div className="stars">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                className={v <= rating ? "star on" : "star"}
                onClick={() => setRatingValue(v)}
              >
                ★
              </button>
            ))}
            <button className="star off" onClick={() => setRatingValue(0)}>
              {app.t("tag.clear")}
            </button>
          </div>

          {/* 人工标签（可编辑） */}
          <div className="section-title">{app.t("tag.manual")}</div>
          <TagInput
            tags={manualTags}
            placeholder={app.t("tag.addPlaceholder")}
            removeTitle={app.t("tag.removeTitle")}
            onAdd={addTag}
            onRemove={removeTag}
          />

          {/* 自动标签（只读，可折叠） */}
          <div className="section-title">
            <button
              className="collapse-toggle"
              onClick={() => setAutoCollapsed((v) => !v)}
              title={autoCollapsed ? app.t("tag.expand") : app.t("tag.collapse")}
            >
              {autoCollapsed ? "▸" : "▾"} {app.t("tag.auto")} ({autoTags.length})
            </button>
          </div>
          {!autoCollapsed && (
            <div className="chips">
              {autoTags.map((t) => (
                <span
                  key={t.id}
                  className="chip static"
                  title={`${app.t("tag.confidence")}: ${t.confidence ?? "—"}`}
                >
                  {t.name}
                  {t.confidence != null && (
                    <span className="dim"> {t.confidence.toFixed(2)}</span>
                  )}
                </span>
              ))}
              {autoTags.length === 0 && (
                <span className="placeholder">{app.t("tag.auto.empty")}</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
