# RFC 0011：布局预设与仓库绑定（应用级默认 + 仓库覆盖）

状态：正式草案。本文落实用户 2026-11-10 确认的口径，**只定义设计，不含实现**；在实现落地前，现行行为与缺陷 `0044`（发布包内的布局预设拿不到）保持不变。

用户确认的三条口径：

1. **归属 = 两级叠加（A3）**：应用级默认 + 仓库可选覆盖（既不是「布局只能属于仓库」，也不是「布局只能属于应用」）。
2. **结构形态 = 形态 2**：预设实体化（应用级、无仓库维度的 `layout_presets`）+ 仓库绑定表（`layout_bindings`）。
3. **必须满足四个场景**：① 发布包 / 新机器开箱即见既定布局；② 每个仓库仍可各用各的布局；③ 消除「一份布局三行、行间漂移」；④ 布局可导出 / 导入（换机、分享、存档）。

设计讨论中列出的六个待拍板点，本文已给出采纳值（决策 5 / 6 / 7 / 8 / 10，以及决策 11 的删除行为）。实现方按本文执行；要偏离必须先重开本文，不得静默改口径。

## 1. 现状（实现前的事实基线）

| 事项 | 事实 | 锚点 |
| --- | --- | --- |
| 布局存储 | 全局配置库 `panel_layouts(id, repo_id, workspace, layer_key, layout_json, blueprint_ids_json, updated_at)`；唯一键 `(repo_id, workspace, layer_key)`；`workspace` 列装的是「布局预设名」 | `crates/hp-store/migrations/global/0001_init.sql`、`0003_layout_blueprints.sql`、`0004_layout_layers.sql` |
| 作用域 | 仓库 × 层 × 名字 三维；默认标记 `app_settings['layout.default.{repoId}']` | `apps/desktop/src-tauri/src/commands/layout.rs:220-221` |
| 命令面 | 八条 `layout.*`（save / list / get / rename / delete / setDefault / getDefault / blueprints） | `docs/spec/commands-events.md:95-106` §3.1.1 |
| 启动套用 | 默认仓库 → 默认布局 → 该层布局；**没有默认仓库就直接返回**（保留代码内建首屏） | `apps/desktop/src/app_ui/core/workspaceBootstrap.ts:21-59` |
| 切层套用 | 读默认标记 → 按 `layerKey` 取该层布局，取不到返回 `false`（保持当前布局） | `apps/desktop/src/app_ui/shared/blueprintRuntime.ts:382-406` |
| 用户入口 | 「窗口 → 布局」：保存当前布局… / 预设列表（点即套用）/ 重命名·删除·设为默认·更新 / 重置布局 | `apps/desktop/src/app_ui/menu/MenuBar.tsx:146-360` |
| 出厂首屏 | 代码内建 `defaultWorkspaceLayout.ts`（无仓库时的兜底，形状 ≠ 用户的「媒体-测试」） | `apps/desktop/src/app_ui/core/defaultWorkspaceLayout.ts` |
| 蓝图联动 | `layout.syncBlueprint`（默认开，D59）：保存布局时增量补 control/group 节点 + contains 边并广播 `blueprint.changed` | `crates/hp-core/src/setting_registry.rs:87`、`packages/config/src/settings.ts:27` |

四个已暴露的问题：

1. **0044**：发布包生成时 `DELETE FROM repos`，而布局与默认标记都按仓库读 ⇒ 包内 `panel_layouts` 存在但不可达，首屏退回代码内建布局，布局菜单为空。证据与三条候选见 `docs/issues/0044-published-package-layout-not-applied.md`。
2. **三行漂移**：一份视觉布局在库里是三条记录（`layer_key = ''` / `l_main` / `l_2`），各自 `updated_at`。当前数据里 `媒体-测试` 的层无关行 `''` 停在 2026-09-13 的旧形状（1365 B），真机编辑的是 `l_main`（2195 B）。
3. **死键**：`app_settings` 里 `layout.names`（`["测试1"]`）与 `layout.测试1`（1351 B）**全仓没有生产者或消费者**，只有 `tools/layout-check.mjs:46` 仍把 `layout.<名>` 当预设行校验——这是 `panel_layouts` 之前老通道的遗留。
4. **无交换格式**：布局只能整库拷贝，没有导出 / 导入。

> 溯源：`0001_init.sql` 里 `repo_id` 的注释本就写着「空串或特殊值表示全局默认布局」（D1），但从未实现。本文把这条原始意图正式落地。

## 2. 目标模型

### 决策 1：三层解析链（自上而下，命中即停）

