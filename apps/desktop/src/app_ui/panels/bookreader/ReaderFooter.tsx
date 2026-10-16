/**
 * 图书阅读器：**底部进度条**。
 *
 * 三项（与参考图一致）：当前进度 / 页数 / 章节数。
 *
 * ## 各项都是**算出来的**，不是编出来的
 *
 * | 项 | 取数 | 拿不到时 |
 * | --- | --- | --- |
 * | 当前进度 | `readerProgress`（epub / pdf 用 `section / section_count`；txt / md 用 `cursor / total`） | 显示 `—` |
 * | 页数 | 当前游标 ÷ 一页的单位长（txt 按字符、md 按块） | 显示 `—` |
 * | 章节数 | 目录里"当前章序号 / 总章数"（`currentTocIndex`） | 目录为空则不显示 |
 *
 * 拿不到就显示 `—`：编一个 0% 会让"还没读数"和"这本书读不了"看起来一样。
 */

import type { Translate } from "../../i18n";
import { formatProgressPercent } from "./readerView";

export interface ReaderFooterProps {
  /** 当前进度（0–1）；`null` = 算不出来。 */
  progress: number | null;
  /** 页数（已读页 / 预计总页）；`null` = 算不出来。 */
  pages: { at: number; total: number } | null;
  /** 章数（当前章 / 总章）；`null` = 这本书没有目录。 */
  chapters: { at: number; total: number } | null;
  /** 受上限所限、只载入了部分正文。 */
  capped: boolean;
  t: Translate;
}

export function ReaderFooter({
  progress,
  pages,
  chapters,
  capped,
  t,
}: ReaderFooterProps): JSX.Element {
  const percent = formatProgressPercent(progress);
  return (
    <footer className="br-footer">
      <span className="br-footer-item">
        {t("bookreader.footer.progress")}
        <b>{percent ?? t("bookreader.unknown")}</b>
      </span>
      <span className="br-footer-item">
        {t("bookreader.footer.pages")}
        <b>
          {pages ? `${pages.at} / ${pages.total}` : t("bookreader.unknown")}
        </b>
      </span>
      {chapters && (
        <span className="br-footer-item">
          {t("bookreader.footer.chapters")}
          <b>
            {chapters.at} / {chapters.total}
          </b>
        </span>
      )}
      {capped && <span className="br-footer-note dim">{t("bookreader.capped")}</span>}
    </footer>
  );
}
