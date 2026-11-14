/**
 * 面板门禁分节 · 音乐播放器：样式 / 队列 / 歌词 / 八条补丁（原第 38–39 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList } from "./harness.mjs";
import { ROOT, config, doc, stylesSource } from "./shared.mjs";
export default async function run() {
// ==================== 音乐播放器面板：两套样式 / 队列 / 歌词取料（D166） ====================
//
// 防的是"功能写了但口径没接上"：歌词时间轴、同类队列步进、曲名/艺人切分、色晕兜底
// 都是**纯逻辑**，按行为断言；"无封面不出图 / 无歌词不出块 / 收藏只是图标 / 传输按钮
// 只属于音乐模式"这类产品口径按源码锚点断言（组件是 .tsx，Node 剥不了 JSX）。

const lrcMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/lrc.ts")).href
);
const queueView = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/queueView.ts")).href
);
const trackInfoMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/trackInfo.ts")).href
);
const musicStageMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/lyricView.ts")).href
);
const hazeMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/haze.ts")).href
);
const musicStyleMod = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/music/musicStyle.ts")).href
);
const musicSpec = config.panelSpec("music");
const videoSpec = config.panelSpec("player");
const playableQueueSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/playableQueue.ts"),
  "utf8",
);
const videoPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MediaPlayerPanel.tsx"),
  "utf8",
);
const musicPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/MusicPlayerPanel.tsx"),
  "utf8",
);
const musicStageSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/music/MusicStage.tsx"),
  "utf8",
);
const waveformSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/shared/AudioWaveform.tsx"),
  "utf8",
);

check(
  "D166：LRC 一行多个时间标签拆成多句，`[offset:]` 整份平移（正数 = 歌词提前）",
  (() => {
    const doc = lrcMod.parseLrc("[offset:+500]\n[00:02.00][00:03.00]dup\n[00:01.50]one");
    const times = doc.lines.map((line) => line.timeMs);
    // 1.5s / 2s / 3s 各减 500ms，并按时间升序（原文件里 2s 那句在前）。
    return (
      eqList(times, [1000, 1500, 2500]) && eqList(doc.lines.map((l) => l.text), ["one", "dup", "dup"])
    );
  })(),
  JSON.stringify(lrcMod.parseLrc("[offset:+500]\n[00:02.00]a\n[00:01.50]b").lines),
);
check(
  "D166：没有时间轴的纯文本歌词仍然显示（`synced: false`、`timeMs = -1`，不当作「没有歌词」）",
  (() => {
    const doc = lrcMod.parseLrc("第一句\n\n第二句");
    return (
      doc.synced === false &&
      doc.lines.length === 2 &&
      doc.lines.every((line) => line.timeMs === -1 && line.text !== "")
    );
  })(),
);
check(
  "D166：当前行 = 最后一个 `timeMs <= position` 的行；未到第一句为 `-1`（边界不落空档）",
  (() => {
    const lines = [
      { timeMs: 1000, text: "" },
      { timeMs: 2000, text: "" },
      { timeMs: 3000, text: "" },
    ];
    return (
      lrcMod.activeLrcIndex(lines, 999) === -1 &&
      lrcMod.activeLrcIndex(lines, 1000) === 0 &&
      lrcMod.activeLrcIndex(lines, 1999) === 0 &&
      lrcMod.activeLrcIndex(lines, 3000) === 2 &&
      lrcMod.activeLrcIndex(lines, 1e9) === 2 &&
      lrcMod.activeLrcIndex([], 100) === -1 &&
      lrcMod.activeLrcIndex(lines, Number.NaN) === -1
    );
  })(),
);
check(
  "D166：歌词窗口两端夹紧且不改行号（长歌词只渲染窗口，DOM 数不随歌词长度增长）",
  (() => {
    const head = lrcMod.lrcWindow(10, 0, 3);
    const tail = lrcMod.lrcWindow(10, 9, 3);
    const none = lrcMod.lrcWindow(0, 0, 3);
    const overflow = lrcMod.lrcWindow(10, 99, 3);
    return (
      head.start === 0 &&
      head.end === 4 &&
      tail.start === 6 &&
      tail.end === 10 &&
      none.start === 0 &&
      none.end === 0 &&
      // 越界下标夹到末行，不是返回空窗口（那会让"最后一句"永远不高亮）。
      overflow.start === 6 &&
      overflow.end === 10
    );
  })(),
);
check(
  "D166：曲名与艺人按**首个**「 - 」切分；切不出时整串是曲名、艺人为空（索引里没有标签字段）",
  trackInfoMod.trackTitleOf("/m/夏日乐队 - 千变万华.flac") === "千变万华" &&
    trackInfoMod.trackArtistOf("/m/夏日乐队 - 千变万华.flac") === "夏日乐队" &&
    trackInfoMod.trackTitleOf("/m/只有曲名.mp3") === "只有曲名" &&
    trackInfoMod.trackArtistOf("/m/只有曲名.mp3") === null &&
    trackInfoMod.trackTitleOf("/m/A - B - C.mp3") === "B - C",
);
check(
  "D169：色晕用封面主导色里**最大的三个**（不足循环、非法值剔除、无封面走兜底）",
  // 用户 2026-11-13 先要「1-2 个颜色」（D167），随后改口「最大的 3 个色块」（D169）：
  // 光斑固定三盏，后端也只给三个主导色。
  hazeMod.HAZE_LAYER_COUNT === 3 &&
    eqList(hazeMod.hazeColorsOf([]), [...hazeMod.HAZE_FALLBACK_COLORS].slice(0, 3)) &&
    eqList(hazeMod.hazeColorsOf(["#112233"]), ["#112233", "#112233", "#112233"]) &&
    eqList(hazeMod.hazeColorsOf(["#112233", "#445566", "#778899", "#aabbcc"]), [
      "#112233",
      "#445566",
      "#778899",
    ]) &&
    eqList(hazeMod.hazeColorsOf(["nope", "#abc"]), ["#abc", "#abc", "#abc"]) &&
    Object.keys(hazeMod.hazeVars([])).join(",") ===
      "--player-haze-a,--player-haze-b,--player-haze-c",
);

check(
  "D170：色晕跟着封面色走（主导色相不被推走、近中性色不参与、不足时同色系补齐）",
  (() => {
    const rgbOf = (hex) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return null;
      const n = Number.parseInt(m[1], 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    };
    const hsv = (hex) => {
      const rgb = rgbOf(hex);
      if (!rgb) return null;
      const [r, g, b] = rgb.map((v) => v / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d > 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
      }
      return { h: h * 60, s: max === 0 ? 0 : d / max };
    };
    const gap = (a, b) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    // 真实封面（牵一半）：淡蓝灰 45% + 近白 6% + 亮黄 0.8%。
    const vars = hazeMod.stageVars(["#9eb5c0", "#fdfdfd", "#fee105"]);
    const a = hsv(vars["--player-haze-a"]);
    const b = hsv(vars["--player-haze-b"]);
    const c = hsv(vars["--player-haze-c"]);
    const source = hsv("#9eb5c0");
    // 单色封面：三盏必须在同一色系里补，不许转色相凭空造色。
    const solo = hazeMod.stageVars(["#112233"]);
    const soloGap =
      // 单色封面时允许「最小让步」推最多两档（每档 18°），但不许推成另一个色系。
      gap(hsv(solo["--player-haze-a"]).h, hsv(solo["--player-haze-c"]).h) <= 40;
    return (
      a !== null && b !== null && c !== null &&
      gap(a.h, source.h) <= 20 &&
      gap(c.h, source.h) <= 20 &&
      // 近中性色被剔除后，三盏都应是彩色（有饱和度）。
      a.s >= 0.16 && b.s >= 0.16 && c.s >= 0.16 &&
      // 黄这类高饱和色不能被推到橄榄绿（与蓝色的色相距离应保持在暖侧）。
      gap(b.h, hsv("#fee105").h) <= 30 &&
      soloGap
    );
  })(),
);

check(
  "D170：样式 1 的底色由主导色压暗而来（不再固定紫黑），光斑面积按主导色排序",
  (() => {
    const vars = hazeMod.stageVars(["#9eb5c0", "#fdfdfd", "#fee105"]);
    const base = /^#[0-9a-f]{6}$/.test(vars["--player-haze-base"] ?? "");
    const hazeBlock = stylesSource.slice(
      stylesSource.indexOf(".player-haze {"),
      stylesSource.indexOf(".player-haze::after"),
    );
    const width = (selector) => {
      const start = stylesSource.indexOf(`${selector} {`);
      if (start < 0) return -1;
      const block = stylesSource.slice(start, stylesSource.indexOf("}", start));
      const m = /width:\s*([\d.]+)%/.exec(block);
      return m ? Number(m[1]) : -1;
    };
    return (
      base &&
      hazeBlock.includes("background: var(--player-haze-base") &&
      // 兜底值仍写在 var() 里，但不许再出现"写死的紫黑背景"。
      !hazeBlock.includes("background: #241a3a") &&
      width(".player-haze-cluster-a") > width(".player-haze-cluster-b") &&
      width(".player-haze-cluster-b") > width(".player-haze-cluster-c") &&
      width(".player-haze-cluster-c") > 0
    );
  })(),
);
check(
  "D171：失焦不暂停——两个面板都只在「面板隐藏」时暂停（判据不得掺 `isActive`）",
  // 用户 2026-11-13：「音乐播放器在失去焦点后继续播放……只在面板隐藏、切换时暂停，
  // 媒体播放器也同（样修改）」。
  /const visible = Boolean\(panelApi\.isVisible\);/.test(musicPanelSrc) &&
    /const visible = Boolean\(panelApi\.isVisible\);/.test(videoPanelSrc) &&
    !/panelApi\.isVisible && panelApi\.isActive/.test(musicPanelSrc) &&
    !/panelApi\.isVisible && panelApi\.isActive/.test(videoPanelSrc),
);

check(
  "D171：歌词切换提前一个过渡时长（动画收尾刚好切到正在唱的句）",
  // 用户 2026-11-13：「切换歌词时提前一点，使动画结束刚好切换到正在唱的歌词」。
  Number.isFinite(musicStageMod.LYRIC_LEAD_MS) &&
    musicStageMod.LYRIC_LEAD_MS >= 400 &&
    musicStageMod.LYRIC_LEAD_MS <= 700 &&
    /const clockMs = positionMs \+ LYRIC_LEAD_MS;/.test(musicStageSrc) &&
    /activeLrcIndex\(items, clockMs\)/.test(musicStageSrc),
);

check(
  "D173：当前句高亮是**字形蒙版**（渐变 + `background-clip: text`），不是两层裁切盒",
  // 用户 2026-11-13：「样式1歌词高亮会有明显的白色矩形边界」——两层方案里上层的裁切边
  // 会切断文字外发光，屏幕上出现一道矩形；改成单层字形蒙版后没有盒子边。
  musicStageMod.lyricFillPercent(0) === "0%" &&
    musicStageMod.lyricFillPercent(0.5) === "50.00%" &&
    musicStageMod.lyricFillPercent(1) === "100%" &&
    /className="player-lyric-main is-filling"/.test(musicStageSrc) &&
    !/\bstyle=\{\{ \[?"--player-lyric-progress/.test(musicStageSrc) &&
    !/player-lyric-(base|fill)/.test(musicStageSrc) &&
    !/player-lyric-(base|fill)/.test(stylesSource) &&
    /\.player-lyric-main\.is-filling \{/.test(stylesSource) &&
    /background-clip: text;/.test(stylesSource) &&
    /@property --player-lyric-progress \{/.test(stylesSource) &&
    /syntax: "<percentage>";/.test(stylesSource),
);

check(
  "D178：填充进度由 rAF 每帧读播放头直写，CSS 里不再有该属性的 `transition`",
  // 用户 2026-11-14：「歌词的颜色填充实际表演效果观感卡顿」。
  // 根因是 `positionMs` 只有 `timeupdate` 的 ~4Hz，靠 `transition: … 0.2s` 补台阶时
  // **每来一个新值就重启过渡**（200ms 过渡 + 250ms 更新）→「追上—停住—再追」的锯齿。
  // 现在每帧读 `audio.currentTime`（精确、与音频同源），只 setProperty，不碰 React。
  /function useLyricFill\(/.test(musicStageSrc) &&
    /requestAnimationFrame\(step\)/.test(musicStageSrc) &&
    /node\.style\.setProperty\("--player-lyric-progress", pct\);/.test(musicStageSrc) &&
    // 换句才 setState：填充本身不触发 re-render。
    /const \[activeIndex, setActiveIndex\] = useState\(-1\);/.test(musicStageSrc) &&
    // 值没变就不写，省掉一次重绘。
    /if \(pct === paintedRef\.current\) return;/.test(musicStageSrc) &&
    // 只匹配**声明行**（行首缩进 + `transition:`）：注释里提到这条属性名不算违规。
    !/^\s*transition: --player-lyric-progress/m.test(stylesSource) &&
    // 面板必须把「实时读数」交下来，否则上层只能退回 250ms 的粗时钟。
    /readPositionMs=\{readPositionMs\}/.test(musicPanelSrc) &&
    /const readPositionMs = useCallback\(\(\): number \| null => \{/.test(musicPanelSrc) &&
    /return audio\.currentTime \* 1000;/.test(musicPanelSrc),
);

check(
  "D174：传输按钮不抢焦点，且空格 / 回车 / 方向键在按钮上被吞掉",
  // 用户 2026-11-14：「当焦点在播放暂停图标时，空格、方向键都可以触发播放暂停」。
  // 三层保险：`tabIndex={-1}`（不进 Tab 序列）、`onMouseDown` 不抢焦点、`onKeyDown` 拦激活键。
  (() => {
    const volumeBlock = (() => {
      const at = videoPanelSrc.indexOf("className={`player-volume-btn");
      return at < 0 ? "" : videoPanelSrc.slice(at, at + 320);
    })();
    return (
      /const keepFocusOnStage = \(event: \{ preventDefault: \(\) => void \}\) => \{/.test(musicStageSrc) &&
      /const swallowButtonKeys = \(event: \{/.test(musicStageSrc) &&
      /event\.key === " " \|\| event\.key === "Enter" \|\| event\.key === "Spacebar" \|\| event\.key\.startsWith\("Arrow"\)/
        .test(musicStageSrc) &&
      (musicStageSrc.match(/onMouseDown=\{keepFocusOnStage\}/g) ?? []).length === 5 &&
      (musicStageSrc.match(/onKeyDown=\{swallowButtonKeys\}/g) ?? []).length === 5 &&
      (musicStageSrc.match(/^\s+tabIndex=\{-1\}$/gm) ?? []).length === 5 &&
      /tabIndex=\{-1\}/.test(volumeBlock) &&
      /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/.test(volumeBlock)
    );
  })(),
);

check(
  "D179：折行的当前句按**阅读顺序**填（每行一层横向渐变），不是从上到下盖帘子",
  // 用户 2026-11-14：「颜色填充在遇到一句歌词但是换行时，填充顺序变为了从上到下，修复」。
  // 纵向渐变的等值线是水平线：两行被同一道帘子自上而下盖住，字形在行内被垂直切开。
  // 现在按文本节点量出每行的矩形（跳过 `<rt>`，注音是贴底字的小字），一行一层横向渐变。
  /const bands = lyricBands\(rects\);/.test(musicStageSrc) &&
    /lyricBands,/.test(musicStageSrc) &&
    /const fill = lyricBandFill\(bands, progress\);/.test(musicStageSrc) &&
    /node\.style\.setProperty\("background-image", fill\.image\);/.test(musicStageSrc) &&
    // 量测必须**跳过注音**：`<rt>` 也是文本节点，整块量会多出一条假的行。
    /element\.closest\("rt"\)/.test(musicStageSrc) &&
    /NodeFilter\.SHOW_TEXT/.test(musicStageSrc) &&
    // 面板宽度变化会改变折行位置：要跟着重算。
    /new ResizeObserver\(\(\) => measure\(\)\)/.test(musicStageSrc) &&
    /data-wrapped=\{wrapped \? "true" : "false"\}/.test(musicStageSrc) &&
    // CSS 里不许再留那条"从上到下"的**歌词填充**渐变（它会盖掉分行的横向渐变）。
    // 注意 `to bottom` 本身在别处是合法的（`mask-image` 的渐隐、色晕的暗角）。
    !/linear-gradient\(\s*to bottom,\s*var\(--player-lyric-sung\)/.test(stylesSource) &&
    !/\.player-lyric-main\.is-filling\[data-wrapped="true"\] \{/.test(stylesSource),
);

check(
  "D179：分行填充的顺序与速度（按行宽切分：读满一行再下一行，行内速度恒定）",
  // 用户 2026-11-14：「遇到一句歌词但是换行时，填充顺序变为了从上到下」——
  // 顺序必须是阅读顺序：第一行从左刷到右之后才轮到第二行。按行宽切分（行宽 ∝ 字数），
  // 于是整句的推进速度恒定；同一行里相邻文本节点的矩形纵向重叠，归并成一条。
  (() => {
    const bands = [
      { left: 0, top: 0, width: 300, height: 20 },
      { left: 0, top: 20, width: 100, height: 20 },
    ];
    const at = (progress) =>
      musicStageMod.lyricBandProgress(bands, progress).map((value) => Math.round(value * 100));
    const merged = musicStageMod.lyricBands([
      { left: 0, top: 0, right: 120, bottom: 20 },
      { left: 120, top: 1, right: 300, bottom: 21 },
      { left: 0, top: 20, right: 100, bottom: 40 },
    ]);
    return (
      JSON.stringify(at(0)) === JSON.stringify([0, 0]) &&
      // 300 / 400 = 0.75 正好把第一行读满，第二行一点没动。
      JSON.stringify(at(0.75)) === JSON.stringify([100, 0]) &&
      JSON.stringify(at(0.375)) === JSON.stringify([50, 0]) &&
      JSON.stringify(at(1)) === JSON.stringify([100, 100]) &&
      merged.length === 2 &&
      Math.round(merged[0].width) === 300 &&
      Math.round(merged[1].top) === 20 &&
      // 退化的量测（宽度为 0 / NaN）不能让填充炸掉：退回整句进度。
      musicStageMod.lyricBands([{ left: 0, top: 0, right: 0, bottom: 20 }]).length === 0 &&
      JSON.stringify(musicStageMod.lyricBandProgress([], 0.5)) === JSON.stringify([])
    );
  })(),
);

check(
  "D179：样式 2 的填充极性跟样式 1 一致（已唱用强调色，未唱是同色淡档）",
  // 用户 2026-11-14：「样式2的颜色填充颜色反了」——此前已唱画成深墨（`--player-ink`）、
  // 未唱才是饱和度更高的紫，屏幕上看"浅的那半边"才是唱过的。两套样式取同一个方向：
  // 已唱更实（样式 1 = 纯白，样式 2 = 强调色），未唱是同色的淡档。
  (() => {
    const at = stylesSource.indexOf("--player-lyric-sung: var(--player-accent");
    const discBody =
      at < 0 ? "" : stylesSource.slice(Math.max(0, at - 260), Math.min(stylesSource.length, at + 320));
    const hazeAt = stylesSource.indexOf("--player-lyric-sung: #fff;");
    const hazeBody =
      hazeAt < 0
        ? ""
        : stylesSource.slice(Math.max(0, hazeAt - 120), Math.min(stylesSource.length, hazeAt + 220));
    return (
      /--player-lyric-sung: var\(--player-accent, #5b46c9\);/.test(discBody) &&
      /--player-lyric-unsung: color-mix\(in srgb, var\(--player-accent, #5b46c9\) 34%, transparent\);/.test(
        discBody,
      ) &&
      !/--player-lyric-sung: var\(--player-ink/.test(stylesSource) &&
      /--player-lyric-sung: #fff;/.test(hazeBody) &&
      /--player-lyric-unsung: rgba\(255, 255, 255, 0\.55\);/.test(hazeBody)
    );
  })(),
);

check(
  "D172：填充进度与「当前行」判定共用一个时钟（否则高亮落后半拍、末尾不填满）",
  // 用户 2026-11-13：「会落后 2 个字，然后最后 2 个字不填充就跳到了下一句」——
  // 根因是判行用 `positionMs + LYRIC_LEAD_MS`、填充用 `positionMs`，两个钟差 480ms。
  /const clockMs = positionMs \+ LYRIC_LEAD_MS;/.test(musicStageSrc) &&
    /activeLrcIndex\(items, clockMs\)/.test(musicStageSrc) &&
    // 填充那一支（rAF 里）也要走同一个提前量：`clock = base + LYRIC_LEAD_MS`。
    /const clock = base \+ LYRIC_LEAD_MS;/.test(musicStageSrc) &&
    /lineProgress\(item\.timeMs, next \? next\.timeMs : null, clock\)/.test(musicStageSrc) &&
    !/lineProgress\(item\.timeMs, next \? next\.timeMs : null, positionMs\)/.test(musicStageSrc),
);

check(
  "D172：歌词窗口是 7 行（当前行上下各 3 行）",
  // 用户 2026-11-13：「歌词显示由当前的 5 行改为 7 行」。
  /const LRC_RADIUS = 3;/.test(musicStageSrc) &&
    /lrcWindow\(items\.length, activeIndex, LRC_RADIUS\)/.test(musicStageSrc) &&
    JSON.stringify(lrcMod.lrcWindow(20, 10, 3)) === JSON.stringify({ start: 7, end: 14 }) &&
    JSON.stringify(lrcMod.lrcWindow(20, 0, 3)) === JSON.stringify({ start: 0, end: 4 }) &&
    JSON.stringify(lrcMod.lrcWindow(5, 4, 3)) === JSON.stringify({ start: 1, end: 5 }),
);

check(
  "D166：上一首 / 下一首只在**同类**里走、端点循环（音频不跳视频，视频也不跳音频）",
  (() => {
    const files = [
      { media_type: "audio" },
      { media_type: "video" },
      { media_type: "audio" },
      { media_type: "image" },
    ];
    return (
      queueView.stepPlayable(files, 0, 1, "audio") === 2 &&
      queueView.stepPlayable(files, 2, 1, "audio") === 0 &&
      queueView.stepPlayable(files, 0, -1, "audio") === 2 &&
      queueView.stepPlayable(files, 1, 1, "video") === 1 &&
      // 当前位置不属于该类（例如在视频上按「上一首」）→ 原地不动，不猜语义。
      queueView.stepPlayable(files, 1, 1, "audio") === 1
    );
  })(),
);
check(
  "D166：队列边界（空 / 不在队列内 / delta 0）返回原值或 `-1`；队列只收音频与视频",
  queueView.stepPlayable([], 0, 1, "audio") === -1 &&
    queueView.stepPlayable([{ media_type: "audio" }], 0, 0, "audio") === 0 &&
    queueView.stepPlayable([{ media_type: "audio" }], -1, 1, "audio") === -1 &&
    queueView.isPlayable({ media_type: "audio" }) &&
    queueView.isPlayable({ media_type: "video" }) &&
    !queueView.isPlayable({ media_type: "image" }) &&
    queueView.playableFiles([{ media_type: "audio" }, { media_type: "image" }]).length === 1,
);
check(
  "D166：随机只在**同类**里抽且不抽到自己（单曲队列原地不动）；循环 `off` 在端点停住、`all` 环绕",
  (() => {
    const files = [
      { media_type: "audio" },
      { media_type: "video" },
      { media_type: "audio" },
      { media_type: "audio" },
    ];
    const shuffleFirst = { shuffle: true, random: () => 0 };
    const shuffleLast = { shuffle: true, random: () => 0.9999 };
    return (
      // 随机落到"同类里的其它项"，不会抽回自己、也不会抽到视频/图片。
      queueView.stepPlayable(files, 0, 1, "audio", shuffleFirst) === 2 &&
      queueView.stepPlayable(files, 0, 1, "audio", shuffleLast) === 3 &&
      queueView.stepPlayable(files, 2, -1, "audio", { shuffle: true, random: () => 0 }) === 0 &&
      // 同类只有自己 → 原地不动（不是 -1，也不是跳到别的类型）。
      queueView.stepPlayable([{ media_type: "audio" }, { media_type: "video" }], 0, 1, "audio", shuffleFirst) === 0 &&
      // 端点：off 停住（-1）且按钮禁用；all/one 都环绕（one 只管自动续播）。
      queueView.stepPlayable(files, 3, 1, "audio", { repeat: "off" }) === -1 &&
      queueView.canStepPlayable(files, 3, 1, "audio", { repeat: "off" }) === false &&
      queueView.stepPlayable(files, 3, 1, "audio", { repeat: "all" }) === 0 &&
      queueView.stepPlayable(files, 3, 1, "audio", { repeat: "one" }) === 0 &&
      queueView.stepPlayable(files, 0, -1, "audio", { repeat: "off" }) === -1 &&
      queueView.canStepPlayable(files, 0, 1, "audio", { repeat: "all" }) === true
    );
  })(),
);
check(
  "D166：双语歌词按「同刻双时间标签」配成原文 + 译文（含假名的那行在上，噪声行不占位）",
  // 用户 2026-11-14：「深海少女日文在上中文在下，`//` 与 `曲：…` 不出现」。
  // 双语 .lrc 的行序不统一（深海少女那份是"先译文后原文"），所以主副由**假名**判定；
  // `//`、空行、`曲：/词：` 这类噪声行只在配对阶段剔除，`parseLrc` 不动数据。
  (() => {
    const paired = lrcMod.pairLrcLines([
      { timeMs: 1000, text: "原文" },
      { timeMs: 1080, text: "译文" },
      { timeMs: 5000, text: "下一句原文" },
      { timeMs: 8000, text: "隔太远" },
      { timeMs: 8010, text: "   " },
    ]);
    // 真实语料的行序：译文在前、原文在后（含假名）。
    const swapped = lrcMod.pairLrcLines([
      { timeMs: 9940, text: "沉至悲伤海洋的我" },
      { timeMs: 9940, text: "目を開けるのも億劫" },
    ]);
    // 噪声行如果留着，`词：ゆうゆ` 会跟版权声明配成一对，把版权声明顶到歌词区。
    const noisy = lrcMod.pairLrcLines([
      { timeMs: 2920, text: "腾讯享有本翻译作品的著作权" },
      { timeMs: 2920, text: "词：ゆうゆ" },
      { timeMs: 3890, text: "//" },
      { timeMs: 4470, text: "曲：ゆうゆ" },
      { timeMs: 5450, text: "//" },
      { timeMs: 6600, text: "悲しみの海に沈んだ私" },
    ]);
    return (
      lrcMod.LRC_PAIR_GAP_MS === 120 &&
      paired.length === 3 &&
      paired[0].main === "原文" &&
      paired[0].sub === "译文" &&
      paired[0].timeMs === 1000 &&
      paired[1].main === "下一句原文" &&
      paired[1].sub === null &&
      // 下一行是空行 → 不把空白当译文，空行自己也不再成一项。
      paired[2].main === "隔太远" &&
      paired[2].sub === null &&
      swapped.length === 1 &&
      swapped[0].main === "目を開けるのも億劫" &&
      swapped[0].sub === "沉至悲伤海洋的我" &&
      noisy.length === 1 &&
      noisy[0].main === "悲しみの海に沈んだ私" &&
      noisy[0].sub === null &&
      noisy[0].timeMs === 6600 &&
      // 放宽阈值可以把 3 秒的间隔也配上（阈值是参数，不是写死的语义）。
      lrcMod.pairLrcLines(
        [
          { timeMs: 0, text: "a" },
          { timeMs: 3000, text: "b" },
        ],
        3000,
      )[0].sub === "b"
    );
  })(),
);
check(
  "D166：两套样式的颜色都由封面主色**算**出来（换一组主色整套变量就变，CSS 里不写死封面色）",
  (() => {
    const warm = hazeMod.stageVars(["#e0709e", "#8f6ee8", "#5b8fe0"]);
    const cold = hazeMod.stageVars(["#1f8f6e", "#2a6fd0", "#c9d34a"]);
    // 纯色是 `#rrggbb`，带透明度的是 `rgba(...)`（`withAlpha` 的产物）。
    const color = /^(?:#[0-9a-f]{6}|rgba?\([^)]*\))$/i;
    const keys = [
      "--player-haze-a",
      "--player-haze-b",
      "--player-ink",
      "--player-accent",
      "--player-sky-1",
      "--player-sky-2",
      "--player-disc-1",
      "--player-disc-2",
      "--player-disc-ring",
    ];
    // 音乐段的 CSS 里不得出现这两组主色的字面值：颜色只能走变量。
    const musicCss = stylesSource.slice(
      stylesSource.indexOf(".player-stage[data-mode=\"music\"]"),
      stylesSource.indexOf("/* ===== 图像查看器面板 ===== */"),
    );
    return (
      keys.every((key) => color.test(warm[key] ?? "") && color.test(cold[key] ?? "")) &&
      // 同一组主色 → 完全确定（不掺随机数）；换主色 → 至少唱片/天空这两处跟着变。
      JSON.stringify(hazeMod.stageVars(["#e0709e", "#8f6ee8", "#5b8fe0"])) === JSON.stringify(warm) &&
      warm["--player-disc-1"] !== cold["--player-disc-1"] &&
      warm["--player-sky-1"] !== cold["--player-sky-1"] &&
      !musicCss.includes("#e0709e") &&
      !musicCss.includes("#8f6ee8") &&
      !musicCss.includes("#5b8fe0") &&
      // 墨色只允许以 `var(--player-ink, #232840)` 的兜底形态出现（变量没注入时
      // 至少不出现白底白字），不允许写成裸色值。
      (musicCss.match(/#232840/g) ?? []).length ===
        (musicCss.match(/var\(--player-[a-z0-9-]+, #232840\)/g) ?? []).length
    );
  })(),
);
check(
  "D166：样式 1 的歌词错位随面板宽度缩放（单位是 `cqw`，不是固定像素）；样式 2 不错位",
  (() => {
    const indent = (d) => musicStageMod.lyricIndent(d);
    return (
      indent(0) === 0 &&
      indent(-1) === 0 &&
      indent(1) > 0 &&
      indent(2) > indent(1) &&
      indent(3) > indent(2) &&
      // 远处的行不再无限右移（阶梯部分 5 行封顶，只剩一点行号抖动），
      // 长歌词不会把行推出可视区。
      indent(9) < 20 &&
      indent(9) - indent(5) < 2 &&
      /marginLeft: `\$\{indent\}cqw`/.test(musicStageSrc) &&
      // 错位只发生在 haze 变体：样式 2 是"左对齐 + 透明度分层"。
      /variant === "haze" && !isActive /.test(musicStageSrc)
    );
  })(),
);
check(
  "D166：样式是**音乐面板**的设置 `panel.music.style`（select，候选与 `MUSIC_STYLES` 逐项相等、缺省 `haze`）",
  (() => {
    const decl = musicSpec?.settings?.find((setting) => setting.key === "style");
    const values = (decl?.options ?? []).map((option) => option.value);
    return (
      decl?.kind === "select" &&
      decl?.default === musicStyleMod.DEFAULT_MUSIC_STYLE &&
      eqList(values, [...musicStyleMod.MUSIC_STYLES]) &&
      musicStyleMod.MUSIC_STYLE_SETTING_KEY === "style" &&
      musicStyleMod.normalizeMusicStyle("disc") === "disc" &&
      // 未知值（旧版本 / 手改库）落回缺省，不是空白舞台。
      musicStyleMod.normalizeMusicStyle("nope") === musicStyleMod.DEFAULT_MUSIC_STYLE &&
      musicStyleMod.musicStyleTitleKey("disc") === "music.settings.style.disc" &&
      // 媒体播放器（视频）不持有样式设置：样式只属于音乐面板。
      !videoSpec?.settings?.some((setting) => setting.key === "style")
    );
  })(),
  JSON.stringify(musicSpec?.settings?.find((setting) => setting.key === "style") ?? null),
);
check(
  "D166：音乐播放器是**独立面板**（`music`），媒体播放器是**通用**播放器（视频 + 音频基础功能）——特化符号只在音乐面板里",
  // 注册层：两个面板各自是注册项，设置各存各的。
  config.BUILTIN_PANEL_IDS.includes("music") &&
    musicSpec?.titleKey === "panel.music" &&
    musicSpec?.category === "media" &&
    // 音乐面板源码：舞台只被 `MusicStage` 一处渲染，外面套的是音乐模式画布。
    (musicPanelSrc.match(/<MusicStage/g) ?? []).length === 1 &&
    /data-mode="music"/.test(musicPanelSrc) &&
    /className="player-transport"/.test(musicStageSrc) &&
    // 媒体播放器面板：音频只是"基础功能"——波形在、播放队列混装、音乐特化符号统统不在。
    // （用户 2026-11-13 裁决：视频播放器可以播放音频，只是音频只有基础功能。）
    /<AudioWaveform/.test(videoPanelSrc) &&
    /usePlayableQueue\(app, panelApi, "any"\)/.test(videoPanelSrc) &&
    !/<MusicStage/.test(videoPanelSrc) &&
    !/player-transport/.test(videoPanelSrc) &&
    !/player-lyrics|player-haze|player-vinyl|player-disc/.test(videoPanelSrc) &&
    !/data-mode/.test(videoPanelSrc) &&
    // 播放请求也分家：音频进 `musicPlayStore`，视频进 `playerPlayStore`。
    /requestMusicPlay/.test(readFileSync(join(ROOT, "apps/desktop/src/app_ui/core/blueprintExecutor.ts"), "utf8")),
);
check(
  "D166：`\"any\"` 是队列口径不是媒体类型——取数时展开成 `[\"audio\", \"video\"]`",
  // 后端逐个校验 `media_types`，把口径值直接发过去会被判成「未知媒体类型」
  // （真机实测：面板一挂载就在状态栏报「读取播放队列失败：请求内容不合法」）。
  /mediaTypes: kind === "any" \? \["audio", "video"\] : \[kind\]/.test(playableQueueSrc) &&
    !/mediaTypes: \[kind\]/.test(playableQueueSrc),
  playableQueueSrc.match(/mediaTypes:[^,\n]*/)?.[0] ?? "",
);
check(
  "D167：缺封面用曲名渲染占位封面（同一块画布），缺歌词整块不渲染",
  // 用户 2026-11-13：「不是省略封面，而是用音乐名渲染封面进行占位，禁止因为缺失封面
  // 而改变样式的布局」。因此封面两处都**恒常渲染**，只是内容在 `CoverVisual` 里二选一：
  // 有 URL 出 `<img>`，没有则出带曲名的占位块。
  (musicStageSrc.match(/<CoverVisual/g) ?? []).length === 2 &&
    /className=\{`\$\{className\} is-placeholder`\}/.test(musicStageSrc) &&
    /player-cover-name/.test(musicStageSrc) &&
    /player-cover\.is-placeholder/.test(stylesSource) &&
    /player-disc-cover\.is-placeholder/.test(stylesSource) &&
    !/data-empty/.test(musicStageSrc) &&
    /if \(!items \|\| items\.length === 0\) return null;/.test(musicStageSrc) &&
    !/player\.noLyrics/.test(musicStageSrc),
);
const audioTagsSrc = readFileSync(join(ROOT, "crates/hp-media/src/tags.rs"), "utf8");
const playerCommandSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/player.rs"),
  "utf8",
);
check(
  "D167：曲名/艺人**先读音频标签**（ffprobe），读不到或没定义才回退文件名（左艺人、右曲名）",
  // 用户 2026-11-13 裁决：「读取音频标签(title/artist)，无法读取，或未标签定义就回退(左艺人、右曲名)」。
  // 索引里没有标签字段（D115 ⑫ 的标签索引仍未排期），所以标签是播放时按需读的。
  /pub fn read_audio_tags\(/.test(audioTagsSrc) &&
    /-show_entries/.test(audioTagsSrc) &&
    /format_tags/.test(audioTagsSrc) &&
    /album_artist/.test(audioTagsSrc) &&
    /hp_media::read_audio_tags/.test(playerCommandSrc) &&
    /ffprobe/.test(playerCommandSrc) &&
    /title: tags\.title/.test(playerCommandSrc) &&
    /artist: tags\.artist/.test(playerCommandSrc) &&
    /media\.tagTitle \?\? trackTitleOf/.test(musicPanelSrc) &&
    /media\.tagArtist \?\? trackArtistOf/.test(musicPanelSrc),
);
check(
  "D167：唱片圆心缺封面时不渲染文字——唱片只有「有没有图」，没有「少一块」（用户 m02898）",
  // 同一块画布，但两种占位的内容不同：封面卡写字（用户 m02560 要的"用音乐名占位"），
  // 唱片圆**不写字**（写上去像贴纸，而不是唱片本身）。
  /label = true,/.test(musicStageSrc) &&
    /label\?: boolean;/.test(musicStageSrc) &&
    /label=\{false\}/.test(musicStageSrc) &&
    /\{label \? <span className="player-cover-name">\{title\}<\/span> : null\}/.test(musicStageSrc) &&
    (() => {
      const start = stylesSource.indexOf(".player-disc-cover.is-placeholder {");
      const end = stylesSource.indexOf("}", start);
      const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
      return body.length > 0 && !/line-clamp|font-/.test(body);
    })(),
);
check(
  "D167：兜底色晕是**浅色**（默认可读白字），且兜底色不经 `vivid` 压暗",
  // 用户 2026-11-13：「默认的颜色晕不要暗色」。vivid 会把颜色压到 0.30–0.58 亮度，
  // 那只对"封面主色常常是白底"有用；兜底色本来就该是亮的氛围色。
  hazeMod.HAZE_FALLBACK_COLORS.every((hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return (r + g + b) / 3 > 0.6;
  }) &&
    hazeMod.hazeVars([])["--player-haze-a"] === hazeMod.HAZE_FALLBACK_COLORS[0] &&
    hazeMod.hazeVars([])["--player-haze-b"] === hazeMod.HAZE_FALLBACK_COLORS[1] &&
    hazeMod.hazeVars([])["--player-haze-c"] === hazeMod.HAZE_FALLBACK_COLORS[2] &&
    hazeMod.HAZE_LAYER_COUNT === 3 &&
    // 有封面色时才做色相铺开：单色系封面也要能铺出三盏不同色相的光斑。
    hazeMod.hazeVars(["#eeeeee"])["--player-haze-a"] !== "#eeeeee",
);
check(
  "D175：色晕是**合成层动画**——噪波形状离线烘焙成纹理，动画只动 transform / opacity",
  // 用户 2026-11-14：「优化渲染颜色晕的性能问题，可以使用 webGPU 进行渲染和其他优化方式」。
  // 旧实现每团一个实时 `feTurbulence`+`feDisplacementMap` 滤镜、外层再跑 52s 的
  // `hue-rotate` 动画，三个大滤镜层每帧重新栅格化（同引擎实测 51 fps / p95 30ms /
  // 峰值 265ms）。现在形状烘焙进 data-URI 纹理，元素只剩合成器动画（158 fps / p95 6ms）。
  (() => {
    const textures = ["a", "b", "c"].map((key) => {
      const match = stylesSource.match(new RegExp(`--player-haze-tex-${key}: url\\("data:image/svg\\+xml;base64,([^"]+)"\\);`));
      return match ? Buffer.from(match[1], "base64").toString("utf8") : "";
    });
    return (
      textures.every((svg) => /feTurbulence/.test(svg) && /feDisplacementMap/.test(svg) && /feGaussianBlur/.test(svg)) &&
      // 每团用不同的种子，叠起来才不会看出"同一张图转了个角度"。
      new Set(textures.map((svg) => (svg.match(/seed='(\d+)'/) ?? [])[1])).size === 3 &&
      // 运行时不再有任何滤镜：形状来自 mask，动画只动 transform / opacity。
      !/filter: url\(#/.test(stylesSource) &&
      /-webkit-mask-image: var\(--player-haze-tex-a\)/.test(stylesSource) &&
      /contain: strict/.test(stylesSource) &&
      /will-change: transform/.test(stylesSource) &&
      // 关键帧里只许出现 transform / opacity（出现 border-radius / filter 就说明又在逐帧重绘）。
      ["a", "b", "c"].every((key) => {
        const at = stylesSource.indexOf(`@keyframes player-haze-drift-${key} {`);
        if (at < 0) return false;
        // 用花括号配平取出这一个关键帧块（三块之间还夹着注释，不能按"下一个 @"切）。
        const open = stylesSource.indexOf("{", at);
        let depth = 0;
        let end = open;
        for (let i = open; i < stylesSource.length; i += 1) {
          if (stylesSource[i] === "{") depth += 1;
          else if (stylesSource[i] === "}") {
            depth -= 1;
            if (depth === 0) { end = i; break; }
          }
        }
        const body = stylesSource.slice(open, end);
        return /transform:/.test(body) && !/border-radius|filter:|margin|left:|top:/.test(body);
      }) &&
      // 减少动效时依旧全停。
      (() => {
        const at = stylesSource.indexOf("@media (prefers-reduced-motion: reduce) {");
        const body = at >= 0 ? stylesSource.slice(at, stylesSource.indexOf(".player-disc {", at)) : "";
        return body.includes(".player-haze,") && body.includes(".player-haze-blob,");
      })()
    );
  })(),
);

check(
  "D168：样式 2 的控制区固定在面板底部、只占左侧列宽（唱片仍钉在右上被裁切）",
  // 用户 2026-11-13 D168：「控制图标默认在面板底部，和样式 1 类似，不是和唱片平齐」。
  (() => {
    const start = stylesSource.indexOf(".player-vinyl {");
    const end = stylesSource.indexOf("}", start);
    const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
    return (
      /top: -\d+%/.test(body) &&
      /right: -\d+%/.test(body) &&
      /width: min\(120cqh, 78cqw\)/.test(body)
    );
  })() &&
    (() => {
      const start = stylesSource.indexOf(".player-bar {");
      const end = stylesSource.indexOf("}", start);
      const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
      // 底栏落在左列第二行：宽度天然等于左列，不会横跨唱片下方。
      return /grid-column: 1/.test(body) && /grid-row: 2/.test(body);
    })() &&
    (() => {
      const start = stylesSource.indexOf('.player-layout[data-variant="disc"] {');
      const end = stylesSource.indexOf("}", start);
      const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
      return /grid-template-rows: minmax\(0, 1fr\) auto/.test(body);
    })() &&
    /<div className="player-bar" data-variant="disc">/.test(musicStageSrc) &&
    // 旧口径（用 min-height 把控制条顶到画面中部）必须彻底消失。
    !/min-height: 30cqh/.test(stylesSource),
);
check(
  "D166：收藏只是图标（非交互 `span`，不是 disabled 按钮——禁用会暗示「现在不能用」）",
  (() => {
    const start = musicStageSrc.indexOf("function FavoriteIcon");
    const end = musicStageSrc.indexOf("function PlayIcon");
    const body = start >= 0 && end > start ? musicStageSrc.slice(start, end) : "";
    return body.includes("<span") && body.includes('role="img"') && !body.includes("<button");
  })(),
);
check(
  "D166：唱片只在播放时旋转，暂停停在当前角度（不归零），减少动效时全停",
  /data-playing=\{playing \? "true" : "false"\}/.test(musicStageSrc) &&
    /\.player-disc\s*\{[^}]*animation:\s*player-disc-spin[^}]*animation-play-state:\s*paused/.test(
      stylesSource,
    ) &&
    /\.player-disc\[data-playing="true"\]\s*\{[^}]*animation-play-state:\s*running/.test(
      stylesSource,
    ) &&
    /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.player-disc[^}]*animation:\s*none/.test(
      stylesSource,
    ),
);
check(
  "D168：收藏爱心是空心描边（实心红留给「已收藏」，而收藏功能尚未实装）",
  (() => {
    const start = musicStageSrc.indexOf("function HeartIcon");
    const end = musicStageSrc.indexOf("function SpeakerIcon");
    const body = start >= 0 && end > start ? musicStageSrc.slice(start, end) : "";
    return body.includes('fill="none"') && body.includes('stroke="currentColor"');
  })(),
);
check(
  "D168：随机与循环互斥（点其一必取消另一个，缺省是顺序播放）",
  // 用户 2026-11-13 D168：「随机和循环的功能是冲突的，当点击了其中之一要取消另一个」。
  queueView.DEFAULT_PLAYBACK_MODE.shuffle === false &&
    queueView.DEFAULT_PLAYBACK_MODE.repeat === "off" &&
    JSON.stringify(queueView.toggleShuffleMode({ shuffle: false, repeat: "off" })) ===
      JSON.stringify({ shuffle: true, repeat: "off" }) &&
    // 循环开着时点随机：循环被取消。
    JSON.stringify(queueView.toggleShuffleMode({ shuffle: false, repeat: "all" })) ===
      JSON.stringify({ shuffle: true, repeat: "off" }) &&
    // 再点一次随机：回到顺序播放。
    JSON.stringify(queueView.toggleShuffleMode({ shuffle: true, repeat: "off" })) ===
      JSON.stringify({ shuffle: false, repeat: "off" }) &&
    // 循环档位 off → all → one → off，且每一档都取消随机。
    JSON.stringify(queueView.cycleRepeatMode({ shuffle: false, repeat: "off" })) ===
      JSON.stringify({ shuffle: false, repeat: "all" }) &&
    JSON.stringify(queueView.cycleRepeatMode({ shuffle: true, repeat: "all" })) ===
      JSON.stringify({ shuffle: false, repeat: "one" }) &&
    JSON.stringify(queueView.cycleRepeatMode({ shuffle: false, repeat: "one" })) ===
      JSON.stringify({ shuffle: false, repeat: "off" }) &&
    /toggleShuffleMode\(current\)/.test(musicPanelSrc) &&
    /cycleRepeatMode\(current\)/.test(musicPanelSrc),
);
check(
  "D168：播放内核不在「设源」的同一拍调 play()（load/play 竞态会让切歌不出声）",
  // 真机现象：切歌成功但没声音、图标还停在「||」。两面板都必须等 loadedmetadata 再播。
  !/\.load\(\)/.test(videoPanelSrc) &&
    !/\.load\(\)/.test(musicPanelSrc) &&
    /const onLoadedMetadata = \(\) => \{/.test(videoPanelSrc) &&
    /const onLoadedMetadata = \(\) => \{/.test(musicPanelSrc) &&
    /if \(autoPlayRef\.current\) \{/.test(videoPanelSrc) &&
    /if \(autoPlayRef\.current\) \{/.test(musicPanelSrc) &&
    // 切歌先落「暂停」态：图标不能等元素事件才纠正。
    /setPlaying\(false\);/.test(musicPanelSrc),
);
check(
  "D168：播放器音频时波形单击 = 暂停/继续、拖动 = 定位",
  // 用户口径：媒体播放器的单击暂停/继续要与视频一致；波形铺满画面区后必须区分
  // 「单击」与「拖动」，否则点一下既定位又切换播放。
  /onTap\?: \(\) => void;/.test(waveformSrc) &&
    /WAVE_DRAG_THRESHOLD_PX = 4/.test(waveformSrc) &&
    /onPointerUp=\{onSeek \|\| onTap \? onPointerUp : undefined\}/.test(waveformSrc) &&
    /event\.stopPropagation\(\);/.test(waveformSrc) &&
    /onTap=\{\(\) => void handleStageClick\(\)\}/.test(videoPanelSrc),
);
check(
  "D168：歌词优先读同目录 .lrc，读不到才用音频内嵌标签",
  // 用户 2026-11-13：微云下载的 flac 把 LRC 存在 `LYRICS` 标签里（也可能是一段 JSON）。
  /pub lyrics: Option<String>/.test(audioTagsSrc) &&
    /const LYRICS_KEYS: &\[&str\] = &\[/.test(audioTagsSrc) &&
    /fn lyrics_of_tags\(/.test(audioTagsSrc) &&
    /"UNSYNCEDLYRICS"/.test(audioTagsSrc) &&
    // JSON 标签兜底：任意标签里塞了 {"lyrics": "..."} 也能取出来。
    /starts_with\('\{'\)/.test(audioTagsSrc) &&
    /read_lyrics\(&src_for_task, tags\.lyrics\.as_deref\(\)\)/.test(playerCommandSrc),
);

// ==================== 音乐播放器：八条真机反馈补丁（D169） ====================

check(
  "D169：色晕取封面**面积最大的三个色块**（按面积排序、跳过近似重复、彩色优先于白底）",
  // 用户 2026-11-13：「颜色晕并没有选取封面中最大的 3 个色块修复」。算法在后端：
  // `hp_media::dominant_colors_from_image`，由 `player.media` 直接回三个色。
  /pub fn dominant_colors_from_image\(/.test(
    readFileSync(join(ROOT, "crates/hp-media/src/palette.rs"), "utf8"),
  ) &&
    /dominant_colors_from_image/.test(
      readFileSync(join(ROOT, "crates/hp-media/src/lib.rs"), "utf8"),
    ) &&
    /const HAZE_COLOR_COUNT: usize = 3;/.test(playerCommandSrc) &&
    /hp_media::dominant_colors_from_image\(&img, HAZE_COLOR_COUNT\)/.test(playerCommandSrc) &&
    // 近重复色块必须被距离闸门挡掉，否则"三个色"会退化成同一个颜色的三个副本。
    /MIN_DISTANCE/.test(readFileSync(join(ROOT, "crates/hp-media/src/palette.rs"), "utf8")) &&
    hazeMod.HAZE_LAYER_COUNT === 3,
);

check(
  "D176：色晕仍是**三团互咬的噪波**（三团各两层、第三团补缝）",
  // 用户 2026-11-13 D169：「像 2 个圆贴在一起高斯模糊了一下，改为更加类似噪波的形状」。
  // 2026-11-14 D177：每团拆两层（`.player-haze-blob-<k>` + `-alt`），纹理交叉淡入。
  (musicStageSrc.match(/player-haze-blob player-haze-blob-/g) ?? []).length === 6 &&
    (stylesSource.match(/--player-haze-tex-[abc]: url\("data:image\/svg\+xml;base64,/g) ?? []).length === 3 &&
    (() => {
      const block = (selector) => {
        const start = stylesSource.indexOf(`${selector} {`);
        const end = start >= 0 ? stylesSource.indexOf("}", start) : -1;
        return start >= 0 && end > start ? stylesSource.slice(start, end) : "";
      };
      // 位置数值由 D170 的"面积按主导色排序"决定，这里只钉第三团确实落在画面中部、
      // 且第三团两层里有一层仍咬着 c 号纹理。
      return (
        /left: -?\d+%/.test(block(".player-haze-cluster-c")) &&
        /top: -?\d+%/.test(block(".player-haze-cluster-c")) &&
        /mask-image: var\(--player-haze-tex-c\)/.test(block(".player-haze-blob-c"))
      );
    })(),
);

check(
  "D177：当前句的填充在**两套样式里都看得见**，且不再有 `text-shadow` 白雾",
  // 用户 2026-11-14：「样式 1 只有填充不显示（一直是满的）；样式 2 文字后面有一个
  // 白色矩形，需要修掉」。样式 2 的活动行把 `color` 设回实色（特异度比 `.is-filling`
  // 高，只写 `color: transparent` 会被盖回去）；`text-shadow` 又照字形画、跟文字颜色
  // 无关，字号一大就摊成一块白雾。填充色必须走 `-webkit-text-fill-color`，阴影点名关掉。
  (() => {
    const block = (selector) => {
      const at = stylesSource.indexOf(`${selector} {`);
      if (at < 0) return "";
      // 注释里也会出现 `}`（引用别的规则时），所以按"行首的 }"收尾，别在注释里截断。
      const rest = stylesSource.slice(at);
      const end = rest.search(/\n\}/);
      return end > 0 ? rest.slice(0, end) : "";
    };
    const filling = block(".player-lyric-main.is-filling");
    // 两套样式各有一条"活动行"规则（haze / disc），都不许再带 text-shadow。
    const active = stylesSource.match(/\.player-lyric\.is-active \.player-lyric-main \{[^}]*\}/g) ?? [];
    return (
      /color: transparent/.test(filling) &&
      /-webkit-text-fill-color: transparent/.test(filling) &&
      /text-shadow: none/.test(filling) &&
      active.length >= 2 &&
      active.every((rule) => !/text-shadow/.test(rule))
    );
  })(),
);

check(
  "D177：填充的边界按**文字宽**推进，不是按整列的行盒宽",
  // 验收时量出来的真问题：`.player-lyric-main` 是 block，盒子吃满整列（深海少女那句
  // 盒宽 494px、字宽只有 240px），而 `background-image` 的百分比是按**盒子**算的 →
  // 进度到 ~48% 文字就整行亮了，后半段在空白里空跑。收成 fit-content 让盒子=文字宽，
  // 左边缘不动，长句仍由 max-width 夹住照旧折行（data-wrapped 的检测也就不变）。
  (() => {
    const at = stylesSource.indexOf(".player-lyric-main.is-filling {");
    if (at < 0) return false;
    const rest = stylesSource.slice(at);
    const end = rest.search(/\n\}/);
    const filling = end > 0 ? rest.slice(0, end) : "";
    return /width: fit-content/.test(filling) && /max-width: 100%/.test(filling);
  })(),
);

check(
  "D177：色晕每团**两层**不同纹理交叉淡入（雾状边缘，轮廓随时间变）",
  // 用户 2026-11-14：「色晕雾化不够，能看出来还是原来那个形状」。单张静态纹理怎么转
  // 轮廓都是那张图；两层各挂不同纹理、按互补节奏淡入，轮廓才会一直变。纹理同时重烘：
  // 画布 640、`stdDeviation` 22–28（旧版 420 画布上 9–12，摊到大画布上看不出雾）。
  (() => {
    const block = (selector) => {
      const at = stylesSource.indexOf(`${selector} {`);
      if (at < 0) return "";
      // 注释里也会出现 `}`（引用别的规则时），所以按"行首的 }"收尾，别在注释里截断。
      const rest = stylesSource.slice(at);
      const end = rest.search(/\n\}/);
      return end > 0 ? rest.slice(0, end) : "";
    };
    const layer = (key) => {
      const body = block(`.player-haze-blob-${key}`);
      const altBody = block(`.player-haze-blob-${key}-alt`);
      const read = (text) => ({
        tex: (text.match(/mask-image: var\(--player-haze-tex-([abc])\)/) ?? [])[1],
        fade: (text.match(
          /animation: player-haze-fade-([abc]) (\d+)s ease-in-out infinite (alternate|alternate-reverse);/,
        ) ?? []).slice(1),
      });
      const one = read(body);
      const two = read(altBody);
      return (
        one.tex !== undefined && two.tex !== undefined && one.tex !== two.tex &&
        one.fade.length === 3 && two.fade.length === 3 &&
        // 同周期、反方向：两层 opacity 和恒为 ~1，亮度不跟着呼吸，变的只有轮廓。
        one.fade[0] === two.fade[0] && one.fade[1] === two.fade[1] &&
        one.fade[2] === "alternate" && two.fade[2] === "alternate-reverse"
      );
    };
    const bake = ["a", "b", "c"].map((key) => {
      const match = stylesSource.match(
        new RegExp(`--player-haze-tex-${key}: url\\("data:image/svg\\+xml;base64,([^"]+)"\\);`),
      );
      const svg = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      return {
        size: Number((svg.match(/width='(\d+)'/) ?? [])[1]),
        std: Number((svg.match(/stdDeviation='(\d+)'/) ?? [])[1]),
        seed: (svg.match(/seed='(\d+)'/) ?? [])[1],
      };
    });
    const drift = (key) =>
      Number((block(`.player-haze-cluster-${key}`).match(/animation: player-haze-drift-[abc] (\d+)s/) ?? [])[1]);
    return (
      layer("a") && layer("b") && layer("c") &&
      bake.every(({ size, std }) => size === 640 && std >= 22 && std <= 28) &&
      new Set(bake.map(({ seed }) => seed)).size === 3 &&
      // 三团的漂移周期互质，不会同时回到原点。
      drift("a") === 53 && drift("b") === 71 && drift("c") === 89
    );
  })(),
);

check(
  "D177：LRC 六位小数的时间标签不再丢行（`[01:32.869995]` → 92869ms）",
  // 深海少女那份 `.flac` 里就有 6 位小数。旧正则只认 1–3 位，整条标签匹配失败，
  // 那行既不进时间轴也不进 `plain`（synced 时被丢弃）——歌词凭空少一句。
  (() => {
    const doc = lrcMod.parseLrc(
      "[01:32.869995]深海少女 特意沉落\n[01:32.869995]暗闇のさなかに赤い頬\n[02:22.95999]尾\n[00:01.5]头",
    );
    return (
      doc.synced &&
      doc.lines.length === 4 &&
      doc.lines[0].timeMs === 1500 &&
      doc.lines[1].timeMs === 92869 &&
      doc.lines[1].text === "深海少女 特意沉落" &&
      doc.lines[2].timeMs === 92869 &&
      doc.lines[3].timeMs === 142959 &&
      // 毫秒分隔符 `:` 的老写法仍然认（3 位小数）。
      lrcMod.parseLrc("[00:12:345]old").lines[0].timeMs === 12345
    );
  })(),
);


check(
  "D176：当前句填充是**柔和过渡**（进度两侧各留一段渐变），不是竖直硬边",
  // 用户 2026-11-14：「不使用进度条式竖直的僵硬边界，而是加一个 1-0 的透明度柔和过渡」。
  /calc\(var\(--player-lyric-progress, 0%\) - 6%\)/.test(stylesSource) &&
    /calc\(var\(--player-lyric-progress, 0%\) \+ 6%\)/.test(stylesSource) &&
    // 折行时同样是柔边：每行那层渐变在进度两侧各留 `LYRIC_BAND_SOFT`%。
    (() => {
      const bands = [
        { left: 0, top: 0, width: 200, height: 20 },
        { left: 0, top: 20, width: 100, height: 20 },
      ];
      // 总进度 1/3 → 第一行正好读到一半（300 × 1/3 = 100 = 200/2）。
      const fill = musicStageMod.lyricBandFill(bands, 1 / 3);
      return (
        musicStageMod.LYRIC_BAND_SOFT === 6 &&
        fill.image.includes("linear-gradient(to right") &&
        fill.image.includes("44.00%") &&
        fill.image.includes("56.00%") &&
        fill.image.includes("var(--player-lyric-unsung) 0%, var(--player-lyric-unsung) 100%)")
      );
    })(),
);

check(
  "D176：日语假名注音（`汉字（かな）` → `<ruby>` + `<rt>`）",
  // 用户 2026-11-14：「音乐播放器实现日语假名注音显示功能」，数据形如
  // `心拍数（はーとびーと）`、`君（きみ）の隣（となり）でさ`。
  (() => {
    const ruby = readFileSync(join(ROOT, "apps/desktop/src/app_ui/panels/music/ruby.ts"), "utf8");
    return (
      /export function parseRuby\(/.test(ruby) &&
      /export function hasRuby\(/.test(ruby) &&
      /（/.test(ruby) &&
      /<ruby/.test(musicStageSrc) &&
      /<rt>/.test(musicStageSrc) &&
      /<LyricText text=\{/.test(musicStageSrc) &&
      /\.player-lyric rt \{/.test(stylesSource) &&
      /ruby-position: over/.test(stylesSource)
    );
  })(),
);

check(
  "D176：音乐面板聚焦时空格暂停/继续、方向键上一首/下一首",
  // 用户 2026-11-14：「音乐播放器面板焦点在时，空格暂停/继续、方向键上一首和下一首」。
  /if \(event\.key === " " \|\| event\.key === "Spacebar"\) \{/.test(musicPanelSrc) &&
    /togglePlay\(\);/.test(musicPanelSrc) &&
    /stepTrack\(event\.key === "ArrowLeft" \? -1 : 1\)/.test(musicPanelSrc),
);

check(
  "D169：暂停态切歌**不自动播放**（图标是播放时才续播）",
  // 用户 2026-11-13：「控制图标是暂停时，切换下一首，禁止自动播放，图标是播放时才可以自动播放」。
  /const loadAndPlay = useCallback\(async \(fileId: string, autoplay = true\)/.test(
    musicPanelSrc,
  ) &&
    /autoPlayRef\.current = autoplay;/.test(musicPanelSrc) &&
    /void loadAndPlay\(target\.id, playing\);/.test(musicPanelSrc) &&
    /\[loadAndPlay, playing, queue\.files/.test(musicPanelSrc),
);

check(
  "D169：歌词切换是**过渡**不是硬切（行级 transition + 新行淡入）",
  // 用户 2026-11-13：「优化显示歌词的效果，不要硬切换」。
  (() => {
    const start = stylesSource.indexOf(".player-lyric {");
    const end = stylesSource.indexOf("}", start);
    const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
    return (
      /transition:/.test(body) &&
      /opacity 0\.5s/.test(body) &&
      /filter 0\.55s/.test(body) &&
      /margin-left 0\.7s/.test(body) &&
      /animation: player-lyric-in 0\.5s/.test(body)
    );
  })() && /@keyframes player-lyric-in/.test(stylesSource),
);

check(
  "D169：样式 2 歌词一直落到控制区上沿（吃满信息区 + 底部渐隐，不留空档）",
  // 用户 2026-11-13：「歌词显示范围向下延伸，以进度条上方一点点为边界」。
  (() => {
    // 同一个选择器可能出现多块（主题变量一块、排版一块），要挑出"排版"那块。
    const needle = '.player-lyrics[data-variant="disc"] {';
    for (let at = stylesSource.indexOf(needle); at >= 0; at = stylesSource.indexOf(needle, at + 1)) {
      const end = stylesSource.indexOf("}", at);
      const body = end > at ? stylesSource.slice(at, end) : "";
      if (/flex: 1 1 auto/.test(body) && /mask-image: linear-gradient/.test(body)) return true;
    }
    return false;
  })(),
);

check(
  "D169：样式 2 的音量条与进度条等长（图标挪进留白，不再占轨道宽度）",
  // 用户 2026-11-13：「进度条和音量条的长度要一致，以进度条的长度为准」。
  (() => {
    const start = stylesSource.indexOf('.player-music[data-style="disc"] .player-volume-row {');
    const end = stylesSource.indexOf("}", start);
    const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
    return /width: 100%/.test(body) && /max-width: none/.test(body);
  })() &&
    (() => {
      const start = stylesSource.indexOf('.player-music[data-style="disc"] .player-volume-icon {');
      const end = stylesSource.indexOf("}", start);
      const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
      return /position: absolute/.test(body) && /right: calc\(100% \+ 10px\)/.test(body);
    })(),
);

check(
  "D169：样式 2 的随机/上下一首/收藏与进度条两端对齐（三段网格，不是 space-between）",
  // 用户 2026-11-13：「随机播放、上一首、下一首、收藏等图标要和进度条两端对齐」。
  (() => {
    const start = stylesSource.indexOf('.player-transport[data-variant="disc"] {');
    const end = stylesSource.indexOf("}", start);
    const body = start >= 0 && end > start ? stylesSource.slice(start, end) : "";
    return (
      /display: grid/.test(body) &&
      /grid-template-columns: 1fr auto 1fr/.test(body) &&
      /width: 100%/.test(body)
    );
  })() &&
    /<div className="player-transport-side">/.test(musicStageSrc) &&
    /<div className="player-transport-main">/.test(musicStageSrc) &&
    /player-transport-side player-transport-side-end/.test(musicStageSrc) &&
    /\.player-transport-side-end \{[^}]*justify-content: flex-end/.test(stylesSource),
);

}
