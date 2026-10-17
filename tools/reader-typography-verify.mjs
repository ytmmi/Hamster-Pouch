/**
 * 一次性探针：验证"块渲染的 EPUB 正文也能判出 cjk 语言档"。
 *
 * 背景：本轮实测发现 `ReaderStage` 的 `bodyProfile` 原先只收集 `item.text`，
 * 而 EPUB 的正文在 `item.blocks`（`text` 恒为 null）——一本中文 EPUB 因此
 * 永远判成 `latin`、首行缩进 1em（中文书刊口径是 2em）。
 *
 * 这里直接 import **真实实现**（`readerView.readerBodyProfile` +
 * `bookText.collectBlockText`），喂一段"真实 EPUB 形状"的块数据，
 * 验证判定结果是 `cjk`。用完即删。
 */

import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readerView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/readerView.ts")).href
);
const bookText = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/bookreader/bookText.ts")).href
);

/** 真实 EPUB 的一页：块模型（`text` 为 null，正文在 `blocks` 的 `spans` 里）。 */
const zhEpubPage = {
  text: null,
  blocks: [
    { kind: "heading", level: 1, spans: [{ text: "序章 『愚者的坚持』", styles: [] }] },
    {
      kind: "paragraph",
      spans: [{ text: "这是从真实 EPUB 取出的正文形状：段落内容在 spans 里，而不是 text。", styles: [] }],
    },
    {
      kind: "paragraph",
      spans: [{ text: "第二段同样在 spans 里，用来验证语言档判定能看见它们。", styles: [] }],
    },
  ],
};

const enEpubPage = {
  text: null,
  blocks: [
    {
      kind: "paragraph",
      spans: [{ text: "This paragraph mirrors a real EPUB block: content lives in spans. ", styles: [] }],
    },
  ],
};

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 旧口径（只收集 text）——必须判不出来。
const oldWay = readerView.readerBodyProfile(zhEpubPage.text ?? "", "latin");
// 新口径（把块文本也算进来）——必须判出 cjk。
const newWay = readerView.readerBodyProfile(bookText.collectBlockText(zhEpubPage.blocks), "latin");
const enWay = readerView.readerBodyProfile(bookText.collectBlockText(enEpubPage.blocks), "latin");

check(
  "复现疏漏：**只收集 `text`** 时中文 EPUB 判成 latin（`text` 恒为 null ⇒ 样本为空 ⇒ 沿用兜底）",
  oldWay === "latin",
  `旧口径结果=${oldWay}`,
);
check(
  "修复成立：把**块文本**算进来后，同一页判成 cjk（首行缩进因此是 2em）",
  newWay === "cjk",
  `新口径结果=${newWay}（缩进 ${readerView.READER_PARA_INDENT_EM[newWay]}em）`,
);
check(
  "英文 EPUB 仍判 latin（1em 缩进，不被中文规则误伤）",
  enWay === "latin",
  `结果=${enWay}（缩进 ${readerView.READER_PARA_INDENT_EM[enWay]}em）`,
);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
