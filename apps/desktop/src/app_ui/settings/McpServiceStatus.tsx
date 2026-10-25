/**
 * 「全部设置 → MCP」的**服务状态**块（D119）。
 *
 * 设置项只声明"要不要开 / 开在哪个端口 / 允不允许写"，而**客户端接入信息**
 * （端点地址 + Bearer token）是运行时才有的东西，必须在这里展示并允许复制——
 * 否则用户没法把仓鼠颊接进任何 MCP 客户端。
 *
 * 它不是设置项：设置项是"用户可写的声明"，这里是"服务当前的事实"，
 * 所以走 `mcp.status` 命令而不是设置注册表（见 `docs/spec/commands-events.md` §3.16）。
 */

import { useCallback, useEffect, useState, type JSX } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import type { McpStatus } from "../shared/types/mcp";
import type { Translate } from "../i18n";

export interface McpServiceStatusProps {
  t: Translate;
  /** 变化即重新拉取状态（三项 `mcp.*` 设置写入后由父组件递增）。 */
  reloadKey: string;
}

export function McpServiceStatus({ t, reloadKey }: McpServiceStatusProps): JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await api.mcpStatus();
        if (alive) {
          setStatus(next);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(errorTextOf(t, e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, t]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 剪贴板不可用时不打断设置界面 */
      }
    },
    [],
  );

  if (error !== null) {
    return (
      <section className="settings-section">
        <div className="section-title">{t("settings.mcp.statusTitle")}</div>
        <hr className="settings-divider" />
        <span className="placeholder">{error}</span>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <div className="section-title">{t("settings.mcp.statusTitle")}</div>
      <hr className="settings-divider" />
      <div className="settings-row">
        <div className="settings-row-label">
          <label>{t("settings.mcp.state")}</label>
        </div>
        <div className="settings-row-control">
          <span className={status?.running ? undefined : "dim"}>
            {status?.running ? t("settings.mcp.stateRunning") : t("settings.mcp.stateStopped")}
          </span>
        </div>
      </div>
      {status?.running && (
        <>
          <div className="settings-row">
            <div className="settings-row-label">
              <label>{t("settings.mcp.endpoint")}</label>
            </div>
            <div className="settings-row-control">
              <span className="dim">{status.endpoint}</span>
              <button
                className="menu-item small"
                onClick={() => void copy(status.endpoint)}
              >
                {t("settings.mcp.copy")}
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <label>{t("settings.mcp.token")}</label>
            </div>
            <div className="settings-row-control">
              <span className="dim">{status.token}</span>
              <button className="menu-item small" onClick={() => void copy(status.token)}>
                {t("settings.mcp.copy")}
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-label">
              <label>{t("settings.mcp.tools")}</label>
            </div>
            <div className="settings-row-control">
              <span className="dim">
                {t("settings.mcp.toolsValue", {
                  total: status.tool_count,
                  write: status.write_tool_count,
                })}
              </span>
            </div>
          </div>
        </>
      )}
      <span className="placeholder">{t("settings.mcp.hint")}</span>
    </section>
  );
}
