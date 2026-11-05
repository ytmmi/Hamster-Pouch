/**
 * 「全部设置 → 关于」的详情主体（D140）。
 *
 * 为什么这个大类不按设置项渲染：右侧有两类内容——
 * 1. **构建时事实**（版本 / 构建时间 / 提交哈希 / 许可证）：烙在二进制里，用户既不能写
 *    也不该写，所以不进设置注册表，走 `app.info` 命令；
 * 2. **自我更新操作**（检查更新 / 跳转 GitHub）与**一个**用户可写的开关
 *    （`ui.autoCheckUpdate`）。
 * 排版仍是「全部设置」的通用形态——`section-title` + `hr.settings-divider` + 一行行值，
 * 与「界面」「蓝图」「面板」等大类一致，**不加卡片边框/底色**（D140-R1 用户明确要求
 * "不要用矩形圈起来，和设置里的其它大类一样使用横线分隔"）。区别只在第一块没有按
 * 设置项渲染，而是"图标 + 名称 + 描述 + 构建时事实"。
 * 因此本组件自己排整块界面，`SettingsApp` 在 `category === "about"` 时改为渲染它（同
 * `McpServiceStatus` 之于 MCP 大类，但那里只是"设置项之后再挂一块"）。
 *
 * 更新检查的数据源是 GitHub Releases（`release.yml` 打的 tag 形如 `v0.1.1-Alpha`），
 * 比较逻辑在 `aboutUpdate.ts` 里，纯函数、可离线断言。
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import * as api from "../shared/api";
import { errorTextOf } from "../shared/api/response";
import { SwitchToggle } from "../shared/SwitchToggle";
import type { AppInfo } from "../shared/types/app";
import type { Translate } from "../i18n";
import { checkForUpdate, type UpdateFound, type UpdateState } from "./aboutUpdate";
// 应用图标直接用仓库里那一份真源（`apps/desktop/src-tauri/icons/icon.ico`，也是 exe 内嵌的
// 同一份），不复制成第二份二进制资产。Vite 的 `client.d.ts` 声明了 `*.ico` 模块，
// WebView2（Chromium）能直接解码 ICO 的 256×256 帧，无需先转 PNG。
import appIconUrl from "../../../src-tauri/icons/icon.ico";

export interface AboutPanelProps {
  t: Translate;
  theme: "light" | "dark";
  /** `ui.autoCheckUpdate` 的当前值（未写入过时取注册表默认值）。 */
  autoCheckUpdate: boolean;
  /** 写入 `ui.autoCheckUpdate`。 */
  onAutoCheckUpdate: (next: boolean) => void;
}

/** 应用图标：直接显示 exe 内嵌的同一份图标（`src-tauri/icons/icon.ico`）。
 * 这是全仓唯一的图形真源——图标换一次，任务栏、exe 与关于页同时变，不存在"关于页
 * 画的是另一只动物"的风险。`aria-hidden`：紧邻的文字已经报了应用名。 */
function AppLogo(): JSX.Element {
  return <img className="about-logo" src={appIconUrl} alt="" width={64} height={64} aria-hidden="true" />;
}

/** 事实区的一行：左标签右值（复用 `.settings-row` 的排版，语义与设置项一致）。 */
function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <label>{label}</label>
      </div>
      <div className="settings-row-control">
        <span className="dim">{value}</span>
      </div>
    </div>
  );
}

