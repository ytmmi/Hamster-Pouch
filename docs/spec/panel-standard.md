# 面板标准（注册表 + 声明参数列表；宿主内置 + 插件可注册）

状态：正式草案。本文是 RFC 0010 决策 4 的**标准化展开**：把「面板」确立为**可注册对象**，并把它必须声明的参数收敛为**一份定义表**，供宿主注册表、插件 manifest 校验、「全部设置 → 面板」界面与蓝图属性面板**共用同一口径**。

**本文规范的对象是「面板」，不是「控件」**（两者层级不同、不得混用，见第 1 节）。控件标准见 `docs/spec/control-standard.md`。

## 1. 术语与层级（先分清三个词）

| 术语 | 指代 | 谁可注册 | 枚举 / 落点 |
| --- | --- | --- | --- |
| **面板（Panel）** | dockview 承载单元：仓库、媒体源、相册、媒体预览、查看器、图像查看器、元数据、标签/评分、tag表、色彩参考、媒体播放器、任务、插件、蓝图 | **宿主内置 14 个 + 插件可注册** | 蓝图节点枚举 `control`（**不变**）；`PANEL_IDS` / `panel_layouts` 表 |
| **控件（Control）** | 面板**内部**的标准 UI 单元（26 种） | **仅宿主**（D62） | 控件 schema 的 `kind` |
| **类目（Category）** | 面板内部条目分类（原显示名「类」） | 宿主 | 蓝图节点枚举 `class`（**不变**） |

**层级（蓝图结构树）**：

```text
界面（层 / 页面）
 ├─ 布局块 ⊃ 标签组 ⊃ 面板 ⊃ 类目 ⊃ 对象
 └─ 浮层（容器，与布局块同级）⊃ 标签组 / 面板
```

**两棵树，别混**：

- **蓝图结构树**：`面板 ⊃ 类目 ⊃ 对象`（面板是蓝图节点 `control`，类目是 `class`）。
- **面板渲染树**：`面板 → 控件 schema`（控件是面板**内部**的 26 种 UI 单元，**不是**蓝图节点）。

由此三条硬边界：

1. **面板不是控件**：面板是 dockview 承载单元与功能边界；控件是面板内部的 UI 单元。插件可注册面板，**不可以**注册控件。
2. **类目不是控件**：类目是蓝图节点，声明"该面板内部按媒体类型分哪几类条目"；控件是渲染单元。
3. **面板不是布局**：面板是"有哪些功能单元"，布局（`panel_layouts`，D1/D53）是"它们摆在哪、多大、怎么分组"。面板注册表**不参与**布局持久化。

### 1.1 与既有 D46 / D68 的口径一致

本次把「面板控件」改回「**面板**」、把「类」改为「**类目**」，与 D46 / D68 同样**只改文档与 UI 显示用语**：

- 蓝图节点枚举 `control` / `class`、字段 `panel_id` / `media_type`、库表 `panel_layouts`、命令名、i18n 键名（`panel.*`）**一律不变**。
- 历史决策条目（D28/D44/D46/D49/D50/D56）**保持原文**，措辞由 `docs/architecture/decision-checklist.md` 的修订说明统一承接。

## 2. 权威与落点

| 关注点 | 权威实现 | 说明 |
| --- | --- | --- |
| 面板注册表（内置 13） | `packages/config/src/panels.ts`（`PANEL_IDS` / `PANEL_TITLES`） | 当前为常量清单，实现时升级为注册表 |
| 面板 → 组件映射 | `apps/desktop/src/app_ui/core/panelRegistry.tsx`（`PANEL_DEFS` / `DOCK_COMPONENTS`） | 插件面板需要动态注册路径 |
| 面板注册的 manifest 侧 | `crates/hp-core/src/plugin_contribution.rs`（`ContributionKind::Panel`） | 声明参数扩展见 `docs/spec/plugin-standard.md` 第 4 节 |
| 面板校验 | `crates/hp-core/src/plugin_validate.rs`（`PluginManifest::validate`；清单结构在 `plugin.rs`） | 硬错误清单见本文第 7 节 |
| 面板布局（**不是**本文对象） | `panel_layouts` 表 + `packages/config/src/layout.ts` | 只按当前仓库与层过滤 |
| 「全部设置 → 面板」界面 | `docs/spec/settings-standard.md` | 按面板 `category` 分组、按面板分节 |

## 3. 面板分类（`category`）

用于「全部设置 → 面板」的二级列表分组，也是面板注册表的必填项。第一版最小集：

| `category` | 中文 | 含义 | 内置成员 |
| --- | --- | --- | --- |
| `source` | 仓库与媒体源 | 仓库、源、相册的归属与组织 | `repo`、`sources`、`albums` |
| `media` | 媒体与查看 | 看/听媒体本体 | `media`、`viewer`、`imageviewer`、`player`、`color` |
| `info` | 信息与元数据 | 描述与检索 | `metadata`、`tags`、`tagtable` |
| `system` | 系统与插件 | 应用自身与扩展 | `tasks`、`plugins`、`blueprint` |
| `other` | 其它 | **兜底分类**：未归类或插件自带分类 | 未分类的插件面板 |

- 取值域是**封闭枚举**（含兜底 `other`）；新增分类必须同时更新本表、Rust `PanelCategory`、前端注册表与「全部设置」文案（同 D61 口径）。
- 插件注册的面板从上述四类中选，未指定或取值非法以外的情况落 **`other`**；`other` **不参与排序语义**（排在末位）。

## 4. 声明参数列表（本体）

面板注册表的每一项是一份**纯数据**声明。列名含义：`必需` = 缺失即硬错误；`来源` = 宿主内置 / 插件 manifest。

| 声明参数 | 类型 | 取值域 / 约束 | 必需 | 来源 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `id` | string | `^[a-z][a-z0-9._-]{0,63}$`；命名空间见第 6 节 | ✅ | 两者 | 面板稳定 id；蓝图 `control` 节点的 `panel_id` 引用它 |
| `title_key` | string | i18n 键（D27） | ✅ | 两者 | 面板标题 + 「全部设置」条目名 + 蓝图属性面板候选名 |
| `category` | enum | `source` / `media` / `info` / `system` / `other`（第 3 节；`other` 为兜底） | ✅ | 两者 | 「全部设置 → 面板」二级列表分组 |
| `has_class` | bool | `true` / `false` | ✅ | 两者 | **有无类目**：该面板能否挂「类目」节点（第 5 节） |
| `blueprint_node` | string | 已注册的蓝图节点类型；内置面板缺省 `control` | ✅ | 两者 | 该面板在蓝图里由哪种节点承载 |
| `settings` | object[] | `{ key, kind, title_key, default?, scope?, requires_capability? }`；`kind` 只取控件的**输入类**白名单（第 5.3 节） | — | 两者 | 面板自身设置项，供「全部设置 → 面板」分节渲染 |
| `capabilities` | string[] | 能力白名单（`docs/spec/plugin-standard.md` 第 5 节） | — | 插件 | 建面板与写操作按仓库校验 |
| `mount` | object | `{ overlay_content?, blueprint_ref?, multiple_per_interface? }`，缺省见第 5.4 节 | — | 两者 | 宿主约束：可挂载位置 |
| `read_only` | bool | 缺省 `true`；`false` 需 `repo.write` | — | 插件 | 面板是否只读（同 D65） |
| `icon` | string | 宿主图标集内的名字；**宿主图标集为空时忽略该字段并软告警**（见 7.1 第 8 条、7.2 第 7 条） | — | 两者 | 显示层信息 |
| `default_size` | `{width, height}` | 正数、≤ 10000 | — | 两者 | 首次创建面板时的建议尺寸（**不写死像素布局**） |
| `origin` | object | `{ kind: "system" \| "plugin", plugin_id? }`；**宿主填充，插件不得自称** | ✅（宿主） | 宿主 | 来源与启用状态，用于审计与灰显 |

