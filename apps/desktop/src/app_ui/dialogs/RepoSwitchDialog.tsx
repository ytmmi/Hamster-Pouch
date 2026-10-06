/**
 * 切换仓库对话框（独立窗口：index.html?dialog=repo-switch）。
 */

import { useCallback, useEffect, useState } from "react";
import { emitHp } from "../shared/events";
import { getCurrentWindow } from "@tauri-apps/api/window";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { DEFAULT_LANGUAGE, isLanguage, makeTranslator } from "../i18n";
import type { RepoListItem } from "../shared/types";

export function RepoSwitchDialog({ lang }: { lang: string | null }): JSX.Element {
  const t = makeTranslator(isLanguage(lang) ? lang : DEFAULT_LANGUAGE);
  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    void getCurrentWindow().close();
  };

  const load = useCallback(async () => {
    try {
      setRepos(await api.repoList());
    } catch (e) {
      setError(errorTextOf(t, e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    try {
      await api.repoOpen({ repoId: id });
      await emitHp("repo.changed", { repoId: id });
      close();
    } catch (e) {
      setError(errorTextOf(t, e));
    }
  };

  return (
    <div className="dialog">
      <h2>{t("repo.switch")}</h2>
      <div className="list dialog-list">
        {repos.map((r) => (
          <button key={r.id} className="list-row" onClick={() => void open(r.id)}>
            <span>{r.name}</span>
            <span className="dim">{r.id.slice(0, 8)}</span>
          </button>
        ))}
        {repos.length === 0 && <span className="placeholder">{t("common.noRepo")}</span>}
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        <button onClick={close}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
