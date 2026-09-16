/**
 * 蓝图画布几何自检（开发期验证，不参与打包）。
 *
 * 验证"右键直线刀痕"的命中判定：
 * 1. 直线穿过连线曲线 → 命中；移开后不再命中（**可取消**）；
 * 2. 直线穿过节点卡片矩形 → 命中；掠过旁边 → 不命中；
 * 3. 容差：贴近连线也算命中，远离不算。
 *
 * 用法：node --no-warnings --import ./tools/blueprint-check-register.mjs \
 *         tools/blueprint-geometry-check.mjs
 */

import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const geo = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintGeometry.ts`).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// 一条水平连线（简化：从 (100,100) 到 (400,100)），采样后作为折线
const curve = geo.sampleEdgeCurve({ x: 100, y: 100 }, { x: 400, y: 100 });

// ---- 1. 竖直直线从中间穿过 → 命中 ----
{
  const hit = geo.segmentHitsPolyline(
    { x: 250, y: 40 },
    { x: 250, y: 200 },
    curve,
    10,
  );
  check("直线穿过连线 → 命中", hit);
}

// ---- 2. 直线移开后不再命中（可取消） ----
{
  const hit = geo.segmentHitsPolyline(
    { x: 250, y: 40 },
    { x: 250, y: 60 },
    curve,
    10,
  );
  check("指针移开（未触及）→ 不命中（标记可取消）", !hit);
}

// ---- 3. 容差：贴近连线命中、远离不命中 ----
{
  const near = geo.segmentHitsPolyline(
    { x: 250, y: 40 },
    { x: 250, y: 106 },
    curve,
    10,
  );
  const far = geo.segmentHitsPolyline(
    { x: 250, y: 40 },
    { x: 250, y: 80 },
    curve,
    10,
  );
  check("容差内贴近连线 → 命中；容差外 → 不命中", near && !far, `near=${near} far=${far}`);
}

// ---- 4. 直线穿过节点卡片矩形 → 命中；从旁边掠过 → 不命中 ----
{
  const rect = { x: 200, y: 150, w: 216, h: 110 };
  const through = geo.segmentHitsRect(
    { x: 100, y: 200 },
    { x: 500, y: 200 },
    rect,
  );
  const beside = geo.segmentHitsRect(
    { x: 100, y: 120 },
    { x: 500, y: 120 },
    rect,
  );
  const diagonal = geo.segmentHitsRect(
    { x: 150, y: 120 },
    { x: 350, y: 300 },
    rect,
  );
  check(
    "直线穿过节点矩形 → 命中；上方掠过 → 不命中；斜穿 → 命中",
    through && !beside && diagonal,
    `through=${through} beside=${beside} diagonal=${diagonal}`,
  );
}

// ---- 5. 零长度刀痕（刚按下未移动）：点到线距离判定 ----
{
  const onCurve = geo.segmentHitsPolyline(
    { x: 250, y: 100 },
    { x: 250, y: 100 },
    curve,
    10,
  );
  const offCurve = geo.segmentHitsPolyline(
    { x: 250, y: 300 },
    { x: 250, y: 300 },
    curve,
    10,
  );
  check("刚按下即在连线上 → 命中；在空白 → 不命中", onCurve && !offCurve);
}

// ---- 6. 贝塞尔采样端点正确（首尾即端口位置） ----
{
  const first = curve[0];
  const last = curve[curve.length - 1];
  check(
    "连线采样首尾与端口一致",
    Math.abs(first.x - 100) < 0.01 &&
      Math.abs(first.y - 100) < 0.01 &&
      Math.abs(last.x - 400) < 0.01 &&
      Math.abs(last.y - 100) < 0.01,
    `${JSON.stringify(first)} → ${JSON.stringify(last)}`,
  );
}

// ---- 7. 视口中心 → 世界坐标（新增节点落点） ----
{
  // 未平移未缩放：视口中心即世界中心
  const base = geo.viewportCenterToWorld(
    { width: 1000, height: 600 },
    { x: 0, y: 0, zoom: 1 },
  );
  // 视图平移 (200, 100)：可见区域中心落到世界坐标 (-100, 25)…即跟着视图走
  const panned = geo.viewportCenterToWorld(
    { width: 1000, height: 600 },
    { x: 200, y: 100, zoom: 1 },
  );
  // 放大 2 倍：中心世界坐标减半
  const zoomed = geo.viewportCenterToWorld(
    { width: 1000, height: 600 },
    { x: 0, y: 0, zoom: 2 },
  );
  check(
    "视口中心→世界坐标：平移与缩放都正确换算",
    base.x === 500 &&
      base.y === 300 &&
      panned.x === 300 &&
      panned.y === 200 &&
      zoomed.x === 250 &&
      zoomed.y === 150,
    `base=${JSON.stringify(base)} panned=${JSON.stringify(panned)} zoomed=${JSON.stringify(zoomed)}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
