# 面板标准（注册表 + 声明参数列表；宿主内置 + 插件可注册）

状态：正式草案。本文是 RFC 0010 决策 4 的**标准化展开**：把「面板」确立为**可注册对象**，并把它必须声明的参数收敛为**一份定义表**，供宿主注册表、插件 manifest 校验、「全部设置 → 面板」界面与蓝图属性面板**共用同一口径**。

**本文规范的对象是「面板」，不是「控件」**（两者层级不同、不得混用，见第 1 节）。控件标准见 `docs/spec/control-standard.md`。

## 1. 术语与层级（先分清三个词）

| 术语 | 指代 | 谁可注册 | 枚举 / 落点 |
| --- | --- | --- | --- |
| **面板（Panel）** | dockview 承载单元：仓库、源、相册、媒体预览、图书预览、查看器、**图书阅读器**、图像查看器、元数据、标签/评分、tag表、色彩参考、媒体播放器、任务、插件、蓝图 | **宿主内置 16 个 + 插件可注册** | 蓝图节点枚举 `control`（**不变**）；`PANEL_IDS` / `panel_layouts` 表 |
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
| 面板注册表（内置 16） | `packages/config/src/panels.ts`（`PANEL_IDS` / `PANEL_TITLES`） | 当前为常量清单，实现时升级为注册表 |
| 面板 → 组件映射 | `apps/desktop/src/app_ui/core/panelRegistry.tsx`（`PANEL_DEFS` / `DOCK_COMPONENTS`） | 插件面板需要动态注册路径 |
| 面板注册的 manifest 侧 | `crates/hp-core/src/plugin_contribution.rs`（`ContributionKind::Panel`） | 声明参数扩展见 `docs/spec/plugin-standard.md` 第 4 节 |
| 面板校验 | `crates/hp-core/src/plugin_validate.rs`（`PluginManifest::validate`；清单结构在 `plugin.rs`） | 硬错误清单见本文第 7 节 |
| 面板布局（**不是**本文对象） | `panel_layouts` 表 + `packages/config/src/layout.ts` | 只按当前仓库与层过滤 |
| 「全部设置 → 面板」界面 | `docs/spec/settings-standard.md` | 按面板 `category` 分组、按面板分节 |

## 3. 面板分类（`category`）

用于「全部设置 → 面板」的二级列表分组，也是面板注册表的必填项。第一版最小集：

| `category` | 中文 | 含义 | 内置成员 |
| --- | --- | --- | --- |
| `source` | 仓库与源 | 仓库、源、相册的归属与组织 | `repo`、`sources`、`albums` |
| `media` | 媒体与查看 | 看/听媒体本体 | `media`、`bookpreview`、`viewer`、`bookreader`、`imageviewer`、`player`、`color` |
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

内置取值（如实反映当前默认蓝图：媒体预览与图书预览有类目）：

| 面板 | `has_class` | 说明 |
| --- | --- | --- |
| `media`（媒体预览） | **`true`** | 内部有 图像 / 视频 / 音频 三个类目 |
| `bookpreview`（图书预览） | **`true`** | 内部有**文本**类目；其下按子类细分（epub / txt / md），另有与类目树**平行**的**标记**（book / manga …） |
| 其余 14 个（含 `viewer`、**`bookreader`**、`imageviewer`） | `false` | 无条目分类；**图书阅读器**只"读一本书"，不按条目分类（挑书在图书预览里做） |

> **`bookpreview` 的类目（2026-10-10 用户口径 / D102）**：本面板下挂一个**文本**类目
> （`media_type = text`），其下再分**子类**（`subclass`：epub / txt / md）；与类目树**平行**
> 地还可以挂**标记**节点（`mark`：book / manga …）。三者的关系是**两条正交的轴**，
> 详见 `docs/spec/blueprint-node-standard.md` 第 2.0.1 节。
>
> **`has_class` 是类目与标记的同一个开关**：两者都直接挂在面板下，因此该面板
> `has_class = false` 时，`面板 → 类目` **与** `面板 → 标记` 的 `contains` 边都会被拒
> （宿主内置面板为硬错误、插件面板为未接通软告警，口径见下）。
>
> `bookpreview` 此前是 `has_class = false`：当时文本类**没有任何类目能表达**
> （`media_type` 只有 image/video/audio），本次随 `media_type` 增加 `text` 一并打开。

- `has_class` **不是**"该面板是否显示媒体"：查看器、图像查看器、媒体播放器都显示媒体，但它们的条目由外部选中驱动，不自分类型。
- **`has_class = false` 面板下已有类目节点时的口径，按声明者区分**（避免"要么全硬要么全软"的两难）：

  | 面板来源 | `has_class` 可否变化 | `panel → class` 边 | 理由 |
  | --- | --- | --- | --- |
  | **宿主内置**（16 个） | **固定不变** | **硬错误**（拒绝保存） | 宿主声明是不变量，出现即是构造错误（同"引用存在但类型不符"） |
  | **插件注册** | **随插件版本可变** | **未接通软告警**（灰显、「允许保存」，插件恢复后自动恢复） | 插件升级把 `has_class` 从 `true` 改成 `false` 时，不能把用户既有文档变成"保存失败"（与 RFC 0010 决策 6 同口径） |

- 编辑器职责：**禁止**在 `has_class = false` 的面板下新建类目节点，属性面板不把类目列入该面板的候选（与结构父唯一性同属编辑器责任）。

### 5.2 `blueprint_node`（对应蓝图节点）

声明"该面板在蓝图里由哪种节点承载"，让**面板注册表与蓝图节点注册表互相对得上**：

- 内置 16 个面板的 `blueprint_node` 均为 `control`（当前唯一承载面板的节点类型）。
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
6. **面板设置的取值域 ↔ 面板实现逐项对齐**：`imageviewer` 的 `navigatorPosition` / `filmstripPosition` / `filmstripView` / `zoomAnchor` 的候选逐项等于 `apps/desktop/src/app_ui/panels/imageviewer/viewerPlacement.ts` 的 `NAVIGATOR_CORNERS` / `FILMSTRIP_EDGES` / `FILMSTRIP_VIEWS` / `ZOOM_ANCHORS`；数值型设置（`filmstripSize`）的缺省必须落在面板自己的夹紧范围内；`divider_before` 必须只出现在分组起点（首项无分隔线）且渲染层真的消费它（声明与实现漂移即失败）。**开关型设置的面板消费同样被断言**：`viewer` 的 `infoBarEnabled` 缺省为真（零视觉变化），且面板**真的**按它条件渲染顶部基础信息栏；归一化只允许一份实现（`normalizePanelSettingValue`），各面板不得重写第二套解析规则。**热加载同样由门禁守护**：面板必须经 `apps/desktop/src/app_ui/shared/settingValue.ts` 订阅本地广播、`setting.changed`、窗口焦点与面板激活四条通路中的全部（只靠事件会出现"改了设置没反应"），因此 `viewer` 也必须拿到 dockview 面板 API（缺它就没有第 4 条触发源）。**宿主设置的消费同样被断言**：元数据面板按 `ui.sizeUnit` / `ui.dateFormat` / `ui.dateShowTime` 出字（体积自适应 KiB→GiB 或 KB→GB、日期三选 ± 时间），**「类型」下面固定渲染「文件后缀」**（`.png`，小写带点，取索引里既有的 `relative_path`、**不改后端**；纯解析是 `panels/metadataInfo.ts` 的 `fileSuffix`，无后缀显示 `—`），并按媒体类型自适应渲染行——图像（解码取像素、EXIF 兜底）、视频（尺寸 / 时长 / 编码 / 码率 / 帧率**各占一行**，优先 ffprobe 原始 JSON、无缓存时用 `<video>` 兜底尺寸与时长）、音频（时长，索引里没有音频元数据，只能前端 `preload="metadata"` 读一次）；缺值渲染 `—`，不省略该行。**图像查看器的底部信息栏用同一批设置与同一份纯函数**（体积 / 日期 / 像素尺寸），只有宽高比 / 百万像素 / 缩放仍是它自己的 `viewerFormat.ts`——两处口径不得再分叉（此前信息栏用 1024 进制却把标签写成 `KB`）。纯格式化与纯解析分别在 `shared/format.ts` 与 `panels/metadataInfo.ts`，两者的行为由 `pnpm check:panels` 的元数据段逐条断言（含 ffprobe / EXIF 夹具）。
   > **为什么数值范围写在面板而不是声明里**：设置项声明只有 `kind` / `default`（没有 min/max 字段，第 5.3 节），因此"数值多大算合法"只能由**用它的人**夹紧；`filmstripSize` 是一个数值两用（左右边 = 宽、上下边 = 高），范围 `[40, 400]` 由面板夹紧并断言。
7. **「只保留调色板」的色彩参考面板（2026-09-29）**：`color` 的 `valueFormat`（`select`，缺省 `hex`）候选逐项等于 `apps/desktop/src/app_ui/panels/colorValue.ts` 的 `COLOR_VALUE_FORMATS`；格式化纯函数（十六进制 `#ffffff` ↔ 十进制 `255, 255, 255`、3 位缩写、解析不出**原样返回**）与归一化（非法回落缺省）都被断言。**显示与复制必须是同一份文本**（面板不另算一套），面板内不再有提取/锁定按钮与原生取色器（手动锁定色值的处置见 D81）。**复制图标是项目内资产**（`apps/desktop/src/app_ui/assets/copy.svg`，用 mask 上色以跟随主题前景色）。**「只读缓存、提取交给全面分析」（2026-09 用户口径，见 D82，取代 D81 ④）**：本面板**不发起提取**——没有提取按钮，也没有"点击图像即提取"的装配层监视器（`core/colorPaletteWatch.tsx` 与 `shared/colorPalette.ts` 已删除）。调色板是**全面分析文件**的副产品：源扫描 / **源全量重扫** / 右键「重新分析该文件」都会走到 `hp_scanner` 的 `index_new` / `index_existing`，两处 `MediaType::Image` 分支共用 `Scanner::write_palette` 顺带写入（**「重新分析该文件」以与源全量同款的后台进度浮窗运行**：`file.reanalyze` 返回 `taskId` 并复用 `scan.*` 事件族，`TaskKind::Analyze`、可取消但无暂停点，见 `docs/spec/commands-events.md` §3.3/§4 与 D82 ⑦）。两条边界由门禁断言：写入前检查 `locked:true`（手动锁定的色值是用户的判定权，重扫不得覆盖），解码失败**不影响索引**（与同处的 `dhash_file(path).ok()` 同口径）。因此"节流/去重"不再需要——提取只在分析期发生一次，而那是后端既有的长任务（不再有"连续浏览时逐次立刻提取把仓库锁排满"的问题）。缓存 JSON 形态收敛为**唯一实现** `hp_media::encode_palette_json`（`version` / `colors` / `locked`）：`color.extract` 与扫描路径都走它，`version` 少写一个字段就会让前端把整库缓存当"未提取"反复重算。面板缺调色板时给出**怎么拿到它**的提示（`color.empty` 文案里写明"右键重新分析该文件 / 全量重扫源"），而不是让用户以为面板坏了。**调色板本体（2026-09-29 用户第二轮反馈）**：默认 **8 色**（`hp_media::DEFAULT_PALETTE_SIZE`，此前 6）、色块**随面板宽度伸展且不是正方形**（只给高度）、**调色板不吃剩余高度**（色值行因而紧跟其下方而非贴面板底部）、调色板留有内边距与上边距（选中蓝框不再被 `overflow` 裁掉，容器**刻意不设** `overflow`）。色板规模/算法一变**必须递增缓存格式版本**（`hp_media::PALETTE_FORMAT_VERSION` ↔ `shared/paletteJson.ts` 的 `PALETTE_FORMAT_VERSION`，两者相等由本门禁断言）：旧版本缓存按「未提取」处理并自动重算，否则改一次规模，看过的图片会永远显示旧结果；`locked:true` 的手动锁定结果不受版本影响。
8. **媒体预览（`media`）的缺省视图 / 图片尺寸 / 文件名开关 / 排序（2026-09；2026-10 补虚拟化与翻页）**（面板按"单文件 ≤ 1200 行"分文件：`MediaPreviewPanel.tsx` 主面板（列表行渲染 + 三种视图容器 + 尺寸 CSS 变量）、`mediaPreviewView.ts` 取值域与纯函数、`mediaPreviewData.ts` 取数、`mediaPreviewPaging.ts` 游标翻页纯逻辑、`mediaPreviewSession.ts` 设置读取与本会话覆盖、`mediaPreviewToolbar.tsx` 顶部工具条、`mediaPreviewActions.ts` 文件操作动作、`mediaPreviewMenu.tsx` 右键菜单、`mediaPreviewSelection.ts` 选中集与 `selection_change` 上报、`mediaPreviewCell.tsx` 缩略图单元 + 宽高比测量（**三种媒体类型同一条取图路径**；2026-10-17 / D115 起不再有"只服务音频"的可见性观察器）、`mediaPreviewDropdown.tsx` 工具条下拉、`mediaPreviewVirtual.ts` 行/列模型纯函数、`mediaPreviewVirtualRows.tsx` 行虚拟化共享钩子、`mediaPreviewScroll.ts` 滚动恢复纯逻辑——门禁 `check:panels` / `check:commands` 读**整个家族**（`MEDIA_FAMILY_FILES` 是硬编码清单，**新增文件必须手动登记**，否则断言形同虚设），拆分不得逃离断言）：`view`（`select`，缺省 `adaptive`）+ `imageSize`（`numberInput`，缺省 `160`）+ `showFileName`（`switch`，缺省**显示** = 零视觉变化；只作用于「预览图」的三种视图，列表视图的文件名是条目本体、不受它影响）+ `showImageFileName` / `showVideoFileName` / `showAudioFileName`（三个 `switch`，缺省均**显示** = 零视觉变化；2026-10 起按媒体类型分项，`divider_before` 起单独一组，语义是**总开关 ∧ 分项开关**——`showFileName` 关掉即三类都不显示，分项只在总开关打开时才有意义；未知媒体类型一律不显示）+ `sortKey`（`select`，缺省 `name`，`divider_before` 起第二组）+ `sortDir`（`select`，缺省 `asc`）；`view` / `sortKey` / `sortDir` 的候选逐项等于 `apps/desktop/src/app_ui/panels/mediaPreviewView.ts` 的 `MEDIA_VIEW_MODES` / `MEDIA_SORT_KEYS` / `SORT_DIRECTIONS`，`imageSize` 的范围 `[80, 400]` 由面板夹紧（`clampImageSize`；声明层没有 min/max，与 `viewerPlacement.clampFilmstripSize` 同理）。**列表视图的体积必须走宿主设置 `ui.sizeUnit`**（「全部设置 → 界面 → 其他设置 → 体积单位」）并与元数据面板**共用** `shared/format.ts` 的 `formatByteSize`——该面板**不得**再立一个同名的 `sizeUnit` 面板设置（两套单位解析必然漂移，第 5.3 节；此前面板把裸字节数直接印在行尾）。**三种视图的语义**（面板右上角的滑条 / 下拉，滑条固定在「视图」左边）：**平铺** = 单元格宽度固定 + 缩略图统一方形并裁剪填满（`cover`）；**自适应** = **逐行两端对齐**（"justified"：行内各格**等高**、高度由该行图片宽高比之和反推，宽度按宽高比分配使每行左右边缘都顶到面板两边，**不同行高度不必相同**）；**瀑布流** = 固定列宽、行高随图像宽高比的多列排布。自适应的两端对齐**于 2026-10（缺陷 0018 P1-A 第 6 轮）改为"JS 断行 + 行内 CSS 分配宽度"**：断行原由 CSS `flex-wrap` 完成，但那样**虚拟化无从下手**（JS 不测量就不知道 CSS 会断在哪，而虚拟化必须先知道行边界才能只渲染窗口内的行），故断行移到纯函数 `adaptiveRowLayout`（用与 `flex-wrap` **同一套贪心**：按 `flex-basis` 累加、放不下就在它之前断），**行内宽度仍由 CSS 按宽高比分配**（`flex-grow = 宽高比` 把该行剩余空间按比例分完）——两端对齐的观感一字不改，`n=60` 的 A/B 实测内容总高与旧实现**逐像素相同**。行容器因此必须 `flex-wrap: nowrap`（行边界由 JS 决定，CSS 再换行就与 JS 不一致）；自适应下仍**不能有内边距与边框**——它们会在宽度上加常数，使 `高度 = 宽 ÷ 宽高比` 逐格不同、行底参差（选中态改用不占布局的 `outline`）；**宽高比只能解码后量**（索引里没有图片尺寸，`media_info_json` 只覆盖视频），面板在 `<img>` 的 `onLoad` 量一次并写**模块级缓存** `ratioCache`，量到之前用 `DEFAULT_CELL_RATIO`（1:1）占位；稀疏行（尤其最后一行只剩一张竖图）受**行高上限** `--mp-row-max-factor: 2` 约束——到上限即停手并把余量居中留白，这是"尽量两端对齐"的例外，否则单张图会被放大到上千像素高（JS 的 `adaptiveRowLayout` 用同一系数封顶）。**宽高比是异步到达的**，而两个变高视图的行高都由它推出，因此 `ratioCache` 带**版本号**（`getRatioCacheVersion` / `setRatioCache` / `subscribeRatioChange`，写入收敛到唯一入口），面板订阅后重算布局；通知**按帧合并**——一次滚动会解码几十张、5 万张的库全程解码上万张，每次写入都通知就是上万次 O(条目数) 的重算。三者**共用同一个图片尺寸**（CSS 变量 `--mp-image-size`：平铺 / 瀑布流落在**宽度**上，自适应落在**目标行高**上），因此瀑布流与平铺**同宽同列数**（列数公式与 `repeat(auto-fill, …)` 一致，由纯函数 `masonryColumnCount` 给出）——此前一个写死 112px、一个写死 180px，用户实测"相差过大"；且三者都**居中对齐**（平铺/瀑布流在容器上，自适应在**行容器**上，`justify-content: center`）：宽度定死时 `auto-fill` 会在行尾留下放不下一格的余量，不居中就是右侧一条空白（用户反馈"设置了宽度后右边空出白色"）。**自适应视图下文件名必须 `contain: inline-size`**：它是 `white-space: nowrap`，若参与单元格的内在尺寸计算，长文件名会把格子顶宽，"按宽高比配平"当场失效。**面板右上角的控件都只是本会话内的覆盖**（模块级变量，与滚动位置同一口径），设置里的值才是**缺省**；用户在「全部设置」里显式改动该项时面板**放弃**覆盖——否则就落进本标准反复点名的头号缺陷"改了设置没反应"。**排序是前端的**：后端 `file.query` 的排序键**固定**为 `(relative_path, source_id, id)` 升序（D78 键集游标，**没有排序参数**），因此"排序代表全库"的前提是**先把来源翻完**——面板按游标**翻到末页**（`mediaPreviewPaging.ts` 的 `drainPages`），首屏第一页到手即渲染、其余页后台继续，翻完后排序才代表全库；翻页途中工具条显示"载入中 N 项…"（三语言），避免把已取到的部分误认为全库。取数上限已从"有界的一页"放开为**整个来源**（原 `MEDIA_PREVIEW_MAX_ITEMS = 2000` 已取消），因此**循环安全**改由两道闸门保证：游标必须**严格前进**（同一游标再现即停）+ 页数上限（`MEDIA_PREVIEW_MAX_PAGES`，触顶返回已取到的部分、不抛错）。**取数依赖数组不含 `app`**：`app` 上下文在每次选中变化时都会换身份，依赖它会导致"每点一下缩略图就重跑整个取数"（即每次点击重发上百次游标请求），改用世代号取消。**滚动位置恢复**（模块级变量，跨 dockview 卸载重建保留）与后台翻页有一个**时序冲突**（缺陷 0018 第 6 轮修）：第一页到手时内容只有 500 行高，深位置会被浏览器**夹住**，且那次赋值触发的 `scroll` 事件会把被夹住的中间值当成新目标、**原始目标永久丢失**；修法是把状态收敛为 `ScrollSlot { target, pending }`（`mediaPreviewScroll.ts`），`pending` 期间拒绝覆盖目标，并把内容长度与 `loading` 放进 effect 依赖以便翻到新内容后重试。排序键与方向共用一个下拉，两者之间用一条横线（`menu-sep`）分隔。`pnpm check:panels` 断言这条闭环（声明 ↔ 取值域 ↔ 归一化 ↔ 面板消费 ↔ 热加载 ↔ 四种排序键的行为、图片尺寸夹紧、瀑布流列分配与"三视图共用同一尺寸变量"、游标翻页的循环安全、滚动恢复的时序）。**浮层的点击判定同样被断言**（2026-09，缺陷 `docs/issues/0015`）：两个下拉的弹出层复用 portal 的 `ContextMenu`，因此"点外部关闭"必须**同时排除按钮与弹出层**（弹出层的 DOM **不在按钮里**；`mousedown` 早于 `click`，只排除按钮会把要点的选项在 `click` 之前卸载掉，表现为"下拉能开、选什么都没反应"）；该判定收敛为纯函数 `shouldCloseDropdown(inButton, inPopup)`，门禁按**行为**断言 `(按钮外, 弹出层内) === 不关闭`——谁把它"化简"回 `!inButton` 即变红。

