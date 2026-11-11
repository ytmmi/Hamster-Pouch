/**
 * 最小 PNG 编解码 + SSIM（`tools/viewer-render-verify.mjs` 专用，**零依赖**）。
 *
 * 为什么要自己写：视觉门禁要在 Node 侧比较两张截图，而仓库没有也不该有图像库
 * （RFC 0013 的边界：不引第三方渲染/图像库）。这里只覆盖门禁真正需要的那一小撮：
 * 8 位、非隔行、colorType 2（RGB）或 6（RGBA）——Chromium 的 `Page.captureScreenshot`
 * 与我们的夹具图都落在这个范围内，其它格式直接抛，免得悄悄给出错误结论。
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG。
 *
 * 夹具图必须**由代码生成**而不是塞一个二进制进仓库：截图对比要的是"同样的像素、两种后端"，
 * 生成式夹具让"图从哪来"这件事在门禁里一眼可查。
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
          raw,
          y * (stride + 1) + 1,
        );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 解码 PNG 为 `{width, height, rgba}`（只支持 8 位 RGB/RGBA、非隔行）。 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("不是 PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`只支持 8 位 PNG（实得 ${data[8]}）`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error("不支持隔行 PNG");
      if (colorType !== 2 && colorType !== 6) throw new Error(`不支持的 colorType ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[x] = (line[x] + a) & 0xff;
          break;
        case 2:
          line[x] = (line[x] + b) & 0xff;
          break;
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`未知的 PNG 行过滤器 ${filter}`);
      }
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/** 转灰度（Rec.601 亮度；SSIM 只需要相对差异，权重取最常见的一组）。 */
export function toGray({ width, height, rgba }) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return { width, height, gray };
}

/**
 * 两张同尺寸灰度图的 SSIM（8×8 窗口、不重叠，均值化）。
 *
 * 不重叠窗口是为了让"1 px 偏移"这件事在单个窗口内的方差变化上就暴露出来；
 * 重叠窗会平滑掉这种小位移，反而看不出错位。
 */
export function ssim(a, b, shiftX = 0, shiftY = 0) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不一致：${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  const win = 8;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let count = 0;
  for (let wy = 0; wy + win <= a.height; wy += win) {
    for (let wx = 0; wx + win <= a.width; wx += win) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let n = 0;
      for (let y = 0; y < win; y += 1) {
        const ay = wy + y;
        const by = ay + shiftY;
        if (by < 0 || by >= b.height) continue;
        for (let x = 0; x < win; x += 1) {
          const ax = wx + x;
          const bx = ax + shiftX;
          if (bx < 0 || bx >= b.width) continue;
          const va = a.gray[ay * a.width + ax];
          const vb = b.gray[by * b.width + bx];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
          n += 1;
        }
      }
      if (n === 0) continue;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const value =
        ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += Math.max(-1, Math.min(1, value));
      count += 1;
    }
  }
  return count === 0 ? 1 : total / count;
}

/**
 * 生成夹具图：渐变 + 棋盘 + 细线 + 圆。
 *
 * 三种频率都要有——只有渐变时任何模糊都看不出差别，只有棋盘时重采样滤波的差异会被
 * 低频掩掉；细线是"1 px 偏移"最敏感的部分。
 */
export function fixtureRgba(width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? 40 : 0;
      const diag = (x + y) % 64 < 2 ? 90 : 0;
      const cx = x - width * 0.5;
      const cy = y - height * 0.5;
      const ring = Math.abs(Math.hypot(cx, cy) - Math.min(width, height) * 0.32) < 2 ? 120 : 0;
      const r = Math.min(255, (x * 255) / width + checker + diag + ring);
      const g = Math.min(255, (y * 255) / height + checker + ring);
      const b = Math.min(255, 128 + checker / 2 + diag);
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}
