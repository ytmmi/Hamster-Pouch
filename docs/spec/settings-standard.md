# 设置标准（「全部设置」系统界面 + 设置注册表 + 插件扩展）

状态：正式草案。本文是 RFC 0010 决策 7 的**标准化展开**：把「顶部设置 → 更多设置」跳转到的**全部设置**界面固化为一份规范——它是**应用级系统界面**，**用户不可自定义**，**插件可增加设置**。

本文规范三件事：**界面结构**（搜索 + 左右分栏 + 二级列表 + 分节）、**设置注册表**（设置项声明参数列表）、**插件扩展**（新贡献点 `settingsSection`）。

## 1. 定位

- **系统界面**：由宿主提供、**用户不可自定义**的界面。它不是蓝图层，**不进 `blueprints` 表、不受蓝图引擎管辖**，也不参与 `panel_layouts` 的布局持久化。
- **应用级**：跨仓库共享同一份；界面本身不随仓库切换而重建。
- **入口**：顶部设置区新增「**更多设置**」项，点击**跳转**到名为「**全部设置**」的界面。
- **与仓库无关的设置项**播放应用级作用域；需要按仓库隔离的设置项在声明里标注 `scope = "repo"`（第 5 节）。

**与蓝图的关系**（必须分清，否则会做出两套互相冲突的"界面"）：

| | 「全部设置」界面 | 蓝图「界面」（层 / 页面） |
| --- | --- | --- |
| 谁定义 | 宿主（系统界面） | 用户（仓库内蓝图） |
| 可否自定义 | ❌ 不可 | ✅ 可 |
| 作用域 | 应用级（跨仓库共享） | 仓库级（`blueprints` 表，按 `repo_id`） |
| 进蓝图引擎 | ❌ 不进 | ✅ 进 |
| 落库 | `app_settings`（键值） | `blueprints` / `blueprint_templates` |

「全部设置」里的「**蓝图**」大类管的是**蓝图相关的设置**（默认蓝图、模板、主界面、自动同步开关），**不是**用户蓝图的编辑器。

### 1.1 权威与落点

| 关注点 | 权威实现 | 说明 |
| --- | --- | --- |
| 设置注册表（宿主项） | `packages/config/src/settings.ts`（`SETTING_CATEGORIES` / `SYSTEM_SETTING_DECLS` / `allSettingDecls` / `validateSettingDecl`） | **前端注册表**（不是命令，见下） |
| **注册表与搜索的形态（2026-09 裁决）** | `apps/desktop/src/app_ui/settings/settingsRegistry.ts`（`sectionsOf` / `searchSettings`） | **前端函数，非 Tauri 命令**：注册表 = TS 静态声明 + 插件贡献（经 `plugin.contributions` 到达前端）；搜索必须匹配 `title_key` 的**当前语言文案**，Rust 侧无 i18n。故原 `setting.registry` / `setting.search` 两条命令**已从契约撤下**（见 `docs/spec/commands-events.md` 3.13） |
| 设置项读写 | `crates/hp-store/src/global/global_db.rs`（`set_setting` / `get_setting`，表 `app_settings`） | 键值对，**不新增库表** |
| 既有设置项 | `ui.theme` / `ui.language` / `layout.syncBlueprint` | 三者必须能在新界面找到并读写（**零行为变化**） |
| 桥接命令与事件 | `apps/desktop/src-tauri/src/commands/repo.rs`（`setting_get` / `_set` / `_list` / `_reset` 与 `setting.changed`） | 只有 4 条命令；**注册表与搜索不经命令**（见上） |
| 面板设置来源 | `docs/spec/panel-standard.md` 第 5.3 节（面板 `settings[]`） | 按面板分节渲染 |
| 插件设置来源 | `docs/spec/plugin-standard.md` 第 3.2 / 4 节（`settings` / `settingsSection`） | 按插件分节渲染 |
| 值控件白名单 | `docs/spec/control-standard.md` 第 4 节（只取**输入类** 6 种） | `button` 与其余类别不允许 |
| 设计 token | `packages/ui` | 外观不写死像素、不引入自定义配色 |