export function AboutPanel({
  t,
  theme,
  autoCheckUpdate,
  onAutoCheckUpdate,
}: AboutPanelProps): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>("idle");
  const [found, setFound] = useState<UpdateFound | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 自动检查只在本次打开界面时跑一次：否则每次重渲染都会打一次 GitHub。 */
  const autoRanRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await api.appInfo();
        if (alive) {
          setInfo(next);
          setInfoError(null);
        }
      } catch (e) {
        if (alive) setInfoError(errorTextOf(t, e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  const runCheck = useCallback(async () => {
    if (info === null) return;
    setState("checking");
    setCheckError(null);
    try {
      const result = await checkForUpdate(info.version);
      setFound(result.newer);
      setState(result.state);
    } catch (e) {
      setFound(null);
      setState("error");
      setCheckError(e instanceof Error ? e.message : String(e));
    }
  }, [info]);

  // 自动检查更新（D140 开关）：只在拿到版本号后、且用户没关掉它时跑一次。
  useEffect(() => {
    if (!autoCheckUpdate || info === null || autoRanRef.current) return;
    autoRanRef.current = true;
    void runCheck();
  }, [autoCheckUpdate, info, runCheck]);

  const open = useCallback(
    async (url: string) => {
      setOpenError(null);
      try {
        await api.appOpenUrl(url);
      } catch (e) {
        setOpenError(errorTextOf(t, e));
      }
    },
    [t],
  );

  const repoUrl = info?.repo_url ?? "";
  const versionText =
    info === null ? "—" : info.commit !== "" ? `${info.version} (${info.commit})` : info.version;
  const buildTimeText = info === null || info.build_time === "" ? t("settings.about.unknown") : info.build_time;
  const licenseText = info === null ? "—" : info.license;

  const statusText =
    state === "checking"
      ? t("settings.about.checking")
      : state === "latest"
        ? t("settings.about.latest")
        : state === "unavailable"
          ? t("settings.about.unavailable")
          : state === "outdated" && found !== null
            ? t("settings.about.outdated", { version: found.version })
            : state === "error"
              ? t("settings.about.failed", { err: checkError ?? "" })
              : t("settings.about.idle");

  return (
    <>
      <section className="settings-section">
        <div className="about-head">
          <AppLogo />
          <div className="about-head-text">
            <div className="about-name">{t("app.name")}</div>
            <div className="about-desc dim">{t("settings.about.description")}</div>
          </div>
        </div>
        {/* 与「界面」「蓝图」等大类同款：标题下一道横线，之后一行行值。身份区不套卡片。 */}
        <hr className="settings-divider" />
        <InfoRow label={t("settings.about.version")} value={versionText} />
        <InfoRow label={t("settings.about.buildTime")} value={buildTimeText} />
        <InfoRow label={t("settings.about.license")} value={licenseText} />
        <div className="settings-row">
          <div className="settings-row-label">
            <label>{t("settings.about.links")}</label>
          </div>
          <div className="settings-row-control about-links">
            <button className="menu-item small" disabled={repoUrl === ""} onClick={() => void open(repoUrl)}>
              {t("settings.about.github")}
            </button>
            <button
              className="menu-item small"
              disabled={repoUrl === ""}
              onClick={() => void open(`${repoUrl}/issues/new`)}
            >
              {t("settings.about.feedback")}
            </button>
            <button
              className="menu-item small"
              disabled={repoUrl === ""}
              onClick={() => void open(`${repoUrl}/blob/main/README.md`)}
            >
              {t("settings.about.privacy")}
            </button>
          </div>
        </div>
        {infoError !== null && <span className="placeholder">{infoError}</span>}
        {openError !== null && <span className="placeholder">{openError}</span>}
      </section>

      <section className="settings-section">
        <div className="section-title">{t("settings.section.aboutUpdate")}</div>
        <hr className="settings-divider" />
        {/* 状态文案直接占左侧标签位（截图同款：左"您已是最新版本"、右"检查更新"），
            不再额外写一行「更新状态」标题——那会变成三列，且它本身就是一句值不是标签。 */}
        <div className="settings-row">
          <div className="settings-row-label">
            <span className={state === "outdated" ? "about-status-new" : "dim"}>{statusText}</span>
          </div>
          <div className="settings-row-control about-links">
            {state === "outdated" && found !== null && (
              <button className="menu-item small" onClick={() => void open(found.url)}>
                {t("settings.about.goUpdate")}
              </button>
            )}
            <button
              className="menu-item small"
              disabled={info === null || state === "checking"}
              onClick={() => void runCheck()}
            >
              {t("settings.about.check")}
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <label>{t("settings.about.autoCheckUpdate")}</label>
          </div>
          <div className="settings-row-control">
            <SwitchToggle
              checked={autoCheckUpdate}
              theme={theme}
              label={t("settings.about.autoCheckUpdate")}
              onChange={onAutoCheckUpdate}
            />
          </div>
        </div>
      </section>
    </>
  );
}
