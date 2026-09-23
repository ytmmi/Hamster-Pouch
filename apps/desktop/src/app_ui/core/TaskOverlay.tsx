/**
 * 长任务进度浮窗 — 界面居中浮层（背景 0.5 白色），盖在布局与面板之上。
 *
 * 扫描与卸载共用（"进度条同款"）：文字全部来自 i18n 键 + 参数，语言切换后随之变化。
 *
 * 两条稳健性保障（此前出现过"永远转圈"）：
 * 1. **与后端对账**：长时间没有进度事件时查询 `task.status`，后端已空闲就自行收起浮窗并刷新；
 * 2. **随时可关**：超过阈值仍无进度就显示「关闭浮窗」，即使任务不可取消也不会把界面锁死。
 *
 * 进度只来自 `taskStore`（不进 AppContext）：否则每次进度事件都会让所有面板重渲染并重跑查库。
 */

import { useEffect, useRef, useState } from "react";

import * as api from "../shared/api";
import { useApp } from "./AppContext";
import { getTask, setTask, useTask } from "./taskStore";

/** 多久没有进度事件就视为"卡住"（毫秒）。 */
const STALE_MS = 5000;
/** 对账轮询间隔（毫秒）。 */
const POLL_MS = 1500;

export function TaskOverlay(): JSX.Element | null {
  const { t, status, refresh } = useApp();
  const task = useTask();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [stale, setStale] = useState(false);

  // 任务结束后复位本地标记
  useEffect(() => {
    if (!task) {
      setCancelRequested(false);
      setStale(false);
    }
  }, [task]);

  // 卡住检测 + 与后端对账
  useEffect(() => {
    if (!task) {
      return;
    }
    const tick = async () => {
      const isStale = Date.now() - task.updatedAt > STALE_MS;
      setStale(isStale);
      if (!isStale) {
        return;
      }
      // 后端已空闲 → 任务早已结束、终止事件丢失：收起浮窗并刷新，别让用户干等
      try {
        const s = await api.taskStatus();
        if (!s.busy && getTask() !== null) {
          setTask(null);
          status(t("task.recovered"), "info");
          refresh();
        }
      } catch {
        /* 对账失败不影响手动关闭 */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [task, status, t, refresh]);

  if (!task) {
    return null;
  }

  // total 为 0 表示总数未知 → 不定进度条
  const known = task.total > 0;
  const pct = known ? Math.min(100, Math.round((task.processed / task.total) * 100)) : 0;

  return (
    <div className="task-overlay" role="dialog" aria-modal="true" aria-busy="true">
      <div className="task-card">
        <div className="task-title">{t(task.titleKey)}</div>
        {task.subtitle && (
          <div className="task-subtitle">{t("task.source", { name: task.subtitle })}</div>
        )}

        <div className="task-bar">
          <div
            className={`task-fill${known ? "" : " indeterminate"}`}
            style={known ? { width: `${pct}%` } : undefined}
          />
        </div>

        <div className="task-meta">
          <span>{t(task.messageKey, task.messageParams)}</span>
          {known && <span className="task-pct">{pct}%</span>}
        </div>

        {task.current && (
          <div className="task-current" title={task.current}>
            {t("task.current", { name: task.current })}
          </div>
        )}

        {stale && <div className="task-stale">{t("task.stale")}</div>}

        <div className="task-actions">
          {stale && <button onClick={() => setTask(null)}>{t("task.close")}</button>}
          {task.cancellable && (
            <button
              className="danger"
              disabled={cancelRequested}
              onClick={() => {
                setCancelRequested(true);
                void api.taskCancel();
              }}
            >
              {t("common.cancel")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