规则：

- 声明是**纯数据**：不含代码、样式表、像素布局或任意表达式（同 RFC 0010 决策 3）。
- **`origin` 由宿主按实际安装方式判定**，manifest 自称无效（RFC 0004 决策 17 / RFC 0009）。
- `id` 与 `(plugin_id, local_id)` 的映射关系见第 6 节。
- 未知参数一律**忽略并记录**；**已知参数取值非法**一律硬错误（歧义即拒绝，不静默降级）。

## 5. 声明的语义

### 5.1 `has_class`（有无类目）

`has_class` 是「面板」与「类目」之间的**唯一开关**：

| `has_class` | 含义 | 蓝图行为 |
| --- | --- | --- |
| `true` | 该面板内部条目**按类型分类**（如媒体预览的图像/视频/音频） | 该面板下**允许**挂「类目」节点；蓝图属性面板把类目候选限定在此 |
| `false` | 该面板内部**没有**条目分类 | 该面板下**不允许**挂类目节点；`panel → class` 的 `contains` 边为**硬错误** |

内置取值（如实反映当前默认蓝图：只有媒体预览面板有类目）：

| 面板 | `has_class` | 说明 |
| --- | --- | --- |
| `media`（媒体预览） | **`true`** | 内部有 图像 / 视频 / 音频 三个类目 |
| 其余 13 个（含 `imageviewer`） | `false` | 无条目分类 |

- `has_class` **不是**"该面板是否显示媒体"：查看器、图像查看器、媒体播放器都显示媒体，但它们的条目由外部选中驱动，不自分类型。
- **`has_class = false` 面板下已有类目节点时的口径，按声明者区分**（避免"要么全硬要么全软"的两难）：

  | 面板来源 | `has_class` 可否变化 | `panel → class` 边 | 理由 |
  | --- | --- | --- | --- |
  | **宿主内置**（14 个） | **固定不变** | **硬错误**（拒绝保存） | 宿主声明是不变量，出现即是构造错误（同"引用存在但类型不符"） |
  | **插件注册** | **随插件版本可变** | **未接通软告警**（灰显、「允许保存」，插件恢复后自动恢复） | 插件升级把 `has_class` 从 `true` 改成 `false` 时，不能把用户既有文档变成"保存失败"（与 RFC 0010 决策 6 同口径） |

- 编辑器职责：**禁止**在 `has_class = false` 的面板下新建类目节点，属性面板不把类目列入该面板的候选（与结构父唯一性同属编辑器责任）。

### 5.2 `blueprint_node`（对应蓝图节点）

声明"该面板在蓝图里由哪种节点承载"，让**面板注册表与蓝图节点注册表互相对得上**：

- 内置 14 个面板的 `blueprint_node` 均为 `control`（当前唯一承载面板的节点类型）。
- 取值必须命中**已注册的蓝图节点类型**（`docs/spec/blueprint-node-standard.md`）；未命中即硬错误。
- 该字段是**反向映射**的权威：蓝图侧 `control` 节点的 `panel_id` 是正向引用，两侧一致性由门禁断言（第 8 节）。
- 若某节点类型声明自己**可承载面板**，它就必须在蓝图中允许 `panel_id` 字段；否则注册表不一致。

### 5.3 `settings`（面板设置项）

面板声明的设置项，由「全部设置 → 面板」按面板分节渲染：

```jsonc
{
  "key": "thumbnail_size",          // 该面板内唯一
  "kind": "slider",                 // 只取控件的输入类白名单
  "title_key": "panel.media.thumbnailSize",
  "options": [                      // 仅 select 可用（select 缺它即无法渲染）
    { "value": "left", "title_key": "…" }
  ],
  "default": 128,
  "divider_before": true,           // 可选：该项**之前**画一条横线（分组分隔线）
  "scope": "app",                   // app | repo（缺省 app）
  "requires_capability": "repo.read" // 可选；不满即该项置灰
}
```

- `kind` **只能取控件白名单里的输入类**：`switch` / `textInput` / `numberInput` / `select` / `slider` / `checkbox`（`button` 不作为设置项控件——设置项是值，不是动作）。其余 `kind`（布局/展示/集合/反馈）用作设置项即**硬错误**。
- `options` **只属于 `select`**，且 `select` **必须**给 `options`（否则无从渲染，硬错误）；候选文案走 i18n 键（D27），`value` 是标量。口径与 `docs/spec/settings-standard.md` 第 5 节完全一致（面板设置与宿主/插件设置**同形**）。
- `divider_before` 是**纯展示**字段：只在「全部设置」里于该项之前画一条横线，把设置按关注点分组。它**不参与取值、不落库、不影响校验**，也**不需要 i18n 键**（没有文案可译，D27）。**分节内的第一项**上写它无意义，渲染层忽略。本版**只做这一级**：没有分组标题、没有嵌套、没有折叠。
- **取值由注册表侧归一化**：`packages/config/src/panels.ts` 的 `normalizePanelSettingValue(panelId, key, raw)` 按声明的 `kind` / `default` 把 `app_settings` 里的原始值转成标量——非法取值（类型不符、`select` 不在候选内、`switch` 收到 `"yes"` 这类非布尔字符串）一律**回落声明缺省**（失败关闭），声明缺项返回 `undefined`。面板**不得**自写第二套解析规则：两处默认值就是漂移源。规则本体与宿主项共用（`packages/config/src/settingValue.ts`），读取与热加载统一走 `apps/desktop/src/app_ui/shared/settingValue.ts`（四条独立触发源，见第 8 节）。
- **面板设置与宿主设置的分工**：某项设置只作用于**一个面板**时声明在面板 `settings[]`；**跨面板共用的通用口径**（体积单位、日期格式这类）声明为**宿主项**，面板只消费（例：元数据面板消费 `ui.sizeUnit` / `ui.dateFormat` / `ui.dateShowTime`，自身**不**声明同名面板设置——两套口径必然漂移）。
- 取值存应用设置，**按面板隔离**；`scope = "repo"` 时按仓库隔离。
- 面板设置**不得**成为绕过 `repo.read` / `repo.write` / `fs.*` 授权的通道：写操作仍按对应能力在该仓库单独校验。
- 与插件级 `settings`（`docs/spec/plugin-standard.md` 第 3.2 节）同形；面板级设置出现在「面板」大类，插件级出现在「插件」大类。
- **没声明 `settings` 的面板不显示**：它既不出现在「全部设置 → 面板」的二级列表，也不生成右侧分节（避免点进去是空页）。二级列表与分节**同源**，两侧口径必须一致（`docs/spec/settings-standard.md` 第 4.1 节）。

