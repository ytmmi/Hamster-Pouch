/**
 * 面板门禁分节 · 蓝图面板的窄面板布局（D226）。
 *
 * 真机实测：蓝图面板停进 213px 宽的停靠组时，`.bp-main` 是 `row` 且检查器固定
 * `width: 232px; flex-shrink: 0`，画布被挤成 **1px 宽**、检查器还溢出面板。画布是这个
 * 面板的主工作面，窄了就整块让给固定宽的检查器，面板等于不可用。
 *
 * 修法：把 `.bp-panel` 声明成宽度查询容器，窄于阈值时改成上下排（画布先拿固定高度、
 * 检查器整宽排在下面）。断言三条：
 * ① 查询容器就声明在面板自己身上（判据量的必须是这个元素的宽度）；
 * ② 窄面板那一段真的纵向、画布拿到足够的最小高度、检查器不再固定宽；同时宽面板
 *    仍是并排（修窄面板不能反过来毁掉宽面板）；
 * ③ 阈值与固定宽的算术成立（阈值下画布仍留得住 ≥300px，否则等于换了个挤法）。
 *
 * 注意：`.bp-panel` 这个类名图书预览面板也在用（蓝图段之前另有一段样式），所以基础
 * 规则必须只在蓝图那一段里找，否则会把图书预览的声明当成蓝图的。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, stripComments } from "./harness.mjs";
import { ROOT, registrySource, stylesSource } from "./shared.mjs";

const canvasSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/BlueprintCanvas.tsx"),
  "utf8",
);
const panelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/BlueprintPanel.tsx"),
  "utf8",
);

/** 蓝图样式段的起点（`M6：蓝图过渡编辑器` 那行注释之后）。 */
const SECTION_MARK = "M6：蓝图过渡编辑器";
const section = stylesSource.slice(Math.max(0, stylesSource.indexOf(SECTION_MARK)));

/** 扫出所有 `@container (max-width: Npx) { … }` 块（按大括号配平截断）。 */
function containerBlocks(src) {
  const out = [];
  const re = /@container\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m = re.exec(src);
  while (m) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
      i += 1;
    }
    out.push({ limit: Number(m[1]), body: src.slice(re.lastIndex, i - 1) });
    m = re.exec(src);
  }
  return out;
}

/** 取某条规则的声明体（同一选择器只认第一条）。 */
function rule(src, selector) {
  const esc = selector.replace(/[.*+?^$()|[\]\\]/g, (c) => "\\" + c);
  const m = src.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : "";
}

