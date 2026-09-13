/**
 * 标签 / 评分面板 — 选中文件的 tag 增删与 0-5 评分。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { TagItem } from "../shared/types";

export function TagRatingPanel(): JSX.Element {
  const app = useApp();
  const [tagName, setTagName] = useState("");
  const [repoTags, setRepoTags] = useState<TagItem[]>([]);
  const [fileTags, setFileTags] = useState<TagItem[]>([]);
  const [rating, setRating] = useState(0);

  const load = useCallback(async () => {
    if (!app.repoId) {
      setRepoTags([]);
      setFileTags([]);
      return;
    }
    try {
      setRepoTags(await api.tagList({ repoId: app.repoId }));
      if (app.selectedFile) {
        setFileTags(
          await api.tagForFile({ repoId: app.repoId, fileId: app.selectedFile.id }),
        );
        setRating(
          (await api.ratingGet({
            repoId: app.repoId,
            fileId: app.selectedFile.id,
          })) ?? 0,
        );
      } else {
        setFileTags([]);
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

          <div className="section-title">当前文件 tag</div>
          <div className="chips">
            {fileTags.map((t) => (
              <button key={t.id} className="chip" onClick={() => removeTag(t.name)}>
                {t.name} ✕
              </button>
            ))}
            {fileTags.length === 0 && <span className="placeholder">无 tag</span>}
          </div>

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
