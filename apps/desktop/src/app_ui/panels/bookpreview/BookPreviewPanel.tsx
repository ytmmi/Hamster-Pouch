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
 * 右键菜单（2026-10-09）**与媒体预览同款**：开关状态与菜单项复用媒体预览那一份
 * （`../mediaPreviewMenu`），四类动作复用 `../mediaPreviewActions`（只把删除的相册分流
 * 关掉，见下），三种视图的单元接同一套 `selected` / `onSelect` / `onContextMenu`。
 * 选中集用的是**全局那一份**（`app.selectedIds`，媒体预览同一口径），因此本面板的
 * "选中"只有单选：范围选择 / Ctrl 切换 / 拖拽是媒体预览的交互（连带蓝图事件源），
 * 文本库的量级（几十–几百本）用不上，本版不引入。
 *
 * 面板设置走 `shared/settingValue.ts`（四条触发源），因此需要 dockview 面板 API。
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useApp } from "../../core/AppContext";
import { useAllMarks } from "../../core/markStore";
import type { PanelRenderCtx } from "../../core/panelRegistry";
import * as api from "../../shared/api";
import { errorTextOf } from "../../shared/api/response";
import { usePanelForeground } from "../../shared/panelForeground";
import { usePanelSettingValue } from "../../shared/settingValue";
import { useStableCallback } from "../../shared/stableCallback";
import type { FileItem } from "../../shared/types";
import { useMediaFileActions } from "../mediaPreviewActions";
import { MediaContextMenu, useMediaContextMenu } from "../mediaPreviewMenu";
import { BookCard } from "./BookCard";
import { BookCoverCell } from "./BookCoverCell";
import { BookCoverMenu, BookMarkMenu } from "./BookCoverMenu";
import { BookListRow } from "./BookListRow";
import { coverOverrideOf, invalidateBookCovers, loadBookCovers } from "./bookCoverCache";
import { useBookPreviewData } from "./bookPreviewData";
import {
  BOOK_COVER_SIZE_MIN,
  BOOK_COVER_SIZE_MAX,
  BOOK_COVER_SIZE_STEP,
  BOOK_PREVIEW_PANEL_ID,
  bookDescLineCount,
  bookDispatchTarget,
  clampCoverSize,
  fileMarks,
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

  // 右键菜单的开关状态与光标定位：**媒体预览那一份**（`../mediaPreviewMenu`）。
  const menu = useMediaContextMenu();
  /**
   * 四类文件动作同款，只把**删除的相册分流**关掉：文本类文件进不了相册成员列表
   * （相册成员分页只认 image / video / audio），跟着"当前选中的相册"走会把删除
   * 变成"移出相册 0 项"的静默空操作——文件还在盘上。
   */
  const actions = useMediaFileActions({ albumScoped: false });

  /**
   * 单击选中本项（单选：本面板不引入范围/Ctrl 多选，理由见文件头），
   * 并把**单击上报蓝图引擎**（带类目细分，见下方 `doubleClickBook` 的说明）。
   */
  const selectBook = useCallback(
    (file: FileItem) => {
      app.setSelectedIds(new Set([file.id]));
      app.setSelectedFile(file);
      app.dispatch({ trigger: "click", target: bookDispatchTarget(file) });
    },
    [app],
  );

  /**
   * **把双击上报蓝图引擎**（RFC 0007 决策 1；2026-10-10 接线）。
   *
   * 上报必须带上**类目细分**才可能命中图书预览的类目：`format`（epub / txt / md）
   * 与 `bookMark`（book 标记）是两个**正交**维度，同一个被标为 book 的 txt
   * 会**同时**命中「txt 类目」与「book 类目」。只报一个裸的文本媒体类型的话，
   * 任何细分都命中不了——这正是本次接线要解决的问题。
   *
   * 与媒体预览的差别（如实记录）：本面板**只做单选**，因此不上报
   * `selection_change` 的 `rating` / `tags` context（那是多选与条件求值的口径，
   * 见 `docs/spec/panel-standard.md` 第 10 节「多选与拖拽」未做项）。
   */
  const doubleClickBook = useCallback(
    (file: FileItem) => {
      app.dispatch({ trigger: "double_click", target: bookDispatchTarget(file) });
    },
    [app],
  );

  /**
   * 右键前的选中口径（与媒体预览同款）：未选中项先单选，已选中则保持当前选中集
   * （因此"右键已选中的那本"不会把多选打散）。
   */
  const ensureSelected = useCallback(
    (file: FileItem) => {
      if (!app.selectedIds.has(file.id)) {
        app.setSelectedIds(new Set([file.id]));
        app.setSelectedFile(file);
      }
    },
    [app],
  );

  /** 在光标位置打开菜单（先按选中口径落选中，再由菜单的 `open` 挡掉默认菜单）。 */
  const openMenu = useCallback(
    (file: FileItem, e: ReactMouseEvent) => {
      ensureSelected(file);
      menu.open(file, e);
    },
    [ensureSelected, menu],
  );

  // 单元是 `memo` 的：三个回调必须收敛为**恒定引用**，否则每次选中变化都会重渲整列书。
  const cellSelect = useStableCallback(selectBook);
  const cellDoubleClick = useStableCallback(doubleClickBook);
  const cellContextMenu = useStableCallback(openMenu);

  /**
   * 菜单里"重命名 / 复制路径 / 重新分析"只在**单选**时给出，"删除选中"恒有
   * （与媒体预览的菜单口径逐项一致）。计数按**本面板列出的书**算，
   * 不让别处残留的选中项影响这个判断。
   */
  const selectedCount = useMemo(
    () => items.reduce((n, item) => (app.selectedIds.has(item.id) ? n + 1 : n), 0),
    [items, app.selectedIds],
  );

  /**
   * **批量**取这一页的封面覆盖（用户自设的颜色 / 图片）。
   *
   * 为什么在面板这里批量取而不是让单元各取各的：一页可能几百本，
   * 逐本一次 IPC 就是几百次往返（见 `bookCoverCache` 的说明）。
   * `items` 变化（翻页 / 切源 / 刷新）时重取一次；`invalidateBookCovers` 之后
   * 由 `app.refresh()` 触发 `items` 变化，因此改完封面会自动重新拉。
   */
  useEffect(() => {
    if (!app.repoId || items.length === 0) return;
    void loadBookCovers(
      app.repoId,
      items.map((item) => item.id),
    );
  }, [app.repoId, items]);

  /** 设置封面（颜色或图片）后：失效缓存 + 刷新（刷新会让上面的批量取重跑）。 */
  const applyCover = useCallback(
    async (kind: "color" | "image", value: string) => {
      if (!app.repoId || !app.selectedFile) return;
      const fileId = app.selectedFile.id;
      try {
        await api.bookSetCover({ repoId: app.repoId, fileId, kind, value });
        invalidateBookCovers(app.repoId);
        app.refresh();
      } catch (e) {
        // 失败必须报出来：图片格式不认 / 源文件读不到都在这里，
        // 静默失败会让用户以为"设了但没生效"（那是另一类缺陷）。
        app.status(app.t("book.cover.setFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [app],
  );

  /** 清除封面覆盖，回默认封面。 */
  const clearCover = useCallback(async () => {
    if (!app.repoId || !app.selectedFile) return;
    const repoId = app.repoId;
    try {
      await api.bookClearCover(repoId, app.selectedFile.id);
      invalidateBookCovers(repoId);
      app.refresh();
    } catch (e) {
      app.status(app.t("book.cover.setFailed", { err: errorTextOf(app.t, e) }), "error");
    }
  }, [app]);

  /** 菜单里"更换封面"区当前这本书有没有覆盖（决定「恢复默认」是否可点）。 */
  const menuFileOverride = menu.target
    ? coverOverrideOf(app.repoId, menu.target.file.id)
    : null;

  /** 菜单里"标记"区当前这本书带的标记（集合）与全部可用标记。 */
  const menuFileMarks = menu.target ? fileMarks(menu.target.file) : [];
  const allMarks = useAllMarks();

  /**
   * 增删一个标记（D102：标记**可多值**、与类目正交）。
   *
   * 标记影响封面来源（`book` 决定要不要取内嵌封面），因此写入后一并失效封面缓存。
   */
  const toggleBookMark = useCallback(
    async (mark: string, on: boolean) => {
      if (!app.repoId || !menu.target) return;
      try {
        await api.fileSetMarks({
          repoId: app.repoId,
          fileIds: [menu.target.file.id],
          add: on ? [mark] : [],
          remove: on ? [] : [mark],
        });
        // 标记影响封面来源（book 决定内嵌封面 vs 文字封面），因此封面缓存也要失效。
        invalidateBookCovers(app.repoId);
        app.refresh();
      } catch (e) {
        app.status(app.t("book.mark.setFailed", { err: errorTextOf(app.t, e) }), "error");
      }
    },
    [app, menu.target],
  );

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
                <BookCard
                  key={item.id}
                  repoId={app.repoId}
                  item={item}
                  selected={app.selectedIds.has(item.id)}
                  onSelect={cellSelect}
                  onDoubleClick={cellDoubleClick}
                  onContextMenu={cellContextMenu}
                />
              ))}
            </div>
          )}
          {app.repoId && items.length > 0 && view === "list" && (
            <div className="bp-rows">
              {items.map((item) => (
                <BookListRow
                  key={item.id}
                  repoId={app.repoId}
                  item={item}
                  selected={app.selectedIds.has(item.id)}
                  onSelect={cellSelect}
                  onDoubleClick={cellDoubleClick}
                  onContextMenu={cellContextMenu}
                />
              ))}
            </div>
          )}
          {app.repoId && items.length > 0 && view === "cover" && (
            <div className="bp-cover-grid">
              {items.map((item) => (
                <BookCoverCell
                  key={item.id}
                  repoId={app.repoId}
                  item={item}
                  selected={app.selectedIds.has(item.id)}
                  onSelect={cellSelect}
                  onDoubleClick={cellDoubleClick}
                  onContextMenu={cellContextMenu}
                />
              ))}
            </div>
          )}
          {loading && <span className="bp-loading dim">{app.t("common.loading")}</span>}
        </div>
      )}

      {/* 右键上下文菜单：**媒体预览那一份**（开关与菜单项都不重写第二套）。
          「更换封面」与「book 标记」经 `extraItems` 插槽挂进来——两者都是**图书特有**
          的能力（媒体预览没有封面可言、也没有 book 标记这个维度）。 */}
      {menu.target && (
        <MediaContextMenu
          target={menu.target}
          selectedCount={selectedCount}
          actions={actions}
          onClose={menu.close}
          t={app.t}
          extraItems={
            <>
              <BookMarkMenu
                marks={menuFileMarks}
                available={allMarks}
                onToggle={(mark, on) => void toggleBookMark(mark, on)}
                onClose={menu.close}
                t={app.t}
              />
              <BookCoverMenu
                hasOverride={menuFileOverride !== null}
                onPickColor={(color) => void applyCover("color", color)}
                onPickImage={(path) => void applyCover("image", path)}
                onClear={() => void clearCover()}
                onClose={menu.close}
                t={app.t}
              />
            </>
          }
        />
      )}
    </div>
  );
}
