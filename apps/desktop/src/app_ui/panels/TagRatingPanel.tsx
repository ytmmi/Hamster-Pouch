/**
 * 标签 / 评分面板 — 选中文件的人工 tag（在上）与自动 tag（在下，可折叠）分开显示，
 * 以及 0-5 评分（D21：人工 / 自动为独立两组）。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { FileTagItem, TagItem } from "../shared/types";

export function TagRatingPanel(): JSX.Element {
  const app = useApp();
  const [tagName, setTagName] = useState("");
  const [repoTags, setRepoTags] = useState<TagItem[]>([]);
  const [manualTags, setManualTags] = useState<FileTagItem[]>([]);
  const [autoTags, setAutoTags] = useState<FileTagItem[]>([]);
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const [rating, setRating] = useState(0);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setRepoTags([]);
      setManualTags([]);
      setAutoTags([]);
      return;
    }
    try {
      setRepoTags(await api.tagList({ repoId: app.repoId }));
      if (app.selectedFile) {
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
      } else {
        setManualTags([]);
        setAutoTags([]);
        setRating(0);
      }
    } catch (e) {
      app.status(`tag/评分加载失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
  }, [load, app.repoId, app.selectedFile, app.refreshKey]);

  const addTag = async () => {
    if (!app.repoId || !app.selectedFile || !tagName.trim()) return;
    try {
      await api.tagAdd({
        repoId: app.repoId,
        fileIds: [app.selectedFile.id],
        tagName: tagName.trim(),
      });
      setTagName("");
      app.status("tag 已添加", "ok");
      app.refresh();
    } catch (e) {
      app.status(`添加 tag 失败: ${String(e)}`, "error");
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
      app.status("tag 已移除", "ok");
      app.refresh();
    } catch (e) {
      app.status(`移除 tag 失败: ${String(e)}`, "error");
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
      app.status(`评分已设为 ${value}`, "ok");
    } catch (e) {
      app.status(`设置评分失败: ${String(e)}`, "error");
    }
  };

  return (
    <div className="panel">
      {!app.selectedFile && <span className="placeholder">未选中文件</span>}
      {app.selectedFile && (
        <>
          <div className="row">
            <input
              value={tagName}
              onChange={(e) => setTagName(e.target.value)}
              placeholder="新 tag 名"
            />
            <button onClick={addTag}>添加</button>
          </div>

          {/* 人工标签（在上，可增删） */}
          <div className="section-title">{app.t("tag.manual")}</div>
          <div className="chips">
            {manualTags.map((t) => (
              <button key={t.id} className="chip" onClick={() => removeTag(t.name)}>
                {t.name} ✕
              </button>
            ))}
            {manualTags.length === 0 && (
              <span className="placeholder">{app.t("tag.manual.empty")}</span>
            )}
          </div>

          {/* 自动标签（在下，可折叠，只读） */}
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
                <span key={t.id} className="chip static" title={`${app.t("tag.confidence")}: ${t.confidence ?? "—"}`}>
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

          <div className="section-title">评分</div>
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
              清除
            </button>
          </div>

          <div className="section-title">仓库 tag（{repoTags.length}）</div>
          <div className="chips">
            {repoTags.map((t) => (
              <span key={t.id} className="chip static">
                {t.name}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
