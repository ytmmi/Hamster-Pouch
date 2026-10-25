/**
 * 图书阅读器：**底部进度条**。
 *
 * 三格（2026-10-17 起）：当前进度 / **本章进度** / 章节数。
 *
 * ## 各项都是**算出来的**，不是编出来的
 *
 * | 项 | 取数 | 精度 | 拿不到时 |
 * | --- | --- | --- | --- |
 * | 当前进度 | `readerProgress`（起点游标 + 段内比例 × 已载入单位，÷ 全书总量） | `00.00%`（两位小数） | 显示 `—` |
 * | 本章进度 | `readerChapterProgress`（按目录区间归一） | `00.0%`（一位小数） | 目录为空则不显示 |
 * | 章节数 | 目录里"当前章序号 / 总章数"（`currentTocIndex`） | 整数比 `1 / 14` | 目录为空则不显示 |
 *
 * ## 为什么章节数保持 `1 / 14` 而不是百分比
 *
 * 用户 2026-10-17 先要求"使用百分比计数"，随即更正为"**章节数保持原样，仅删除页数**"。
 * 章节数是**离散计数**（第几章 / 共几章），与"读到哪儿"是两回事：把它折成百分比
 * 反而与旁边的当前进度重复表达同一件事，还丢掉了"第几章"这个可对照目录的信息。
 *
 * **页数一格已删除**：它只在纯文本里是"按一页 2 万字符折算"的估算值
 * （`TEXT_PAGE_CHARS`），与另外两格的精确百分比并列会误导——用户看到 12 / 351
 * 会以为那是排版后的真实页数。
 *
 * 两处精度不同是用户明确要求的（当前进度 `00.00%`、本章进度 `00.0%`），
 * 因此 `formatProgressPercent` 的位数是参数，不写死。
 *
 * 拿不到就显示 `—`：编一个 0% 会让"还没读数"和"这本书读不了"看起来一样。
 */

import type { JSX } from "react";
import type { Translate } from "../../i18n";
import { formatProgressPercent } from "./readerView";

export interface ReaderFooterProps {
  /** 全书当前进度（0–1）；`null` = 算不出来。 */
  progress: number | null;
  /**
   * 本章进度（0–1）；`null` = 这本书没有目录（PDF / 无可识别章节），整项不显示。
   *
   * 与 `progress` 分开传：两者的精度与"算不出来"的表现都不同——当前进度显示 `—`，
   * 本章进度整项省略（一个没有章的 PDF 显示"本章进度 —"只会让人困惑）。
   */
  chapterProgress: number | null;
  /** 章数（当前章 / 总章）；`null` = 这本书没有目录。 */
  chapters: { at: number; total: number } | null;
  /** 受上限所限、只载入了部分正文。 */
  capped: boolean;
  t: Translate;
}

export function ReaderFooter({
  progress,
  chapterProgress,
  chapters,
  capped,
  t,
}: ReaderFooterProps): JSX.Element {
  // 当前进度两位小数、本章进度一位小数（用户 2026-10-17 口径）。
  const percent = formatProgressPercent(progress, 2);
  const chapterPercent = formatProgressPercent(chapterProgress, 1);
  return (
    <footer className="br-footer">
      <span className="br-footer-item">
        {t("bookreader.footer.progress")}
        <b>{percent ?? t("bookreader.unknown")}</b>
      </span>
      {chapterPercent !== null && (
        <span className="br-footer-item">
          {t("bookreader.footer.chapterProgress")}
          <b>{chapterPercent}</b>
        </span>
      )}
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