### 5.4 `mount`（宿主约束）

| 字段 | 缺省 | 含义 |
| --- | --- | --- |
| `overlay_content` | `true` | 能否作为**浮层内容**（浮层 `contains` 的目标） |
| `blueprint_ref` | `true` | 能否被蓝图 `control` 节点通过 `panel_id` 引用 |
| `multiple_per_interface` | `true` | 同一界面内是否允许多个实例（`false` 时第二个实例为软告警） |

- `mount` 只**收窄**宿主既有约束，不新增能力：面板永远不能借 `mount` 变成独立窗口或绕过布局。
- `overlay_content = false` 的面板被浮层 `contains` 时：校验层报**硬错误**（与"浮层不得 contains 布局块"同级）。
- `mount` **不影响**布局持久化：不参与 `panel_layouts` 的读写。

### 5.5 `capabilities`（能力）

- 面板声明的是"**我需要什么**"，不是"我有什么"：实际授权仍按「插件在该仓库是否启用 + 该能力是否授权」判定（RFC 0004 决策 6/14）。
- `read_only = false` 的面板隐含要求 `repo.write`；声明里省略 `capabilities` **不会**免除该校验。
- 声明了未授权能力的面板：注册成功但**置灰不可用**，并在「全部设置 → 插件」如实展示缺哪项授权（不静默失败）。

## 6. 命名空间与冲突

| 来源 | `id` 形式 | 示例 |
| --- | --- | --- |
| 宿主内置 | **裸 id** | `repo` / `media` / `viewer` |
| 插件注册 | **`plugin.<plugin_id>.<local_id>`** | `plugin.dev.hamsterpouch.palette.palette` |

- `plugin_id` 即 manifest 的 `id`（`^[a-z0-9][a-z0-9._-]{2,63}$`）。
- 因此**不存在**"插件面板顶掉宿主面板"的可能，也不需要运行时"加前缀消歧"的猜测（RFC 0010「命名空间」）。
- 同一插件内 `local_id` 唯一；跨插件天然不冲突。
- 蓝图 `control` 节点的 `panel_id` 对插件面板使用**完整** `plugin.<plugin_id>.<local_id>`。
- 插件卸载**不重写**用户蓝图里的 `panel_id`：该引用按未接通处理（第 7.2 节），插件重新安装且 id 相同时自动恢复。

## 7. 校验分级

### 7.1 硬错误（拒绝注册 / 拒绝保存）

1. `id` / `title_key` / `category` / `has_class` / `blueprint_node` 缺失。
2. `id` 不合命名规则（含插件项未用 `plugin.<plugin_id>.<local_id>` 形式）。
3. `id` 与已注册项冲突（宿主内置项**不可被覆盖**）。
4. `category` / `blueprint_node` 不在取值域内，或 `blueprint_node` 未命中已注册的节点类型。
5. `settings[].kind` 不在输入类白名单内；`settings[].key` 在面板内重复。
6. `mount.overlay_content = false` 的面板被浮层 `contains`。
7. **宿主内置**面板的 `has_class = false`，而文档里出现 `panel → class` 的 `contains` 边（插件注册面板的同类情形按未接通软告警，见 7.2 第 6 条）。
8. `default_size` 非正数或 > 10000；**`icon` 取值不在宿主图标集内**（**仅当宿主图标集已定义时**；白名单为空期间按 7.2 第 7 条处理）。

### 7.2 软告警（不阻塞，可渲染 / 可保存）

1. **引用的面板当前无注册项**（插件未安装 / 未启用 / 宿主 API 版本不兼容）：蓝图里该 `control` 节点按**未接通**处理——灰显、不参与求值，**允许保存**，插件恢复后自动恢复（RFC 0010 决策 6）。
2. `mount.multiple_per_interface = false` 但同一界面出现多个实例。
3. 声明了未授权能力 → 面板置灰。
4. `default_size` 小于宿主建议最小尺寸 → 按最小值夹紧并提示。
5. `settings[].scope = "repo"` 但当前未打开仓库 → 该项置灰。
6. **插件注册面板**的 `has_class` 由 `true` 改为 `false`，而文档里已有类目节点：灰显「未接通」、**允许保存**（与插件缺失同口径，RFC 0010 决策 6）。
7. **`icon` 而宿主图标集尚未定义**（`PANEL_ICON_WHITELIST` 为空）：**忽略该字段、面板照常注册**（渲染用默认图标），并记录一次软告警说明原因。

> **第 7 条的依据（2026-09 裁决）**：`icon` 白名单的**安全意图**是"不许插件塞任意资源"，这一点用**忽略并回落默认图标**即可满足，**不必拒绝整个面板声明**。硬错误只在白名单**已定义**后才有意义（此时"集内不存在的名字"才是真错误）。因此本条的严重度是**条件性**的：白名单为空 → 软告警；白名单非空 → 硬错误（7.1 第 8 条）。原表述"一律拒绝"会让**任何**带图标的插件面板都无法注册，属规范缺陷，已修正。

### 7.3 宿主拒绝规则

- 插件试图声明**控件** `kind`：忽略并记录（控件不可由插件注册，D62）。
- 插件试图覆盖宿主内置面板 id：拒绝注册。
- 插件试图在面板声明里携带代码 / 样式 / 像素布局 / 任意表达式：忽略并记录。
- 插件 `origin` 自称 `system`：忽略，以宿主判定为准。

## 8. 验证

- **`pnpm check:panels`**（新增门禁，与 `check:controls` / `check:blueprint-nodes` 同款）：
  1. 注册表 ↔ 声明列表 ↔ 本文档三方一致（`id` 清单、顺序、`category`、`has_class`、`blueprint_node`）。
  2. `PANEL_IDS` ↔ `PANEL_DEFS` ↔ `PANEL_TITLES` 三方一致（现有约束，接入门禁）。
  3. 每个 `blueprint_node` 都命中已注册的蓝图节点类型；可承载面板的节点类型必须允许 `panel_id`。
  4. Rust `PanelCategory` / `PanelSpec` ↔ TS 注册表逐项对齐。
  5. 「全部设置」的大类/二级列表**只列出声明了 `settings` 的面板**，且分组与 `category` 一致；右侧**只**显示左侧所选面板的分节。
