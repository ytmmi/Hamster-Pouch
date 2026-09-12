/**
 * 音频波形提取与绘制（Web Audio API）。
 *
 * 用于媒体预览面板以「波纹图」形式预览音频文件。
 */

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/** 从音频 URL 提取峰值数组（长度 = buckets）。 */
export async function extractWaveform(
  url: string,
  buckets = 96,
): Promise<number[]> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`读取音频失败: ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  const ctx = getContext();
  const audio = await ctx.decodeAudioData(buf);
  const channel = audio.getChannelData(0);
  const block = Math.max(1, Math.floor(channel.length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i += 1) {
    let max = 0;
    const start = i * block;
    const end = Math.min(start + block, channel.length);
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

/** 在 canvas 上绘制波形（居中对称条形）。 */
export function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  color = "#4aa3ff",
): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 160;
  const h = canvas.clientHeight || 48;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx || peaks.length === 0) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  const mid = h / 2;
  const barW = w / peaks.length;
  peaks.forEach((p, i) => {
    const barH = Math.max(1, p * (h * 0.9));
    ctx.fillRect(i * barW, mid - barH / 2, Math.max(1, barW - 1), barH);
  });
}