## 2. 界面结构

```text
┌──────────────────────────────────────────────────────────────┐
│  全部设置                                        [搜索框]     │
├───────────────┬──────────────────────────────────────────────┤
│ 大类（一级）  │ 详细设置（右侧）                              │
│               │                                              │
│ ▸ 界面        │  分节标题 A                                  │
│ ▸ 蓝图        │  ─────────────────────────────────────────   │
│ ▾ 面板        │   设置项…                                     │
│    基础       │                                              │
│    ├ 仓库     │  分节标题 B                                  │
│    ├ 媒体源   │  ─────────────────────────────────────────   │
│    └ 相册     │   设置项…                                     │
│    媒体       │                                              │
│    └ 媒体预览 │                                              │
│ ▸ 插件        │                                              │
│ ▸ 语言        │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

结构规则：

1. **顶部搜索框**：横跨整宽，搜索**全部大类与全部设置项**（第 6 节）。
2. **左右分栏**：左侧为大类，右侧为详细设置。
3. **左右都可有两级**：
   - 左侧：**一级 = 大类**，**二级 = 该大类下的条目**（面板大类 → 各面板；插件大类 → 各插件）。
   - 右侧：**分节**用**横线**分割（同一页面内多个分类），节标题 + 设置项列表。
4. **右侧 = 左侧当前选择的详情（主从结构）**：右侧**只**渲染所选节点的设置项，**不是**左侧整栏的混合。
   - 大类**有**二级项（面板 / 插件）：选中某个二级项 → 右侧只显示**它**那一节；点大类本身 → 选中其**第一项**。
   - 大类**没有**二级项（界面 / 蓝图 / 语言）：大类自身即叶子，右侧显示该大类的分节。
   - 所选节点没有任何设置项时，右侧只留**一行空态**，不写说明文字（大类本身**不隐藏**，见第 3 节）。
   - 因此**不再使用"选中即滚动定位"**：右侧不渲染其它节点，也就没有可滚动的目标。
5. **宽度自适应**：分栏比例由宿主决定，左栏有最小/最大宽度；**不写死像素**，取 `packages/ui` 设计 token。
6. **不写说明文字**：界面 / 蓝图等大类不在左侧或右侧插入解释性段落（如"应用级系统界面…"）；界面只呈现设置项本身。

## 3. 大类

| 大类 | 二级列表 | 内容 |
| --- | --- | --- |
| **界面** | 无（按分节：**外观** / **其他设置**） | 主题（浅色/深色）、窗口与启动行为、界面级显示选项；**「其他设置」分节**装跨面板共用的通用口径——体积单位 `ui.sizeUnit`（二进制 KiB/MiB/GiB 缺省、十进制 KB/MB/GB）、日期格式 `ui.dateFormat`（YYYY-MM-DD 缺省 / MM/DD/YYYY / DD/MM/YYYY）、日期后显示时间 `ui.dateShowTime`（缺省关） |
| **蓝图** | 无（按默认/模板/同步分节） | 内置默认蓝图与版本、蓝图模板管理、主界面（`is_home`）、「保存布局时自动同步进蓝图」开关 |
| **面板** | **各面板**（按面板 `category` 分组） | 每个面板的设置项，**按面板分节** |
| **插件** | **各插件**（按插件分类分组） | 每个插件的设置项 + 启用状态与能力授权展示 |
| **语言** | 语言列表 | 界面语言（`zh-CN` / `zh-TW` / `en`） |

- **大类是封闭枚举**：新增大类必须同时更新本表、宿主设置注册表与 i18n 文案。
- **「面板」大类管的是面板设置，不叫「控件」**：控件（26 种宿主 UI 单元）**不单独占一个大类**——它们不是用户可直接配置的功能单元，其外观由设计 token 与主题统一决定（RFC 0010 决策 1、7）。
- 某个大类的注册表为空时，该大类**仍然显示**（不隐藏，避免"设置项凭空消失"），右侧只给**一行空态**；空大类不写解释性说明文字（第 2 节规则 6）。

## 4. 面板与插件的二级列表

### 4.1 面板（大类「面板」）

- **二级列表 = 各面板**，**按面板 `category` 分组**（`source` / `media` / `info` / `system` / `other`，见 `docs/spec/panel-standard.md` 第 3 节）。该 `category` 下没有任何带设置项的面板时，**连分组标题一起不渲染**。
- **右侧按面板分节**：每个面板一个分节（节标题 = 面板标题），节内是该面板声明的 `settings[]`。
- 面板**没有**声明 `settings` 时：该面板**不出现在**二级列表，**也不生成**右侧分节（避免点进去是空页）。二级列表与分节**同源**（`settingsRegistry.panelsWithSettings`），两处口径强制一致。
  > **已定（2026-09，用户裁决）**：本项原先在第 12 节列为开放点（"不显示"或"置灰空态"二选一）。现确定为**不显示**；因当前没有任何内置面板声明 `settings`，「面板」大类在实际运行中为空，按第 3 节保留大类并只给一行空态。
- 插件注册的面板与内置面板**同权**：同样按 `category` 分组、同样按面板分节。

### 4.2 插件（大类「插件」）

- **二级列表 = 各插件**，**按插件分类分组**（第 4.3 节）。
- 每个插件的分节包含：**插件声明值设置**（`settings[]`，`docs/spec/plugin-standard.md` 第 3.2 节）、**启用状态**（按仓库）、**能力授权**（已授权/未授权、请求了但未授权的高危能力）。
- **未启用的插件**仍出现在列表里（否则用户无法启用），但其设置项置灰并说明原因。
- 插件设置值**按插件隔离**存应用设置（不复用其它插件的键空间）。

### 4.3 插件分类

用于「插件」大类的二级分组。第一版最小集：

| 分类 | 中文 | 含义 |
| --- | --- | --- |
| `panel` | 面板 | 提供面板/查看器的插件 |
| `ai` | AI | 提供 AI 推理的插件 |
| `metadata` | 元数据 | 提供元数据字段/解析的插件 |
| `tool` | 工具 | 命令/批处理类插件 |
| `other` | 其它 | 未分类兜底 |

- 分类来源：manifest 声明（缺省 `other`）。
- 未分类插件**不隐藏**，落 `other`。

## 5. 设置注册表（声明参数列表）

「全部设置」渲染的一切设置项都来自**统一的设置注册表**。每个设置项是一份**纯数据**声明；面板设置、插件设置与宿主设置**同形**，只有 `owner` 不同。

| 声明参数 | 类型 | 取值域 / 约束 | 必需 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | `^[a-z][a-z0-9._-]{0,63}$`；应用设置键 `app_settings.key` | ✅ | 稳定 id，也是落库键（宿主设置用 `ui.*` / `layout.*` 前缀） |
| `category` | enum | 大类：`interface` / `blueprint` / `panel` / `plugin` / `language` | ✅ | 归属大类（第 3 节） |
| `owner` | object | `{ kind: "system" \| "panel" \| "plugin", id? }` | ✅ | 归属：宿主 / 某面板 / 某插件；`panel`/`plugin` 时 `id` 必需 |
| `title_key` | string | i18n 键（D27） | ✅ | 设置项显示名；**不得内联文字** |
| `kind` | string | **只能取控件的输入类**：`switch` / `textInput` / `numberInput` / `select` / `slider` / `checkbox` | ✅ | 值控件类型（见下方规则） |
| `options` | object[] | `{ value: string \| number \| boolean, title_key }`；**仅 `kind = "select"` 可用**；`select` **缺它即硬错误** | 仅 `select` | 下拉候选；**选项文案必须走 i18n 键**（D27），`value` 必须是标量 |
| `default` | 依 `kind` | 与 `kind` 匹配的标量 | — | 缺省值；不写即"未设置" |
| `divider_before` | bool | `true` / `false` | — | **纯展示**：在该项之前画一条横线（分组分隔线）。不参与取值与校验、不需要 i18n 键；分节首项上写它无意义（渲染层忽略）。本版只有这一级分组，**没有**标题/嵌套/折叠 |
| `scope` | enum | `app`（缺省） / `repo` | — | 作用域：应用级 / 按仓库隔离 |
| `requires_capability` | string | 能力白名单 | — | 不满即该项**置灰**并说明，不静默隐藏 |
| `keywords` | string[] | 任意字符串 | — | 搜索补充关键词（第 6 节） |
| `section_key` | string | i18n 键 | — | 右侧分节标题；缺省用 `owner` 的分节 |

规则：

- **`kind` 只能取输入类控件**：设置项是**值**，不是动作，因此 `button` 不允许；布局/展示/集合/反馈类的 `kind` 用作设置项即**硬错误**（同 `docs/spec/panel-standard.md` 第 5.3 节）。
- **`switch` 与 `checkbox` 语义不同、外观相同**（宿主渲染口径）：
  - `switch` = 立即生效的开关；`checkbox` = 表单式布尔值——两者**都是**胶囊按钮（胶囊 + 圆形滑块，**滑块位置与胶囊颜色**共同表示开/关），`role="switch"` + `aria-checked`，文案走 `aria-label`（D27）。
  - **宿主只维护一种勾选框外观**：`apps/desktop/src/app_ui/shared/SwitchToggle.tsx` 是唯一实现，设置项（两种 kind）、面板内控件标准的 `switch` / `checkbox`、菜单与蓝图里的布尔项（插件启用、带结构创建、浮层显隐/隐藏标签）全部走它。
  - 门禁 `pnpm check:settings` 断言：`app_ui` 内**不得**再出现原生复选框输入（递归扫描，这是"所有勾选框都是胶囊"的唯一可靠判据）、以及 `<label>` 不得包住该组件（label 不允许包含其它可交互元素，用 `<span>` 容器 + `label` 属性替代）。
- **`options` 只属于 `select`**：`select` **必须**给 `options`（否则无从渲染，硬错误）；其它 `kind` 带 `options` 即**硬错误**（歧义即拒绝）。`options[].title_key` 是 i18n 键，**不得内联选项文字**（D27）；`options[].value` 必须是**标量**，且不得重复。
  > 与控件标准的差别：控件标准里 `select` 的候选来自 `bind`（`options_kind = static`/`bound`，见 `docs/spec/control-standard.md` 第 4 节）；**设置项没有数据绑定**，候选是**声明期的静态列表**，故用 `options` 承载。
- **设置项不新增能力**：设置项不是绕过 `repo.read` / `repo.write` / `fs.*` 授权的通道；由设置项触发的写操作仍按对应能力在该仓库单独校验。
- **值一律是标量**：string / number / bool；不接受嵌套对象或任意表达式（与 D32 同口径）。
- **面板设置的取值归一化在注册表侧**（2026-09 补记）：面板项由 `packages/config/src/panels.ts` 的 `normalizePanelSettingValue(panelId, key, raw)` 按声明的 `kind` / `default` 归一化（非法取值回落缺省、声明缺项返回 `undefined`），面板不得自写第二套解析规则；读取与热加载走 `apps/desktop/src/app_ui/shared/settingValue.ts`（四条独立触发源）。**宿主项与面板项共用同一份归一化内核**（`packages/config/src/settingValue.ts` 的 `normalizeDeclaredValue`）与同一份订阅内核（`shared/settingValue.ts` 的 `useStoredSetting`）——两者只有"落库键怎么拼、声明去哪里查"不同：宿主项用 `normalizeHostSettingValue(key, raw)` / `useHostSettingValue(key)`，面板项用 `normalizePanelSettingValue(panelId, key, raw)` / `usePanelSettingValue(panelId, key)`。详见 `docs/spec/panel-standard.md` 第 5.3 / 8 节；插件项的声明随插件包（不经这两个函数）。
- **`id` 全局唯一**：冲突即硬错误（插件设置键由 `plugin.<plugin_id>.` 前缀隔离，见第 7 节）。
- **落库**：`app_settings`（全局库）键值对；`scope = "repo"` 的项按仓库隔离存储。**不新增库表**。

## 6. 搜索

- **范围**：全部大类与全部设置项（含当前未展开的大类）。
- **匹配**：① 设置项 `title_key` 的**当前语言文案**；② `keywords`；③ 所属面板/插件的标题。**不接受正则与任意表达式**。
- **结果**：按大类分组列出命中项；点击即**跳转定位**到该项所属分节并高亮。
- **空态**：无命中时给空态占位（不显示空白页）。
- **不搜索**：设置项的**当前值**、仓库数据、插件内部数据（避免把仓库数据搬进设置界面）。

## 7. 插件扩展

插件经**新贡献点 `settingsSection`** 增加设置（`docs/spec/plugin-standard.md` 第 4 节）：

```jsonc
{
  "kind": "settingsSection",
  "id": "palette.settings",
  "title_key": "palette.settings.title",
  "category": "panel",              // 归入**五大类**之一（interface/blueprint/panel/plugin/language，见第 5 节）
                                    // **不是**第 4.3 节的"插件分类"（那是另一根轴，见下方注）
  "settings": [                     // 形状与第 5 节完全一致
    { "id": "grid_size", "kind": "numberInput", "title_key": "palette.gridSize", "default": 4 }
  ]
}
```

> **两根轴不要混（2026-09 更正）**：本文件有**两个都叫「分类/大类」的枚举**，此前示例注释把二者写混了：
>
> | 轴 | 字段 | 取值域 | 作用 |
> | --- | --- | --- | --- |
> | **大类**（五大类） | `settingsSection.category`、`SettingDecl.category` | `interface` / `blueprint` / `panel` / `plugin` / `language` | 决定设置**落在左侧哪个一级大类** |
> | 插件分类 | 插件 manifest 的分类（供「插件」大类的二级列表分组） | `panel` / `ai` / `metadata` / `tool` / `other`（第 4.3 节） | **只**决定插件在「插件」大类内**二级列表**怎么分组 |
>
> 两者**取值偶然重叠**（`panel` 同时是合法大类与合法插件分类），但**语义无关**、不可互替。`settingsSection.category` **必须**取五大类之一（第 8 节硬错误 3 的依据）。

规则：

- **插件只能增加设置项，不能增加大类**（大类是宿主封闭枚举）。
- **插件不得隐藏或改写宿主设置项**；同名 id 一律**硬错误**（不做覆盖、不做合并）。
- 插件设置的落库键**必须**带 `plugin.<plugin_id>.` 前缀，由宿主强制加前缀，插件不能自定义前缀。
- 插件声明未授权能力相关的设置项时，该项**置灰**并如实说明缺哪项授权。
- 插件被禁用/卸载时，其设置项**从界面消失但值保留**在 `app_settings` 里（重新启用即恢复）——与蓝图侧"未接通不删数据"同一取舍（RFC 0010 决策 6）。

## 8. 校验分级

**硬错误（拒绝注册 / 拒绝渲染该项）**：

1. `id` / `category` / `owner` / `title_key` / `kind` 缺失。
2. `id` 不合命名规则，或与既有设置项冲突。
3. `category` 不在五个大类内；`owner.kind = panel`/`plugin` 但 `owner.id` 缺失或未注册。
4. `kind` 不在输入类白名单内。
5. `default` 与 `kind` 不匹配（如 `switch` 给了字符串）。
6. `scope` 不在 `app` / `repo` 内。
7. 插件设置项的落库键未带 `plugin.<plugin_id>.` 前缀（宿主强制加，插件自带其它前缀即拒绝）。
8. **`options` 相关（2026-09 补入）**：`kind = "select"` 而**缺 `options`**；非 `select` 的 `kind` 带 `options`；`options[].title_key` 缺失（选项文案必须走 i18n 键，D27）；`options[].value` 不是标量（string / number / boolean）或在同一项内**重复**。

**软告警（不阻塞，可渲染）**：

1. `requires_capability` 未授权 → 该项置灰。
2. `scope = "repo"` 但当前未打开仓库 → 该项置灰。
3. `keywords` 为空且 `title_key` 文案在同大类内重名 → 搜索可能歧义，提示维护者。
4. 某大类的注册表为空 → 显示空态占位。

**宿主拒绝规则**：

- 插件试图新增/改名**大类**：忽略并记录。
- 插件试图隐藏、改写宿主设置项或覆盖同名 id：拒绝并记录。
- 设置项声明里出现嵌套对象、任意表达式、像素或自定义配色：忽略并记录。

**写入路径的宿主校验（2026-09 落地，`docs/spec/commands-events.md` 3.13 的四条规则）**：

声明校验（上表）管的是"声明本身合不合法"；写入时还有一层**键与值的宿主校验**，
由 `crates/hp-core/src/setting_registry.rs`（注册表**校验镜像** + `validate_setting_value` +
`scoped_storage_key`）与 `apps/desktop/src-tauri/src/commands/repo.rs` 执行：

1. **未知键拒绝**：落库键必须命中某个声明（宿主 / 面板项取镜像，插件项按 manifest 反查），
   否则 `validation`——避免把 `app_settings` 当任意键值存储；
2. **按 `kind` 校验值**：`switch`/`checkbox` 要布尔、`numberInput`/`slider` 要数值、
   `textInput` 要字符串、`select` 必须命中 `options`（**空 `options` 的 `select` 直接拒绝**）；
   值一律标量，`null`/数组/对象一律拒绝（同 D32）；
3. **插件项不满能力 → `permission`**：`requires_capability` 由 `PluginHost::check_capability`
   按仓库校验；**失败关闭**——拿不到 `repoId` 就无法判定授权，同样返回 `permission`；
4. **仅 `scope = "repo"` 的项拼 `{key}.{repoId}`**：`app` 项忽略传入的 `repoId`；
   `repo` 项缺 `repoId` 即 `validation`。

> **注册表的权威声明在前端 TS**（第 1 节，D80 已裁决它不做成命令）。宿主侧只镜像
> **校验所需的事实**（id / owner / kind / scope / options / requires_capability，**不含文案**），
> 镜像与 TS 声明的一致性由 `pnpm check:settings` **逐项断言**（漂移即门禁失败）。
> **已知缺口**：插件 `select` 设置项的 `options` 尚未在 manifest 侧解析，
> 因此宿主对插件 `select` 只能校验"是字符串"，**不假装**校验了枚举归属。

## 9. 验证

- **`pnpm check:settings`**（新增门禁）：
  1. 设置注册表 ↔ 本文档五大大类一致；每个 `category` 都有归属项或空态。
  2. `kind` 白名单与控件注册表的**输入类子集**一致（`docs/spec/control-standard.md` 第 4 节），不得出现 `button` 或非输入类 `kind`。
  3. 「面板」二级列表的分组与面板注册表 `category` 一致（`docs/spec/panel-standard.md` 第 3 节），且**只列出声明了 `settings` 的面板**（第 4.1 节）。
  4. **右侧 = 左侧当前选择的详情**（第 2 节规则 4）：面板/插件的每个二级项**只**解析出自己那一节；未显式选择（或选择已失效）时回退到该大类第一项。
  5. 「插件」二级列表覆盖全部已注册插件，未分类落 `other`。
  6. 落库键前缀规则（宿主 `ui.*` / `layout.*`；插件强制 `plugin.<plugin_id>.`）。
  7. 搜索：`title_key` 在所有语言资源里都存在（三套语言键集一致）。
  8. **（2026-09 新增）** Rust 校验镜像 ↔ TS 权威声明**逐项一致**（宿主项 ↔ `SYSTEM_SETTING_DECLS`、面板项 ↔ `panelSettingDecls()`，比对落库键 / `kind` / `scope` / `options`），且**无多余声明**（反向断言）；以及写入路径四条规则与 D76 包装的落点断言。
- **`cargo test -p hp-core`**：设置声明的硬错误清单、`kind` 输入类白名单、插件键前缀强制、同名 id 冲突拒绝；**（2026-09 新增）** 校验镜像的落库键/`kind`/`scope`、值校验分级、`select` 必须有可选项、以及"仅 `repo` 项拼 `repoId`"（`crates/hp-core/src/setting_registry.rs` 的 4 个用例）。
- **回归**：现有三项设置（`ui.theme` / `ui.language` / `layout.syncBlueprint`）必须能在新界面里找到并读写（**零行为变化**）。
- **（2026-09 补记）显示格式类宿主设置的"行为"由 `pnpm check:panels` 的元数据面板段断言**：体积两制（1024 / 1000）且按体积自适应、日期三格式 ± 时间开关、时长/码率/帧率、ffprobe / EXIF 解析夹具，以及"面板真的消费它并按媒体类型自适应渲染"。分工：`check:settings` 管**声明合法与镜像不漂移**，该段管**显示正确**。
- `pnpm typecheck` / `pnpm build` / `check-line-count` / `check-doc-status` 通过。

## 10. 落地顺序（强制）

1. ✅ 本文（设置标准）定稿；RFC 0010 决策 7 记录。
2. ✅ 系统界面路由与「更多设置」入口（`app_ui/settings/SettingsApp.tsx`、`menu/MenuBar.tsx:367`-`377`、`core/AppUiApp.tsx:348`-`354`；独立于仓库蓝图与 `panel_layouts`）。
3. ✅ 设置注册表 + 三个宿主设置项迁入 + `app_settings` 读写（`packages/config/src/settings.ts`；**键名与默认值未变**）。
4. ✅ 「面板」大类接入面板注册表（按 `category` 分组、按面板分节；**无 `settings` 的面板不显示**，第 4.1 节）。
5. 🟡 「插件」大类接入插件注册表 ✅，但**能力授权展示未接线**（`requires_capability` 目前一律按"未授权"置灰 —— 失败关闭是对的，但真正的授权查询未接进来，见第 12 节开放点）。
6. ✅ 搜索（`title_key` 的**当前语言文案** + `keywords`；前端函数 `settingsRegistry.ts` 的 `searchSettings`，非命令）。
7. ✅ 贡献点 `settingsSection`（`plugin_contribution.rs` + `plugin_validate.rs` 的大类/前缀/同名校验；可用夹具 `plugins/system/palette`）。

## 11. 明确不做（第一版）

- 用户自定义「全部设置」界面（它是**系统界面**）。
- 插件新增/改名大类、隐藏或改写宿主设置项。
- 任意表达式、正则、嵌套对象作为设置值与搜索条件。
- 设置项写死像素或自定义配色（外观只取 `packages/ui` 设计 token）。
- 把「全部设置」做成蓝图的一层（它不是蓝图层，不受蓝图引擎管辖）。
- 为设置新增库表（只写 `app_settings`）。

## 12. 开放点（实现期）

- ~~「面板」大类：无 `settings` 的面板是**不显示**还是**置灰空态**~~ —— **已定（2026-09）：不显示**，见第 4.1 节。
- 搜索是否支持匹配**同义词**与拼音/注音（当前仅 `title_key` 文案 + `keywords`）。
- 设置项的**重置为默认**与**导入/导出**是否需要（当前只有逐项读写）。
- `scope = "repo"` 的设置项在未打开仓库时是置灰还是隐藏（当前置灰）。
- 插件分类是否由插件自带图标与描述。
- 大类的排序是否可由宿主配置（当前固定顺序：界面 / 蓝图 / 面板 / 插件 / 语言）。
- **`requires_capability` 的授权通道未接线（已知缺口，2026-09 记录）**：当前实现是"**无法确认授权时按未授权处理**"（该项置灰并说明），符合第 8 节软告警 1 的失败关闭原则；但真正的授权查询（Rust 侧已有 `PluginHost::check_capability`）尚未接进设置界面。现有三项宿主设置均未声明 `requires_capability`，故**当前零影响**；一旦有插件声明该字段，就会表现为"设置项一直置灰"——届时需要把授权状态接进来。
- `SettingDecl.options` 的候选是否需要支持**分组**（`optgroup`）或禁用项。