6. **面板设置的取值域 ↔ 面板实现逐项对齐**：`imageviewer` 的 `navigatorPosition` / `filmstripPosition` / `filmstripView` / `zoomAnchor` 的候选逐项等于 `apps/desktop/src/app_ui/panels/imageviewer/viewerPlacement.ts` 的 `NAVIGATOR_CORNERS` / `FILMSTRIP_EDGES` / `FILMSTRIP_VIEWS` / `ZOOM_ANCHORS`；数值型设置（`filmstripSize`）的缺省必须落在面板自己的夹紧范围内；`divider_before` 必须只出现在分组起点（首项无分隔线）且渲染层真的消费它（声明与实现漂移即失败）。**开关型设置的面板消费同样被断言**：`viewer` 的 `infoBarEnabled` 缺省为真（零视觉变化），且面板**真的**按它条件渲染顶部基础信息栏；归一化只允许一份实现（`normalizePanelSettingValue`），各面板不得重写第二套解析规则。**热加载同样由门禁守护**：面板必须经 `apps/desktop/src/app_ui/shared/settingValue.ts` 订阅本地广播、`setting.changed`、窗口焦点与面板激活四条通路中的全部（只靠事件会出现"改了设置没反应"），因此 `viewer` 也必须拿到 dockview 面板 API（缺它就没有第 4 条触发源）。**宿主设置的消费同样被断言**：元数据面板按 `ui.sizeUnit` / `ui.dateFormat` / `ui.dateShowTime` 出字（体积自适应 KiB→GiB 或 KB→GB、日期三选 ± 时间），并按媒体类型自适应渲染行——图像（解码取像素、EXIF 兜底）、视频（尺寸 / 时长 / 编码 / 码率 / 帧率**各占一行**，优先 ffprobe 原始 JSON、无缓存时用 `<video>` 兜底尺寸与时长）、音频（时长，索引里没有音频元数据，只能前端 `preload="metadata"` 读一次）；缺值渲染 `—`，不省略该行。**图像查看器的底部信息栏用同一批设置与同一份纯函数**（体积 / 日期 / 像素尺寸），只有宽高比 / 百万像素 / 缩放仍是它自己的 `viewerFormat.ts`——两处口径不得再分叉（此前信息栏用 1024 进制却把标签写成 `KB`）。纯格式化与纯解析分别在 `shared/format.ts` 与 `panels/metadataInfo.ts`，两者的行为由 `pnpm check:panels` 的元数据段逐条断言（含 ffprobe / EXIF 夹具）。
   > **为什么数值范围写在面板而不是声明里**：设置项声明只有 `kind` / `default`（没有 min/max 字段，第 5.3 节），因此"数值多大算合法"只能由**用它的人**夹紧；`filmstripSize` 是一个数值两用（左右边 = 宽、上下边 = 高），范围 `[40, 400]` 由面板夹紧并断言。
