/**
 * 任务面板 — 后台任务与事件概览（扫描 / 相册同步 / 色彩提取）。
 */

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useApp } from "../AppContext";

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
            push(`扫描进度 ${JSON.stringify(e.payload)}`),
          ),
          await listen("scan.completed", (e) =>
            push(`扫描完成 ${JSON.stringify(e.payload)}`),
          ),
          await listen("scan.error", (e) =>
            push(`扫描错误 ${JSON.stringify(e.payload)}`),
          ),
          await listen("album.sync.progress", (e) =>
            push(`相册同步 ${JSON.stringify(e.payload)}`),
          ),
          await listen("album.sync.conflict", (e) =>
            push(`相册冲突 ${JSON.stringify(e.payload)}`),
          ),
          await listen("color.extracted", (e) =>
            push(`色彩提取 ${JSON.stringify(e.payload)}`),
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
        <span className="dim">当前仓库: {app.repoId ?? "—"}</span>
        <button onClick={() => setLines([])}>清空</button>
      </div>
      <div className="list compact">
        {lines.map((l, i) => (
          <span key={`${l.time}-${i}`} className="mono task-line">
            [{l.time}] {l.text}
          </span>
        ))}
        {lines.length === 0 && <span className="placeholder">暂无任务事件</span>}
      </div>
    </div>
  );
}
