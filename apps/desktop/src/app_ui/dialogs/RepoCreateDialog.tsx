/**
 * 创建仓库对话框（独立窗口：index.html?dialog=repo-create）。
 */

import { useState } from "react";
import { emitHp } from "../shared/events";
import { getCurrentWindow } from "@tauri-apps/api/window";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { DEFAULT_LANGUAGE, isLanguage, makeTranslator } from "../i18n";

export function RepoCreateDialog({ lang }: { lang: string | null }): JSX.Element {
  const t = makeTranslator(isLanguage(lang) ? lang : DEFAULT_LANGUAGE);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    void getCurrentWindow().close();
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("repo.namePlaceholder"));
      return;
    }
    setBusy(true);
    try {
      const repo = await api.repoCreate({ name: trimmed });
      await emitHp("repo.changed", { repoId: repo.id });
      close();
    } catch (e) {
      setError(errorTextOf(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog">
      <h2>{t("repo.create")}</h2>
      <input
        value={name}
        autoFocus
        placeholder={t("repo.namePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void submit();
          }
        }}
      />
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        <button onClick={close}>{t("common.cancel")}</button>
        <button disabled={busy} onClick={() => void submit()}>
          {t("common.confirm")}
        </button>
      </div>
    </div>
  );
}