7. **「只保留调色板」的色彩参考面板（2026-09-29）**：`color` 的 `valueFormat`（`select`，缺省 `hex`）候选逐项等于 `apps/desktop/src/app_ui/panels/colorValue.ts` 的 `COLOR_VALUE_FORMATS`；格式化纯函数（十六进制 `#ffffff` ↔ 十进制 `255, 255, 255`、3 位缩写、解析不出**原样返回**）与归一化（非法回落缺省）都被断言。**显示与复制必须是同一份文本**（面板不另算一套），面板内不再有提取/锁定按钮与原生取色器（手动锁定色值的处置见 D81）。**复制图标是项目内资产**（`apps/desktop/src/app_ui/assets/copy.svg`，用 mask 上色以跟随主题前景色）。**「只读缓存、提取交给全面分析」（2026-09 用户口径，见 D82，取代 D81 ④）**：本面板**不发起提取**——没有提取按钮，也没有"点击图像即提取"的装配层监视器（`core/colorPaletteWatch.tsx` 与 `shared/colorPalette.ts` 已删除）。调色板是**全面分析文件**的副产品：源扫描 / **源全量重扫** / 右键「重新分析该文件」都会走到 `hp_scanner` 的 `index_new` / `index_existing`，两处 `MediaType::Image` 分支共用 `Scanner::write_palette` 顺带写入（**「重新分析该文件」以与源全量同款的后台进度浮窗运行**：`file.reanalyze` 返回 `taskId` 并复用 `scan.*` 事件族，`TaskKind::Analyze`、可取消但无暂停点，见 `docs/spec/commands-events.md` §3.3/§4 与 D82 ⑦）。两条边界由门禁断言：写入前检查 `locked:true`（手动锁定的色值是用户的判定权，重扫不得覆盖），解码失败**不影响索引**（与同处的 `dhash_file(path).ok()` 同口径）。因此"节流/去重"不再需要——提取只在分析期发生一次，而那是后端既有的长任务（不再有"连续浏览时逐次立刻提取把仓库锁排满"的问题）。缓存 JSON 形态收敛为**唯一实现** `hp_media::encode_palette_json`（`version` / `colors` / `locked`）：`color.extract` 与扫描路径都走它，`version` 少写一个字段就会让前端把整库缓存当"未提取"反复重算。面板缺调色板时给出**怎么拿到它**的提示（`color.empty` 文案里写明"右键重新分析该文件 / 全量重扫源"），而不是让用户以为面板坏了。**调色板本体（2026-09-29 用户第二轮反馈）**：默认 **8 色**（`hp_media::DEFAULT_PALETTE_SIZE`，此前 6）、色块**随面板宽度伸展且不是正方形**（只给高度）、**调色板不吃剩余高度**（色值行因而紧跟其下方而非贴面板底部）、调色板留有内边距与上边距（选中蓝框不再被 `overflow` 裁掉，容器**刻意不设** `overflow`）。色板规模/算法一变**必须递增缓存格式版本**（`hp_media::PALETTE_FORMAT_VERSION` ↔ `shared/paletteJson.ts` 的 `PALETTE_FORMAT_VERSION`，两者相等由本门禁断言）：旧版本缓存按「未提取」处理并自动重算，否则改一次规模，看过的图片会永远显示旧结果；`locked:true` 的手动锁定结果不受版本影响。
8. **媒体预览（`media`）的缺省视图 / 图片尺寸 / 文件名开关 / 排序（2026-09；2026-10 补虚拟化与翻页）**（面板按"单文件 ≤ 1200 行"分文件：`MediaPreviewPanel.tsx` 主面板（列表行渲染 + 三种视图容器 + 尺寸 CSS 变量）、`mediaPreviewView.ts` 取值域与纯函数、`mediaPreviewData.ts` 取数、`mediaPreviewPaging.ts` 游标翻页纯逻辑、`mediaPreviewSession.ts` 设置读取与本会话覆盖、`mediaPreviewToolbar.tsx` 顶部工具条、`mediaPreviewActions.ts` 文件操作动作、`mediaPreviewMenu.tsx` 右键菜单、`mediaPreviewSelection.ts` 选中集与 `selection_change` 上报、`mediaPreviewCell.tsx` 缩略图单元 + 宽高比测量 + 共享可见性观察器（**只服务音频**）、`mediaPreviewDropdown.tsx` 工具条下拉、`mediaPreviewVirtual.ts` 行/列模型纯函数、`mediaPreviewVirtualRows.tsx` 行虚拟化共享钩子、`mediaPreviewScroll.ts` 滚动恢复纯逻辑——门禁 `check:panels` / `check:commands` 读**整个家族**（`MEDIA_FAMILY_FILES` 是硬编码清单，**新增文件必须手动登记**，否则断言形同虚设），拆分不得逃离断言）：`view`（`select`，缺省 `adaptive`）+ `imageSize`（`numberInput`，缺省 `160`）+ `showFileName`（`switch`，缺省**显示** = 零视觉变化；只作用于「预览图」的三种视图，列表视图的文件名是条目本体、不受它影响）+ `sortKey`（`select`，缺省 `name`，`divider_before` 起第二组）+ `sortDir`（`select`，缺省 `asc`）；`view` / `sortKey` / `sortDir` 的候选逐项等于 `apps/desktop/src/app_ui/panels/mediaPreviewView.ts` 的 `MEDIA_VIEW_MODES` / `MEDIA_SORT_KEYS` / `SORT_DIRECTIONS`，`imageSize` 的范围 `[80, 400]` 由面板夹紧（`clampImageSize`；声明层没有 min/max，与 `viewerPlacement.clampFilmstripSize` 同理）。**列表视图的体积必须走宿主设置 `ui.sizeUnit`**（「全部设置 → 界面 → 其他设置 → 体积单位」）并与元数据面板**共用** `shared/format.ts` 的 `formatByteSize`——该面板**不得**再立一个同名的 `sizeUnit` 面板设置（两套单位解析必然漂移，第 5.3 节；此前面板把裸字节数直接印在行尾）。**三种视图的语义**（面板右上角的滑条 / 下拉，滑条固定在「视图」左边）：**平铺** = 单元格宽度固定 + 缩略图统一方形并裁剪填满（`cover`）；**自适应** = **逐行两端对齐**（"justified"：行内各格**等高**、高度由该行图片宽高比之和反推，宽度按宽高比分配使每行左右边缘都顶到面板两边，**不同行高度不必相同**）；**瀑布流** = 固定列宽、行高随图像宽高比的多列排布。自适应的两端对齐**于 2026-10（缺陷 0018 P1-A 第 6 轮）改为"JS 断行 + 行内 CSS 分配宽度"**：断行原由 CSS `flex-wrap` 完成，但那样**虚拟化无从下手**（JS 不测量就不知道 CSS 会断在哪，而虚拟化必须先知道行边界才能只渲染窗口内的行），故断行移到纯函数 `adaptiveRowLayout`（用与 `flex-wrap` **同一套贪心**：按 `flex-basis` 累加、放不下就在它之前断），**行内宽度仍由 CSS 按宽高比分配**（`flex-grow = 宽高比` 把该行剩余空间按比例分完）——两端对齐的观感一字不改，`n=60` 的 A/B 实测内容总高与旧实现**逐像素相同**。行容器因此必须 `flex-wrap: nowrap`（行边界由 JS 决定，CSS 再换行就与 JS 不一致）；自适应下仍**不能有内边距与边框**——它们会在宽度上加常数，使 `高度 = 宽 ÷ 宽高比` 逐格不同、行底参差（选中态改用不占布局的 `outline`）；**宽高比只能解码后量**（索引里没有图片尺寸，`media_info_json` 只覆盖视频），面板在 `<img>` 的 `onLoad` 量一次并写**模块级缓存** `ratioCache`，量到之前用 `DEFAULT_CELL_RATIO`（1:1）占位；稀疏行（尤其最后一行只剩一张竖图）受**行高上限** `--mp-row-max-factor: 2` 约束——到上限即停手并把余量居中留白，这是"尽量两端对齐"的例外，否则单张图会被放大到上千像素高（JS 的 `adaptiveRowLayout` 用同一系数封顶）。**宽高比是异步到达的**，而两个变高视图的行高都由它推出，因此 `ratioCache` 带**版本号**（`getRatioCacheVersion` / `setRatioCache` / `subscribeRatioChange`，写入收敛到唯一入口），面板订阅后重算布局；通知**按帧合并**——一次滚动会解码几十张、5 万张的库全程解码上万张，每次写入都通知就是上万次 O(条目数) 的重算。三者**共用同一个图片尺寸**（CSS 变量 `--mp-image-size`：平铺 / 瀑布流落在**宽度**上，自适应落在**目标行高**上），因此瀑布流与平铺**同宽同列数**（列数公式与 `repeat(auto-fill, …)` 一致，由纯函数 `masonryColumnCount` 给出）——此前一个写死 112px、一个写死 180px，用户实测"相差过大"；且三者都**居中对齐**（平铺/瀑布流在容器上，自适应在**行容器**上，`justify-content: center`）：宽度定死时 `auto-fill` 会在行尾留下放不下一格的余量，不居中就是右侧一条空白（用户反馈"设置了宽度后右边空出白色"）。**自适应视图下文件名必须 `contain: inline-size`**：它是 `white-space: nowrap`，若参与单元格的内在尺寸计算，长文件名会把格子顶宽，"按宽高比配平"当场失效。**面板右上角的控件都只是本会话内的覆盖**（模块级变量，与滚动位置同一口径），设置里的值才是**缺省**；用户在「全部设置」里显式改动该项时面板**放弃**覆盖——否则就落进本标准反复点名的头号缺陷"改了设置没反应"。**排序是前端的**：后端 `file.query` 的排序键**固定**为 `(relative_path, source_id, id)` 升序（D78 键集游标，**没有排序参数**），因此"排序代表全库"的前提是**先把来源翻完**——面板按游标**翻到末页**（`mediaPreviewPaging.ts` 的 `drainPages`），首屏第一页到手即渲染、其余页后台继续，翻完后排序才代表全库；翻页途中工具条显示"载入中 N 项…"（三语言），避免把已取到的部分误认为全库。取数上限已从"有界的一页"放开为**整个来源**（原 `MEDIA_PREVIEW_MAX_ITEMS = 2000` 已取消），因此**循环安全**改由两道闸门保证：游标必须**严格前进**（同一游标再现即停）+ 页数上限（`MEDIA_PREVIEW_MAX_PAGES`，触顶返回已取到的部分、不抛错）。**取数依赖数组不含 `app`**：`app` 上下文在每次选中变化时都会换身份，依赖它会导致"每点一下缩略图就重跑整个取数"（即每次点击重发上百次游标请求），改用世代号取消。**滚动位置恢复**（模块级变量，跨 dockview 卸载重建保留）与后台翻页有一个**时序冲突**（缺陷 0018 第 6 轮修）：第一页到手时内容只有 500 行高，深位置会被浏览器**夹住**，且那次赋值触发的 `scroll` 事件会把被夹住的中间值当成新目标、**原始目标永久丢失**；修法是把状态收敛为 `ScrollSlot { target, pending }`（`mediaPreviewScroll.ts`），`pending` 期间拒绝覆盖目标，并把内容长度与 `loading` 放进 effect 依赖以便翻到新内容后重试。排序键与方向共用一个下拉，两者之间用一条横线（`menu-sep`）分隔。`pnpm check:panels` 断言这条闭环（声明 ↔ 取值域 ↔ 归一化 ↔ 面板消费 ↔ 热加载 ↔ 四种排序键的行为、图片尺寸夹紧、瀑布流列分配与"三视图共用同一尺寸变量"、游标翻页的循环安全、滚动恢复的时序）。**浮层的点击判定同样被断言**（2026-09，缺陷 `docs/issues/0015`）：两个下拉的弹出层复用 portal 的 `ContextMenu`，因此"点外部关闭"必须**同时排除按钮与弹出层**（弹出层的 DOM **不在按钮里**；`mousedown` 早于 `click`，只排除按钮会把要点的选项在 `click` 之前卸载掉，表现为"下拉能开、选什么都没反应"）；该判定收敛为纯函数 `shouldCloseDropdown(inButton, inPopup)`，门禁按**行为**断言 `(按钮外, 弹出层内) === 不关闭`——谁把它"化简"回 `!inButton` 即变红。