export default async function run() {
  // 基础规则 = 蓝图段去掉容器查询块（窄面板的改写只在那块里，单独断言）。
  const blocks = containerBlocks(section);
  const baseSrc = blocks.reduce((src, b) => src.split(b.body).join(""), section);
  const panel = rule(baseSrc, ".bp-panel");
  const main = rule(baseSrc, ".bp-main");
  const inspector = rule(baseSrc, ".bp-inspector");
  const narrow = blocks.find((b) => /\.bp-main\s*\{/.test(b.body)) ?? null;
  // 注释里也会出现 `.bp-inspector { width: 232px }` 这样的引用，先去掉注释再匹配。
  const nb = narrow ? stripComments(narrow.body) : "";
  const nMain = rule(nb, ".bp-main");
  const nCanvas = rule(nb, ".bp-canvas");
  const nInspector = rule(nb, ".bp-inspector");
  // 基础规则 `.bp-inspector { width: 232px }` 排在容器查询之后：同特异度下后来居上，
  // 改写会被整条盖掉（真机实测过一次），所以窄面板的改写必须用更高特异度的选择器。
  const nInspectorSel = (nb.match(/([^{}]+)\{\s*width:\s*100%/) ?? [])[1] ?? "";
  const canvasMin = Number((nCanvas.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? 0);

  check(
    "蓝图面板：宽度查询容器声明在面板自己身上（窄面板判据量的就是这个元素）",
    /container-type:\s*inline-size/.test(panel) && /display:\s*flex/.test(panel),
    "container-type=" + (/container-type:\s*inline-size/.test(panel) ? "有" : "缺"),
  );

  check(
    "蓝图面板：窄面板改成上下排（画布固定高度、检查器整宽），不再并排把画布挤成一条线",
    /display:\s*flex/.test(main) &&
      /width:\s*232px/.test(inspector) &&
      /flex-direction:\s*column/.test(nMain) &&
      /flex:\s*0 0 auto/.test(nMain) &&
      /min-height:\s*0/.test(nMain) &&
      canvasMin >= 300 &&
      /width:\s*100%/.test(nInspector) &&
      /min-width:\s*0/.test(nInspector) &&
      (nInspectorSel.match(/\.bp-/g) ?? []).length >= 2,
    "画布最小高度=" + (canvasMin || "（缺）") + "px",
  );

  check(
    "蓝图面板：窄面板阈值与检查器固定宽的算术成立（阈值下画布仍留得住 ≥300px）",
    (() => {
      const limit = narrow ? narrow.limit : 0;
      const inspectorWidth = Number((inspector.match(/width:\s*(\d+)px/) ?? [])[1] ?? 0);
      // 面板左右内边距来自通用 `.panel`，画布与检查器之间的间隙来自 `.bp-main` 的 gap。
      const panelPad = Number((rule(stylesSource, ".panel").match(/padding:\s*(\d+)px/) ?? [])[1] ?? 0);
      const gap = Number((main.match(/gap:\s*(\d+)px/) ?? [])[1] ?? 0);
      const leftover = limit - panelPad * 2 - gap - inspectorWidth;
      return limit >= 400 && inspectorWidth > 0 && leftover >= 300;
    })(),
    "阈值=" + (narrow ? narrow.limit : "（缺）") + "px 检查器=" + (inspector.match(/width:\s*(\d+)px/) ?? [])[1] + "px",
  );

  // ============ D228：点标签切进蓝图面板时把键盘焦点交给画布 ============
  //
  // 画布的 Delete / Backspace 删节点与删连线**只在画布有焦点时**才收得到；
  // 画布自己的 onPointerDown 已经会 focus 一次（鼠标点进来就能用），缺的是
  // "从别的面板点标签切进来"这条路径——那时焦点还在 dockview 的标签上。
  //
  // 焦点目标必须是**画布**（.bp-canvas），不是面板根：键处理器挂在画布上，
  // 给根等于换了个地方收不到键。
  check(
    "蓝图面板：点标签切进面板时把键盘焦点拿到画布（与播放器等共用 shared/panelFocus.ts）",
    /import \{ usePanelFocusOnActivate \} from "\.\.\/shared\/panelFocus";/.test(canvasSrc) &&
      /usePanelFocusOnActivate\(api, canvasRef\);/.test(canvasSrc) &&
      /api\?: PanelRenderCtx\["api"\];/.test(canvasSrc) &&
      // 面板把句柄透传给画布，且注册表把 dockview 的面板句柄交给面板——三段缺一即空转。
      /api=\{panelApi\}/.test(panelSrc) &&
      /^ {2}blueprint: \(ctx\) => <BlueprintPanel api=\{ctx\.api\} \/>,$/m.test(registrySource),
  );
  check(
    "蓝图面板：焦点落在画布（.bp-canvas 可聚焦且有键处理），不是没有键处理器的面板根",
    // 同一个根节点上既有 ref 又能聚焦（中间隔着十来行事件处理器，窗口放宽）。
    /ref=\{canvasRef\}[\s\S]{0,900}?tabIndex=\{0\}/.test(canvasSrc) &&
      /onKeyDown=\{onKeyDown\}/.test(canvasSrc) &&
      !/className="bp-canvas"[\s\S]{0,80}?tabIndex=\{-1\}/.test(canvasSrc) &&
      !/className="panel bp-panel"[\s\S]{0,40}?tabIndex=\{0\}/.test(panelSrc),
  );
}
