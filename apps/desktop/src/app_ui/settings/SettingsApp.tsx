/**
 * 「全部设置」系统界面（RFC 0010 决策 7 / `docs/spec/settings-standard.md`）。
 *
 * - **系统界面**：宿主提供、用户不可自定义；**不是蓝图层**（不进 `blueprints` 表、
 *   不受蓝图引擎管辖、不参与 `panel_layouts`）；
 * - **应用级**：跨仓库共享；值只写全局库 `app_settings`（键值对，**不新增库表**）；
 * - 结构：**顶部搜索框 + 左右分栏**；左侧大类（面板/插件含二级列表），右侧按分节渲染
 *   （分节用横线分割）；点左侧二级项**滚动定位**到对应分节（不重建页面）。
 *
 * 打开入口是顶部设置区的「更多设置」（`MenuBar`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  SETTING_CATEGORIES,
  allSettingDecls,
  type SettingCategory,
  type SettingDecl,
  type SettingValue,
} from "@hamster-pouch/config";

import * as api from "../shared/api";
import { useApp } from "../core/AppContext";
import type { Translate, TranslationKey } from "../i18n";
import {
  allSettingCategories,
  decodeSettingValue,
  encodeSettingValue,
  searchSettings,
  sectionsOf,
  settingCategoryTitleKey,
  storageKeyOf,
  subGroupsOf,
} from "./settingsRegistry";

export interface SettingsAppProps {
  onClose: () => void;
  /** 主题变化（设置项 `ui.theme` 写库后同步宿主主题）。 */
  onThemeChange: (theme: "light" | "dark") => void;
  /** 语言变化（设置项 `ui.language` 写库后同步宿主语言）。 */
  onLanguageChange: (language: "zh-CN" | "zh-TW" | "en") => void;
}