9. **后台标签**冻结**（2026-09，媒体预览是第一个使用者）：dockview 会把非激活标签的组件**留在 DOM 里**（媒体预览还被设成 `renderer: "always"`，为的是同组 tab 切换不丢滚动位置），于是后台面板会继续参与每一次选中变更的渲染、继续为离屏单元请求缩略图与解码音频波形——**都是用户看不到的纯浪费**。统一做法（`apps/desktop/src/app_ui/shared/panelForeground.ts` 的 `usePanelForeground`）：**判据只看 `isVisible`**（= 本面板是所在组的**激活标签**）——**绝不能**掺 `isActive`：dockview 8.3.1 的 `isActive = 组是激活组 && 组内激活标签`，用户点媒体源/相册时它会变 false 而本面板仍在显示，掺进去就是"点源不刷新、非得再点一下媒体预览才显示"（实测缺陷，见 `docs/issues/0016`）。`isVisible === false` 时**不渲染条目容器**，成本降到工具栏那一行；可见性变化必须让"滚动恢复/布局测量"这类副作用重跑（否则冻结期间面板被调整过尺寸，切回来是旧布局）。**拿不到 dockview API / 首帧**一律当作"在显示"——判断错方向的代价是"面板一片空白"，宁可多渲染一次。配合**单元级 `memo`**：`ThumbCell` 用 `memo` 包住，且父级传下去的回调必须**恒定引用**（`useStableCallback` 把最新实现放进 ref）——`app` 上下文在每次选中变化时都会换身份，直接传 `useCallback` 出来的函数等于没有 memo。`pnpm check:panels` 断言这三点（三个容器都要求 `foreground`、共享钩子的判据与降级、memo 的前提与"不许逐格新建闭包"的反向）。
10. **容器虚拟化（2026-10，缺陷 0018 P1-A；数万张量级的硬要求）**：媒体预览的**三种视图都必须只渲染视口内的行/条目**，DOM 单元数与条目总数**脱钩**。第 5 轮做了平铺与列表，第 6 轮补齐**瀑布流（按列）**与**自适应（按行）**。
    - **平铺**：一行 `--mp-tile-columns` 个单元、行高为常量 → 内容总高度 = 行数 × 行高，**不依赖测量**（滚动条不会抖）。列数由面板按 `masonryColumnCount` 算好下发，CSS 从 `repeat(auto-fill, …)` 改为 `repeat(var(--mp-tile-columns), …)`——**虚拟化必须知道 CSS 会排几列**。
    - **列表**：一行一条，行高**测量**回真实值（文字度量随语言/系统缩放变化）。`measureElement` 依赖被测量元素上的 **`data-index`** 属性（库靠它把 DOM 节点反查回行号）；**少这个属性测量会被整条跳过**（`indexFromElement` 返回 `-1` → `isIndexInRange(-1)` 为假），行高永远停在首帧估计值，而唯一信号是控制台一句 warning。门禁钉住 `data-index` 与 `measureRef` 必须在**同一节点**上。
    - **瀑布流**：列宽固定 → 列内是**线性偏移**，每项偏移由纯函数 `masonryColumnLayout` 直接算出（不像自适应要复现 CSS 断行），列内只渲染滚动窗口内的条目（`masonryVisibleRange` 二分求区间）。槽位用 `position: absolute` + `translateY(面板算出的偏移)`，**列高由面板下发**（虚拟化后列内只有几十个单元，不给高度容器总高会塌掉）。
    - **自适应**：见第 8 项——断行改由 JS（`adaptiveRowLayout`），行高逐行不同但完全由纯函数给出，用 `useVariableRowVirtualizer`（`estimateSize` 是**行号的函数**，不是常量）。
    - **`content-visibility: auto` 仍然打开**（自适应/瀑布流），但占位高度必须**按视图算准**：根因曾是 `contain-intrinsic-size: auto 140px` 写死，与"行高由宽高比推出"无关；改为面板按视图下发 `contain-intrinsic-block-size`（带 `auto` 关键字，渲染过就用记住的真实尺寸）。**遇到"这个特性在我们这儿不能用"时，先怀疑喂给它的参数。**
    - **可见性观察器收成模块级唯一一个**（原实现每格一个：5 万个单元 = 5 万个 `IntersectionObserver`），且**只服务音频波形**（`decodeAudioData` 是实打实的 CPU，为离屏条目预先解码没有观感收益）。
    - **缩略图（图片/视频）挂载即预热，不得再挂"等进入视口"的闸门（2026-10-07 用户报缺陷）**：三种视图都已虚拟化，"被挂载" ⟺ "在虚拟化窗口内"，而窗口以 `scrollTop` 为中心、**上下同余量**（`masonryVisibleRange` 的 `overscan` 上下各一份），因此**窗口本身就是对称的预加载带**。此前这条链路上有两道多余闸门，都会让取图时机偏离那条对称窗口，表现为**方向性差异**（用户原话："向下滑动时可以覆盖（预加载），向上时不会预加载空间未完全展示的图片"）：① 共享 `IntersectionObserver`（`rootMargin: 200px`）等"真的进入视口"——那是**虚拟化之前**（全量渲染）的做法；② `<img loading="lazy">` 把时机交给浏览器懒加载启发式。二者均已移除，并补上**显式预热**（模块级 `warmedThumbs` + `new Image()`）：`.mp-cell` 的 `content-visibility: auto` 会让被跳过渲染的单元**不触发** `<img>` 取图，而 overscan 带恰恰最容易被跳过——只设 `src` 不够，取图时机仍会落回渲染启发式。**判据是"窗口是否对称"**：`pnpm check:panels` 用纯函数按行为断言上下余量相等，并正向锚定缩略图 effect 的守卫**只有** `needsThumb` 一个条件（只禁止旧拼法是不够的，换成别的可见性状态名就绕过去了——实测该写法曾让断言变空洞）。
    - **绝对定位方案有一个隐蔽的失败模式**：偏移是绝对的，因此槽位顶边永远精确落在预测值上——**高度猜错不表现为错位，而表现为相邻单元重叠**。瀑布流的盒模型曾按 CSS 猜错（实测相邻单元重叠 `minGap = −18px`，应为 8px），真实式子是 `28 + (列宽−12)/宽高比`（缩略图有 1px 边框、文件名实际行高 **12px** 不是 16px）。**这类方案必须单独量"间距/重叠"，不能只看"位置对不对"。**
    - **未解码单元要同时拿到预测高度**：否则槽位已按预测高度定位、单元内容却很矮（占位符），中间出现大空洞（实测瞬时 `maxGap` 达 259px），解码后又被填上，表现为快速滚动时的跳动。
    - **实测收益**（5 万条合成语料，`apps/desktop/perf`）：瀑布流 50 000 → **70** 个单元、滚动 37 030 → **691 ms（52×）**；自适应 50 000 → **85** 个单元、73 660 → **1 202 ms（61×）**；长帧 42 → **0–2**。真机（4717 张真实照片，`tools/real-machine-verify.mjs`）三个视图均 **0 长帧、0 重叠**、自适应行内高度差 **0.02px**。
    - **固有代价（不是缺陷）**：索引里没有图片尺寸（`media_info_json` 只覆盖视频），未渲染的条目按 `DEFAULT_CELL_RATIO` 占位，因此瀑布流/自适应的**滚动条长度是估计值**、随浏览收敛（实测漂移 ≤ 10px / 102 万）。
