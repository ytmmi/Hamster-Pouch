/**
 * 图书预览面板（`panel.bookpreview`）— 把文本类文件（`txt` / `md` / `epub`）当"书"展览。
 *
 * 两种视图（用户 2026-10-08 命名）：
 * - **卡片模式**（缺省）：封面在上、**文件名**在下（文件名即作品名，超长省略、
 *   悬停滚轮横向滚动看全名）——见 `BookCard`；
 * - **封面模式**：封面在左，右侧自上而下是文件名 / 作者 / 简介——见 `BookCoverRow`。
 *
 * 封面来源：`epub` 取**内嵌封面**（`book.meta`，带磁盘缓存），`txt` / `md` 用
 * **文字封面**（文件名渲染，底色由名字派生）——见 `BookCoverArt`。
 *
 * 取数：`file.query` 过滤 `mediaTypes: ['text']`，按当前仓库 / 源 / 目录（不用相册，
 * 理由见 `bookPreviewData.ts`）。当前不做虚拟化：文本库的量级是几十到几百本，
 * 与"数万张图"不是一个问题（媒体预览的虚拟化是为后者的量级做的）。
 *
 * 面板设置走 `shared/settingValue.ts`（四条触发源），因此需要 dockview 面板 API。
 */

import { useEffect, useState, type CSSProperties } from "react";

import { useApp } from "../../core/AppContext";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import { usePanelForeground } from "../../shared/panelForeground";
import { usePanelSettingValue } from "../../shared/settingValue";
import { BookCard } from "./BookCard";
import { BookCoverRow } from "./BookCoverRow";
import { useBookPreviewData } from "./bookPreviewData";
import {
  BOOK_PREVIEW_PANEL_ID,
  clampCoverSize,
  resolveBookView,
  type BookViewMode,
} from "./bookPreviewView";

export interface BookPreviewPanelProps {
  /** dockview 面板 API：面板设置的"面板回到前台时补读"这条触发源需要它。 */
  api?: PanelRenderCtx["api"];
}

export function BookPreviewPanel({ api: panelApi }: BookPreviewPanelProps = {}): JSX.Element {
  const app = useApp();
  const settingView = resolveBookView(
    usePanelSettingValue(BOOK_PREVIEW_PANEL_ID, "view", panelApi),
  );
  const coverSize = clampCoverSize(
    usePanelSettingValue(BOOK_PREVIEW_PANEL_ID, "coverSize", panelApi),
  );

  /**
   * 工具条上的视图切换是**本会话内的临时覆盖**（与媒体预览右上角那两个下拉同口径）：
   * 声明层里 `view` 的 `default` 才是"用户没在面板里改过时"的缺省。
   * 设置一变（「全部设置」里改过）就丢弃覆盖，避免"设置说卡片、面板显示封面"。
   */
  const [sessionView, setSessionView] = useState<BookViewMode | null>(null);
  useEffect(() => {
    setSessionView(null);
  }, [settingView]);
  const view = sessionView ?? settingView;

  const { items, loading } = useBookPreviewData();
  // 后台标签冻结：dockview 把非激活标签留在 DOM 里，不冻结就会为看不见的书取封面。
  const foreground = usePanelForeground(panelApi);

  const style = { "--bp-cover-size": `${coverSize}px` } as CSSProperties;

  return (
    <div className="panel bp-panel" style={style}>
      <div className="bp-toolbar">
        {(["card", "cover"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={`bp-view-tab${view === mode ? " active" : ""}`}
            aria-pressed={view === mode}
            onClick={() => setSessionView(mode)}
          >
            {app.t(`book.settings.view.${mode}`)}
          </button>
        ))}
        <span className="bp-count dim">{app.t("book.count", { n: items.length })}</span>
      </div>

      {/* 冻结时不渲染条目容器：成本降到工具条那一行（切回来再渲染，缓存还在）。 */}
      {foreground && (
        <div className="bp-body">
          {!app.repoId && <span className="placeholder">{app.t("common.selectRepo")}</span>}
          {app.repoId && items.length === 0 && !loading && (
            <span className="placeholder">{app.t("book.empty")}</span>
          )}
          {app.repoId && items.length > 0 && view === "card" && (
            <div className="bp-cards">
              {items.map((item) => (
                <BookCard key={item.id} repoId={app.repoId} item={item} />
              ))}
            </div>
          )}
          {app.repoId && items.length > 0 && view === "cover" && (
            <div className="bp-rows">
              {items.map((item) => (
                <BookCoverRow key={item.id} repoId={app.repoId} item={item} />
              ))}
            </div>
          )}
          {loading && <span className="bp-loading dim">{app.t("common.loading")}</span>}
        </div>
      )}
    </div>
  );
}