1. **仓库覆盖**：本仓库在 `layout_bindings` 里有绑定行 ⇒ 用该预设；
2. **应用级默认**：`app_settings['layout.default']` 指向的预设；
3. **出厂默认**：代码内建形状（仅 1、2 都缺时使用）。

四个场景的落点：发布包只带第 2 层（随包数据里有预设 + 指针），无仓库也生效；仓库覆盖是可选的 0/1 行；出厂默认只在「库内没有任何预设或默认」时兜底。

### 决策 2：两张表（全局配置库，迁移 `global/0005`）

```sql
-- 应用级预设：无仓库维度；一份布局 = 一行
CREATE TABLE layout_presets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,          -- 预设名（原 workspace 列语义）
  layers_json        TEXT NOT NULL,                 -- { "l_main": {…}, "l_2": {…}, "": {…} }
  blueprint_ids_json TEXT NOT NULL DEFAULT '[]',    -- 绑定蓝图（沿用原语义，作用于整份预设）
  origin             TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'seeded'（出厂播种，见决策 5）
  updated_at         TEXT NOT NULL
);

-- 仓库覆盖：一行 = 该仓库指定用哪份预设；无行 = 走应用级默认
CREATE TABLE layout_bindings (
  repo_id    TEXT PRIMARY KEY,
  preset_id  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`layers_json` 的键是蓝图层 key；`""` 键保留为**层无关快照**（迁移前旧预设的形状），只在「这份布局里没有该层」时兜底。

### 决策 3：一份布局 = 一条记录

- 保存 = 整份写回（含各层），因此**不可能再出现行间漂移**。
- 读取顺序：当前层条目 → `""` 条目 → 都没有则视为「这份预设没有可用布局」，**沿解析链继续往下**（绝不跨预设借别处的旧行）。
- `layout.save` 的语义从「写当前层那一行」变为「更新预设内当前层的那一格」。

### 决策 4：默认与绑定

- `app_settings['layout.default']` = 应用级默认预设的 `id`；迁移时把现有 `layout.default.{repoId}` 收敛为这一个键，并删除带后缀的旧键。
- 仓库覆盖写 `layout_bindings` 行；删除该行 = 回到应用级默认。

### 决策 5：出厂默认与首次播种

- 出厂默认仍**由代码提供**，但**首次运行会把它播种成一条 `origin = 'seeded'` 的应用级预设**，并设为应用级默认。
  （2026-11-10 / D158 修订：形状从 `defaultWorkspaceLayout.ts` 的「启动时窗口形状」改成 `packages/config/src/layoutDefault.ts` 的 `DEFAULT_LAYOUT_LAYERS`——分层、与 `DEFAULT_BLUEPRINT` 逐层配对；同时首次启动会建「演示仓库」。）
- 播种条件：库里**没有任何预设**时执行一次；已有预设则不动作。
- 版本升级替换规则：仅当该 `seeded` 预设仍未被用户改动（`origin = 'seeded'` 且 `updated_at` 等于播种时间）时才可被新版本替换；用户改过则永不覆盖。

### 决策 6：导出 / 导入

```json
{
  "format": "hamster-pouch.layout",
  "version": 1,
  "name": "媒体-测试",
  "layers": { "l_main": { }, "l_2": { } },
  "blueprintIds": []
}
```

- **导出**：任选一份预设 → 上述 JSON（`layers` 即 `layers_json` 的解析结果）。
- **导入**：校验 `format` / `version` / 结构（复用布局门禁的同一套结构不变量）后落为一条**应用级预设**；重名默认追加后缀 `-2`、`-3`…，不覆盖既有预设。
- 导入**不写** `layout_bindings`，除非用户在导入时显式选择「并为当前仓库绑定」。

### 决策 7：「上次使用」与应用级默认分离

- 新增「上次使用」状态（记录上次用的预设 id 与层 key），只用于恢复现场。
- **它不是默认**：改「上次使用」不影响解析链第 2/3 层；改「默认」也不改当前屏幕。

### 决策 8：蓝图联动保持现状

- `layout.syncBlueprint`（默认开）语义不变：保存预设时增量补 control/group 节点 + contains 边并广播 `blueprint.changed`；作用对象从「一行」变为「整份预设」。
- **不**拆分「布局保存」与「蓝图保存」（原讨论里的 F2 方案不采纳）。

### 决策 9：死键处置

- 迁移中删除 `layout.names` 与全部 `layout.<名>` 键（内容先按决策 10 折算进 `layout_presets`，不丢数据）。
- `tools/layout-check.mjs` 改为校验 `layout_presets.layers_json`；`layout.names` 不再是 `app_settings` 键空间成员。

### 决策 10：现有数据的折算算法

对每个 `workspace`（预设名）分组：

1. 该组所有行的 `layer_key → layout_json` 组成 `layers_json`；
2. `''` 行仍进 `layers_json[""]`，但**不作为主形状**；
3. 预设名 = `workspace`；`updated_at` = 该组最大值；`blueprint_ids_json` 取 `''` 行（原语义：预设级、作用于全部层行）；
4. 原 `layout.default.{repoId}` 的值换算成对应预设 `id`，写成 `layout_bindings(repo_id)`；`app_settings['layout.default']` 取**最后写入**的一条（`app_settings` 无 `updated_at`，按 `rowid DESC`）；
5. 跨仓库同名的同一层格若内容不同，保留 `updated_at` 较新的一格，并在迁移日志里记一行；
6. 落到当前数据：`媒体-测试` 折成一份预设（`l_main` 以 2195 B 那一份为准，`''` 保留旧快照 1365 B，`l_2` 297 B）、`媒体-测试-1` 折成另一份（`''` 1559 B，2026-09-13）；应用级默认指向 `媒体-测试`。

   > **修订注记（2026-11-10，用户裁决）**：`媒体-测试` 的 `''` **不再保留 1365 B 旧快照，改为对齐 `l_main`**
   > （`layers_json[""] = layers_json["l_main"]`）。理由是 1365 B 那行是 2026-09-13 的旧通道残渣、无读写方，
   > 保留会让「层无关兜底」命中一个用户没在用的形状；`媒体-测试-1` 只有 `''`，原样保留。
   > 迁移 `crates/hp-store/migrations/global/0005_layout_presets.sql` 按此裁决实现（组内存在 `l_main` 即对齐）。

### 决策 11：命令面

| 现命令 | 目标命令 | 说明 |
| --- | --- | --- |
| `layout.save` | `layout.save(name, layoutJson, layerKey?, blueprintIds?)` | 去 `repoId`；写预设内该层那一格 |
| `layout.list` | `layout.list()` | 返回应用级预设（不再按仓库过滤） |
| `layout.get` | `layout.get(name, layerKey?)` | 按决策 3 的读取顺序取 |
| `layout.rename` | `layout.rename(name, newName)` | 同步更新默认指针与绑定引用 |
| `layout.delete` | `layout.delete(name)` | 命中应用级默认或任一条绑定时**拒绝删除**（返回错误，提示先改默认 / 解绑）——显式优于隐式 |
| `layout.setDefault` | `layout.setDefault(name)` | 应用级默认 |
| `layout.getDefault` | `layout.getDefault()` | 返回应用级默认名 |
| `layout.blueprints` | `layout.blueprints(name)` | 语义不变 |
| — | `layout.bindRepo(repoId, name?)` | 设 / 清仓库覆盖（`name` 省略 = 清除） |
| — | `layout.export(name)` / `layout.import(json)` | 决策 6 |

八条既有命令都保持「已包装」（返回 `ApiResponse<…>`），新增命令同口径；`docs/spec/commands-events.md` §3.1.1 与桥接层 `fn layout_*` 必须同步，否则 `tools/check-commands.mjs` 会失败。

## 3. 影响面（实现清单）

**数据层**

- 新增 `crates/hp-store/migrations/global/0005_layout_presets.sql`：建两张新表 + 决策 10 的折算 + 删死键；迁移文件**只能追加、不可回头改**（`docs/spec/database-schema.md` 第 5 节、`crates/hp-store/src/migrate.rs` 文件头）。
- `crates/hp-store/src/global/global_db.rs`：`GLOBAL_MIGRATIONS`（`:15-18`）加 0005；`PanelLayoutRow`（`:33`）与 `save_panel_layout`（`:228`）、`set_layout_blueprints`（`:303`）、`list_panel_layouts`（`:329`）、`get_panel_layout`（`:348`）、`rename_panel_layout`（`:379`）、`delete_panel_layout`（`:402`）全部改到新表；`delete_repo`（`:437`）不能再删 `panel_layouts`（改删 `layout_bindings`）；`row_to_layout`（`:474`）/`parse_blueprint_ids`（`:488`）随之调整。
- 全局库版本 **4 → 5**，`docs/spec/database-schema.md:676` 的版本行必须同步。

**命令层**

- `apps/desktop/src-tauri/src/commands/layout.rs`（八条 `:48-:217` + `layout_default_key` `:220-221`）按决策 11 改签名；新增 `layout_bind_repo` / `layout_export` / `layout_import`。

**前端**

- `apps/desktop/src/app_ui/shared/api/layout.ts`、`shared/types/layout.ts`、`settings/SettingsApp.tsx:5`、`core/AppUiApp.tsx:117,410`（`panel_layouts` 引用点）。
- `menu/MenuBar.tsx:146-360`（去 `repoId`；无仓库时也列预设；新增导出 / 导入菜单项）、`core/workspaceBootstrap.ts:21-59`（**无仓库也要套用应用级默认**；无 layer 时用 `""` 条目）、`shared/blueprintRuntime.ts:382-406`（去 `repoId`）。
- 共享类型重新生成（`pnpm check:types` 的对偶生成链路），否则 `check:types` 的 `git diff --exit-code` 会失败。

**门禁与测试**

- `tools/layout-check.mjs:46` 的 SQL 与校验对象改为 `layout_presets.layers_json` + `layout.default`；结构不变量（`grid.root.type === "branch"` 等）保持不变。
- `tools/check-settings.mjs:139/153/305`（键空间 / legacy 清单）、`tools/check-commands.mjs`（§3.1.1 与桥接层一致性）。
- `crates/hp-store/tests/m4_panel_layout.rs` 重写：现有断言按 `repo-1` / `repo-a` / `repo-b` 验证仓库隔离（`:1,50,65,66,97`），要改为「应用级预设 + 解析链 + 绑定 + 折算」语义。
- `tools/fix-layer-layout.mjs`（往 `panel_layouts` 写 `repo_id` 的开发期修数据脚本）随之删除或改写为按新表操作。

**文档**

- `docs/spec/database-schema.md`：3.3 面板布局段（`:43-70`）+ `app_settings` 键空间 + `:676` 版本行。
- `docs/spec/commands-events.md:95-106` §3.1.1；`docs/architecture/decision-checklist.md` 新增 D 条（实现落地时）；`docs/architecture/file-structure.md`（`:730` 的 rfc 范围 + `:821` 的表引用）。
- `docs/spec/control-standard.md:66,155,198,469`、`docs/spec/panel-standard.md:11,32,38,49,236,438`、`docs/spec/settings-standard.md:9,278`、`docs/rfc/0007-blueprint.md:51,239,243,497,589`、`docs/rfc/0010-panel-and-node-registration.md:23` 中凡提「按仓库的布局 / `panel_layouts`」的措辞。
- 私有：`docs/issues/0044-published-package-layout-not-applied.md` 与 `docs/issues/README.md` 的状态从「暂不修」改为「设计已定，待实施」（本 RFC 即其候选 C 的正式化）。

## 4. 迁移、兼容与回滚

- 迁移只追加；折算在**一个事务**内完成（`migrate::apply` 的既有语义），失败即整支不生效。
- 迁移后旧版本 exe **读不了新库**（表结构已变）⇒ 采用与 D139 相同的「发布物整包替换、不做新旧混跑」口径。
- 回滚只有一条路：从 `backups/appdata/` 的同步前备份恢复全局库（实现前先跑 `node tools/sync-user-data.mjs` 留快照）。
- 发布包重建后，`data/system/hamster-pouch-global.sqlite3` 里应带 `layout_presets` 的随包预设（不再依赖 `repos`）。

## 5. 验收标准

1. `node tools/layout-check.mjs`（活动数据源与发布包库两份）通过。
2. 门禁全绿：`node tools/check-commands.mjs`、`node tools/check-settings.mjs`、`node tools/check-status.mjs`、`node tools/check-doc-status.mjs`、`node tools/check-encoding.mjs`、`node tools/check-line-count.mjs`；`cargo test -p hp-store`。
3. **真机（本轮的核心验收）**：`node tools/package-build.mjs` 后运行 `apps/desktop/src-tauri/target/release/release/hamster-pouch-desktop.exe`——**不建立仓库**的前提下，首屏即用户的「媒体-测试」形状（`l_main`：媒体源与相册同标签组），「窗口 → 布局」列出应用级预设且可切换。
4. 导出→导入往返：`layout.export` 产出的 JSON 经 `layout.import` 后，`layers_json` 与源逐字节一致。
5. 发布包数据自洽：`data/system/hamster-pouch-global.sqlite3` 中 `layout_presets` 含随包预设、`app_settings['layout.default']` 指向它、`repos` 仍为空（发布包不含用户数据这条口径不放松）。

## 6. 不纳入本文（边界）

- 不做「布局独立于仓库」的**替换式**方案（即讨论中的 D150 / A2）——用户已叫停并撤销，见 `docs/architecture/decision-checklist.md` 末尾的 0044 小节。
- 不改蓝图节点 / 控件 / 面板注册（RFC 0007 / 0010 的口径不动）。
- 不引入布局的版本化历史或多份并存的自动快照；预设内 `version` 字段只服务导入格式。
- 不做布局的云同步 / 插件注册布局（插件仍不得注册布局）。