9. **后台标签**冻结**（2026-09，媒体预览是第一个使用者）：dockview 会把非激活标签的组件**留在 DOM 里**（媒体预览还被设成 `renderer: "always"`，为的是同组 tab 切换不丢滚动位置），于是后台面板会继续参与每一次选中变更的渲染、继续为离屏单元请求缩略图与解码音频波形——**都是用户看不到的纯浪费**。统一做法（`apps/desktop/src/app_ui/shared/panelForeground.ts` 的 `usePanelForeground`）：**判据只看 `isVisible`**（= 本面板是所在组的**激活标签**）——**绝不能**掺 `isActive`：dockview 8.3.1 的 `isActive = 组是激活组 && 组内激活标签`，用户点媒体源/相册时它会变 false 而本面板仍在显示，掺进去就是"点源不刷新、非得再点一下媒体预览才显示"（实测缺陷，见 `docs/issues/0016`）。`isVisible === false` 时**不渲染条目容器**，成本降到工具栏那一行；可见性变化必须让"滚动恢复/布局测量"这类副作用重跑（否则冻结期间面板被调整过尺寸，切回来是旧布局）。**拿不到 dockview API / 首帧**一律当作"在显示"——判断错方向的代价是"面板一片空白"，宁可多渲染一次。配合**单元级 `memo`**：`ThumbCell` 用 `memo` 包住，且父级传下去的回调必须**恒定引用**（`useStableCallback` 把最新实现放进 ref）——`app` 上下文在每次选中变化时都会换身份，直接传 `useCallback` 出来的函数等于没有 memo。`pnpm check:panels` 断言这三点（三个容器都要求 `foreground`、共享钩子的判据与降级、memo 的前提与"不许逐格新建闭包"的反向）。
10. **容器虚拟化（2026-10，缺陷 0018 P1-A；数万张量级的硬要求）**：媒体预览的**三种视图都必须只渲染视口内的行/条目**，DOM 单元数与条目总数**脱钩**。第 5 轮做了平铺与列表，第 6 轮补齐**瀑布流（按列）**与**自适应（按行）**。
    - **平铺**：一行 `--mp-tile-columns` 个单元；行高**按行**算——三个文件名分项开关让同一行可能混着"显示文件名"与"不显示"的条目（图像 / 视频 / 音频各有独立开关），故取该行 `tileRowHeight` 的**最大值**（`tileRowHeights`），再用 `useVariableRowVirtualizer` 按行号取高度：内容总高度仍**完全由纯函数给出、不依赖测量**（滚动条不会抖），且与 CSS 网格的自然行高一致（不一致会表现为行错位/底部留白）。列数由面板按 `masonryColumnCount` 算好下发，CSS 从 `repeat(auto-fill, …)` 改为 `repeat(var(--mp-tile-columns), …)`——**虚拟化必须知道 CSS 会排几列**。
    - **列表**：一行一条，行高**测量**回真实值（文字度量随语言/系统缩放变化）。`measureElement` 依赖被测量元素上的 **`data-index`** 属性（库靠它把 DOM 节点反查回行号）；**少这个属性测量会被整条跳过**（`indexFromElement` 返回 `-1` → `isIndexInRange(-1)` 为假），行高永远停在首帧估计值，而唯一信号是控制台一句 warning。门禁钉住 `data-index` 与 `measureRef` 必须在**同一节点**上。
    - **瀑布流**：列宽固定 → 列内是**线性偏移**，每项偏移由纯函数 `masonryColumnLayout` 直接算出（不像自适应要复现 CSS 断行），列内只渲染滚动窗口内的条目（`masonryVisibleRange` 二分求区间）。槽位用 `position: absolute` + `translateY(面板算出的偏移)`，**列高由面板下发**（虚拟化后列内只有几十个单元，不给高度容器总高会塌掉）。
    - **自适应**：见第 8 项——断行改由 JS（`adaptiveRowLayout`），行高逐行不同但完全由纯函数给出，用 `useVariableRowVirtualizer`（`estimateSize` 是**行号的函数**，不是常量）。行内每格的文件名行高度**逐格**判定（`adaptiveRowLayout` 的第 6 参接受**按条目下标的数组**，行高取行内最大值），因此三个分项开关在同一行混用时行底仍然齐平。
    - **瀑布流**同理：`masonryCellHeight` 按 `showFileNameFor(item.file.media_type)` **逐格**算高，列内偏移由 `masonryColumnLayout` 一次算出。
    - **`content-visibility: auto` 仍然打开**（自适应/瀑布流），但占位高度必须**按视图算准**：根因曾是 `contain-intrinsic-size: auto 140px` 写死，与"行高由宽高比推出"无关；改为面板按视图下发 `contain-intrinsic-block-size`（带 `auto` 关键字，渲染过就用记住的真实尺寸）。**遇到"这个特性在我们这儿不能用"时，先怀疑喂给它的参数。**
    - **可见性观察器已**整个删除**（2026-10-17 / D115 收紧）**：它曾是模块级唯一一个、**只服务音频波形**（`decodeAudioData` 是实打实的 CPU，为离屏条目预先解码没有观感收益）。D115 之后波形改由**后端** ffmpeg 生成（`thumb.get` → `<hash>.png`，与图片缩略图同一份 `thumbUrl.ts` 缓存），取它没有 CPU 代价——那条例外因此**失去存在理由**。**留着它就是"为不存在的原因保留一道闸门"**，会把音频重新变回"向上不预加载"的那个例外（缺陷 0025 的形态）。门禁因此改成正反两面：三种媒体类型走**同一条取图路径**（正向锚点：`needsThumb` 必须含 `audio`），且单元模块内**零** `IntersectionObserver`（反向）。
    - **缩略图（图片/视频/**音频波形图**）挂载即预热，不得再挂"等进入视口"的闸门（2026-10-07 用户报缺陷）**：三种视图都已虚拟化，"被挂载" ⟺ "在虚拟化窗口内"，而窗口以 `scrollTop` 为中心、**上下同余量**（`masonryVisibleRange` 的 `overscan` 上下各一份），因此**窗口本身就是对称的预加载带**。此前这条链路上有两道多余闸门，都会让取图时机偏离那条对称窗口，表现为**方向性差异**（用户原话："向下滑动时可以覆盖（预加载），向上时不会预加载空间未完全展示的图片"）：① 共享 `IntersectionObserver`（`rootMargin: 200px`）等"真的进入视口"——那是**虚拟化之前**（全量渲染）的做法；② `<img loading="lazy">` 把时机交给浏览器懒加载启发式。二者均已移除，并补上**显式预热**（模块级 `warmedThumbs` + `new Image()`）：`.mp-cell` 的 `content-visibility: auto` 会让被跳过渲染的单元**不触发** `<img>` 取图，而 overscan 带恰恰最容易被跳过——只设 `src` 不够，取图时机仍会落回渲染启发式。**判据是"窗口是否对称"**：`pnpm check:panels` 用纯函数按行为断言上下余量相等，并正向锚定缩略图 effect 的守卫**只有** `needsThumb` 一个条件（只禁止旧拼法是不够的，换成别的可见性状态名就绕过去了——实测该写法曾让断言变空洞）。
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

13. **图像查看器（`imageviewer`）换图：新图首帧不得沿用上一张的缩放/平移（2026-10-07，缺陷 0026）**：换图链路上，"新图解码完成"与"重新适应窗口"**分属两个提交**——`ViewerStage.tsx` 的 `<img onLoad>` → `setNatural(新图尺寸)` 是一次提交（**先被浏览器绘制**），而把变换改成「适应窗口」的是 `ImageViewerPanel.tsx` 的**被动** `useEffect`（依赖 `[natural, viewport, url]`，绘制**之后**才跑）。因此在修复前，新图的第一帧必然按**上一张**的 `zoom`/`offset` 绘制（`ViewerStage.tsx` 的 `imageStyle` 取"新图的 `natural` + 旧的 `transform`"），下一帧才跳回——表现为切换瞬间的一次拉伸（极值对照：6000×4000 → 400×300 先按 0.13 倍画、再跳到 2.5 倍；反向同理）。
    - **判据必须在渲染路径上，不能靠 effect 事后纠正**：面板把变换与**它所属图像的 token**（asset URL）绑成一条记录（`ImageViewerPanel.tsx` 的 `OwnedTransform`），渲染时经纯函数 `viewerZoom.resolveViewTransform(owned.token, token, …)` 取值——**记录不属于当前图像就取「适应窗口」**（`viewerZoom.fitTransform` = contain + **平移清零**；`fitZoom` 只给倍率，"忘了清零"是跳变的另一半）。这样首帧即正确，跳变在**结构上**不可能出现；换 `useLayoutEffect` 只是把窗口压小，仍依赖"`onLoad` → 绘制"的时序约定（并非规范保证），不采用。
    - **同一张图内不得被清掉**：记录属于当前图像时**原样采用**——用户的滚轮缩放与拖动平移必须保留（渲染路径的兜底只能作用于"不属于当前图像"的记录，否则修好跳变的代价是"每次换图清掉用户的缩放"）。写入只发生在交互回调（滚轮 / 导航器 / 拖动 / 适应窗口 / 1:1）与"面板改尺寸重适应"里，且**写入时记下 token**（`commitTransform` → `setOwned({ token, transform })`）；effect 由此只剩两件事：把首帧的取值**落账**、以及改尺寸时的重适应/夹紧——它读最新变换走 `transformRef`，**不得**把 `transform` 放进依赖（会自激循环），与 `ViewerStage` 读原生监听器最新状态同一手法。**一个容易忽略的稳健点**：换图时面板先把 `url` 置空（同一条 URL effect 里的 `setUrl(null)`），因此 token 必然经过空串——即便两张图解析出**同一个** asset URL，"记录是否属于当前图像"也不会误判（`token = url ?? ""` 由此成为判据的一部分）。
    - **相对更新（滚轮 / 导航器 / 1:1）另有一条硬要求**：必须走**函数式**写法（`prev` 形式）且基准先经 `resolveViewTransform` 归一化。① 滚轮这类**连续事件**在 React 18 里会被批处理，若先读渲染当帧的 `transform` 再写入，同一帧内的第二次事件会读到同一份旧值——中间那一步被**丢掉**（按步累加的 `prev` 形式不会）；② 基准不经归一化，换图后就会拿上一张的缩放当基准（与首帧缺陷同源，只是发生在更新侧）。"绝对"写入（适应窗口 / 舞台拖动 / effect 落账）才用 `commitTransform`。
    - **「待解码」兜底几何必须与「适应窗口」同口径（2026-10-07，缺陷 0027——同一现象的另一半）**：`onLoad` 之前那一帧由 `.iv-image-pending` 兜底，它**必须**用 `width/height: 100%` + `object-fit: contain`（CSS 的 contain，**含放大**）。旧写法 `max-width/max-height: 100%` 只会**缩小**、**永不放大**，而 `fitZoom` 会把小图放大到铺满较紧的一边——于是**宽高都小于舞台的图**在解码完成那一帧先按原尺寸画、下一帧才被放大（无头 Edge 逐帧实测：400×300 的图在 800×600 舞台里先画 `400×300`、再跳到 `800×600`，**50% 偏差**；把旧规则注回来偏差帧立刻重现，改用 contain 后**偏差帧为 0**）。**大图两帧恰好相同**，所以这类缺陷**只在小图上可见**——这正是它长期与"换图首帧"一起被误当成同一个根因的原因。居中由 `object-position`（默认 `50% 50%`）负责，`left/top: 0` + `transform: none` 不再用位移抵消。**已知亚像素差与盲区**：落定态用 `getBoundingClientRect()`（含 1px 边框）算缩放，CSS 侧用内边距盒 → 差 1px/边（约 0.25%）；`fitZoom` 的 `MAX_ZOOM` 夹紧（只对小于 25px 的图生效）不在 CSS 侧复现。两条都远低于可感知阈值且只影响这一帧。
    - **换图必须是"解码后原子替换"（2026-10-07，缺陷 0028——同一现象的第三条根因）**：`url` 与"这张图的尺寸/几何"**必须同批提交**，且**换图前先解码**。原实现是"先换 URL、等 `onLoad` 再补尺寸"的两次提交，中间必然存在"元素已换、位图还没有"的帧——旧画面停留、空白闪烁、或旧光栅被合成器拉成新尺寸（用户原话："下一张图片大小为上一张的，然后复原为原比例，然后图像闪烁或抖动一次"）。现在的形态：① `ShownImage{url, natural, fileId}` 是"正在显示的那张图"的**唯一**状态（url 与尺寸只能一起换，"半新半旧"的帧在结构上不可能出现）；② `viewerDecode.decodeImageSize` 离屏解码完成**之后**才替换，`wantRef` 丢弃过期结果（解码途中又换图不串图）；③ 选中项变化**不提前清空画面**——解码期间上一张继续显示（只有"没有可显示的图"与失败才清空），因此没有"载入中"占位闪烁；④ 每个 URL 一个**新 `<img>` 元素**（`key={url}`）且 `decoding="sync"`，复用元素才会让合成器拿旧光栅去填新盒子。代价如实记录：**可见延迟不变**（仍是解码耗时，实测 200–400 ms），只是等待期间停在上一张而不是错误/空白帧；另有"文字先到、画面后到"的瞬态（信息栏文件名已切、尺寸/缩放仍描述屏幕上的那张）。
    - `pnpm check:panels` 按**行为**断言（直接 import `viewerZoom.ts` 驱动）：记录不属于当前图像 → 取「适应窗口」（与上一张的极端 `zoom:3` / `offset:{120,-80}` **完全无关**）、同一张图 → 原样保留、`fitTransform` 的 contain+居中与"尺寸不可用（未解码 / 舞台未测量）退化为恒等"；外加源码锚点——正向：面板的变换经纯函数取值、状态**带 token**、舞台拿到的是渲染值；反向：**不得**再出现"无主的 `useState<ViewTransform>` + 裸 `setTransform(`"（那正是本条缺陷的形态）、**不得**把渲染当帧的 `transform` 当相对更新的基准。**待解码兜底那一条**另有三项：规则体必须是 `width/height: 100%` + `object-fit: contain`、**不得**含 `max-width/max-height`、且其几何与 `fitZoom` 在四组夹具（小图放大 / 大图缩小 / 宽扁 / 高瘦）上**逐值相等**。**换图原子性**另有五项：三值同一个状态对象且渲染两值取自它（反向：不得再有 `setUrl(`/`setNatural(` 这种分两次提交的写法）、先解码后替换（含兜底同路）、**不提前清空画面**、舞台每张图一个新 `<img>` 元素 + `decoding="sync"`、解码模块无 React/Tauri 依赖。**回退即红**实测：纯函数改回"总是返回记录值"→ 2 项红；面板渲染改回 `owned.transform` → 1 项红；待解码规则退回 `max-width/max-height` → 1 项红（再从规则体里加回 `max-width` → 反向那条也红）。

14. **仓库面板（`repo`）的「当前仓库」显示**仓库名**，不是内部 `repoId`（2026-10-08，缺陷 0030）**：`repoId` 是仓库的**内部主键**（`RepoId::generate()` 的 UUID），把它印在界面上对用户没有任何意义；更直接的矛盾是**同一个面板里两套写法**——「切换仓库」子菜单列的是 `r.name`（仓库名），而下方「当前仓库」一行印的是 `app.repoId`（哈希），同一件事在一个面板内对不上。修法是把**显示名解析**收敛为纯函数模块 `apps/desktop/src/app_ui/panels/repoDisplay.ts`（不 import React / Tauri），面板只消费它。
    - **解析只认已装载列表里真实存在的行**：按 **`id` 相等**查找（名称可重名、列表顺序可变，两者都不能当查找键），命中且**非空白**才返回名字；未打开仓库 / 查不到 / 名字为空或纯空白一律返回 `null`，由调用方渲染占位符 `—`（与全应用其它缺值处同款；**不省略该行**，否则"没有名字"与"面板坏了"外观一致）。
    - **名字不可得时绝不回落 `repoId`**：回落等于把哈希换个位置显示，正是本条要消掉的形态。这条是**正向要求**，不是"禁止某个旧拼法"。
    - **长名截断**：名称是用户输入、长度不限（UUID 定长，名称不是），`.repo-current-name` 必须 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`，否则会把 `.kv` 的 `1fr` 列顶宽、面板出现横向滚动。
    - `pnpm check:panels` 按**行为**断言（直接 import `repoDisplay.ts` 驱动）：按 id 命中（含**重名**行取 id 命中的那一条，而不是"第一条同名的"）、未打开/查不到/空名/纯空白名 → 占位符、占位符取值 `—`；外加源码锚点——正向：面板经 `repoNameLabel(repos, app.repoId)` 渲染；反向：**不得**再把 `repoId` 当显示值渲染（`app.repoId === r.id` 这类**比较**仍允许，故只禁"渲染进节点"的形态，且断言前先剥注释——文件头会**引用** `repoId` 说明口径）；CSS 三条截断属性齐备；纯逻辑模块无 React / Tauri 依赖。**回退即红**实测：面板改回 `{app.repoId ?? "—"}` → 1 项红；解析函数回落到 `repoId` → 1 项红；删掉 CSS 截断 → 1 项红。

15. **图书预览（`bookpreview`）的三种视图 / 封面来源 / 文件名滚轮（2026-10-08 立项，2026-10-09 修订视图与展示规则，2026-10-11 加入 PDF）**：面板把**"书"**（文本类 + PDF）展览。声明两项设置：`view`（`select`，缺省 **`card`**）与 `coverSize`（`numberInput`，缺省 **160**；工具条另有**封面宽度滑条**，与媒体预览的图片尺寸滑条**同款**——复用 `mp-size*` 样式类，拖滑条改的是**本会话临时覆盖**，声明缺省才是"用户没动过"的值）；`view` 的候选逐项等于 `panels/bookpreview/bookPreviewView.ts` 的 `BOOK_VIEW_MODES`，`coverSize` 的范围 `[96, 400]`（步进 8）由面板夹紧（`clampCoverSize`；声明层没有 min/max，与 `media.imageSize`、`imageviewer.filmstripSize` 同理）。面板按"单文件 ≤ 1200 行"分文件：`BookPreviewPanel.tsx` 主面板（工具条 + 三种视图容器 + 封面宽度滑条 + 右键菜单装配）、`bookPreviewView.ts` 取值域与纯函数（**零依赖**，门禁直接 import）、`bookPreviewData.ts` 取数、`bookMetaCache.ts` 元数据缓存、`useBookMeta.ts` 单本读取、`BookCard.tsx` 卡片单元、`BookListRow.tsx` 列表单元、`BookCoverCell.tsx` 封面单元、`BookRowInfo.tsx` 列表/封面共用的信息三行、`BookCoverArt.tsx` 封面画面、`BookTextCover.tsx` 文字封面——门禁 `check:panels` 读**整个家族**（`BOOK_FAMILY_FILES` 是硬编码清单，**新增文件必须手动登记**）。
    - **三种视图**（2026-10-09 用户修订命名）：**卡片模式**（缺省）= 封面在上、**文件名**在下；**列表模式** = 封面在左，右侧自上而下是**文件名 / 作者 / 简介**、右栏**填充剩余空间**——它由原「封面模式」改名而来（用户口径：原封面模式"实际为列表模式"）；**封面模式**（重新定义）= 规则与列表模式**一致**，但一行可展示**多本**（网格），且右栏**不填充剩余空间**、固定为**封面宽度的 2 倍**（`BOOK_COVER_INFO_SCALE = 2`；单元格总宽 = 封面 + 10px 间距 + 2 倍封面，列宽固定不拉伸，面板再宽右栏也不变宽）。文件名取**去目录与去扩展名的文件名**（= 用户口径里的「作品名」），**不读** EPUB 内嵌 `dc:title`——内嵌标题与文件名经常不一致（实测样本如此），取它会让"显示的是哪本书"变得对不上号。工具条上的视图切换是**本会话内的临时覆盖**（与媒体预览右上角下拉同口径），声明层的 `default` 才是缺省；设置一变即丢弃覆盖。
    - **信息三行的展示规则**（2026-10-09 用户口径，列表 / 封面两模式一致，共用一个 `BookRowInfo`）：作者行前面加 **「作者：」**、简介**单独一行**且行首加 **「简介：」**（i18n 键 `book.authorLabel` / `book.descLabel`，不硬编码中文）；简介的**溢出标准 = 和封面图片底部齐平**——截断行数由封面高度推得（`bookDescLineCount(coverSize)`：信息列与封面同高，扣掉文件名 19.5px + 作者 18px + 两处 4px 间距后除以简介行高 18px，至少 1 行；行高参数与 `styles.css` 的 `line-height: 1.5` **逐项相等、只定义一次**），面板经 `--bp-desc-lines` 下发，CSS `-webkit-line-clamp: var(--bp-desc-lines)` 消费——封面变大简介就能多显示几行，**不再是写死的 3 行**。文件名与作者保持**单行省略**。缺值渲染 `—`（不省略该行，与元数据面板同口径）。
    - **封面来源按 book 标记分流**（`usesEmbeddedCover`，与 `fileBookMark` 同一个事实）：带 **book 标记** → 走 `book.meta` 取封面；其余 → **文字封面**（把作品名渲染成书皮，底色由名字派生：`textCoverHue` 用 FNV-1a，**同名恒同色、跨会话稳定**——用随机色相的话每次打开都是另一个颜色，用户会当成渲染故障）。子类型就是**标记**，所以把它改成 `document` 就不再取封面，这正是"标记"该有的效果。**两种"取封面"的形态**：`epub` 取**内嵌封面**（`hp-book` 解 OPF，**原格式不转码**）；**`pdf` 取第一页栅格化**（`hp-pdf`，编成 JPEG，见 §10 的 PDF 条目）。两者落到**同一个** `path_for_book_cover`，因此前端只有一条渲染路径。**旧行兜底**：迁移 0008 / 0010 之前入库的行没有标记，此时按扩展名（`epub` / **`pdf`**）判定，免得存量书在重扫前全退化成文字封面（"还没重扫"与"面板坏了"必须看起来不一样）。
    - **封面画面 = 文字封面打底 + 内嵌封面盖上**：加载期间看到的是这本书的文字封面（不是灰块），图片解码完成后直接盖上去；图片加载失败（路径失效 / 格式 Chromium 不认）把图摘掉即可自然回落——**不需要第二套错误态**。封面框是 `2/3` 书形 + `object-fit: contain`（**不裁剪**：裁掉书名是书封最不能接受的一种"好看"）。
    - **文件名滚轮横向滚动**（"焦点在文件名上可滚动滚轮查看"）必须满足四条，缺一条都会表现为"看起来实现了、实际不好用"：① 用**原生监听器 + `{ passive: false }`**——React 的 `onWheel` 在根节点上是**被动**监听，`preventDefault()` 被忽略，滚轮会同时滚名字与面板；② **只有真的被省略**（`scrollWidth > clientWidth`）时才拦截，否则每个单元都变成滚动黑洞；③ 位移算术在纯函数 `nextScrollLeft` 里（两端夹紧，门禁按行为断言）；④ 文件名元素 `tabIndex = 0`，使"焦点在文件名上"**字面上**也成立。
    - **截断形态刻意分两种**：文件名与作者**单行省略**（`text-overflow: ellipsis`），简介**多行截断**且行数**由封面高度推得**（`-webkit-line-clamp: var(--bp-desc-lines)`，见上文"信息三行"）——单行会把简介变成没有信息的碎屑，而"简介"这一栏的全部价值就是能读进去一两句；写死 3 行则会让封面放大后简介还停在 3 行（2026-10-09 用户口径：溢出标准和封面底部齐平）。缺值渲染 `—`（不省略该行，与元数据面板同口径）。
    - **取数只按仓库 / 源 / 目录**过滤**"书"的两个类目** `mediaTypes: ['text', 'pdf']`（`BOOK_MEDIA_TYPES`，与 `hp-core` 的 `MediaType::is_book()` 逐项一致），**不按相册**：相册成员分页的 SQL 只认 `image` / `video` / `audio` 三个字面量，文本类与 PDF 都进不了相册成员列表；因此相册被选中时面板仍按源/目录列"书"，而不是显示空列表把"相册不支持书"伪装成"这里没有书"。翻页复用媒体预览的纯逻辑 `mediaPreviewPaging.drainPages`（严格前进 + 页数上限两道闸门只有一份实现）。
    - **元数据不进索引**：封面是二进制、简介是长文本，塞进 `files` 行会让每次文件查询都背上几十 KB 的负载，而列表只用得到"有没有封面"。因此 `book.meta` 走**按内容哈希的磁盘缓存**（`<hash>.cover.<ext>` + `<hash>.bookmeta.json`），解析在**阻塞线程**里跑；**坏书降级为"没有元数据"而不是错误**（一本书打不开不该让整个面板变成错误态）。前端缓存（`bookMetaCache`）做结果缓存 + in-flight 去重，且**只为需要封面的书发命令**（`txt` / `md` 一本一个 IPC 是纯浪费，那是面板端就能判定的事）。**PDF 也走这条**：它的封面是第一页栅格化出来的（实测 20–122 ms），因此缓存不是可选项。
    - **不做虚拟化**：文本库的量级是几十到几百本，与"数万张图"不是一个问题（媒体预览的虚拟化是为后者的量级做的）。**后台标签冻结照做**（`usePanelForeground`）：dockview 把非激活标签留在 DOM 里，不冻结就会为看不见的书取封面。本项列入 §10 开放点。
    - **右键上下文菜单与媒体预览同款（2026-10-09 用户口径："为图书预览面板增加媒体预览同款右键菜单"）**：**同一份实现**，不是"再抄一套一样的"——开关与光标定位复用 `panels/mediaPreviewMenu.tsx`（`useMediaContextMenu` + `MediaContextMenu`），菜单项渲染也由它负责；四类动作复用 `panels/mediaPreviewActions.ts`（删除选中 / 重命名 / 复制路径 / 重新分析，文案沿用 `media.*` 键）。图书预览**不得**绕过它直接使用 `menu/ContextMenu` 自己拼菜单：那样会同时丢掉"菜单项只在单选时给出"与缺陷 0013 的 portal 口径。
    - **删除动作不按相册上下文分流**（`useMediaFileActions({ albumScoped: false })`）：媒体预览在相册被选中时"删除 = 移出相册"，但**文本类文件进不了相册成员列表**（相册成员分页只认 `image` / `video` / `audio`，§8 第 16 项），跟着相册走会把删除变成"已移出相册（0）"的**静默空操作**——文件还在盘上。因此图书预览的删除恒走 `fileTrash`（系统回收站）。媒体预览那一侧的缺省 `albumScoped = true` **不得**被这次改动带偏（改了就是"相册里删除变成真删盘"）。
    - **选中集复用全局那一份**（`app.selectedIds` / `app.selectedFile`，与媒体预览同一口径），因此跨面板的选中语义一致；但本面板只做**单选**（单击即"清空其余、选中本项"）：Shift 范围 / Ctrl 切换 / 拖拽载荷（`application/x-hp-files`）/ 条目容器的键盘快捷键（Ctrl+A 全选 / Esc 取消 / Delete 删除）都是媒体预览的交互，文本库几十–几百本的量级用不上，本版**不引入**——不引入就不得假装有：菜单里"重命名 / 复制路径 / 重新分析"三项由**所选数量 == 1** 决定，"删除选中"恒有，计数**只数本面板列出的书**（别处残留的选中项不能把"是否单选"判断带偏）。**蓝图事件上报已于 2026-10-10 接入**（`click` / `double_click`，带 `format` + `bookMark`，见下），但**只发这两个**——`selection_change`（连带 `rating` / `has_tag` 的异步 context）是"多选 + 条件求值"的口径，本面板只有单选，不引入。
    - **三种视图（卡片 / 列表 / 封面）接同一套口径**：单元只回传"点的是哪一本"（`onSelect` / `onContextMenu`，`e.preventDefault()` 在单元里做掉，免得 WebView 默认菜单先弹出来），选中集、菜单定位与菜单项都在面板侧。两个回调必须是**恒定引用**（`shared/stableCallback.ts` 的 `useStableCallback`——三个单元都是 `memo` 的，逐格新建闭包会让 `memo` 形同虚设；该钩子 2026-10 由 `MediaPreviewPanel.tsx` 抽到 `shared/`，两个面板共用一份）。**右键前先按选中口径落选中**（未选中项先单选，已选中则保持当前选中集），顺序反了会删错文件。
    - **选中态样式是同一份 CSS**（`.bp-card.selected` / `.bp-row.selected` / `.bp-cover-cell.selected` 一条规则），取媒体预览同款的 `--sel-border` / `--sel-bg` token；用 `outline` + `outline-offset: -1px` 而不是 `border`——三视图的几何（卡片网格列数、封面模式"固定列宽不拉伸"）不该因为选中多了 1px 边框而挪位，环画在单元内侧也不吃 10px 的行/列间距。
    - `pnpm check:panels` 按**源码锚点**断言以上各条：复用共享菜单与共享动作（反向：不得出现 `from "../menu/ContextMenu"`）、`albumScoped: false` 与媒体预览缺省 `albumScoped = true`、三视图单元三项 props + 选中态类名 + 先 `preventDefault()`、面板三处接线齐备 + 两个回调走 `useStableCallback` + 右键先落选中、菜单计数只数本面板列出的书、选中态 CSS 一条规则带同款 token。**回退即红**实测四处：`albumScoped` 改回 `true` → 1 项红；媒体预览缺省改成 `false` → 1 项红；面板 `selected={false}` → 1 项红；选中态 `outline` 去掉 → 1 项红；单元少一个 `onContextMenu` prop → 1 项红。
    - **封面容器是白底 + 有投影**（用户 2026-10-09 口径："图书预览的 epub 的封面的背景改为白色，并为封面容器添加阴影"）：底色写**字面白色**（`#ffffff`）而**不跟主题变量**——内嵌封面按 `contain` 完整显示，留出的就是这层"纸边"，跟着主题走会在深色下变成一圈深灰、看着像图没加载完；投影用两段（近处实、远处散），深色主题下另给一组更重的（同样的 alpha 在深底上几乎看不见）。**白边里不能透出打底的文字封面**：内嵌封面加载完成后给容器加 `bp-art-loaded`，CSS 据此把文字封面 `display: none`（加载中 / 失败时它仍在 = 无空窗，见上一项的"封面画面"）。
    - **封面可被用户覆盖**（用户 2026-10-09 口径："txt 右键可以更换封面颜色或自定义图片"，决策 D99）：右键菜单里挂「更换封面」（预设色板 + 系统取色器 + 选择图片 + 恢复默认）。**优先级：自定义图片 > 自定义颜色 > 内嵌封面 / 文字封面**——颜色必须**压过内嵌封面**，否则对 `epub` 设颜色毫无效果（图盖在上面），用户会以为功能坏了。覆盖存在仓库库的 `file_covers` 表（迁移 0009，按 `file_id` 存，重扫不变）；`image` 只存 `data\user\covers\` 下的**裸文件名**（绝对路径随安装目录变，存了会在换位置后全失效）。取数走**批量** `book.covers`（一页一次，不逐本 IPC），且前端按 **id 粒度**记账（翻页时 id 会变多，按仓库整体去重会让新一页的封面永远取不到）。「更换封面」经**共享菜单的 `extraItems` 插槽**挂进来，不是第二份菜单（缺陷 0013 的 portal 口径只有一份）。安全边界：`value` 会拼进磁盘路径，`is_safe_cover_file_name` 在 `hp-core` 与桥接层各校验一道（目录穿越）。
    - **标记可被用户增删**（用户 2026-10-10 口径，决策 D102）：右键菜单里挂「标记」**多选区**（按**可注册清单**渲染，勾选态用 ✓ 表达，`aria-pressed` 同步），走 `file.setMarks` 命令（`add` / `remove` 各自幂等）。**标记是可多值的、与类目正交**：一个文件可以**同时**带 `book` 与 `manga`（用户口径"标记可以交叉"），因此这里是**一组开关**而不是"挑一个"。**标记影响封面来源**（`book` 决定要不要取内嵌封面），故写入后一并失效封面缓存。与本面板的「更换封面」**同一个 `extraItems` 插槽**（不是第二份菜单）。**已带但不在清单里的标记**也要显示出来（否则用户看不到自己打过的标记、无从取消）。
    - **蓝图事件上报**（2026-10-10 接入，决策 D102）：本面板上报 `click` / `double_click`（**三个视图的单元都接上**——只接一个视图等于另两个静默不生效），且上报必须带**三条轴**才能真正命中：`mediaType`（类目）、`format`（子类）、`marks`（标记集合）。只报一个裸的文本媒体类型时，图书预览的类目/子类/标记**一个也匹配不上**。取值域与匹配口径见 `docs/spec/blueprint-node-standard.md` 第 2.0.1 节。
    - `pnpm check:panels` 按**行为**断言（直接 import `bookPreviewView.ts` 驱动）：声明候选与取值域逐项一致（`["card","list","cover"]`）、缺省落在夹紧范围内、`clampCoverSize` 的夹紧与"缺失回落缺省"、`resolveBookView` 的失败关闭、`bookDescLineCount`（简介行数 = 封面高度推得、随封面单调不减、小到没空间至少 1 行）、`bookCoverCellWidth`（封面模式右栏 2 倍封面的算术）、`bookDisplayName`（中间的点保留、无扩展名、Windows 分隔符、点开头的隐藏文件）、`usesEmbeddedCover`（book 标记优先 + 旧行按扩展名兜底）、`fileFormat` / `fileBookMark` / `fileMarks`（**三轴正交**：同一个 `txt` 既有 txt 子类、又带 `manga` 标记；标记**可多值**）、`bookDispatchTarget`（上报必须带 `mediaType` + `format` + `marks`）、`nextScrollLeft` 两端夹紧、`wrapCoverName` 只在真截断时加省略号、`textCoverHue` 的稳定性与值域；外加源码锚点——正向：面板经 `usePanelSettingValue` 消费两项设置、注册表把 dockview API 传下去、按 `foreground` 冻结、取数写死 `mediaTypes: ["text"]` 且**不出现** `albumId`、三个视图单元**都**接上双击（计数 == 3）、面板上报 `click` / `double_click` 且经 `bookDispatchTarget`、卡片单元用原生 `wheel` + `{ passive: false }` 且**不出现** `onWheel=`、CSS 三种截断形态齐备（简介的 clamp **必须读 `--bp-desc-lines`**）、封面模式网格列宽固定且右栏 `calc(... * 2)` + `flex: none`、工具条有同款滑条（range + min/max/step 常量）、信息三行共用 `BookRowInfo` 且带 `book.authorLabel` / `book.descLabel`、封面白底 + 两段投影 + 深色主题另给一组、`bp-art-loaded` 藏文字封面、封面覆盖的优先级与批量取与 id 记账、`extraItems` 插槽同时挂「标记」与「更换封面」、恢复默认的条件渲染；反向：纯逻辑模块**零依赖**（无 React / Tauri、**没有任何 import**）、图片加载失败**不得**用一个布尔表达"哪张图失败了"、不得逐本发封面命令。

16. **文本媒体类型、PDF 与 book 标记（2026-10 立项；2026-10-11 加入 PDF）**：`bookpreview` 能列出"书"，靠的是扫描期新增的 `text` / **`pdf`** 媒体类型（`hp-core` 的 `MediaType`，存 `"text"` / `"pdf"`）与 **book 标记**（`hp-core` 的 `FileMark`，存 `file_marks` 表）。
    - **`pdf` 是独立类目，不是 `text` 的一种**（用户口径 2026-10-11）：PDF 是**二进制容器**（`%PDF-` magic bytes），文本类那套"编码判定 → 按字符分页"对它完全不适用；并进 `text` 会让那个类目对 PDF 变成一句谎话，且查看器 / 元数据的文本分支处处要排除它。**"书"的唯一判据是 `MediaType::is_book()`**（= `text` 或 `pdf`）——相册的排除集与图书预览的收录集**共用它**，两处各写一遍必然漂移。
    - **判定：文本类只认扩展名，PDF 认扩展名 + 内容兜底**（`hp-scanner/src/media_type.rs` 的 `ext_to_media_type` / `sniff_media_type`）：`txt` / `md` 没有 magic bytes，任何"看着像文本"的兜底都会把未知二进制吸进索引（「未知类型不索引」因此失守）；而 `%PDF-` 是**可靠**的 magic bytes，因此改名的 PDF（`a.dat`）也能正确入库——**这正是 D11「扩展名优先 + 内容兜底」里内容兜底该发挥作用的地方**。
    - **默认标记表与扩展名表放在一起**（`hp-scanner` 的 `default_file_marks` 调 `hp-core` 的 `default_book_mark_for_ext`）：`epub` / **`pdf`** → `book`；`txt` / `md` → **无默认标记**（2026-10-10 前给的是 `document`，那是"没打标记"的旧默认值，已废弃）。**`pdf` 为什么也算 book**：判据是"它是不是一本**自带封面与元数据、按书阅读**的容器"，而不是"它是不是电子书格式"——两者在这条判据上完全一致。这条默认值**决定封面来源**（带 book 标记才去 `book.meta` 取封面）。
    - **标记可多值、且与类目正交**（2026-10-10 用户口径："text 为类目，md、txt、epub 为子类，book 为标记，**标记可以交叉**，例子：漫画.zip 文件的类目为压缩包，可以标记为 manga"）：它不是单值"子类型"，而是**集合**（`file_marks` 一对多表），一个文件可以**同时**带 `book` 与 `manga`。与**子类**（`epub` / `txt` / `md`，扩展名判定）正交，因此一个被标为 `manga` 的 `txt` 会**同时**命中蓝图里的「txt 子类」与「漫画标记」。`MediaType` 由扩展名给出、用户不可改；标记**可编辑**，扫描**只在该文件一个标记都没有时**补默认值，**绝不覆盖**已有标记（与调色板 `locked` 同口径：用户的判定权不被重扫打回）。用户侧入口**已落地**（右键多选区 → `file.setMarks`，见 §10）。
    - **入库口径**：文本与 PDF 照算内容哈希（移动识别/去重与图片同口径），但不产出感知哈希 / 缩略图 / 调色板 / `media_info_json`（两者都不进索引期的派生数据；封面与正文走 `book.meta` / `book.content` 的按内容哈希磁盘缓存）。**两者在 `hp-scanner` 的 `compute` 里合用一个 arm**——入库口径逐条相同，分成两个 arm 写两遍只会在下次改动时漏掉其中一个。**音频自 2026-10-17 / D115 起也不再是占位行**：它同样照算内容哈希并多一份 ffprobe 元数据（`media_info_json`），但感知哈希 / 调色板仍为空——**三者的"不产出视觉派生"这一条完全一致**，差别只在该不该存媒体信息。
    - **迁移 0008 → 0010**：0008（`ALTER TABLE files ADD COLUMN subtype TEXT`）是**历史**，其列**已废弃**（新代码不读不写）；**0010** 建 `file_marks` 一对多表并把存量 `subtype = 'book'` 的行搬成 `book` 标记（`document` 不搬——它不是标记状态）。`files.media_type` 是裸 TEXT 列、**没有 CHECK 约束**（0001 如此），因此新增取值不需要重建表。**forward-only**：`0001` 不得被改，`files.subtype` 列保留不删（DROP COLUMN 在旧 SQLite 不可用，且会让降级直接崩），明确标注为已废弃。
    - **已知边界（如实记录）**：① 相册成员分页（`hp-store` 的 `query_album_members_page`）与相册属性（`AlbumMediaType`）都只认 `image` / `video` / `audio`，**"书"（文本类 + PDF）进不了相册**；要不要把相册扩到文本类属未排期决定（列入 §10 开放点）。**相册属性这一侧已按同一口径收紧**：`AlbumMediaType::contains` 对所有取值（含 `Multimedia`）都返回"不含书"（判据是 `MediaType::is_book()`）——否则 `multimedia` 的跟随源相册会把文本 / PDF 文件**写成成员**，而成员分页永远列不出它们（"有成员但看不见"），卸载源的影响评估也会多算。② **媒体预览不含"书"**（用户 2026-10-08 裁决，D95；2026-10-11 PDF 沿同一条口径）：媒体预览的类型筛选里「全部」= **图片 / 视频 / 音频这三个**，不是"不筛"——`file.query` 的 `filter.mediaTypes` 因此是**集合**（缺省/空 = 不筛），单值 `mediaType` 已废弃。两条口径互不重叠：**"书"只在图书预览显示**。`pnpm check:panels` 按行为断言这一点（任何档位的请求集合都不含 `text` / `pdf`，且筛选选项由取值域生成而不是手写 `<option>`）。
    - `pnpm check:panels` 断言：Rust 侧 `text` 与**标记**取值域齐备、文本类**不参与内容兜底**、迁移 **0010** 建多值标记表且只搬 `book`、已登记进 `REPO_MIGRATIONS`、`0001_init.sql` **不得**被改（forward-only）。
    - **类目 / 子类 / 标记（2026-10-10，D102）**：本面板的 `has_class` 由 `false` 改为 `true`——此前为 `false` 正是因为"文本类没有任何类目能表达"（`media_type` 只有 image/video/audio）。本面板下挂**文本**类目 → 其下分**子类**（epub / txt / md）；与类目树**平行**地可挂**标记**（book / manga …）。三轴的取值域与匹配口径见 `docs/spec/blueprint-node-standard.md` 第 2.0.1 节与 §5.1。

17. **图书阅读器（`bookreader`，2026-10-16 用户立项）**：宿主内置的**第 16 个**面板，`has_class = false`（只"读一本书"，挑书在图书预览里做），`category = media`，`blueprint_node = control`，`defaultSize = 900×700`（阅读需要行宽，窄面板下页宽/字号都退化成摆设）。它补齐的是 D98/D110 明确**留空**的那部分（"完整的阅读器：目录跳转、书签、字号 / 分栏的用户设置项"）。
    - **分工**：查看器（`viewer`）的口径仍是"显示**开头**内容、范围为面板大小、滚动看更多"；阅读器复用**同一套**正文命令与块渲染（`book.content` + `BookBlocks.tsx`），另加目录（`book.toc`）与阅读选项。两者共用 `book.content` 的分页实现——**纯文本改为按窗口渐进读取**（2026-10-18 需求 2：不再整本解码、不再有单本缓存，见 `hp_book::text_stream`），因此目录能覆盖全书（第 800 章不在 2 MiB 之内）而内存与文件大小无关（详见 D113）。
    - **界面**（用户给了参考图，逐块对应）：顶栏 = 退出阅读 / 章节标题 · 文件名 / 本次阅读时间 / 读完本页约需 N 分钟 / 全屏模式 / **「更多」图标**；主体 = 左侧内置面板（目录 / 书签 / 笔记 / 高亮）+ 阅读区 + 右侧「阅读选项」；底栏 = 当前进度 / **本章进度** / 章节数（**页数已删除**）。**右上角的「更多」图标**是 2×2 四个圆角方块的**矢量**图标（`ReaderMoreMenu.tsx` 的 `MoreGridIcon`，`currentColor` 填充），点击展开**内置面板菜单**（目录 / 书签 / 笔记 / 高亮 / 阅读选项），每一项是**开合切换**且带勾选态；再点图标 / 点菜单外 / Esc 三种方式关闭。左右两栏因此有两个入口（图标菜单 + 栏内标签页），读的是同一份状态。
    - **阅读选项 = 13 项面板设置**（`viewMode` / `bg` / `text` / **`simulatedPageBackground`** / `fontSize` / `lineHeight` / `pageMargin` / `pageWidth` / `letterSpacing` / `paragraphSpacing` / `brightness` / `fontFamily` / `textAlign`）：**不新增库表**，全部落 `app_settings` 的 `panel.bookreader.<key>`（第 5.3 节），因此关掉面板再打开仍在，且「全部设置 → 面板 → 图书阅读器」能改同一批值；读取与热加载走 `shared/settingValue.ts` 的四条触发源，写入后**本地广播**（同窗口即时生效，不等 IPC 往返）。取值域的唯一权威是 `panels/bookreader/readerView.ts`（零依赖纯逻辑），声明层候选与之**逐项一致**（`pnpm check:panels` 断言）；数值项范围**只由面板夹紧**（`clampReaderNumber`，声明层没有 min/max）——字号 12–48、行距 100–240（百分比，170 = 1.7 倍）、页边距 0–80、页宽 30–100（占面板宽度百分比）、字间距 0–20、段间距 0–100、亮度 30–100。**背景/文字颜色是封闭预设**（各 6 / 5 档，面板按预设套 CSS 类）——面板设置的值是标量，任意色值要另立一套校验与回退，而阅读背景真正需要的是"几档对比度"。**字体只用系统字体栈**（D20：不捆绑字体文件、不把字体目录变成运行期前提）。`simulatedPageBackground`（缺省 `true`）是**布尔开关**，面板内用共享的胶囊开关 `SwitchToggle` 渲染（`app_ui` 内不得出现原生复选框，`check:settings` 全局扫描保证）；Rust 侧 `setting_registry.rs` 的校验镜像必须同步，否则 `setting.set` 拒写。
    - **目录（`book.toc`）**：游标**与 `book.content` 同语义**（epub = 章节序号、纯文本 = **字符偏移**、md = 顶层块序号），因此"跳章"就是把目录项的 `cursor` 原样交给 `book.content`——前端**不做任何换算**，避免两套坐标漂移（这条由 `book_tests.rs` 的**往返**用例钉住：拿目录给的游标取正文，第一页必须以那一章开头）。来源：EPUB 的 `nav`（EPUB3）→ NCX（EPUB2）→ 各章 `<title>` 兜底；Markdown 的顶层标题块；**纯文本按内置小说章节规则识别**（用户 2026-10-16 口径："txt 文件使用内置规则识别创建目录（针对小说的优化）"）——`第<数字><章回节篇卷…>`（阿拉伯 / 全角 / 汉字数字）、`Chapter 12` / `Part 2` / `Prologue`、`楔子 / 序章 / 番外 / 后记` 三类写法，并有三条防误判约束（行不超过 60 字、不以句读收尾、"第 + 数字"后必须紧跟章节量词——`第二天早上…` 不认）；`level` = 卷/部/集 分组层级；**PDF 没有目录**（版式描述里没有章节语义）→ 空目录、阅读器只显示正文与页码。
    - **翻页方式**（`viewMode`）：`scroll`（缺省，连续滚动，滚到接近底部取下一页）/ `page` / `spread`（整页翻页，单页 / 双页）。分页用 **CSS 多栏**实现（固定列数 + 固定纸张高度 ⇒ 浏览器把内容横向排成若干栏，翻页 = `translateX` 平移**一屏**），而不是"把滚动条切成一段段"（后者会在段落中间断开）。分页模式没有"滚到底"这个信号，因此"还要不要取下一页"的判据是**已经在最后一页**（`shouldLoadMorePages`）。跳章用 `key={游标}` **重新挂载阅读区**：滚动位置与当前页一起回到开头，不必与渲染竞态。
    - **分页纸张与仿真背景（D116，2026-10-17 用户口径："单页应为一个居中容器，双页应为一对居中的容器，并且都是跟随自适应大小的" + "增加仿真背景(图书阴影)实现和…开关"；2026-10-18 九项修订见下）**：分页模式的可视结构是**一张纸**，居中摆放在阅读区里——**单页** = 一张纸（1 栏）、**双页** = 两张**相贴**的纸（2 栏，书脊处无缝）。层次是三层：`.br-stage`（阅读区，外圈"桌面"）→ `.br-paper`（纸张，`margin: 0 auto` 居中）→ `.br-flow`（正文多栏流）＋ `.br-face-layer`（**纸页层**，`N` 张绝对定位的纸，在正文之下、`pointer-events: none`）。**为什么纸页要单独一层**：CSS 多栏无法给"单栏"上背景（`column-*` 只作用在**一个盒子**的内容上），因此用"纸张盒 + `N` 个纸页层"表达，两者只需宽度相等即可对齐。
    - **2026-10-18 修订（D116-R2）**：**① 三个量各自唯一**——`paperWidth`（整张纸 = 一屏，「页面宽度」%）／`faceWidth = paperWidth / N`（一张纸，**等分**）／`margin`（正文到纸边，「页边距」）。上一版用"各外扩半个栏间距"（`READER_PAGE_INSET`）凑相贴，多出一个必须与栏间距联动的常数；这一版改成**切分**纸张，`N` 张逐像素铺满、相邻天然无缝，那个常数整个删除。**② 桌面留白与「页边距」解耦**（否则用户"书页大一点"与"正文离纸边远一点"两条要求互相矛盾）：桌面是固定小留白（`--br-desk-x/y` = 8px，纸张外的 `.br-stage` padding），「页边距」搬进纸张**内部**（`.br-paper` 的 padding）。实测：页边距 8→60 时**纸张宽不变**（884），只有栏宽 394→322。**③ 书脊缝 = 2×页边距**，是"每栏在自己纸上居中"的**精确解**（推导见 `readerPagedLayout`；这个值正是实体书的接缝）；代入后几何塌缩成恒等式 **`columnWidth = faceWidth - 2·margin`**（纸 = 栏 + 两侧页边距）与 **`screenPitch = paperWidth`**（翻一页正好推进一张纸）。页边距夹紧也据此：上限 `(faceWidth - 48)/2`（**不是** `(paperWidth - N·48)/2`，后者会放大 N 倍——门禁测出写成它会算出栏宽 1px）。**④ 翻页是"刷新"不是"滑动"**：去掉 `.br-flow` 的 `transition: transform 0.18s`，分页平移**无过渡**（滑动是"连续滚动"的观感，与"翻到下一页"的直觉相反）。**⑤ 全屏纸张铺满上下**（用户裁决 B）：`--br-desk-y` 全屏为 0、横向仍留薄桌面（`.br-stage-fullscreen` 类 + `ReaderStage` 的 `fullscreen` prop，并触发一次补测）。**⑥ 顶栏 / 底栏"自然融合"**：去掉 `border-bottom` / `border-top` **横线**、背景改 `transparent`（透出阅读区底色，如参考图 1 的同一片底色）；**刻意不跟 `filter: brightness()`**——亮度只作用在阅读区，进度读数不该随亮度变暗。**⑦ 删除两个按钮 + 一个浮层**：顶栏的「退出阅读」与「全屏模式」按钮都删掉，全屏作为**动作行**放进右侧「阅读选项」栏顶部（裁决 A，保持 D113「更多直接开合两栏」不变）——**删掉入口不等于删掉能力**；右下角悬浮翻页器（`.br-pager`）整个删除，翻页仍可由方向键 / PageUp·PageDown / 滚轮完成。
    - **EPUB 排印（D116-R2 ⑨，2026-10-18 用户口径："解析 epub 排版要正确，去参考开源的 epub 的解析器和阅读器的实现"）**：判据取自**上游一手实现**（Readium CSS <https://github.com/readium/css> / foliate-js <https://github.com/johnfactotum/foliate-js>，不是网文转述；原始样式表不随仓库携带，用到的原值写在 `readerView.ts` 与 `check-panels.mjs` 的注释里，出处可查）。三条落地：**(a) 段落间距缺省 0**（Readium `--RS__paraSpacing: 0`，`p { margin: 0 }`；原为 12px）——中英文书刊都用**首行缩进**分段，再叠间距就是双重分隔（这正是参考图与旧实现的可见差别）；**(b) 首行缩进按语言**（Readium `--RS__paraIndent: 1em`，`:root:lang(zh) { 2em }`）——由新增纯函数 `readerBodyProfile` 按**正文的字符构成**判定（≥30% 方块字判 cjk；样本不足 24 字时**沿用上一档**，否则同一本书会章章跳变）；**(c) 紧跟标题 / 分隔线的第一段不缩进** + **段落内行内元素不继承缩进**（Readium `h1 + p` / `p *`，foliate `:not(p) + p, p:first-child`）。另按 Readium 的 typeScale 1.125 收紧标题层级（**注意渲染元素是 h2–h4**：书的 `h1` 被 `BookBlocks` 收敛成 `h2`，最大字号挂在 `h2`）与 CJK `line-break: strict`。**边界如实登记**：**书自带的 CSS 不解析**——本项目走"受控白名单 → 块模型 → 自己的样式"（安全边界见 `hp-book/epub_text.rs`），因此 `p.illus` / `.center` 之类的**类名样式不生效**。
    - **实测修掉的两处真实缺陷（D116-R2 ⑩）**：**(a) 内外两层多栏打架**——`.br-content` 带着查看器的 `column-gap: 32px`，而 `.br-flow` 是 `2×页边距`（48px）；两层多栏叠加时**内层**按 32px 切节拍，纸页（按外层算）与正文栏**错位 16px**（实测栏中心 229/655 vs 纸 229/671）。修法：`.br-content` 在分页模式下**不再自己分栏**（`column-count: auto; column-gap: normal`）——修正后逐像素相同，且内容流总宽从 3802 降到 1720。**(b) 语言档只看 `text`**——`txt` 内容在 `item.text`，而 `epub` / `md` 在 `item.blocks`（`text` 恒为 null）；只收集 `text` 时**中文 EPUB 永远判 latin**、缩进停在 1em。修法：复用块文本遍历，并为避免循环依赖抽到中立模块 `bookText.ts`（`BookReaderPanel` 已 import `ReaderStage`，反向会成环）。
    - **已验证的边界（如实记录）**：① **繁简转换不做**（项目内没有简繁转换表，要引入一份映射数据），参考图里的那一行**不假装存在**；② **PDF 的目录为空**（无章节语义）；③ 纯文本超过 64 MiB 时如实降级为"仅载入到这里"（`capped`，不是错误）；④ **全书搜索不做**（见下方栏头段的"仍未做"）；⑤ **未真机验收**：分页模式的多栏观感（不同字号下的断栏位置）、配色预设的实际对比度、全屏模式在 WebView2 下的行为都只过了代码层与纯函数层断言，需要眼睛看；**D116-R2 的纸张几何已用无头 Edge 逐项量过（33 项，含全屏铺满上下 8/8→0/0）**，但真机 WebView2 的 DPR / 字体渲染差异仍在；**翻页动画不做**（本轮按用户口径把"滑动"改成**刷新切换**；仿真翻页 / curl 动画仍属未排期）；**没有"封面单独一页、正文再双页"**（书刊惯例，未做）。
    - **书签 / 笔记 / 高亮（落库）**：三个标签页**共用一张表** `reader_annotations`（迁移 **0011**，`docs/spec/database-schema.md` §4.5.2）——它们是"读者在书里的某个位置留下的东西"这一件事的三种形态，差别只有 `kind`（有没有备注、有没有选中文字），三张表会让"这一章我留了什么"变成三次查询 + 三份几乎相同的读写代码。**`cursor` 与 `book.content` 同语义**，因此"点批注跳回去"与目录跳转走**同一条路**（`jumpTo(cursor)`，前端不换算）。**写库前一律校验**（`hp_core::validate_annotation_content`）：书签不需要正文、**笔记 / 高亮至少要有一项非空**（一条没有文字的高亮在列表里就是一行空白，用户会以为没存上）、游标非空、文本不超 20000 字符；违约是 `validation` 而不是静默写坏记录。`excerpt`（选中原文**快照**）与 `note`（读者写的话）**分两列**：合成一列就分不清"这段是原文"与"这段是我写的"，而两者在界面上的排版完全不同（原文引用块 vs 我的批注）。**没有"编辑"命令**是刻意的——批注是**留痕**，改一条旧笔记会让"我当时怎么想的"变得不可信，要改就删了重写（删除幂等）。**高亮的原文来源**：浏览器选区优先，**划不到就用当前页正文开头兜底**（前 200 字符）——后端拒绝空高亮，而"没划字直接点高亮"是完全正常的操作顺序。**新增后回读列表**而不是本地拼装：`id` / `created_at` 由后端生成，拼假的会让紧接着的删除失败。命令在 `reader.*` 命名空间（`commands/reader.rs`）：`book.*` 是"从**文件**里读出内容属性"（不写库），批注是"**读者**留下的东西"（写库、按仓库隔离），是两个域。
    - **顺带修掉一处真实缺口（如实记录）**：`hp-store` 的 `purge_repo.rs` 的 `DERIVED_TABLES`（卸载源时逐表清理的清单）此前**漏了 `file_marks`**（迁移 0010 建的标记表，D102）——两张表都带 `ON DELETE CASCADE`，但那份清单刻意**显式列出**所有引用 `files(id)` 的表（"不依赖 `foreign_keys` 开关是否恰好打开，也便于清点"）。漏登的后果是"卸载源时标记是否被清掉"变成取决于 pragma 状态。本次把 `file_marks` 与 `reader_annotations` 一并补登，并把清点（`SourceDataCounts` 的 `marks` / `annotations`）与清理**成对**加上——**少一项不会报错**，只会让卸载进度条的总数偏小、进度提前跑到 100%，因此这条由门禁按源码锚点断言（`DERIVED_TABLES` 两张表都在、清点与 `derived_total` 都含它们、`match` 分支给结果赋值）。
    - `pnpm check:panels` 断言（新增一段）：注册表条目 + 标题键 + `has_class = false` + `defaultSize`、13 项设置的 kind / 候选 / 缺省与 `readerView.ts` 逐项一致、面板走 `useReaderSettings` / `useReaderBook` 且把 dockview API 传下去、`MoreGridIcon` 是**矢量**（`<svg>` + 四个 `rect`，不得用文字/图片代替）、目录点击调 `bookToc` 给的 `cursor` 而不是自己算、`readerView.ts` **零依赖**（无 React / Tauri / 任何 import）、`book_reader.rs` 的 `book_toc` 按**媒体类型**分流并返回 `ApiAsync`、纯文本目录走**流式扫描**（`hp_book::text_toc_stream`，且代码里**不得**再出现整本解码/单本缓存：`with_reader_text` / `ReaderTextCache` / `READER_MAX_BYTES`）、正文取页走 `hp_book::read_text_page_window` 并把 `content_hash` 作为锚点表的内容身份、阅读批注的迁移 0011 已登记进执行器且三种形态共用一张表 + 写库前校验（**钉调用点**：只断言符号名会被 import 行满足，实测把调用改成 `if false` 仍全绿）、卸载源的清理清单含标记与批注且清点与清理成对。**D116 另加 5 条**（纸张等分 + 恒等式、跟随自适应、仿真开关贯通、书脊缝仅双页、步进为整张纸）；**D116-R2 再加 10 条**（桌面与页边距解耦、页边距可读性夹紧、书脊缝 = 2×页边距且每栏居中、段落间距缺省 0、首行缩进按语言分档、语言档纯函数、块文本必须算进语言档、遍历单一实现，以及全屏/排印的源码锚点）。**回退即红实测 7 处**（夹紧写成 `(paperWidth - N·MIN)/2` ⇒ 栏宽 1px；"等分"改回"栏宽 + 2×纸边"；桌面与页边距共用一个数；书脊缝挂到单页；开关被忽略；页内比例换成"屏内第几栏"；语言档只收集 `text`）。`tools/reader-layout-verify.mjs` 另以无头 Edge 量 **33 项**真实布局（缝隙 0px / 等分铺满 / 正文离纸边 = 页边距设置 / 改页边距纸张宽不变 / 翻页无过渡 / 全屏铺满上下），`tools/reader-typography-verify.mjs` **3 项**判语言档实证。

    - **左栏栏头（D114，2026-10-17 用户口径："目录部分的样式如图所示，最上面要有封面，作者等"）**：左栏自上而下改成**三段**——① **栏头**（封面 + 书名 + 「作者：…」+「已读：N min」，`ReaderBookHeader.tsx`）；② **标签条**（目录 / 书签 / 笔记 / 高亮，`flex: 1` **等分栏宽**，当前页加粗 + 2px 下划线，关闭按钮贴右边缘）；③ 当前标签页的内容。栏头**常驻**、**包在标签切换条件之外**（`{book && <ReaderBookHeader …/>}`）：它回答的是"我正在读哪本书"，切到书签页时把封面收起来会让用户以为换了本书。封面**复用图书预览的 `BookCoverArt`**（同一本书两个面板一张封面：文字封面打底 + 封面图盖上、覆盖优先级、失败回落都在那里），取数复用 `usesEmbeddedCover` / `loadBookMeta` / `loadBookCovers` + `useBookCoverOverride`（`useReaderBookIdentity.ts`），因此 **`txt` / `md` 一次 IPC 都不发**；书名走 `bookDisplayName`（去目录去扩展名），作者沿用 `book.authorLabel`，缺值显示 `—`（`bookreader.unknown`）。**「已读 N min」是本次会话计时**（与顶栏「本次阅读时间」**同一个** `sessionMinutes`），**不是**累计阅读时长——项目里没有那种记录，编一个假的比不显示更糟。下划线用 **`--fg` 而非 `--accent`**：浅色主题下 `--accent` 是白色（画在白底上等于没有线），`--accent-border` 在浅色下只有 `#b8bcc2`，2px 浅灰线读不出"当前在这一页"；这里画的是**线不是字**，不存在反色问题。左栏宽度 `min(260px, 70%)`：260px 是栏头（72px 封面 + 三行文字）读得开的宽度，`70%` 是窄面板下的兜底（浮层不该让阅读区完全消失）。封面里的文字封面要单独收字号（10px / 行高 1.3 / 内边距 4px），否则 `BookTextCover` 的 12px × 6 字断行会溢出 72px 宽的框。**仍未做（如实登记）**：① **「全书搜索」不放**——参考图左栏顶部有那个输入框，但项目里**没有**书内检索层（`hp-book` 只有"按游标取一页"，没有索引 / 检索；PDF 是栅格化位图、没有文本层，搜不了）。要做就得新增 `book.search` 命令（txt / md / epub 可做、PDF 无结果），属未排期项；截图里那一行**不放假开关**（与"繁简转换不做"同一条口径）。**静态观感已核对**（无头 Edge 加载真实 `styles.css` + 同构静态夹具，900×620 与 320px 窄面板两档截图测量：栏头 125px、封面 72×108、四标签各 ≈59px 等分、长书名三行不压作者行、明暗两主题都可读）；**真机 WebView2 的滚动观感与 DPR 差异仍未验收**。

    - **点击正文收起两栏（2026-10-17 用户口径："点击更多后，点击正文区域可以隐藏两栏（等同于再次点击更多）"）**：阅读区挂 `onClick`，命中即 `setRailsOpen(false)`——与再点一次「更多」**同一个状态量**，不是第二条开合路径。三条判据分别落在三处：① **"两栏没开"是结构性条件**，面板只在展开时才传回调（`onBodyClick={railsOpen ? collapseRails : undefined}`），收起态下手压根不存在——比在回调里再判一次更硬；② **点在可交互元素里不收起**（`isInteractiveTarget` 走 `closest("button, a, input, textarea, select, label")` 而不是 `tagName`：正文里可点的通常是链接内部的 `<span>`，只比 tagName 会把"点在链接文字上"判成"点在正文空白处"）；③ **有非空选区不收起**（`window.getSelection()`）——用户划完词松手那一下同样会触发 `click`，不排除的话"划一句话准备加高亮"会顺手把目录关掉。②③ 收敛成纯函数 `bodyClickHidesRails`（`readerView.ts`，零依赖），门禁按**行为**逐条钉住（空白处 true；链接内 false；划词 false；两者同时 false），并另钉 `isInteractiveTarget` 的 `closest` 路径与空目标不抛错、面板的条件传参。**回退即红实测 3 处**：删掉两条否决判据 → 红；`isInteractiveTarget` 恒 `false` → 红；回调改成无条件传 → 红。

    - ****【过程记录，已被取代】**这一轮（第一次修正）的做法已被本条之后的最新一轮推翻，保留只为说明"为什么会走到现在的口径"；实现请以本段之后的最新一条为准。进度跟随滚动 / 翻页 + 本章进度（2026-10-17 用户口径："实装当前进度的计数（当前仅仅是按照章节计数），新增本章进度，都要跟随文本滚动或翻页计数，当前进度精确到 00.00%，本章进度精确到 00.0%"）**：旧实现的当前进度只有**章级**粒度（`epub` / `pdf` 用 `(section+1)/section_count`），一章之内怎么滚都不动；现在把位置拆成两半相加——`全书位置 = 起点游标 + 段内比例 × 已载入单位`，÷ 全书总量即连续进度。三个量来源各自唯一：**起点游标** = 本轮取数的 `cursor`（换章变、滚动加载不变）；**段内比例**由阅读区上报（滚动 = `scrollTop / (scrollHeight - clientHeight)`，分页 = `当前页 / (总页数 - 1)`）；**已载入单位** = 已取回页的字符 / 块 / 页数之和（`readerLoadedUnits`）。**总量按格式取**：`txt` / `md` 用 `book.toc` 的 `total`，**`epub` / `pdf` 用 `first.section_count`**（它们的 `book.total` 恒为 `null`——这一点漏了就是"epub 进度整项消失"）。**本章进度**按目录区间归一（`toc[i].cursor` → 下一条**严格大于**它的游标，末章用 `total` 收口），三处刻意口径：① 用**连续位置**而非取数游标（否则章内照样卡住）；② 第一条目录**之前**（前言 / 版权页）按 `[0, 第一条)` 算，不返回 `null`；③ **相邻两条游标相等**（EPUB nav 允许同一章挂两个锚点）时往回找第一条更大值，否则 `end <= start` 会让整项消失。**精度**：当前进度 `00.00%`（2 位）、本章进度 `00.0%`（1 位）——`formatProgressPercent` 的位数因此是**参数**而非写死。**性能**：位置上报经 `fractionWorthReporting` 节流（阈值 `1e-4` = 显示精度的 0.01%），滚动一秒几十次不会每帧重画整块正文。**位置只有两个上报位置**：`scroll` 事件（滚动模式）+ 一条依赖 `[pages, paged, page, pageCount, width]` 的 effect（覆盖翻页、`loadMore` 加长正文、面板变宽、切单双页——这些都不触发 `scroll`；**不补这条**就会拿旧的"占可滚高度比例"去乘新的单位数，进度凭空跳一格）。翻页 / 滚轮回调里**刻意不再重复上报**：那条 effect 依赖 `page`，翻页后必然重跑；两处都报会让"抽掉任何一处都不红"，第一条断言最初就因此被垫绿过（已如实记录）。跳章用 `key={游标}` 重挂载阅读区，挂载时显式上报 `0`（否则新章会沿用上一章的比例）。**门禁 321 → 330 项**，9 条全部按行为写（章内三点不同 / epub 总量取 `section_count` / 拿不到总量为 `null` / 本章区间 + 前言 + 末章 + 重复游标 / 两处精度 / 末页 = 100% / 已载入单位三种口径 / 节流阈值 / 接线）。**回退即红实测 7 处**：段内比例不参与 → 红；epub 总量退回 `book.total` → 红；本章进度退回取数游标 → 红；分页分母改回 `pageCount` → 红；两处精度都写 2 位 → 红；删掉统一 effect 的上报 → 红；删掉滚动事件的上报 → 红。

    - **底栏删页数（2026-10-17 用户口径："使用百分比计数" → 随即更正为"章节数保持原样，仅删除页数"）**：底栏因此是**三格**——当前进度 / 本章进度 / 章节数。**章节数仍是 `1 / 14`**：它是**离散计数**（第几章 / 共几章），与"读到哪儿"是两回事；折成百分比会与旁边的当前进度重复表达同一件事，还丢掉"第几章"这个可对照目录的信息（用户先要百分比、随后撤回，两者不能并存——门禁**双向**钉住：正向要求 `<b>{chapters.at} / {chapters.total}</b>`，反向禁止 `formatProgressPercent(chapters.at…)` 与 `chaptersPercent`）。**删掉的是页数**：它只在纯文本里是"按一页 2 万字符折算"的估算值（`TEXT_PAGE_CHARS`），与另外两格的精确百分比并列会让人以为那是排版后的真实页数；面板侧的 `pagesInfo` 与 `BookReaderPanel` 的传参一并删除，footer 里不再有 `pages` 属性，三语 i18n 键 `bookreader.footer.pages` 也一并移除（键集三语必须一致，留着就是死键）。**门禁 330 → 332 项**，两条都按行为/结构双向写。**回退即红实测 2 处**：章节数改回百分比 → 红；footer 里再出现 `pages` → 红。

    - ****【过程记录，已被取代】**这一轮（第二次修正）的做法已被本条之后的最新一轮推翻，保留只为说明"为什么会走到现在的口径"；实现请以本段之后的最新一条为准。章节数实时 + 首屏游标收敛（2026-10-17 用户口径："章节数不跳动，也要实时"）**：根因是章节数读的是**取数游标** `book.cursor`——它只在**换章 / 加载更多**时变，滚过章节边界要等下一次取数才反映，于是"滚着读，章号纹丝不动"。改为读 `absolutePosition`（含段内滚动 / 翻页的连续位置），与当前进度、本章进度**同一个判据**。**同族的四处在这一次一并对齐**（否则同一个面板里两个数字会互相矛盾）：① 底部章节数；② 顶栏章节标题（不改就会出现"章节数已经 3 / 14、标题还写着第一章"）；③ 左栏目录高亮；④ 新建批注的落点 `cursor`（它记的应当是"我划下这句时读到哪儿"，不是"这一页加载时从哪儿开始"——长章里后者会偏差整页）。**必须保持不变的一处**：`ReaderStage` 的 `key` **仍是取数游标**——拿连续位置当 key 会在每一帧卸载重建阅读区，滚动位置每动一下就被重置到开头，"实时"的是底部读数而不是阅读区实例（门禁**双向**钉住：key 里必须含 `book.cursor`、不得含 `absolutePosition` / `readFraction`）。**顺带修掉一个真实缺陷**：首屏 `book.cursor` 是 `null`（`useReaderBook` 的第一页是 `fetchPage(null)`），而 `book.content` 的 `cursor` 缺省语义就是"从头开始"——旧代码把 `null` 直接交给 `readerProgress` 得到 `null`，表现为**刚打开一本书时进度一直是 `—`**，直到第一次翻页才突然出现；现在 `null` 收敛为 **0**（且只在真有正文页时——没有正文仍应"算不出来"）。**门禁 332 → 335 项**。**回退即红实测 5 处**：章节数退回取数游标 → 红；章节标题退回取数游标 → 红；阅读区 key 改用连续位置 → 红；首屏游标不收敛 → 红；目录高亮退回取数游标 → 红。

    - ****【过程记录，已被取代】**这一轮（第三次修正）的做法已被本条之后的最新一轮推翻，保留只为说明"为什么会走到现在的口径"；实现请以本段之后的最新一条为准。章节计数修正：两种游标语义 + 段起点分离（2026-10-17 用户报缺陷："章节计数不正确，本来下一章是第4章-序章（前面是封面、彩页、目录），计数结果变回 1 了"）**：用真实语料（`E:\仓鼠\图书测试\re0\…04.epub`）取到该书的目录游标，复现出**两个**独立缺陷。**缺陷 ①：`book.cursor` 不是"段起点"**——它只在 `jumpTo` 里被赋值，首屏（`fetchPage(null)`）与 `loadMore` 都不动它，于是"已载入这一段的起点"在任何非跳转路径上都是 `null`/`0`：用它当基准，读完整本书位置都停在开头，章节数永远显示第 1 章（正是用户报的现象）。修法是**把两个语义拆成两个字段**：`cursor`（跳转目标，只喂阅读区 `key`）与新增的 `segmentStart`（段起点：首屏 = `"0"`、跳转 = 目标、**`loadMore` 不变**）。同时**删掉 `fetchPage` 里的 `cursor: from` 回写**——那既让段起点每加载一页往后漂，又让 `key` 每页变一次、阅读区反复重挂载。**缺陷 ②：epub / pdf 的游标是绝对序号，不是偏移量**——`toc.cursor` 对 epub 是**绝对章号**（实测该书：封面 0 / 制作信息 2 / 简介 4 / 彩页 5 / 目录 10 / 序章 11 / 第一章 12…），而"已载入页数"只是**这一段**的长度；把两者相加，读到第 6 页算成 `0 + 1×6 = 6` 而不是 `5`，正好把「序章」多跳一位算成「第一章」。因此绝对位置**按格式分两条公式**（见 `BookReaderPanel` 的表）：`txt`/`md` 用 `段起点 + 段内比例 × 已载入单位`，`epub`/`pdf` 用 `当前页 section + 页内比例`（`section` 与 `toc.cursor` 同一坐标，不做任何累加）；`readerProgress` 的 `baseCursor` 传入同口径（epub / pdf 传 `first.section`）。**门禁 335 → 336 项**（原"首屏游标收敛"一条换成本轮两条：绝对位置分格式 + `segmentStart` 不被 `loadMore` 改动）。**回退即红实测 4 处**：epub 退回"段起点 + 已载入页数" → 红；进度退回统一用 `baseCursor` → 红；`loadMore` 里改 `segmentStart` → 红；`fetchPage` 回写 `cursor` → 红。**一处断言写法缺陷（如实记录）**：`segmentStart` 那条反向断言最初写成 `!/segmentStart/`，而 setter 名是 **`setSegmentStart`**（`SegmentStart` 大写 S）——正则匹配不到，变异测试当场显示"没红"；改为匹配 `setSegmentStart` 后才真正捕获（与 D113 ⑫ 记过的"只断言符号名会被 import 行满足"是同一类教训：**断言的字符串必须与真实写法逐字符一致**）。

    - **章节数改成"直接读目录 + 当前页游标"（2026-10-17 第三次修正，用户口径："章节数十/十二的计数直接读取目录和当前章节计算不就可以了" + "现在就是当前章节没有和目录实际对上"）**：前两轮都在给**插值**打补丁，根因是**跨页做比例乘法**这件事本身错了——两个量不成比例：滚动比例是**像素**的、位置总量是**结构**的（章数 / 字符数），章节长短不等时乘出来必然错位；而 `loadMore` 会让分母（总高 / 已载入单位）突变，位置就在加载瞬间跳好几章。**这次彻底换掉**：① **页区间精确化**——新增 `readerPageCursors`，用 `BookContentResult` 自带的 `next_cursor` 逐页推出 `[start, end)`（`epub` / `pdf` 直接是 `[section, section+1)`，与 `toc.cursor` 同坐标），不需要任何估算；② **只在单页内部插值**——`readerPositionFromPage(页序, 页内比例, 区间表)` 给出绝对位置，跨页位置由页序号**精确**给出，因此 `loadMore` 不会改变已显示页的起点（门禁按"加载前后逐页 start/end 不变"钉住）；③ **章号不做插值**——章节数 / 章节标题 / 目录高亮三处统一读 `currentPageCursor`（**整数**页起点）再交给 `currentTocIndex`，页内读了多少不改变章号（用户看到的"当前章节没和目录对上"，正是拿带小数点数的位置去比目录游标：小数一越过下一条目录项，章号就提前跳一位）；④ **页级探测**——每页渲染时带 `data-page-index`，阅读区用 `elementFromPoint(...).closest("[data-page-index]")` 认出**当前真正显示的是第几页**（滚动取纵向比例、分页取横向比例），替代了原来"整段滚动了百分之多少"；三个触发点：`scroll` 事件、`requestAnimationFrame` 包住的 `[pages, page, pageCount, width]` effect（加载 / 翻页 / 变宽都不产生事件，必须补）、以及 `key` 重挂载后的一次。⑤ **删掉两套已废实现**：`readerProgress` / `readerScrollFraction` / `readerPageFraction` / `readerLoadedUnits` / `readerPageUnits` / `pageAtPixels` 及对应断言一并移除——留着它们就是留一条"看起来还在用"的死路（`readerView.ts` 从 704 行降到约 520 行）。**验证**：用真实语料 `re0/…04.epub` 的 13 项目录 + 20 个 section 逐页核对，`section 11 → 序章（第 6 项）`、`section 15 → 第四章（第 10 项）`，全 20 项与目录**逐项对上**，且页内比例 0 / 0.5 / 0.99 不改变章号。**门禁 339 → 332 项**（删掉 6 条废函数断言、加 4 条新架构断言：真实目录逐项 + 加载稳定 / DOM 探测 / 三触发点 / 接线）。**回退即红实测 4 处**：章节数改用带小数的 `absolutePosition` → 红；章节数退回取数游标 → 红；位置改回"整段像素比例 × 已载入单位" → 红；删掉 `data-page-index` → 红。**提交前补修一处真实隐患（探测点）**：探测点原先以**舞台** `.br-stage` 的左上角往里 40px 取点，而舞台带 `padding: var(--br-page-margin)`、**上限 80px**——页边距一旦超过 40px，探测点就落进**内边距**，`elementFromPoint` 返回舞台本身、`closest("[data-page-index]")` 得到 `null`，`visibleIndex` 变成 `-1` → **章节数退回第 1 章**（正是用户报的现象的另一条触发路径）。改为以**内容框** `.br-flow`（位于内边距之内）取点，并把探测点夹进"可视区 ∩ 内容框"；分页模式的视口左缘用 `hostRect.left + host.clientLeft`（舞台有左边框时内容起点要往里一个 `clientLeft`）。**这一条也如实记一次断言教训**：把 `flow.getBoundingClientRect()` 换成 `host.getBoundingClientRect()` 时，只检查`flowRef.current` / `flowRect.left` **字面写法**的断言**仍然全绿**——变量名没变、变的是它装了什么；改为直接钉 `const flowRect = flow.getBoundingClientRect();`（并反向禁止取自 `host`）后才真正捕获。这与前面 `setSegmentStart` 那条是同一类教训：**断言要钉"值从哪来"，不能只钉"变量叫什么"**。

    - **真机反馈的四项修复（2026-10-16，用户实测后当场报回）**：① **左右两栏改为浮层**——用户口径"点击更多后，左右两栏**浮在正文上面**，不是在正文旁边分出来"。并排三栏会**改变正文宽度**，于是分栏重算、当前页位置漂移：用户只是打开目录看一眼，正文却跟着跳。因此 `.br-body` 是定位容器（`position: relative`），两栏 `position: absolute` 贴左右边缘 + `z-index` + 投影，阅读区独占整宽（浮层不动正文几何，关掉即回原样）。② **目录当前章与「阅读选项」选中档位的配色**——用户口径"选择某章节后文字变白/消失"、"被选择的按钮文字是白色，看不清"。**同一个根因**：我误用了 `color: var(--accent)`，而**浅色主题下 `--accent` 是白色 `#ffffff`**（`styles.css` 顶部第 111 行早已写明这条禁忌："不能用 var(--accent)——浅色主题下 --accent 为白色，会白底白字不可见"）。改用项目既有的"选中"约定：`--active-bg` 实心底 + `--active-fg` 反色前景（与 `.menu-item.small.on` / `.mp-toggle button.active` 同一对 token），并给选中项加 `font-weight: 600`，明暗两套主题下都高对比。**同族的第三处**（本次一并修）：新增的 `.br-annotation-jump` 批注跳转链接也用了 `var(--accent)`，改用 `--cross-tag`（两套主题下都为"可点蓝"）。③ **分页模式的滚轮翻页**——用户口径"单页和双页滚轮滚动一次应该是一页，现在的方式和普通滚动无区别"。**根因是 React 的 `onWheel` 是 passive 监听器**：`preventDefault()` 被忽略 ⇒ 原生滚动照常发生 ⇒ 分页退化成普通滚动。本项目在 `panels/bookpreview/BookCard.tsx` 已记录过同一个坑，本次沿用其处置：**原生 `addEventListener("wheel", …, { passive: false })`**。同时修正两处伴随缺陷：(a) **按增量累积**而不是"一个事件翻一页"——一次物理滚动 ≠ 一个 `wheel` 事件（触控板会把一次滑动拆成几十个小事件，按事件数翻页会一滑翻十几页），口径是累积到 `READER_WHEEL_STEP_PX`(60) 即翻**一页**并清零（**不是**除以阈值取整，否则一格 300 的鼠标一次翻 5 页）；`deltaMode` 按 行×16 / 页×400 归一化（不折算会让按行报数的设备永远攒不到阈值 = 滚轮失灵）。(b) **分页几何收敛为 `readerPagination` 一处算术**——此前页数与 `translateX` 步进都按**单栏**算，于是双页模式一次只挪一栏（正文在屏幕里横向漂半格）、页数还翻倍；现在栏宽 / 栏数 / 页数 / 步进（`pitch = 屏内栏数 × (栏宽 + 间距)`）出自同一份推导，CSS 侧也把 `column-width` 改为 `column-count`（列数固定 ⇒ 浏览器**等分**宽度，真实列距与算出来的逐像素一致；`column-width` 只是建议值，浏览器会拉伸 ⇒ 翻几页就错位）。**滚动模式不受影响**：监听器在 `!paged` 时直接不注册，原生滚动照旧。
    - `pnpm check:panels` 为这四项各加了断言（**钉行为与机制**，不只钉符号出现）：两栏必须 `position: absolute` + `z-index` + `left/right: 0` 且**不得**再有 `flex-shrink: 0`（并排写法）；`.br-toc-item-active` / `.br-choice-item-active` 必须是 `--active-bg` + `--active-fg`，且**剥注释后不得出现** `color: var(--accent)`；`ReaderStage` 必须是 `addEventListener("wheel", onWheel, { passive: false })` + `removeEventListener` + `preventDefault()`，且**不得**再有 `onWheel={`；`accumulateWheelStep` 的四组行为（小增量保留 / 到阈值翻一页并清零 / 一次大增量**只翻一页** / 负向翻上一页）与 `normalizeWheelDelta` 的三档 `deltaMode`；`readerPagination` 的单栏与双页几何（栏宽 / 步进 / 页数按"一屏 N 栏"算）。**回退即红实测 5 处**：两栏改回并排 → 红；选中态改回 `var(--accent)` → 红；滚轮改回 React `onWheel` → 红；累积改成"不累积" → 红；双页步进退回按单栏 → 红。

18. **音频波形图（2026-10-17 / D115）**：波形由**后端** `ffmpeg showwavespic` 生成（`hp-media/src/waveform.rs`），前端只是显示一张图。三处消费方**共用一个组件与一份纯几何**：

    - **一张 PNG、透明背景、按内容哈希缓存**：`showwavespic` 输出 `rgba` 且未画到处 **alpha = 0**（实测角像素 `0,0,0,0`），因此**不生成第二套"深色主题版"**——同一张图在三套配色下直接用（底色交给 CSS）；该滤镜在此构建里没有 `background` 选项（实测 `Option not found`）。同一输入两次生成**逐字节相同**（实测 SHA-256 相同），因此它可以像缩略图一样**按内容哈希缓存**，并作为"内容没变就是同一张图"的判据。**只出一种尺寸**（1200×240）：三处共用同一个缓存文件，分两种尺寸就要第二条取图命令与第二个缓存，收益只是"网格那张小一点"。
    - **音频与图片/视频走同一条取图路径**：波形在缓存里占的就是"缩略图"那一格（`thumb.get` → `.mp-thumb`），因此复用 `shared/thumbUrl.ts` 的**同一份结果缓存与 in-flight 去重**，不需要第二条命令。**D115 之前音频是唯一的例外**（前端 `decodeAudioData` 现算现画，因此另走一道"真的进入视口才解码"的观察器闸门，D89 ③）——那条例外随波形改由后端出图而**失去存在理由**：取一张缓存的 PNG 没有 CPU 代价。故 `mediaPreviewCell.tsx` 的 `needsThumb` 收进 `audio`，模块内那个共享 `IntersectionObserver` **整个删除**。**留着它 = 为不存在的原因保留一道闸门**，会把音频重新变回"向上不预加载"（缺陷 0025）。
    - **`hp-media` 侧三条口径**：**原子落盘**（复用 `thumbnail` 的 `temp_sibling` / `commit`——扫描已并行，同一内容可能被两个线程同时画，直接写目标文件会交错出半张图）；**`hidden_command`**（GUI 父进程下不新建控制台窗口，与 probe / decode / thumbnail / player 同一漏斗，`check:hidden-console` 的接入口清单因此从四个变**五个**）；**整段线性**（不裁剪、不缩放音频，横轴与时间线性对应——这是播放器"在波形上叠游标"的前提，由 `waveform_covers_the_whole_duration` 钉住）。
    - **前端纯几何（`shared/waveformView.ts`，零依赖、门禁直接 import）**：`waveDrawnBox` 把"容器尺寸 + 图像原始尺寸 → **真实绘制盒**"独立出来；游标（`waveCursorX`）与点击定位（`waveSeekSeconds`）**都从它出发、互为逆运算**。**为什么必须有它**：`.wf-image` 用 `object-fit: contain`，容器与波形（1200×240）宽高比通常不同，**较紧的那一边会留白**（letterbox）——"容器左边缘"与"波形第 0 帧"因此不是同一个位置；拿容器宽度当图像宽度，游标与定位都会偏一个留白量，而且**音频越长越不明显**（留白占比小），极易漏掉。这与缺陷 0027 同一类：**几何口径必须与真实绘制一致**，不能拿"容器盒"当"图像盒"。游标用 `left: <px>`（不是百分比）正是同一个理由——百分比相对容器、而留白不是。
    - `pnpm check:panels` 断言：三种媒体类型同一条取图路径（正向锚点 `needsThumb` 含 `audio`）+ 单元模块内**零** `IntersectionObserver` + 组件与缓存同源 + 波形几何**三条行为断言**（互逆运算 / 留白被算进绘制盒 / 越界与"不适用"都有确定答案。越界指 `positionMs` 略大于 `durationMs`——浏览器两个值来自不同来源、末帧常差几毫秒；"不适用"指时长未知时返回 `null`，**不画一根在 0 上的假游标**，那会被读成"播放卡在开头"）。**回退即红实测 2 处**：`waveDrawnBox` 的 `left` 恒 0 → 留白断言红；`waveCursorX` 不补回留白 → 互逆断言红（探针存档 `archive/2026-10-17-audio-waveform-mutation-probe/`）。
    - **播放器的两条定位路径只有一份实现**：进度条拖动与波形点击**共用** `commitSeek`——各写一遍 `currentTime = …` 就会把夹紧范围各写一遍，迟早出现"进度条能拖到末帧、波形点不到"。查看器的音频舞台同款（时长与位置取自 `<audio>` 元素本身，不是索引元数据——判据是"永远与正在播的这份文件一致"，旧库未升级或换源都不会错位）。**视频不画波形**：波形的横轴必须与音频时间线性对应才可读，视频那张图只能是"某一帧"或"整段抽样"，两者语义不同。

- **`cargo test -p hp-core`**：面板声明的硬错误清单、命名空间规则、`settings.kind` 白名单、`has_class = false` 的类目拒绝、`mount.overlay_content = false` 的浮层拒绝。
- **回归**：内置 16 个面板的声明必须能通过校验且与现状一致（**零行为变化**）；插件面板缺失时蓝图可保存且灰显「未接通」。
- `pnpm typecheck` / `pnpm build` / `check-line-count` / `check-doc-status` 通过。

## 9. 落地顺序（强制）

1. ✅ 本文（面板标准）定稿；RFC 0010 决策 1–4、7 记录。
2. ✅ 面板注册表升级为可注册结构（`packages/config/src/panels.ts` 的 `BUILTIN_PANEL_SPECS` / `registerPluginPanels` / `allPanels`；内置项行为不变）。
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
- **媒体派生信息的数据来源（2026-09 实测后记录；音频部分 2026-10-17 / D115 已落地，见下第一项）**：
  - **音频（2026-10-17 / D115 起口径已变）**：`files` 表对音频**不再是 D11 占位行**——扫描期照算内容哈希、并用 ffprobe 缓存媒体信息（时长 / 编码 / 码率 / 采样率），因此**索引里就有**时长。元数据面板优先读 `media_info_json` 的 ffprobe 结果（并新增「采样率」一行，**解析只看 `codec_type === "audio"` 的流**——取"首流"会把纯视频文件的字段误读成采样率）；前端 `preload="metadata"` 退为**兜底**，只服务于尚未升级的旧库行。**存量占位行原位补齐**：扫描的准备阶段只要发现音频行**哈希缺失**就重算一次，与 size/mtime 是否变化无关（否则"未变即跳过"会把占位行永远留下）。
  - **视频**：尺寸 / 时长 / 编码 / 码率 / 帧率来自 `media_info_json`（**扫描时 ffprobe 可用才写入**，`crates/hp-scanner/src/scanner.rs` 的 `process_video`）。**早于该状态的索引行永远是空的**——实测索引库里存在这种行，表现为"设置没错、面板却没显示任何媒体行"。现由面板用前端 `<video>` 兜底**尺寸与时长**；*编码 / 码率 / 帧率 DOM 拿不到，如实显示 `—`*。是否补"重新分析"入口或按需后端探测来补齐这三个字段，待定。
  - 两者的共同点：**面板只读索引 + 前端兜底，绝不隐式写入索引**（不替用户改数据）；缺值一律渲染为 `—` 而不是省略该行（省略会让"索引没数据"与"面板坏了"外观一致）。
- **图书预览（`bookpreview`，2026-10-08 立项；正文查看 2026-10-09 落地）**：
  - **查看器（`viewer`）的 `txt` / `md` / `epub` 正文查看——2026-10-09 已落地；PDF 于 2026-10-11 追加**（用户口径："查看器面板新增 2 个文件的查看：1、txt，显示文本开头的内容，范围为查看器面板大小。2、epub，显示开头内容，包含文本和图像，根据查看器自适应展示单栏或双栏，默认为单栏，显示范围为查看器面板大小"；2026-10-11："查看器增加 pdf 支持"，追问后裁决"逐页栅格化为图片、滚动看后续页"）。口径与落点：
    - **判据用媒体类型**，**不按扩展名**：`isBookMedia` = `media_type === "text" || "pdf"`——媒体类型由扫描期的扩展名表给出（`hp-scanner` 的 `ext_to_media_type`），在面板里再列一遍扩展名就是第二份口径，迟早与扫描器漂移（`md` / `markdown` 这类最容易漏）。**PDF 与文本类合在一条判据里**：对查看器而言两者行为一致（都要 `book.content` 分页取正文、都不取 `file.path`），差别只在阅读区内部按 `format` 渲染。
    - **内容 = 书的开头，固定上限**：纯文本按字节上限（`hp_book::TEXT_VIEW_MAX_BYTES`，2 MiB ≈ 60–100 万字符）读文件开头并**判编码**；epub 按 **spine 章节**分页，每章转成**类型化块**；**PDF 按页栅格化**（见 §10 的 PDF 条目）。三者都**不是**"把整本书读进来"。
    - **滚动看更多 = 分页按需取**（用户追问后裁定："固定上限 + 面板内滚动看更多，但是字符缓存不需要大，滚动时按需缓存"）：`book.content` 每次只回**一页**（纯文本一页 2 万字符 / epub 一章 / **pdf 一页**），游标由前端带着走（纯文本 = **字符偏移**、epub = **章节序号**、**pdf = 页码**），滚到接近底部才取下一页（`shouldLoadMore`，提前量 400px）。**到末尾不是错误**（`next_cursor: null`），面板显示"已显示开头内容"。因为解码量被上限封住，**每次翻页重新解码也是毫秒级**（实测 14 本 txt 59–408 ms/本含判编码），因此**不维护**任何"已解码正文"缓存。**PDF 是这条口径的例外**：栅格化实测 25–156 ms/页，不缓存的话往回翻一次就要重画，因此每一页**按内容哈希落盘**（`<hash>.book-<页码>-0.jpg`）。
    - **编码判定必须做，且顺序有讲究**（实测依据：真机语料 14 本 txt **无一带 BOM**，**7 本 GBK + 7 本 UTF-8**）：① BOM 权威；② **UTF-8 合法性**（可判定的硬事实，排在统计探测之前）；③ `chardetng` 统计探测；④ **GBK 可解码性兜底**（替换字符少 + CJK 占比 ≥ 20%）。第 ④ 步是必需的：实测 `chardetng` 在**不给 TLD 提示**时对 7 本 GBK 中的 **6 本给出 `windows-1252`**——那是它的"我判断不了"兜底值，照它解码整本书都是 `ÌìÑÄÔÚÏß` 这样的乱码。
    - **一个真实的坑（已由测试钉住）**：采样窗口按固定字节数切出来，**会切在多字节字符中间**——实测 4 本**整份合法**的 UTF-8 若直接校验前 256 KiB 会被判非法（首个非法位置 `262142` = 256 KiB − 2）。因此校验口径是"合法，**或只在尾部差一个被截断的字符**"（用标准库 `Utf8Error::error_len()` 的 `None` 区分），见 `hp_book::text::is_utf8_but_maybe_truncated`。
    - **安全边界：正文**不是** HTML**（这是本项最硬的一条）：EPUB 的正文是 XHTML、Markdown 可以内嵌 HTML，渲染它们要么走 `dangerouslySetInnerHTML`（**本项目不接受**），要么做一遍受控白名单。**白名单做在解析侧**（`hp-book` 的 `epub_text` 与 `markdown`），桥接层与前端拿到的只有 `BookBlockItem` / `BookSpanItem` 这样的**纯数据**，前端用 React 元素渲染——**前端没有可注入 HTML 的入口**，不是"我们记得别用"。`<script>` / `<style>` / `<head>` 的内容**整段丢弃**（实测语料里有 13 处 `<script>`），白名单外的标签**丢标签留文字**（不丢正文）。**Markdown 侧有一条实测抓到的坑**：`pulldown-cmark` 把 `<script>alert('xss')</script>` 拆成 `InlineHtml("<script>")` + **`Text("alert('xss')")`** + `InlineHtml("</script>")`——中间那段是**普通文字事件**，只过滤 HTML 事件会漏掉它；因此"丢弃深度"必须**跨事件**存活（见 D100 ⑥）。
    - **单栏 / 双栏纯自动、无设置项**（用户 2026-10-09 追问后裁定"不做设置项，纯自动（无 UI）"）：分栏数只看**面板可用宽度**（`readerColumns`，阈值 `READER_TWO_COLUMN_MIN_WIDTH = 900`，判据用**扣掉左右内边距**后的宽度）——**窄面板恒单栏**，这就是"默认为单栏"的落点。字号同样随宽度给一档（`readerFontSize`）。**不新增面板设置**（`viewer` 仍只有 `infoBarEnabled` 一项）。
    - **"范围为查看器面板大小"**：阅读区 `flex: 1` + 自己 `overflow: auto`（面板其余部分不动）；内容用 CSS `column-count` 断栏（文本流交给浏览器最省事，天然"一栏读满再读下一栏"）。
    - **文件拆分**（单文件 ≤ 1200 行）：`panels/viewer/ViewerReader.tsx` 阅读区装配、`panels/viewer/BookBlocks.tsx` **块渲染（EPUB 与 Markdown 共用）**、`panels/viewer/useViewerBookContent.ts` 分页取数、`panels/viewer/viewerReaderView.ts` 纯逻辑（**零依赖**，门禁直接 import）。**注意文件名大小写**：纯逻辑模块叫 `viewerReaderView.ts` 而不是 `viewerReader.ts`——后者与 `ViewerReader.tsx` 在 Windows 上**大小写不敏感地撞名**，`tsc` 直接报 `TS1261`（实测）。
    - **图片落盘**：epub 章节内的插图由桥接层落到缩略图缓存目录（`<hash>.book-<章节>-<序号>.<ext>`，按内容哈希失效），前端 `convertFileSrc` 渲染；单张图落盘失败只跳过那张图，**不让整章变成错误态**。
    - **PDF 正文：逐页栅格化（2026-10-11，用户口径）**——用户原话："查看器增加 pdf 支持"，追问后裁决 **"逐页栅格化为图片、滚动看后续页"**。口径与落点：
      - **为什么不是抽文字**：PDF 是**版式描述**而非文本流（分栏、表格、五线谱、公式、图片的位置与字形都在内容流的绘制指令里，文字只是其中一类）。抽文字会丢掉版式（表格散架、乐谱全丢）；栅格化则**所见即原貌**。
      - **一页 = 一张整页位图**：`book.content` 的 `pdf` 分支把第 N 页栅格化（`hp-pdf` 的 `render_page_jpeg`，目标宽 `PDF_PAGE_WIDTH = 1200`）落盘成 `<hash>.book-<页码>-0.jpg`，返回**一个 `image` 块**——与 EPUB 的章节插图**同一个块种类**，因此前端渲染器（`BookBlocks.tsx`）**一行都不用改**。
      - **游标是页码**（与 epub 的章节序号同形）：`section` / `section_count` 直接复用，前端只有一套分页与进度提示；只有 `format === "pdf"` 决定文案（`viewer.pageOf`，**页**而不是**章**——"第 3 / 54 章"对一份展板 PDF 是错的）。
      - **恒单栏**：每一"页"是整页位图，塞进 `column-count` 只会让一页被拦腰断成两栏（既不是原貌也不是连续文本）。面板侧 `isPdf ? 1 : readerColumns(width)` 钉成 1，CSS 侧 `.vr-content.vr-pdf` 再钉一道；页面图 `max-height: none`（覆盖 `.vr-image` 给**插图**定的 70vh——整页就是内容本体，限制高度会让用户每页都要放大才能读）。
      - **落盘失败 / 打不开一律降级**：单页渲染失败给一个空块（不让整个查看器变成错误态）；打不开的 PDF（损坏 / **加密**）返回空结果 → 面板显示 `viewer.noContent` 占位。**游标越界回落最后一页**而不是报错（与 `parse_cursor` 的"翻页游标不该成为新的错误来源"同一条口径）。
    - `pnpm check:panels` 按**行为**断言（直接 import `viewerReaderView.ts` 驱动）：`readerColumns` 的阈值与"扣掉内边距"、`firstColumnEnd`、`shouldLoadMore`（含"没有下一页时不发请求"）、`readerFontSize`、`isImageOnly`；外加源码锚点——正向：面板按 `media_type === "text"` 分流、文本类**不取** `file.path` / `preview.get`、阅读区经 CSS 变量下发分栏与字号、取数走 `book.content` 且**只在需要时**取下一页、epub 块用 React 元素渲染；反向：**不得**出现 `dangerouslySetInnerHTML`、不得在面板里再列一遍文本扩展名。
  - **Markdown（`.md` / `.markdown`）渲染——2026-10-10 已落地（D100）**（用户口径："为查看器面板增加 .md 格式支持"，追问后裁决为 **"渲染 + 完整 Markdown 语法覆盖"**）。口径与落点：
    - **原先是什么**：`.md` 早已按 `media_type === "text"` 走纯文本通路（`<p>` + `white-space: pre-wrap`），显示的是 **Markdown 源码**。本次把它**渲染**成排版正文，判据仍是媒体类型、不在前端列扩展名（沿 D98 口径）。
    - **两种格式共用一套块模型**（本项最重要的结构决策）：`hp-book/src/block.rs` 定义 `BookBlock` / `BookSpan` / `SpanStyle` / `ColumnAlign` 等**纯数据**，**EPUB 与 Markdown 都产出它**；前端因此**只有一份渲染器**（`BookBlocks.tsx`），改一处样式只改一处。行内样式是**可叠加的标记列表**（`***x***` = `[strong, emphasis]`）并由 `normalize_styles` 归一化成**固定次序**——否则同一段文字会因嵌套顺序不同而不相等。
    - **完整语法覆盖**（`markdown.rs` 的 `options()` 逐项开）：表格 / 脚注 / 删除线 / 任务列表（勾选态进 `BookListItem.checked`）/ GFM 告示块（`> [!NOTE]` → `quote_kind`）/ 定义列表 / 上标 / 下标 / 数学（按纯文本渲染）/ 标题属性（`{#id}` 要吃掉）/ YAML front matter（文首要吃掉）。**刻意不开**：智能标点（会改写用户原文）、wikilinks（Obsidian 私有语法）。
    - **解析侧用 `pulldown-cmark`**（CommonMark 参考实现、纯 Rust、无 C 依赖）：Markdown 的**行内强调**与**链接引用**规则很绕，手写"差不多"的实现在这两处会长期出错。它**只用来产出事件流**——`html` 特性**刻意不开**，因此"库能生成 HTML"不给本项目增加 HTML 注入路径。
    - **图片只给真的在盘上的绝对路径**：相对路径按**文档所在目录**解析、`..` / `.` 归一化后再 `is_file()` 确认；远程 URL 与 `data:` URI 不落成 `<img>`。前端拿到的每个 `image` 都可渲染，"破图"在结构上不出现；跳过的图片进 `warnings`（可诊断，**不让整篇变成错误态**）。
    - **分页按**块**而不是按字符**：渲染后是结构化的块，按字符拦腰截断会切出半个表格、截断代码块。游标是**块序号**（与 epub 的章节序号同一形态），一页 `MARKDOWN_PAGE_BLOCKS = 60` 个顶层块；**仍复用字节上限**（2 MiB）封住读盘与解码，编码判定与 txt 同一条路径（`.md` 也可能是 GBK）。
    - **文件拆分**：`hp-book/src/block.rs`（块模型）、`inline.rs`（行内累积 + HTML 片段扫描，两格式共用）、`markdown.rs`（Markdown → 块）、`markdown_tests.rs`（测试独立成文件，守 1200 行）。
    - `pnpm check:panels` 新增 7 项断言：丢弃深度**跨事件**存活、两格式**共用**块模型、图片**确认在盘**、完整语法开关齐备（**只看 `options()` 函数体**——常量名在注释里也出现，全文匹配会让"关掉开关"的变异仍然通过）、前端渲染新块种类、阅读区按 `format` 分流、桥接层按扩展名分流且游标是块序号。**回退即红实测 3 处**（含上述空洞断言被改成按行为断言）。
  - **标记的用户入口——2026-10-10 已落地（D102）**：图书预览的右键菜单新增 **「标记」多选区**（按**可注册清单**渲染，勾选态用 ✓ 表达），走 `file.setMarks` 命令（`add` / `remove` 各自幂等）写 `file_marks` 表。**标记是可多值、与类目正交的集合**——用户口径："book 为标记，标记可以交叉，例子：漫画.zip 文件的类目为压缩包，可以标记为 manga（漫画）"。**仍未做**：① **标记清单的管理界面**（当前内置 `book` / `manga`，插件/宿主可经 `registerBlueprintMarks` 登记，但没有面向用户的"新建标记"入口）；② **标记驱动行为的完整闭环**——用户例子里"漫画标记的文件按漫画阅读器蓝图打开"要等**压缩包媒体类型 + 漫画阅读器面板**落地（本轮按用户裁定不含，属下一轮的消费者）；③ 多标记的批量入口（当前右键一次改一本）；④ **"显式清除全部标记"与"从未标记"不可区分**——扫描的补默认值判据是"该文件**一个标记都没有**"，因此把一本 `epub` 的标记**全部**清掉后，重扫会按扩展名把 `book` 补回来（这与旧单值口径的边界相同；要区分需给"显式清除"一条独立状态，属未排期决定）。
  - **多选与拖拽**：图书预览的选中集复用全局那一份（`app.selectedIds`），但只做**单选**；Shift 范围 / Ctrl 切换 / 拖拽载荷（`application/x-hp-files`）与条目容器的键盘快捷键（Ctrl+A / Esc / Delete）是媒体预览的交互，本版**没有**搬过来。
  - **蓝图事件上报（2026-10-10 接入）**：本面板**只上报 `click` / `double_click`**（三个视图的单元都接上，不是只接一个），且**只发自己这一类**——不上报媒体预览的 `selection_change`（连带 `rating` / `has_tag` 的异步 context），因为那是多选与条件求值的口径、本面板只有单选。上报必须带**类目细分**（`format` + `bookMark` 两个**正交**维度），否则 `media_type = text` 的类目一个也命中不了：只报裸的文本媒体类型时，四个类目全都匹配不上（引擎的两级判据见 `docs/spec/blueprint-node-standard.md` 第 2.0.1 节）。
  - **虚拟化与排序**：文本库的量级（几十–几百本）不值得上虚拟化（媒体预览那套是为数万张图做的）；排序本版固定为 `file.query` 的自然序（相对路径升序），**没有**排序设置。若将来文本库涨到数千本，再按媒体预览的路子补虚拟化与排序（届时 `coverSize` / `view` 之外还要加 `sortKey` / `sortDir`）。
  - **更多文本格式**：当前把 `txt` / `md` / `markdown` / `epub` 判为 `text`，把 `pdf` 判为它自己的 `pdf` 类目。`mobi` / `azw3` 这类也能进同一张扩展名表，但它们是二进制容器、`hp-book` 解析不了封面与元数据（会落到文字封面）；要不要支持属未排期决定。
  - **PDF 的未做项（如实记录，2026-10-11）**：① **加密 / 带密码的 PDF 打不开**（`hayro` 的能力边界，本项目没有"输入密码"的入口）——按"坏书"降级为文字封面 / 空正文，不是错误态；② **没有缩放 / 旋转 / 跳页 UI**（用户口径是"滚动看后续页"，一页按整宽显示，不做设置项）；③ **不做文字选择与复制**（栅格化的固有代价——要复制就得走文字抽取那条路，而它正是本项刻意不选的）；④ **大页面按 4 倍上限缩放**（`PDF_MAX_SCALE`：一个 72pt 的小页面不会按 1200px 目标放大成 16.7 倍，那既慢又没有信息增量）；⑤ 混合模式 / 隔离组 / 挖空组等高级合成特性支持不完整（`hayro` 自述）。
  - **相册与"书"**：见 §8 第 16 项的"已知边界"——文本类与 PDF 都进不了相册成员列表，本版按"面板不按相册取数"绕开，**没有**扩相册的语义。
