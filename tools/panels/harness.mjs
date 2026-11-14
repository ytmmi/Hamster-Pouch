// 面板门禁的断言框架（D189）：结果收集、PASS/FAIL 打印、列表比较、注释剥离、汇总。

export const results = [];
export const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
export const eqList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 剥掉 `//` 行注释与 `/* … *​/` 块注释，供"**不得出现**某写法"这类断言使用。
 *
 * 为什么需要：说明性注释里常常**引用**被禁的写法（例如"不用 `loading="lazy"`"），
 * 直接对全文匹配会把注释当代码——出现"注释一写就红"的假失败，或反过来让断言形同虚设。
 * 与 `tools/check-encoding.mjs` 的 `stripComments` 同一口径（各门禁自持一份，
 * 避免为一个小工具引入共享模块）。
 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, " "))
    .join("\n");
}

export function summarize() {
  const passed = results.filter((r) => r.ok).length;
  console.log(String.fromCharCode(10) + passed + "/" + results.length + " 通过");
  process.exit(passed === results.length ? 0 : 1);
}