export function SettingsApp({
  onClose,
  onThemeChange,
  onLanguageChange,
}: SettingsAppProps): JSX.Element {
  const app = useApp();
  const { t } = app;
  const [category, setCategory] = useState<SettingCategory>("interface");
  const [values, setValues] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  // 读取全部应用设置（一次读完，界面据注册表按 `kind` 还原）。
  const reload = useCallback(async () => {
    try {
      const result = await api.settingList();
      setValues(Object.fromEntries(result.items.map((row) => [row.key, String(row.value)])));
    } catch (e) {
      app.status(t("settings.loadFailed", { err: String(e) }), "error");
    }
  }, [app, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // `setting.changed`：设置变更**不广播**仓库级事件（不触发蓝图/布局对账），
  // 只用来刷新「全部设置」界面自身（`docs/spec/commands-events.md` 3.13）。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen("setting.changed", () => {
          void reload();
        });
      } catch {
        /* 非 Tauri 运行时忽略 */
      }
    })();
    return () => dispose?.();
  }, [reload]);

  const writeValue = useCallback(
    async (decl: SettingDecl, value: SettingValue) => {
      const key = storageKeyOf(decl);
      try {
        await api.settingSet({ key, value: value as string | number | boolean });
        setValues((prev) => ({ ...prev, [key]: encodeSettingValue(value) }));
        app.status(t("settings.saved", { name: t(decl.title_key as TranslationKey) }), "ok");
        // 宿主设置里的主题/语言即时生效（与旧的顶部设置同一行为）。
        if (key === "ui.theme" && (value === "light" || value === "dark")) {
          onThemeChange(value);
        }
        if (
          key === "ui.language" &&
          (value === "zh-CN" || value === "zh-TW" || value === "en")
        ) {
          onLanguageChange(value);
        }
      } catch (e) {
        app.status(t("settings.saveFailed", { err: String(e) }), "error");
      }
    },
    [app, onLanguageChange, onThemeChange, t],
  );

  const resetValue = useCallback(
    async (decl: SettingDecl) => {
      const key = storageKeyOf(decl);
      try {
        await api.settingReset({ key });
        setValues((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        app.status(t("settings.resetDone"), "ok");
      } catch (e) {
        app.status(t("settings.saveFailed", { err: String(e) }), "error");
      }
    },
    [app, t],
  );

  const subGroups = useMemo(() => subGroupsOf(category), [category]);
  const sections = useMemo(() => sectionsOf(category), [category]);
  const hits = useMemo(
    () => searchSettings(query, (key) => t(key as TranslationKey)),
    [query, t],
  );

  const scrollTo = (anchor: string) => {
    sectionRefs.current.get(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label={t("settings.title")}>
      <div className="settings-window">
        <header className="settings-header">
          <span className="settings-title">{t("settings.title")}</span>
          <input
            className="settings-search"
            type="search"
            placeholder={t("settings.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="menu-item small" onClick={onClose}>
            {t("settings.close")}
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav">
            {allSettingCategories().map((item) => (
              <div key={item}>
                <button
                  className={`settings-nav-item ${item === category ? "active" : ""}`}
                  onClick={() => setCategory(item)}
                >
                  {t(settingCategoryTitleKey(item) as TranslationKey)}
                </button>
                {item === category &&
                  subGroups.map((group, index) => (
                    <div key={group.groupKey ?? index} className="settings-nav-group">
                      {group.groupKey && (
                        <span className="settings-nav-group-title">
                          {t(group.groupKey as TranslationKey)}
                        </span>
                      )}
                      {group.items.map((sub) => (
                        <button
                          key={sub.anchor}
                          className="settings-nav-sub"
                          onClick={() => scrollTo(sub.anchor)}
                        >
                          {t(sub.titleKey as TranslationKey)}
                          {sub.count === 0 && (
                            <em className="dim"> · {t("settings.value.unset")}</em>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                {item === category && subGroups.length === 0 && (
                  <div className="settings-nav-hint dim">{t("settings.subtitle")}</div>
                )}
              </div>
            ))}
          </nav>
          <div className="settings-detail">
            {query.trim() !== "" && (
              <div className="settings-search-results">
                <div className="section-title">{t("settings.searchPlaceholder")}</div>
                {hits.length === 0 && <span className="placeholder">{t("settings.searchEmpty")}</span>}
                {hits.map((hit) => (
                  <button
                    key={hit.storageKey}
                    className="menu-item grow"
                    onClick={() => {
                      setCategory(hit.category);
                      setQuery("");
                      // 大类切换后分节才渲染，下一帧再滚动定位。
                      requestAnimationFrame(() =>
                        scrollTo(anchorForHit(hit.ownerTitleKey, hit.storageKey)),
                      );
                    }}
                  >
                    {t(settingCategoryTitleKey(hit.category) as TranslationKey)} ·{" "}
                    {t(hit.titleKey as TranslationKey)}
                    {hit.ownerTitleKey && ` · ${t(hit.ownerTitleKey as TranslationKey)}`}
                  </button>
                ))}
              </div>
            )}
            {!query.trim() && sections.length === 0 && (
              <span className="placeholder">{t("settings.emptyCategory")}</span>
            )}
            {!query.trim() &&
              sections.map((section) => (
                <section
                  key={section.anchor}
                  className="settings-section"
                  ref={(el) => {
                    if (el) sectionRefs.current.set(section.anchor, el);
                    else sectionRefs.current.delete(section.anchor);
                  }}
                >
                  <div className="section-title">{t(section.titleKey as TranslationKey)}</div>
                  <hr className="settings-divider" />
                  {section.emptyKey && (
                    <span className="placeholder">{t(section.emptyKey as TranslationKey)}</span>
                  )}
                  {section.decls.map((decl) => (
                    <SettingRow
                      key={storageKeyOf(decl)}
                      decl={decl}
                      raw={values[storageKeyOf(decl)]}
                      t={t}
                      onWrite={writeValue}
                      onReset={resetValue}
                    />
                  ))}
                </section>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 搜索命中项的滚动锚点：面板/插件命中落在其分节上，宿主项落在大类首节。 */
function anchorForHit(ownerTitleKey: string | undefined, storageKey: string): string {
  if (storageKey.startsWith("panel.")) {
    return `panel.${storageKey.slice("panel.".length).split(".").slice(0, -1).join(".")}`;
  }
  if (storageKey.startsWith("plugin.")) {
    const rest = storageKey.slice("plugin.".length);
    return `plugin.${rest.split(".").slice(0, -1).join(".")}`;
  }
  return ownerTitleKey ?? "";
}

/** 单个设置项：按 `kind` 渲染**受控输入**（只取 6 种输入类，`button` 不允许）。 */
function SettingRow({
  decl,
  raw,
  t,
  onWrite,
  onReset,
}: {
  decl: SettingDecl;
  raw: string | undefined;
  t: Translate;
  onWrite: (decl: SettingDecl, value: SettingValue) => void;
  onReset: (decl: SettingDecl) => void;
}): JSX.Element {
  const value = raw === undefined ? decl.default : decodeSettingValue(decl, raw);
  // 声明了 `requires_capability` 的设置项在**无法确认授权**时按"未授权"置灰并说明
  // （`docs/spec/settings-standard.md` 第 8 节软告警 1）：本版能力授权通道尚未接线，
  // 因此该字段一旦声明即置灰，而不是静默当作已授权。
  const locked = decl.requires_capability !== undefined;
  const title = t(decl.title_key as TranslationKey);

  const control = () => {
    switch (decl.kind) {
      case "switch":
      case "checkbox":
        return (
          <input
            type="checkbox"
            disabled={locked}
            checked={value === true}
            onChange={(e) => onWrite(decl, e.target.checked)}
          />
        );
      case "numberInput":
        return (
          <input
            type="number"
            disabled={locked}
            value={typeof value === "number" ? value : 0}
            onChange={(e) => onWrite(decl, Number(e.target.value) || 0)}
          />
        );
      case "slider":
        return (
          <input
            type="range"
            disabled={locked}
            value={typeof value === "number" ? value : 0}
            onChange={(e) => onWrite(decl, Number(e.target.value) || 0)}
          />
        );
      case "select":
        return (
          <select
            disabled={locked}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onWrite(decl, e.target.value)}
          >
            {(decl.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.title_key as TranslationKey)}
              </option>
            ))}
          </select>
        );
      default:
        return (
          <input
            type="text"
            disabled={locked}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onWrite(decl, e.target.value)}
          />
        );
    }
  };

  return (
    <div className={`settings-row ${locked ? "locked" : ""}`}>
      <div className="settings-row-label">
        <label>{title}</label>
        {decl.scope === "repo" && <span className="dim">{t("settings.scope.repo")}</span>}
        {locked && (
          <span className="dim">
            {t("settings.requiresCapability", { cap: decl.requires_capability ?? "" })}
          </span>
        )}
      </div>
      <div className="settings-row-control">
        {control()}
        {raw !== undefined && (
          <button className="menu-item small" onClick={() => onReset(decl)}>
            {t("settings.reset")}
          </button>
        )}
      </div>
    </div>
  );
}

/** 设置注册表里的全部大类（供门禁与诊断展示）。 */
export const SETTINGS_CATEGORIES = SETTING_CATEGORIES;

/** 注册表规模（供诊断：设置项总数）。 */
export function settingsDeclCount(): number {
  return allSettingDecls().length;
}
