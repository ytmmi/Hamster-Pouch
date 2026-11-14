/**
 * 面板注册表一致性自检（RFC 0010 决策 4 / `docs/spec/panel-standard.md` 第 8 节）。
 *
 * 断言：
 * 1. **注册表 ↔ 声明列表 ↔ 本文档**三方一致（id 清单、顺序、`category`、`has_class`、
 *    `blueprint_node`）；
 * 2. `PANEL_IDS` ↔ `PANEL_DEFS` ↔ `PANEL_TITLES` 一致（`PANEL_DEFS` 由注册表派生，
 *    断言其派生写法与 `RENDERERS` 的键集——渲染体必须覆盖每个内置面板且无多余键）；
 * 3. 每个 `blueprint_node` 都命中**已注册**的蓝图节点类型；可承载面板的节点类型必须
 *    允许 `panel_id` 字段（面板标准第 5.2 节）；
 * 4. Rust `PanelCategory` / 设置项输入类白名单 ↔ TS 注册表逐项对齐；
 * 5. 「全部设置」的大类/二级列表**只列出声明了 `settings` 的面板**，且分组与
 *    `category` 一致（无设置项的面板不显示，见 `docs/spec/settings-standard.md` 第 4.1 节）；
 * 6. **命名空间与插件缺失容错**：插件面板项必须是 `plugin.<plugin_id>.<local_id>`；
 *    未注册的 `panel_id` 既不报硬错误也不被丢弃（允许保存、原样保留）；
 * 7. **面板设置的闭环**：声明 ↔ 归一化 ↔ 面板消费 ↔ 热加载四条触发源（查看器顶部
 *    基础信息栏的 `infoBarEnabled` 是这套闭环的第一个布尔设置；色彩参考的
 *    `valueFormat` 另有"声明候选 ↔ 面板纯函数取值域"与"显示/复制同一份文本"两条断言），
 *    外加「点击图像即按需提取调色板」这条**装配层**行为（面板里没有提取按钮）。
 *
 * 用法：pnpm check:panels
 *
 * D189 起这 488 条断言按面板域拆到 tools/panels/*.mjs，本文件只负责按原顺序执行与汇总：
 * 顺序即断言顺序（模块在 import 期执行），擅自调换会改变 PASS 输出次序。
 * 共享真值在 tools/panels/shared.mjs，断言框架在 tools/panels/harness.mjs。
 */

import { summarize } from "./panels/harness.mjs";
import runRegistry from "./panels/registry.mjs";
import runViewerInfoBar from "./panels/viewer-info-bar.mjs";
import runColor from "./panels/color.mjs";
import runMediaPreview from "./panels/media-preview.mjs";
import runMetadata from "./panels/metadata.mjs";
import runImageviewer from "./panels/imageviewer.mjs";
import runRegistryDocs from "./panels/registry-docs.mjs";
import runBookPreview from "./panels/book-preview.mjs";
import runBookReader from "./panels/book-reader.mjs";
import runTagtable from "./panels/tagtable.mjs";
import runMusic from "./panels/music.mjs";

await runRegistry();
await runViewerInfoBar();
await runColor();
await runMediaPreview();
await runMetadata();
await runImageviewer();
await runRegistryDocs();
await runBookPreview();
await runBookReader();
await runTagtable();
await runMusic();

summarize();
