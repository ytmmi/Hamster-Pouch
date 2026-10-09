/**
 * 图书预览面板（`panel.bookpreview`）— 把文本类文件（`txt` / `md` / `epub`）当"书"展览。
 *
 * 三种视图（用户 2026-10-09 修订命名）：
 * - **卡片模式**（缺省）：封面在上、**文件名**在下（文件名即作品名，超长省略、
 *   悬停滚轮横向滚动看全名）——见 `BookCard`；
 * - **列表模式**：封面在左，右侧自上而下是 文件名 / 作者 / 简介，右栏**填充剩余空间**
 *   （由原「封面模式」改名而来：它本来就是列表）——见 `BookListRow`；
 * - **封面模式**：规则与列表一致，但一行可展示**多本**，右栏**固定为封面宽度的 2 倍**
 *   （不填充剩余空间）——见 `BookCoverCell`。
 *
 * 两模式共用的信息三行（作者：/ 简介：前缀、简介溢出齐平封面底）在 `BookRowInfo`。
 * 工具条有**封面宽度滑条**（与媒体预览同款样式，复用 `mp-size*` 类）：拖滑条改的是
 * 本会话的临时覆盖，声明层 `coverSize` 的 `default` 才是"用户没动过"时的缺省。
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
import { BookCoverCell } from "./BookCoverCell";
import { BookListRow } from "./BookListRow";
import { useBookPreviewData } from "./bookPreviewData";
import {
  BOOK_COVER_SIZE_MIN,
  BOOK_COVER_SIZE_MAX,
  BOOK_COVER_SIZE_STEP,
  BOOK_PREVIEW_PANEL_ID,
  bookDescLineCount,
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
  const settingCoverSize = usePanelSettingValue(BOOK_PREVIEW_PANEL_ID, "coverSize", panelApi);

  /**
   * 工具条上的视图切换与滑条拖动都是**本会话内的临时覆盖**（与媒体预览同口径）：
   * 声明层里 `view` / `coverSize` 的 `default` 才是"用户没在面板里改过时"的缺省。
   * 设置一变（「全部设置」里改过）就丢弃覆盖，避免"设置说卡片、面板显示封面"。
   */
  const [sessionView, setSessionView] = useState<BookViewMode | null>(null);
  useEffect(() => {
    setSessionView(null);
  }, [settingView]);
  const view = sessionView ?? settingView;

  const [sessionCoverSize, setSessionCoverSize] = useState<number | null>(null);
  useEffect(() => {
    setSessionCoverSize(null);
  }, [settingCoverSize]);
  const coverSize = clampCoverSize(sessionCoverSize ?? settingCoverSize);

  const { items, loading } = useBookPreviewData();
  // 后台标签冻结：dockview 把非激活标签留在 DOM 里，不冻结就会为看不见的书取封面。
  const foreground = usePanelForeground(panelApi);

  // `--bp-cover-size` 供全部三种视图共用；`--bp-desc-lines` 是简介的截断行数
  // （列表 / 封面模式按封面高度推得，见 `bookDescLineCount`）。
  const style = {
    "--bp-cover-size": `${coverSize}px`,
    "--bp-desc-lines": String(bookDescLineCount(coverSize)),
  } as CSSProperties;

  return (
    <div className="panel bp-panel" style={style}>
      <div className="bp-toolbar">
        {(["card", "list", "cover"] as const).map((mode) => (
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
        {/* 封面宽度滑条（媒体预览同款：复用 `mp-size*` 样式类）。三视图都用 coverSize。 */}
        <span className="mp-size">
          <span className="mp-size-label">{app.t("book.settings.coverSize")}</span>
          <input
            type="range"
            className="mp-size-range"
            min={BOOK_COVER_SIZE_MIN}
            max={BOOK_COVER_SIZE_MAX}
            step={BOOK_COVER_SIZE_STEP}
            value={coverSize}
            aria-label={app.t("book.settings.coverSize")}
            title={`${app.t("book.coverSizeHint")} — ${coverSize}px`}
            onChange={(e) => setSessionCoverSize(Number(e.target.value))}
          />
          <span className="mp-size-value">{coverSize}</span>
        </span>
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
          {app.repoId && items.length > 0 && view === "list" && (
            <div className="bp-rows">
              {items.map((item) => (
                <BookListRow key={item.id} repoId={app.repoId} item={item} />
              ))}
            </div>
          )}
          {app.repoId && items.length > 0 && view === "cover" && (
            <div className="bp-cover-grid">
              {items.map((item) => (
                <BookCoverCell key={item.id} repoId={app.repoId} item={item} />
              ))}
            </div>
          )}
          {loading && <span className="bp-loading dim">{app.t("common.loading")}</span>}
        </div>
      )}
    </div>
  );
}
