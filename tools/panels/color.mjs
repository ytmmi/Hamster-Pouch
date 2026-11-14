/**
 * 面板门禁分节 · 色彩参考色值格式与按需提取（原第 4 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList } from "./harness.mjs";
import { ROOT, config, format, optionValues, registrySource, stylesSource } from "./shared.mjs";
export default async function run() {
// ==================== 色彩参考（`panel.color`）的色值格式设置 + 按需提取 ====================
//
// 与查看器同一套闭环：**声明**（注册表）↔ **取值域**（声明候选 ↔ 面板纯函数逐项一致）↔
// **归一化**（非法取值回落缺省）↔ **面板消费**（真的按设置格式化 + 复制同一份文本）。
//
// **调色板提取的归属（用户口径 2026-09）**：面板**只读缓存**，提取不再是界面行为——
// 它是"**全面分析文件**"（源扫描 / 源全量重扫 / 右键「重新分析该文件」）的副产品，
// 落在 `hp_scanner::Scanner::write_palette`（两个 `MediaType::Image` 分支共用）。
// 因此这一段的断言从"点击即提取的装配层行为"改成"分析路径顺带提取 + 面板只读"。

const colorPanelSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/ColorPanel.tsx"),
  "utf8",
);
const colorPaletteWatchPath = join(ROOT, "apps/desktop/src/app_ui/core/colorPaletteWatch.tsx");
const colorPalettePath = join(ROOT, "apps/desktop/src/app_ui/shared/colorPalette.ts");
const appUiAppSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/core/AppUiApp.tsx"),
  "utf8",
);
const scannerPaletteSrc = readFileSync(join(ROOT, "crates/hp-scanner/src/scanner.rs"), "utf8");
// 2026-10（缺陷 0018）：调色板的**计算**落在并行阶段的新模块里（`scan_compute.rs`），
// 而"要不要算"与"落库"仍在 `scanner.rs`。门禁读这两个文件。
const scannerComputeSrc = readFileSync(
  join(ROOT, "crates/hp-scanner/src/scan_compute.rs"),
  "utf8",
);
// 第 44 轮（D161）：一次解码的**复用**发生在 `scan_task.rs`（缩略图由那张图编码）。
const scannerTaskSrc = readFileSync(join(ROOT, "crates/hp-scanner/src/scan_task.rs"), "utf8");
const colorCommandSrc = readFileSync(
  join(ROOT, "apps/desktop/src-tauri/src/commands/color.rs"),
  "utf8",
);
// 第 43 轮（D160）：调色板"锁定与否"的那一列跟着扫描快照一起取回，
// 因此快照查询所在的存储层也进入这条断言的读取面。
const fileRepoSrc = readFileSync(
  join(ROOT, "crates/hp-repo/src/file_repo.rs"),
  "utf8",
);
const colorValue = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/colorValue.ts")).href
);

const colorSpec = config.panelSpec("color");
const colorFormatDecl = colorSpec?.settings?.find((s) => s.key === "valueFormat");
check(
  "色彩参考声明了「色值格式」设置（select，缺省十六进制 = 与存储口径同形）",
  (colorSpec?.settings ?? []).length === 1 &&
    colorFormatDecl?.kind === "select" &&
    colorFormatDecl?.title_key === "color.settings.valueFormat" &&
    colorFormatDecl?.default === "hex",
  `decls=${(colorSpec?.settings ?? []).map((s) => s.key).join(",") || "（无）"} default=${colorFormatDecl?.default}`,
);
check(
  "色值格式的 select 候选 ↔ 面板纯函数 `colorValue.ts` 的取值域逐项一致（缺省同源）",
  eqList(optionValues("color", "valueFormat"), [...colorValue.COLOR_VALUE_FORMATS]) &&
    colorValue.DEFAULT_COLOR_VALUE_FORMAT === colorFormatDecl?.default,
  `decl=${optionValues("color", "valueFormat").join(",")} ` +
    `panel=${[...colorValue.COLOR_VALUE_FORMATS].join(",")}`,
);
check(
  "色值格式按声明归一化：非法取值回落十六进制、未注册面板返回 undefined",
  config.normalizePanelSettingValue("color", "valueFormat", "decimal") === "decimal" &&
    config.normalizePanelSettingValue("color", "valueFormat", "rgb") === "hex" &&
    config.normalizePanelSettingValue("color", "valueFormat", null) === "hex" &&
    colorValue.resolveColorValueFormat("bogus") === "hex" &&
    config.normalizePanelSettingValue("ghost", "valueFormat", "hex") === undefined,
);
check(
  "色值格式化纯函数：十六进制 `#ffffff` ↔ 十进制 `255, 255, 255`（含 3 位缩写与非法输入原样返回）",
  colorValue.formatColorValue("#ffffff", "hex") === "#ffffff" &&
    colorValue.formatColorValue("#ff0000", "decimal") === "255, 0, 0" &&
    colorValue.formatColorValue("#ABC", "hex") === "#aabbcc" &&
    colorValue.formatColorValue("  #0a0B0c  ", "hex") === "#0a0b0c" &&
    colorValue.formatColorValue("nope", "hex") === "nope" &&
    colorValue.formatColorValue("nope", "decimal") === "nope",
);
check(
  "色彩参考面板消费该设置：同一份文本既显示又复制，且面板**只保留调色板**",
  /usePanelSettingValue\(COLOR_PANEL_ID, "valueFormat"/.test(colorPanelSrc) &&
    /formatColorValue\(selected, format\)/.test(colorPanelSrc) &&
    /navigator\.clipboard\.writeText\(text\)/.test(colorPanelSrc) &&
    /className="palette"/.test(colorPanelSrc) &&
    // 手动锁定/提取按钮与原生取色器都已移除（面板里只剩调色板 + 色值行）。
    !/lockManual|type="color"|colorSet\(/.test(colorPanelSrc),
);
check(
  "color 面板拿到 dockview 面板 API（第 4 条触发源「面板激活」才可达）",
  /^ {2}color: \(ctx\) => <ColorPanel api=\{ctx\.api\} \/>,$/m.test(
    registrySource,
  ),
);
check(
  "复制图标是项目内资产（`assets/copy.svg`）且用 mask 上色（图标随主题前景色）",
  existsSync(join(ROOT, "apps/desktop/src/app_ui/assets/copy.svg")) &&
    /from "\.\.\/assets\/copy\.svg"/.test(colorPanelSrc) &&
    /maskImage/.test(colorPanelSrc) &&
    /\.color-copy-icon\s*\{/.test(stylesSource) &&
    /\.color-copy-icon[\s\S]{0,200}mask-size: contain/.test(stylesSource),
);
check(
  "调色板**不再由界面触发提取**：点击即提取的装配层监视器与请求入口都已移除，面板只读缓存",
  // 三个"曾经的入口"都不该回来：监视器文件、请求模块、装配层挂载点。
  !existsSync(colorPaletteWatchPath) &&
    !existsSync(colorPalettePath) &&
    !/<ColorPaletteWatch/.test(appUiAppSrc) &&
    !/requestPaletteExtraction/.test(colorPanelSrc) &&
    // 面板只读：一次 `color.get` + 纯函数解析；**不是**提取命令。
    /parsePaletteJson\(await api\.colorGet\(\{ repoId, fileId \}\)\)/.test(colorPanelSrc) &&
    !/colorExtract/.test(colorPanelSrc) &&
    // 缺调色板时给"怎么拿到它"的提示（而不是让用户以为面板坏了）。
    /app\.t\("color\.empty"\)/.test(colorPanelSrc),
);
check(
  "提取绑定在**全面分析**上：扫描/重新分析都顺带写调色板，且**不覆盖手动锁定**的色值",
  // 2026-10（缺陷 0018）：扫描改为"串行准备 → 并行计算 → 串行写库"三段式，
  // 调色板的"要不要算"在**准备阶段**定（`want_palette`）、颜色值在**并行阶段**算出
  // （`scan_compute::analyze_image`）、落库在**写库阶段**（`write_one`）。
  // 断言内容不变，只改它读哪些文件——这正是 file-structure.md 第「门禁跟着代码走」条的办理方式。
  //
  // ① 并行阶段只解码**一次**，调色板与感知哈希共用同一张图（旧实现各解码一次）。
  //    第 44 轮（D161）：这张图还要交给缩略图编码，因此派生这一层只**借用**
  //    （`analyze_image_derivations(img: &DynamicImage, …)`），断言跟着改成不取地址。
  /fn analyze_image_derivations\(\s*img: &image::DynamicImage,\s*want_palette: bool,?\s*\)/.test(
    scannerComputeSrc,
  ) &&
    /extract_palette_from_image\(img, 0\)/.test(scannerComputeSrc) &&
    // 缩略图由这张已解码的图编码，不再第二次打开文件（`encode_image_thumbnail`）。
    /encode_image_thumbnail\(/.test(scannerTaskSrc) &&
    /let \(perceptual, palette, thumb_status\) = match decode_scan_image\(/.test(scannerTaskSrc) &&
    // ② 落库唯一入口：写库阶段的 `write_one` 走唯一 JSON 实现。
    /encode_palette_json\(colors\)/.test(scannerPaletteSrc) &&
    // ③ 手动锁定的色值在**准备阶段**就被排除（`want_palette` 为假 → 并行阶段不算它）。
    //    `locked:true` 是用户的判定权，重扫不得抹掉——旧实现是在写入前 return，
    //    现在提前到"决定要不要算"，语义相同且省下一次全尺寸重采样。
    //    第 43 轮（D160）：锁定判定不再逐图 `get_color_ref`，改为读**随快照一起取回**的
    //    `color_refs.color_json`（`list_files_for_scan` 的 LEFT JOIN）；判据收敛到自由函数
    //    `palette_locked`，源扫描与单文件重分析共用同一口径。
    /fn palette_locked\(color_json: Option<&str>\) -> bool/.test(scannerPaletteSrc) &&
    /color_json\.is_some_and\(palette_is_locked\)/.test(scannerPaletteSrc) &&
    // 锁定列必须由那一条 JOIN 返回（整源一次 SELECT，而不是每图一条查询）。
    /LEFT JOIN color_refs/.test(fileRepoSrc) &&
    /!palette_locked\(existing\.as_ref\(\)\.and_then\(\|row\| row\.color_json\.as_deref\(\)\)\)/.test(
      scannerPaletteSrc,
    ) &&
    // ④ 两条触发链路都设 `want_palette`：源扫描的准备阶段 + 单文件重新分析。
    (scannerPaletteSrc.match(/want_palette,?\s*$/gm) ?? []).length >= 2 &&
    // ⑤ 两条触发链路：`file.reanalyze` → `scanner.rescan_file`；源全量 → `options.full` 强制重算。
    //    **断言不假设折行方式**：rustfmt 会把长实参列表逐行展开（每个实参一行），
    //    因此实参之间只用 `\s*` 而不写死空格或换行；断言对象是「四个实参按序传入、cancel 为 Some」。
    //    2026-10-25（D120）格式化后此断言曾因写死折行而假红，即本条的由来。
    // （`file.reanalyze` 自 2026-09 起是**后台任务**：带上任务的取消标志，见 `check:commands`
    //  的"单文件分析 = 与源扫描同款的后台任务"那组断言。）
    /\.scanner\s*\.rescan_file\(\s*&mut db,\s*&source,\s*&file\.relative_path,\s*&options,\s*Some\(&cancel\),?\s*\)/.test(
      readFileSync(join(ROOT, "apps/desktop/src-tauri/src/commands/file.rs"), "utf8"),
    ) &&
    // `options.full` 仍然强制重算（"源全量重扫"会把全部图片的调色板刷新一遍）。
    /options\.full \|\| row\.size != size \|\| row\.mtime != mtime/.test(scannerPaletteSrc) &&
    // ⑥ 按需命令保留（契约不变），但已无界面调用方：UI 只走分析路径。
    /db\.upsert_color_ref\(file_id, &encode_palette_json\(&palette\.colors\)\)\?;/.test(
      colorCommandSrc,
    ) &&
    !/colorExtract|color_extract\(/.test(appUiAppSrc) &&
    !/requestPaletteExtraction/.test(appUiAppSrc),
);

// 调色板本身：规模（8 色）、缓存格式版本（旧缓存自愈）与面板内的排布。
// （`colorCommandSrc` 在本节开头已经读过：上面的"提取绑定在全面分析上"用它断言写入路径。）
const paletteRsSrc = readFileSync(join(ROOT, "crates/hp-media/src/palette.rs"), "utf8");
const paletteJson = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/shared/paletteJson.ts")).href
);
const rustPaletteSize = Number(
  (paletteRsSrc.match(/DEFAULT_PALETTE_SIZE:\s*usize\s*=\s*(\d+)/) || [])[1],
);
const rustPaletteVersion = Number(
  (paletteRsSrc.match(/PALETTE_FORMAT_VERSION:\s*u32\s*=\s*(\d+)/) || [])[1],
);
check(
  "调色板默认取 **8 色**（用户 2026-09-29 指定；此前 6）",
  rustPaletteSize === 8,
  `DEFAULT_PALETTE_SIZE=${rustPaletteSize}`,
);
check(
  "调色板缓存的格式版本 TS ↔ Rust 相等，且**唯一编解码处**真的把 `version` 写进 `color_json`",
  rustPaletteVersion > 0 &&
    rustPaletteVersion === paletteJson.PALETTE_FORMAT_VERSION &&
    // JSON 形态只有一处实现（`hp_media::encode_palette_json`）：两个写入方（分析路径与
    // 按需命令）都必须走它——谁自己拼串就可能漏写 `version`，前端会把缓存当"未提取"反复重算。
    /pub fn encode_palette_json\(colors: &\[String\]\) -> String \{[\s\S]{0,200}?"version": PALETTE_FORMAT_VERSION/.test(
      paletteRsSrc,
    ) &&
    /encode_palette_json/.test(scannerPaletteSrc) &&
    /encode_palette_json/.test(colorCommandSrc) &&
    // 反向：谁都不许再手写一份 `color_json`（旧的命令实现就是手拼的）。
    !/"version": PALETTE_FORMAT_VERSION,\s*\n\s*"colors"/.test(colorCommandSrc),
  `rust=${rustPaletteVersion} ts=${paletteJson.PALETTE_FORMAT_VERSION}`,
);
check(
  "旧版本/无版本的缓存按「未提取」处理（自动重算）；**手动锁定**的色值不受版本影响",
  paletteJson.parsePaletteJson('{"colors":["#112233"],"locked":false}').length === 0 &&
    paletteJson.parsePaletteJson(
      `{"version":${paletteJson.PALETTE_FORMAT_VERSION},"colors":["#112233"],"locked":false}`,
    ).length === 1 &&
    paletteJson.parsePaletteJson('{"colors":["#112233"],"locked":true}').length === 1 &&
    paletteJson.parsePaletteJson(null).length === 0 &&
    paletteJson.parsePaletteJson("not json").length === 0,
);
check(
  "色块随面板宽度伸展且**不是正方形**（flex 撑满一行、只给高度、不给固定宽度）",
  /\.swatch\s*\{[^}]*flex:\s*1 1 /.test(stylesSource) &&
    /\.swatch\s*\{[^}]*height:\s*18px/.test(stylesSource) &&
    !/\.swatch\s*\{[^}]*[\s;{]width:/.test(stylesSource),
);
check(
  "调色板不吃剩余高度（色值行紧跟其下方）、留出选中框空间且**不再裁掉蓝框**",
  /\.palette\s*\{[^}]*flex:\s*none/.test(stylesSource) &&
    /\.palette\s*\{[^}]*margin-top:/.test(stylesSource) &&
    /\.palette\s*\{[^}]*padding:/.test(stylesSource) &&
    !/\.palette\s*\{[^}]*overflow:/.test(stylesSource),
);

}
