/**
 * 任务面板 — 后台任务与事件概览（扫描 / 相册同步 / 色彩提取）。
 */

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useApp } from "../core/AppContext";

interface TaskLine {
  time: string;
  text: string;
}

export function TaskPanel(): JSX.Element {
  const app = useApp();
  const [lines, setLines] = useState<TaskLine[]>([]);
  const unlistenRef = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    const push = (text: string) => {
      const time = new Date().toLocaleTimeString();
      setLines((prev) => [{ time, text }, ...prev].slice(0, 200));
    };

    void (async () => {
      try {
        unlistenRef.current.push(
          await listen("scan.progress", (e) =>
            push(app.t("task.scanProgress", { payload: JSON.stringify(e.payload) })),
          ),
          await listen("scan.completed", (e) =>
            push(app.t("task.scanCompleted", { payload: JSON.stringify(e.payload) })),
          ),
          await listen("scan.error", (e) =>
            push(app.t("task.scanError", { payload: JSON.stringify(e.payload) })),
          ),
          await listen("album.sync.progress", (e) =>
            push(app.t("task.albumSync", { payload: JSON.stringify(e.payload) })),
          ),
          await listen("album.sync.conflict", (e) =>
            push(app.t("task.albumConflict", { payload: JSON.stringify(e.payload) })),
          ),
          // 整体失败是独立事件（缺陷 0004）：以前它与"单文件冲突"挤在同一个事件名里
          await listen("album.sync.failed", (e) =>
            push(app.t("task.albumSyncFailed", { payload: JSON.stringify(e.payload) })),
          ),
          await listen("color.extracted", (e) =>
            push(app.t("task.colorExtracted", { payload: JSON.stringify(e.payload) })),
          ),
        );
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();

    return () => {
      for (const fn of unlistenRef.current) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  return (
    <div className="panel">
      <div className="row">
        <span className="dim">
          {app.t("task.currentRepo")}: {app.repoId ?? "—"}
        </span>
        <button onClick={() => setLines([])}>{app.t("common.clear")}</button>
      </div>
      <div className="list compact">
        {lines.map((l, i) => (
          <span key={`${l.time}-${i}`} className="mono task-line">
            [{l.time}] {l.text}
          </span>
        ))}
        {lines.length === 0 && <span className="placeholder">{app.t("task.empty")}</span>}
      </div>
    </div>
  );
}