11. **图像查看器（`imageviewer`）的按键映射与键盘焦点（2026-10-07）**：面板的键盘处理挂在**根节点**（`tabIndex = 0` 的 `.iv-panel`）上，因此"功能在、就是按不动"的根因通常不是键位写错，而是**焦点不在面板上**。两条入口都必须成立，且各由门禁断言：
    - **从其他面板进入**（蓝图双击图像 → `focusPanel` → `panel.api.setActive()`）：dockview 的**程序激活不会把 DOM 焦点移过来**（焦点仍留在原面板），根节点于是收不到 `keydown`。面板订阅 `onDidActiveChange` / `onDidVisibilityChange`，在**进入**"激活且可见"这个转换时把焦点拿到根节点（`{ preventScroll: true }`，避免聚焦把面板滚进视口引起跳动）。三处时序细节缺一不可，否则会"看起来实现了、实际按不动"：① **只在"进入"这个转换上取一次**（独立单面板窗口的 `panelApi` 是每次渲染新建的替身，无条件取会反复抢焦点）；② **判据在激活的当帧读**——`onDidActiveChange` 在 `pointerdown` 派发中同步触发（`dndStrategy = "pointer"` 时 dockview 就是同步 `openPanel`），此刻浏览器尚未执行"点击即聚焦"，读到的是**点之前**的焦点 → 放行；而键盘在标签条按 Enter 激活时读到标签元素 → 拦下；③ **取焦点延后一帧**——鼠标点标签页时浏览器默认动作会把焦点给标签元素（dockview 的标签是可聚焦 `div`），同步 `focus()` 会被覆盖；帧内**重读激活态**（这一帧里用户可能已切走），但**不重读焦点判据**（那时焦点已被给到标签）。
    - **在面板内点击**：`onPointerDown` 把焦点交给根节点；**胶片栏的 `<button>` 不抢**（否则点缩略图后键盘操作被面板吞掉）。
    - **取焦点必须有判据**（`shouldTakeViewerFocus`，纯函数）：`input` / `textarea` / `select` / `contenteditable`（用户正在输入）、`[role="dialog"]` 内（「全部设置」/ 确认弹窗 / 任务浮窗盖在布局之上，键盘属于浮层）、`[role="tablist"]` 内（dockview 用方向键在标签间移动焦点）**一律不抢**；无焦点 / `<body>` / 普通元素才取。**失败方向刻意选"不抢"**——抢错的代价是把用户正在打的字打到别处。
    - **键位只在 `apps/desktop/src/app_ui/panels/imageviewer/viewerKeymap.ts` 声明一次**（`viewerKeyAction`）：`ArrowLeft` / `ArrowUp` / `PageUp` = **上一张**，`ArrowRight` / `ArrowDown` / `PageDown` = **下一张**，`Home` = 适应窗口，`1` = 100%；**不匹配返回 `null`**，调用方据此**放行**该按键（既不处理也不 `preventDefault`，宿主与浮层的快捷键照常冒泡）。组件里不得再有散落的 `case "ArrowLeft"` 分支。
    - **顺序口径**：上一张/下一张**就是胶片栏的顺序**——键位不碰序列，面板把动作交给同一个换图入口 `stepIndex(sequence.index, sequence.files.length, ±1)` → `selectIndex`（序列来源与顺序见 `useViewerSequence.ts`；越界**不环绕**）。**不得**为方向键另立一套下标推进（那会绕开序列边界与空序列）。
    - `pnpm check:panels` 按**行为**断言以上各条（直接 import `viewerKeymap.ts` 驱动，而不是只对源码写正则）：左右两键的语义、无关按键返回 `null`、上下键与 `PageUp`/`PageDown` 的既有语义未被删除（回归对照）、左右键落到同一换图入口、程序激活时取焦点、三类"不抢"判据、纯逻辑模块不得 import React / Tauri。
