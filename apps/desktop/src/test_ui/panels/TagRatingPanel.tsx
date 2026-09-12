/**
 * 标签与评分面板 — 添加/移除标签、列出仓库标签、显示文件标签、设置/读取评分。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../api";
import type { FileItem, StatusHandler, TagItem } from "../types";

export interface TagRatingPanelProps {
  repoId: string | null;
  selectedFile: FileItem | null;
  onRefresh: () => void;
  onStatus: StatusHandler;
  refreshKey: number;
}

export function TagRatingPanel({
  repoId,
  selectedFile,
  onRefresh,
  onStatus,
  refreshKey,
}: TagRatingPanelProps): JSX.Element {
  const [repoTags, setRepoTags] = useState<TagItem[]>([]);
  const [fileTags, setFileTags] = useState<TagItem[]>([]);
  const [rating, setRating] = useState<number | null>(null);
  const [newTagName, setNewTagName] = useState("");

  // 刷新仓库标签列表
  useEffect(() => {
    if (!repoId) {
      setRepoTags([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const tags = await api.tagList({ repoId });
        if (!cancelled) setRepoTags(tags);
      } catch (e) {
        if (!cancelled) onStatus(`标签列表失败: ${String(e)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, onStatus, refreshKey]);

  // 刷新文件标签和评分
  useEffect(() => {
    if (!repoId || !selectedFile) {
      setFileTags([]);
      setRating(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [tags, r] = await Promise.all([
          api.tagForFile({ repoId, fileId: selectedFile.id }),
          api.ratingGet({ repoId, fileId: selectedFile.id }),
        ]);
        if (!cancelled) {
          setFileTags(tags);
          setRating(r);
        }
      } catch (e) {
        if (!cancelled) onStatus(`文件标签/评分读取失败: ${String(e)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedFile, onStatus, refreshKey]);

  const handleAddTag = useCallback(async () => {
    if (!repoId || !selectedFile || !newTagName.trim()) {
      onStatus("需要选中文件并输入标签名", "error");
      return;
    }
    try {
      await api.tagAdd({
        repoId,
        fileIds: [selectedFile.id],
        tagName: newTagName.trim(),
      });
      onStatus(`标签 "${newTagName}" 已添加`, "ok");
      setNewTagName("");
      onRefresh();
    } catch (e) {
      onStatus(`添加标签失败: ${String(e)}`, "error");
    }
  }, [repoId, selectedFile, newTagName, onRefresh, onStatus]);

  const handleRemoveTag = useCallback(
    async (tagName: string) => {
      if (!repoId || !selectedFile) return;
      try {
        await api.tagRemove({
          repoId,
          fileIds: [selectedFile.id],
          tagName,
        });
        onStatus(`标签 "${tagName}" 已移除`, "ok");
        onRefresh();
      } catch (e) {
        onStatus(`移除标签失败: ${String(e)}`, "error");
      }
    },
    [repoId, selectedFile, onRefresh, onStatus],
  );

  const handleSetRating = useCallback(
    async (value: number) => {
      if (!repoId || !selectedFile) return;
      try {
        await api.ratingSet({
          repoId,
          fileId: selectedFile.id,
          rating: value,
        });
        setRating(value);
        onStatus(`评分已设置为 ${value}`, "ok");
      } catch (e) {
        onStatus(`设置评分失败: ${String(e)}`, "error");
      }
    },
    [repoId, selectedFile, onStatus],
  );

  return (
    <div className="panel">
      <h2>标签与评分</h2>

      {!repoId && <span className="placeholder">请先打开仓库</span>}

      {repoId && (
        <>
          <div className="panel-section">
            <label>评分</label>
            {!selectedFile && <span className="placeholder">未选中文件</span>}
            {selectedFile && (
              <div className="rating-stars">
                {[0, 1, 2, 3, 4, 5].map((star) => (
                  <span
                    key={star}
                    className={`rating-star ${
                      rating !== null && rating >= star ? "active" : ""
                    }`}
                    onClick={() => handleSetRating(star)}
                  >
                    {"\u2605"}
                  </span>
                ))}
                <span className="placeholder">
                  当前: {rating ?? "未设置"}
                </span>
              </div>
            )}
          </div>

          <div className="panel-section">
            <label>添加标签</label>
            {!selectedFile && <span className="placeholder">未选中文件</span>}
            {selectedFile && (
              <div className="panel-row">
                <input
                  type="text"
                  placeholder="标签名"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                />
                <button onClick={handleAddTag}>添加</button>
              </div>
            )}
          </div>

          <div className="panel-section">
            <label>文件标签 ({fileTags.length})</label>
            <div className="item-list">
              {fileTags.length === 0 && (
                <span className="placeholder">无标签</span>
              )}
              {fileTags.map((t) => (
                <div key={t.id} className="item-list-item">
                  <span>{t.name}</span>
                  <button
                    onClick={() => handleRemoveTag(t.name)}
                    className="danger"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <label>仓库全部标签 ({repoTags.length})</label>
            <div className="item-list">
              {repoTags.length === 0 && (
                <span className="placeholder">无标签</span>
              )}
              {repoTags.map((t) => (
                <div key={t.id} className="item-list-item">
                  <span>{t.name}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
