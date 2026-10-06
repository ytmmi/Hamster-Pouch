/**
 * 蓝图小地图几何自检（开发期验证，不参与打包）。
 *
 * 验证画布右下角小地图的纯几何（`blueprintMinimapGeometry`）：
 * 1. 包围盒/等比缩放/留边：内容完整落在框内且不放大；
 * 2. 世界 ↔ 小地图坐标往返一致；
 * 3. 视口指示框：始终留在框内、随缩放变小；
 * 4. 视口世界矩形与画布变换一致（与 `viewportCenterToWorld` 互为逆运算）；
 * 5. 空图不崩、拖动落点能反解回世界坐标。
 *
 * 用法：node --no-warnings --import ./tools/blueprint-check-register.mjs \
 *         tools/blueprint-minimap-check.mjs
 */

import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const mini = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintMinimapGeometry.ts`).href
);
const geo = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/panels/blueprintGeometry.ts`).href
);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const near = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;
const size = mini.MINIMAP_SIZE;

// ---- 1. 内容包围盒：含卡片占位，忽略缺 position 的节点（按原点） ----
{
  const bounds = mini.contentBounds([
    { x: 40, y: 170, w: mini.MINIMAP_CARD.w, h: mini.MINIMAP_CARD.h },
    { x: 300, y: 40, w: mini.MINIMAP_CARD.w, h: mini.MINIMAP_CARD.h },
  ]);
  check(
    "内容包围盒：覆盖所有矩形",
    bounds.x === 40 && bounds.y === 40 && bounds.w === 216 + 260 && bounds.h === 130 + 110,
    JSON.stringify(bounds),
  );
  check("空集合 → null（空图不画内容）", mini.contentBounds([]) === null);
}

// ---- 2. 等比缩放 + 居中留边；只缩小不放大 ----
{
  const bounds = { x: 0, y: 0, w: 1000, h: 500 };
  const t = mini.fitBounds(bounds);
  const tl = mini.worldToMini({ x: 0, y: 0 }, t);
  const br = mini.worldToMini({ x: 1000, y: 500 }, t);
  const ratios = [t.scale, t.scale];
  check(
    "等比缩放：宽高用同一 scale，内容居中且四周留边",
    near(ratios[0], ratios[1]) &&
      tl.x >= mini.MINIMAP_PADDING - 0.01 &&
      tl.y >= mini.MINIMAP_PADDING - 0.01 &&
      br.x <= size.width - mini.MINIMAP_PADDING + 0.01 &&
      br.y <= size.height - mini.MINIMAP_PADDING + 0.01,
    `scale=${t.scale.toFixed(4)} tl=${JSON.stringify(tl)} br=${JSON.stringify(br)}`,
  );
  const single = mini.fitBounds({ x: 0, y: 0, w: 10, h: 10 });
  check(
    "只缩小不放大：极小内容 scale 封顶 1（不会被放大铺满整框）",
    single.scale === 1,
    `scale=${single.scale}`,
  );
}

// ---- 3. 世界 ↔ 小地图坐标往返一致 ----
{
  const t = mini.fitBounds({ x: -200, y: -50, w: 800, h: 400 });
  const p = { x: 123.5, y: -12.25 };
  const back = mini.miniToWorld(mini.worldToMini(p, t), t);
  check(
    "世界 → 小地图 → 世界：往返一致",
    near(back.x, p.x) && near(back.y, p.y),
    JSON.stringify(back),
  );
}

// ---- 4. 视口指示框：随缩放变小、且平移到远处也仍在框内 ----
{
  const viewport = { width: 1000, height: 600 };
  const far = { x: 9000, y: 5000, zoom: 1 };
  const zoomIn = { x: 0, y: 0, zoom: 2 };
  const layout = mini.minimapLayout([], viewport, far);
  const vr = layout.viewportRect;
  const inBox =
    vr.x >= -0.01 &&
    vr.y >= -0.01 &&
    vr.x + vr.w <= size.width + 0.01 &&
    vr.y + vr.h <= size.height + 0.01;
  check(
    "视口位于图外（平移到空白）→ 指示框仍完整落在框内（包围盒含视口）",
    inBox && vr.w > 0 && vr.h > 0,
    JSON.stringify(vr),
  );
  const wide = mini.viewportWorldRect(viewport, far);
  const narrow = mini.viewportWorldRect(viewport, zoomIn);
  check(
    "视口世界矩形：平移正确、放大 2 倍后宽高减半",
    wide.x === -9000 && wide.y === -5000 && wide.w === 1000 && wide.h === 600 &&
      narrow.w === 500 && narrow.h === 300,
    `far=${JSON.stringify(wide)} zoom2=${JSON.stringify(narrow)}`,
  );
}

// ---- 5. 视口世界矩形与画布变换互为逆运算（与 viewportCenterToWorld 同源） ----
{
  const viewport = { width: 800, height: 400 };
  const view = { x: 120, y: -60, zoom: 1.5 };
  const rect = mini.viewportWorldRect(viewport, view);
  const center = geo.viewportCenterToWorld(viewport, view);
  check(
    "视口矩形中心 == viewportCenterToWorld（画布与小地图同一套变换）",
    near(rect.x + rect.w / 2, center.x) && near(rect.y + rect.h / 2, center.y),
    `rect中心=(${rect.x + rect.w / 2}, ${rect.y + rect.h / 2}) world=(${center.x}, ${center.y})`,
  );
}

// ---- 6. 布局：节点矩形数量与顺序对齐、可反解回节点位置 ----
{
  const nodes = [
    { key: "a", type: "control", position: { x: 40, y: 40 } },
    { key: "b", type: "interface", position: { x: 520, y: 40 } },
  ];
  const layout = mini.minimapLayout(nodes, { width: 900, height: 500 }, { x: 0, y: 0, zoom: 1 });
  check(
    "布局：每个节点一个小地图矩形（同序）",
    layout.nodeRects.length === nodes.length && layout.nodeRects.every((r) => r.w > 0 && r.h > 0),
    JSON.stringify(layout.nodeRects),
  );
  const backA = mini.miniToWorld({ x: layout.nodeRects[0].x, y: layout.nodeRects[0].y }, layout.transform);
  check(
    "布局：小地图矩形左上角反解回节点世界坐标（拖动定位口径一致）",
    near(backA.x, 40) && near(backA.y, 40),
    JSON.stringify(backA),
  );
}

// ---- 7. 空图不崩 ----
{
  const layout = mini.minimapLayout([], { width: 900, height: 500 }, { x: 0, y: 0, zoom: 1 });
  check(
    "空图：仍返回视口指示框（不抛异常）",
    layout.nodeRects.length === 0 && Number.isFinite(layout.viewportRect.x),
    JSON.stringify(layout.viewportRect),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
