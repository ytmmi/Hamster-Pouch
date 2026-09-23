/**
 * 确认弹窗（与任务进度浮窗同款卡片样式）— 用于卸载源这类**不可恢复**操作。
 *
 * 用法：`const ok = await app.askConfirm({ ... })`；
 * 待确认状态与 resolver 由 `useConfirm` 提供，宿主（应用窗口 / 独立面板窗口）渲染本组件。
 */

import { useApp } from "./AppContext";

export function ConfirmDialog(): JSX.Element | null {
  const app = useApp();
  const { confirm, resolveConfirm, t } = app;

  if (!confirm) {
    return null;
  }

  return (
    <div className="task-overlay" role="dialog" aria-modal="true">
      <div className="task-card confirm-card">
        <div className="task-title">{confirm.title}</div>
        <p className="confirm-message">{confirm.message}</p>
        {confirm.warning && <div className="confirm-warning">{confirm.warning}</div>}

        {confirm.details && confirm.details.length > 0 && (
          <div className="confirm-details">
            {confirm.detailsTitle && (
              <div className="confirm-details-title">{confirm.detailsTitle}</div>
            )}
            <ul>
              {confirm.details.map((line, i) => (
                // 明细行内容固定、顺序固定，用下标作 key 是安全的
                <li key={i} title={line}>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="task-actions">
          <button onClick={() => resolveConfirm(false)}>
            {confirm.cancelLabel ?? t("common.cancel")}
          </button>
          <button
            className={confirm.danger ? "danger" : "primary"}
            onClick={() => resolveConfirm(true)}
          >
            {confirm.confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