12. **图像查看器（`imageviewer`）的相邻图像预加载（2026-10-07）**：换图链路是「解析路径 →（HEIC/HEIF 还要后端**生成**全分辨率 JPEG）→ 浏览器读盘 + 解码」，其中 HEIC 全分辨率生成实测可达 **0.8 s**（102 MP 样本，缺陷 0019），完全落在用户按下方向键**之后**——于是每次换图都有可感知的等待。预加载把这段成本**提前**到用户还在看当前图的时候，分三段：① 解析并缓存邻居的 asset URL；② 触发后端 `preview.get` 让 HEIC/HEIF 的 JPEG **先生成好**（落盘后换图即秒开）；③ 用 `new Image()` 把邻居字节读进浏览器图像缓存（换图时只剩解码）。设置项 `preloadRadius`（`numberInput`，缺省 **1**，`divider_before` 起第四组）控制半径；**`0` = 关闭**（是合法值，不回落兜底）。
    - **取哪些邻居**（`viewerPreload.ts` 的 `preloadTargets`，纯函数、无框架依赖）：以当前项为中心、半径内的前后各若干项，**近的优先、同距离时向前优先**（顺放比回看更常见）；**越界不环绕**（与 `stepIndex` 的换图口径一致：到头就停）；当前项**不在序列内**（`index < 0`，例如选中的图像不属于当前相册/源）返回空——没有"邻居"可言，硬按首尾预加载只会加载用户看不到的图。
    - **半径夹紧**（`clampPreloadRadius`，`[0, 3]`）：设置项声明只有 `kind` / `default`（没有 min/max 字段，第 5.3 节），范围只能由**用它的人**夹紧，与 `filmstripSize` 同一处置。**上限 3 的理由是内存**：一张 100 MP 的图解码后可达数百 MB，无上限的预加载会把内存吃光。
    - **三条边界**（都不是可选项，各由门禁断言）：① **面板不在前台就不预加载**——dockview 会把后台标签留在 DOM 里，隐藏时预加载纯属浪费，判据用 `usePanelForeground`（只看 `isVisible`，理由见 `shared/panelForeground.ts`）；② **大图只"解析 + 生成"、不"解码预热"**——索引里没有图片尺寸（`media_info_json` 只覆盖视频），只能用**字节数**当代理，超过 `PRELOAD_DECODE_MAX_BYTES`（64 MiB）的文件仍触发后端生成，但**不**用 `new Image()` 把解码位图留在内存里（宁可换图时多一次解码，也不把内存吃光）；③ **同一张只预热一次**（换序列才重置记录），避免每次渲染重造 `Image`。
    - **取图策略收敛到 `shared/imageUrl.ts`**：HEIC/HEIF 走后端全分辨率预览（并复用 `previewUrl.ts` 的缓存）、其余走原图；**结果缓存 + in-flight 去重**使**预加载与当前图命中同一份**——否则 HEIC 会被生成两次，后端白做一遍全分辨率解码。缓存的是 `ImageUrlOutcome`（含错误），面板据此仍能区分「不可用」与「读取失败：{err}」两种提示（既有行为不退化）。
    - `pnpm check:panels` 按**行为**断言以上各条（直接 import `viewerPreload.ts` 驱动）：邻居选择顺序、越界不环绕、半径 `0` 即关闭、夹紧到 `[0, 3]`、声明缺省落在夹紧范围内、三条边界（前台判据 / 大图护栏 / 只预热一次）、预加载与当前图共用同一份缓存、面板不再自写取图分支、纯逻辑模块不得 import React / Tauri。

- **`cargo test -p hp-core`**：面板声明的硬错误清单、命名空间规则、`settings.kind` 白名单、`has_class = false` 的类目拒绝、`mount.overlay_content = false` 的浮层拒绝。
- **回归**：内置 14 个面板的声明必须能通过校验且与现状一致（**零行为变化**）；插件面板缺失时蓝图可保存且灰显「未接通」。
- `pnpm typecheck` / `pnpm build` / `check-line-count` / `check-doc-status` 通过。

## 9. 落地顺序（强制）

1. ✅ 本文（面板标准）定稿；RFC 0010 决策 1–4、7 记录。
2. ✅ 面板注册表升级为可注册结构（`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS` / `registerPluginPanels` / `allPanels`；14 个内置项行为不变）。
3. ✅ manifest 贡献点 `panel` 的声明参数扩展 + 校验（`plugin_contribution.rs` + `panel_types.rs` 的 `validate_panel_decl`；TS↔Rust 由 `pnpm check:panels` **23 项**断言）。
4. ✅ 蓝图侧按 `has_class` 过滤类目候选（`panels/blueprintNodeFactory.ts`、`shared/blueprintLint.ts`）；`blueprint_node` 反向一致性接入门禁。
5. ✅ 「全部设置 → 面板」界面（`app_ui/settings/SettingsApp.tsx` + `settingsRegistry.ts`；`pnpm check:settings` **43 项**）。
6. ✅ 插件面板的**动态注册**已完成（`core/pluginRegistryHost.ts` → `core/panelRegistry.tsx` 的 `allPanelDefs` / `useDockComponents`）；**面板内控件 schema 的渲染已接线**（2026-09）——`panels/PluginPanelHost.tsx` 走「`api.pluginPanelSchema`（运行时通道）→ `api.pluginValidateControl`（业务级复算）→ `ControlPanelView`」。**余留**：`bind` 的受控取数通道与插件语言资源（控件标准第 5、8 节的余留，不影响本项）。

## 10. 开放点（实现期）

- `category` 是否需要插件可自定义分类（当前为封闭枚举 + `other` 兜底）。
- `mount` 是否增加"每层至多一个"（当前只有 `multiple_per_interface`）。
- `has_class = true` 的面板，其类目是否允许自由命名（当前类目由 `media_type` 固定三值）。
- `settings` 是否支持分组/嵌套（**已收窄**：`divider_before` 提供**一级分隔线**，无分组标题、无嵌套、无折叠；标题/嵌套仍待定）。
- 插件面板的**图标**是否允许自带资源（当前只接受宿主图标集名字，D44 边界）。
- `default_size` 与 `panel_layouts` 既有尺寸记忆的优先级（当前：布局优先，`default_size` 只作用于首次创建）。
- **媒体派生信息的数据来源（2026-09 实测后记录；音频部分经用户裁决"延后"）**：
  - **音频**：`files` 表对音频是 **D11 占位行**（无哈希、无缩略图、**无 `media_info_json`**），索引里**根本没有时长**。元数据面板当前由前端 `preload="metadata"` 读一次容器时长（探完 `load()` 复位释放文件）。若要"库里就有"，需在扫描期对音频也跑 ffprobe——那会改变 D11 对音频的占位行口径，属**未排期**的决定（用户 2026-09：先延后、只记录）。
  - **视频**：尺寸 / 时长 / 编码 / 码率 / 帧率来自 `media_info_json`（**扫描时 ffprobe 可用才写入**，`crates/hp-scanner/src/scanner.rs` 的 `process_video`）。**早于该状态的索引行永远是空的**——实测索引库里存在这种行，表现为"设置没错、面板却没显示任何媒体行"。现由面板用前端 `<video>` 兜底**尺寸与时长**；*编码 / 码率 / 帧率 DOM 拿不到，如实显示 `—`*。是否补"重新分析"入口或按需后端探测来补齐这三个字段，待定。
  - 两者的共同点：**面板只读索引 + 前端兜底，绝不隐式写入索引**（不替用户改数据）；缺值一律渲染为 `—` 而不是省略该行（省略会让"索引没数据"与"面板坏了"外观一致）。
