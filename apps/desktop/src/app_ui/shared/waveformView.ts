/**
 * 波形图的**纯几何逻辑**（零依赖：不 import React / Tauri，门禁可直接 import 断言）。
 *
 * 三处消费方共用同一份口径——媒体预览的单元、查看器的音频舞台、播放器的波形条：
 *
 * | 用途 | 取哪几个函数 |
 * | --- | --- |
 * | 波形上叠**播放游标** | `waveCursorPercent` |
 * | 点 / 拖波形**定位** | `waveSeekSeconds` |
 *
 * **为什么必须收敛成纯函数**：游标位置与"点哪儿跳到哪儿"是同一件事的两种投影
 * （一个是"位置 → 百分比"、一个是"百分比 → 位置"），两者若各写一遍就会**互相漂移**
 * ——游标指在 30% 而点那里却跳到 32%，而这种偏差不会让任何功能断言变红。
 * 这里把两者放在一起、互为逆运算，门禁就能按**行为**断言它们一致。
 *
 * 波形图是**整段**音频的线性映射（后端 `showwavespic` 按整段画，见
 * `crates/hp-media/src/waveform.rs`），因此时间与横轴是线性的：
 * 两个函数都建立在同一条 `position / duration = x / width` 之上。
 */

/** 波形图在面板里的横轴宽度（px）——与 CSS 的 `width: 100%` 同一量纲。 */
export interface WaveGeometry {
  /** 波形图实际占据的宽度（px）；非正数时视为"不可用"。 */
  width: number;
  /** 音频总时长（ms）；非正数时视为"不可用"。 */
  durationMs: number;
}

/** 波形图在容器内的**实际绘制盒**（相对容器左上角，px）。 */
export interface WaveDrawnBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * `object-fit: contain` 的绘制盒：容器尺寸 + 图像原始尺寸 → 真正画出来的矩形。
 *
 * **为什么必须算它**：波形图的宽高比由后端固定（[`WaveGeometry`] 之上的
 * `1200×240`），而三处容器的宽高比各不相同（网格单元近方形、舞台很宽）。
 * `object-fit: contain` 会在**较紧的那一边**留白（letterbox），于是"容器左边缘"
 * 与"波形第 0 帧"**不是同一个位置**——直接按容器宽度算百分比，游标与点击定位
 * 都会偏一个留白量，且音频越短偏差越明显（长音频的留白占比小，所以很容易漏掉）。
 *
 * 这与缺陷 0027 同一类：**几何口径必须与真实绘制一致**，不能拿"容器盒"当"图像盒"。
 *
 * 返回 `null` 表示尺寸不可用（容器或原始尺寸非正）——调用方据此不画游标、不响应定位。
 */
export function waveDrawnBox(
  container: { width: number; height: number },
  natural: { width: number; height: number },
): WaveDrawnBox | null {
  const cw = container.width;
  const ch = container.height;
  const nw = natural.width;
  const nh = natural.height;
  if (![cw, ch, nw, nh].every((v) => Number.isFinite(v) && v > 0)) return null;
  // contain = 取两个方向的缩放比中**较小**者（保证整图放得下）。
  const scale = Math.min(cw / nw, ch / nh);
  const width = nw * scale;
  const height = nh * scale;
  return {
    left: (cw - width) / 2,
    top: (ch - height) / 2,
    width,
    height,
  };
}

/**
 * 播放位置 → 游标百分比（0–1，**已夹紧**）。
 *
 * 夹紧不是可选的：`positionMs` 可能略大于 `durationMs`（浏览器的 `currentTime` 与
 * `duration` 由不同来源给出，末帧常差几毫秒），也可能在拖动期间为负。
 * 不夹紧就会出现"游标跑到波形框外面"，看起来像面板坏了。
 *
 * 几何 / 时长不可用时返回 `null`（调用方据此**不画游标**，而不是画一根在 0 上的假游标
 * ——那会让人以为"播放卡在开头"）。
 */
export function waveCursorPercent(positionMs: number, geometry: WaveGeometry): number | null {
  const { durationMs } = geometry;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (!Number.isFinite(positionMs)) return null;
  return clamp01(positionMs / durationMs);
}

/**
 * 点在波形上的 `x` 位置（px，相对**容器**左边缘）→ 应跳到的**秒数**。
 *
 * **入参是 `WaveDrawnBox` 而不是容器宽度**：只有图像的绘制盒知道"波形第 0 帧"
 * 到底在哪一格像素（见 [`waveDrawnBox`]）。拿容器宽度算，letterbox 的留白会被
 * 算成"音频的开头"，点在最左边就跳不到 0。
 *
 * 与 [`waveCursorPercent`] 严格互为逆运算：`waveSeekSeconds(x, box, g)` 与
 * `waveCursorPercent(seconds * 1000, g)` 在同一组入参下一致。
 *
 * 返回 `null` 表示不该响应这次点击（几何 / 时长不可用——点一个还不知道多长的音频
 * 不该触发任何定位）。
 */
export function waveSeekSeconds(
  clickX: number,
  box: WaveDrawnBox | null,
  geometry: WaveGeometry,
): number | null {
  const { durationMs } = geometry;
  if (!box) return null;
  if (!Number.isFinite(box.width) || box.width <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (!Number.isFinite(clickX)) return null;
  // 先把"容器坐标"移到"图像坐标"：减去 letterbox 的左留白。
  const fraction = clamp01((clickX - box.left) / box.width);
  return (fraction * durationMs) / 1000;
}

/**
 * 游标百分比 → 相对**容器**左边缘的 x 像素（绘制用）。
 *
 * 对称地补回 letterbox 的左留白：游标是绝对定位在容器里的，而百分比是相对**图像**的。
 */
export function waveCursorX(
  percent: number,
  box: WaveDrawnBox | null,
): number | null {
  if (!box) return null;
  if (!Number.isFinite(percent)) return null;
  return box.left + clamp01(percent) * box.width;
}

/** 夹紧到 `[0, 1]`；`NaN` 由调用方在前面挡掉（这里只兜底取 0）。 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
