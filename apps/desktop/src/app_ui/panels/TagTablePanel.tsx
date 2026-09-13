/**
 * tag表 — 仓库 tag 实体列表（由原「标签/评分」组件的仓库 tag 部分独立而来）。
 *
 * 后续关系图谱组件将以此为数据源（D22）。
 */

import { useCallback, useEffect, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { TagItem } from "../shared/types";

export function TagTablePanel(): JSX.Element {
  const app = useApp();
  const [tags, setTags] = useState<TagItem[]>([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!app.repoId) {
      setTags([]);
      return;
    }
    try {
      setTags(await api.tagList({ repoId: app.repoId }));
    } catch (e) {
      app.status(`tag表加载失败: ${String(e)}`, "error");
    }
  }, [app]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.repoId, app.refreshKey]);

  const keyword = filter.trim().toLowerCase();
  const shown = keyword
    ? tags.filter((t) => t.name.toLowerCase().includes(keyword))
    : tags;

  return (
    <div className="panel">
      {!app.repoId && (
        <span className="placeholder">{app.t("common.selectRepo")}</span>
      )}
      {app.repoId && (
        <>
          <div className="row">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={app.t("tagtable.filter")}
            />
            <span className="dim">
              {shown.length}/{tags.length}
            </span>
          </div>
          <div className="list compact">
            {shown.map((t) => (
              <span key={t.id} className="tag-table-row">
                {t.color && (
                  <span className="tag-dot" style={{ background: t.color }} />
                )}
                {t.name}
              </span>
            ))}
            {shown.length === 0 && (
              <span className="placeholder">{app.t("tagtable.empty")}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
