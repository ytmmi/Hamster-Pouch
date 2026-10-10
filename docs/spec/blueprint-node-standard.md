# 蓝图节点标准（节点类型定义表 + 注册表声明参数 + 端口/边规则）

状态：正式草案。本文是 RFC 0007「决策 1 节点分层与节点类型」的**标准化展开**，并经 **RFC 0010 决策 5/6 扩展**：把 **12 种**内置节点类型的字段、取值域、引用目标、端口与边规则收敛为**一份定义表**，并把该定义表升级为**注册表**（宿主内置 + **插件可注册**），供后端校验、前端解析层、画布端口表与属性面板**共用同一口径**。

**2026-09 术语修订（RFC 0010 决策 1，仅显示用语，JSON 不变）**：

| 原显示名 | 新显示名 | 枚举值 |
| --- | --- | --- |
| 面板控件（Panel Control） | **面板**（Panel） | `control`（不变） |
| 类（Class） | **类目**（Category） | `class`（不变） |

本文**不改变既有 JSON 字段名与枚举取值**（向后兼容）：内容全部来自 RFC 0007 / D28–D70、RFC 0010 与现有实现（`crates/hp-core/src/blueprint_*.rs`、`packages/config/src/blueprint*.ts`、`apps/desktop/src/app_ui/panels/blueprintPorts.ts`）。若本文与 RFC 0007 / RFC 0010 正文冲突，以 RFC 与 `docs/architecture/decision-checklist.md` 为准，并须修正本文。

## 1. 权威与落点

| 关注点 | 权威实现 | 说明 |
| --- | --- | --- |
| 取值域（枚举） | `crates/hp-core/src/blueprint_types.rs` | `NodeType` / `GroupMode` / `HideDirection` / `Trigger` / `ActionOp` / `EdgeKind` / `TokenLevel` / `OverlayAnchor` |
| 结构（字段） | `crates/hp-core/src/blueprint_node.rs` | `BlueprintNode` / `BlueprintEdge` / `BlueprintLayer` / `BlueprintPosition` / `OverlaySize` |
| 硬错误 | `crates/hp-core/src/blueprint_validate.rs` | 拒绝保存；见第 6 节 |
| 软告警（未接通） | `crates/hp-core/src/blueprint_warnings.rs` | 不阻塞保存；见第 6 节 |
| 迁移与版本闸门 | `crates/hp-core/src/blueprint_migrate.rs` / `blueprint.rs` | `schema_version` 权威在文档内（D52/D58） |
| **节点类型注册表（前端）** | `packages/config/src/blueprintNodes.ts`（`BLUEPRINT_NODE_REGISTRY`） | **单一事实来源**；内置 **12** 种 + 插件注册项 |
| 前端取值域与解析层校验 | `packages/config/src/blueprint.ts` | `parseBlueprintDocument` / `forUserSave` / 分层工具 |
| 浮层几何纯函数 | `packages/config/src/blueprintOverlay.ts` | `resolveOverlayPosition` / `resolveOverlaySize` 等 |
| 端口与边类型契约 | `apps/desktop/src/app_ui/panels/blueprintPorts.ts` | `PORT_DEFS` / `CONTAINMENT` / `kindForEdge` |
| 节点显示层 | `apps/desktop/src/app_ui/panels/blueprintLabels.ts` | 本地化显示名/摘要/字段标签 |
| **插件注册入口** | `crates/hp-core/src/plugin_contribution.rs` | 贡献点 `blueprintNode`（RFC 0010 决策 5/6） |

**实测对齐缺口（已知，2026-10-10 已加门禁）**：`blueprintPorts.ts` 的端口可用性目前靠人工维护，与 `blueprint_validate.rs` 的包含层级规则是两处独立表述，改动一侧容易漏另一侧。第 2–4 节即为**双方共用的定义表**；两侧的取值域断言由 `pnpm check:blueprint-nodes` 覆盖。

> **2026-10-10 实例（真实缺陷）**：`mark` 声明了 `parents: ["control"]`，但 `control.children` 只写了 `["class"]`——**漏了 `mark`**。由于画布连线（`containmentAllows`）与 Rust 校验（`can_contain`）都**只读父节点的 `children`**、不读子节点的 `parents`，结果是**「面板 → 标记」被判为非法边，线上根本连不出来**（用户反馈："面板节点无法链接标记节点"）。
>
> 两处教训已固化为门禁：①**父子声明必须双向互指**——新增断言独立比对两侧声明（而不是只看由 `children` 派生的 `CONTAINMENT` 表；后者**遍历不到**漏声明的组合，因此此前 59/69 项全绿却漏掉了它）；②**同族的多条轴要一起加**——`class` 与 `mark` 是面板下两条平行的轴，给面板加子级时漏掉任一条都会让对应连线静默失效（与 D102 那次"`on` 端口静默消失"同族）。

## 2. 节点类型定义表（内置 12 种）

约定：**每层至多一个 `interface`**；`key` 蓝图内唯一（第 7 节命名规范）；**每个节点都带 `layer`**（多页文档必填，单层文档可缺省兜底）；节点可选带 `name`（显示名，缺省由前端按类型本地化生成）与 `position {x, y}`（画布坐标，浮层/组节点另有语义，见下）。

| `type` | 名称 | 中文名 | 结构角色 | 必需字段 | 可选字段 | 可作为 `contains` 的父 | 可作为 `contains` 的子 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `interface` | Interface | 界面（层的根 / 页面） | 层根，与层 1:1 | `layer` | `position` | — | `layout_block`、`overlay` |
| `layout_block` | Layout Block | 布局块（区域/栏） | 结构中间层 | `name` | `position` | `interface` | `group`、`control` |
| `overlay` | Overlay | 浮层（容器） | 与布局块同级 | —（显示名派生） | `name`、`position`、`visible`、`height`、`size`、`anchor`、`offset_x`、`offset_y`、`shadow`、`radius`、`hide_label` | `interface` | `group`、`control` |
| `group` | Group | 标签组 | 面板容器 | `mode` | `default_visible`、`hide_direction`、`position`、`name` | `layout_block`、`overlay` | `control` |
| `control` | Panel | **面板** | 面板实例 | `panel_id` | `title_key`、`name` | `layout_block`、`group`、`overlay` | `class`、`mark` |
| `class` | Category | **类目** | 面板内条目分类（按媒体类型） | `control`、`media_type` | `name` | `control` | `subclass`、`object` |
| `subclass` | Subclass | **子类** | 类目之下的细分（如文本 → epub/txt/md） | `subclass`、`format` | `name` | `class`（**必须**） | `object` |
| `mark` | Mark | **标记** | 与类目树**平行**的标记（book / manga …） | `control`、`mark` | `name` | `control`（**必须**） | `object` |
| `object` | Object | 对象 | 条目实例（挂在**三条轴之一**下） | `scope` | `class` / `subclass` / `mark_ref`（三选一）、`name` | `class`、`subclass`、`mark` | — |
| `event` | Event | 操作（事件） | 规则起点 | `trigger` | `target`、`name` | 无结构边 | — |
| `condition` | Condition | 条件 | 规则中间 | `expr` | `name` | 无结构边 | — |
| `action` | Action | 状态（动作） | 规则终点 | `op`、`target` | `payload`、`name` | 无结构边 | — |

要点：

- `overlay` 与 `layout_block` **同级**（界面直接子级），且是**容器**（D50 修订）；界面**不得**直接 contains 标签组/面板/类目/对象。
- `layout_block` 不能嵌套 `layout_block`（布局块嵌套列为 RFC 0007 开放点）；`overlay` 不能 contains `layout_block` / `overlay` / `class` / `subclass` / `mark` / `object`。
- 规则三节点（`event`/`condition`/`action`）**不参与结构 `contains`**，只通过 `on` / `fires` / `guards` 连线。
- `interface` 的显示名取自**层名**（D51）；节点上**不存** `name`。
- `control`（面板）的 `panel_id` 引用**面板注册表**（`docs/spec/panel-standard.md`）；该面板的 `has_class` 决定其下**能否**挂 `class`（类目）与 `mark`（标记）节点——两者都直接挂在面板下，受**同一个**开关约束。

#### 2.0.1 三轴模型：类目 / 子类 / 标记（2026-10-10 / D102）

用户口径（原话）：

> "**text 为类目，md、txt、epub 为子类，book 为标记，标记可以交叉**，例子：漫画.zip 文件的
> 类目为压缩包，可以标记为 manga（漫画），当漫画标记的文件被打开时，会按照漫画标记的蓝图
> 设定打开，如漫画阅读器面板。"

因此条目由**三条正交的轴**定位，各有自己的节点类型：

| 轴 | 节点类型 | 取值来源 | 例子 |
| --- | --- | --- | --- |
| **类目** | `class` | `media_type`：`image` / `video` / `audio` / `text`（扫描判定） | 「文本」类目 |
| **子类** | `subclass` | `format`：**按类目分域**（`text` → `epub` / `txt` / `md`） | 「txt」子类 |
| **标记** | `mark` | `mark`：**可注册清单**（内置 `book` / `manga`） | 「漫画」标记 |

三者的结构位置不同，这是本模型的关键：

```
面板 ⊃ 类目 ⊃ 子类 ⊃ 对象        （类目—子类是**层级**关系）
面板 ⊃ 标记 ⊃ 对象               （标记与类目树**平行**）
```

- **子类挂在类目之下**（`class ⊃ subclass`）：它是该类目的细分，因此 `format` 的取值域
  **由所属类目的 `media_type` 决定**（`text` → `epub`/`txt`/`md`；其余媒体类型当前**没有**
  子类取值域，即该类目下不能建子类）。挂在 `image` 类目下的子类 = **硬错误**。
- **标记挂在面板之下**（与类目树平行）：它**不属于任何类目**，因此**与类目正交**。
- **`object` 的结构父是三者之一**（`class` / `subclass` / `mark_ref`，**互斥**）：
  一个对象要么描述"某类目里的条目"、要么"某子类里的条目"、要么"带某标记的条目"。

**「补充节点」的层级位置（2026-10-10 用户口径；同日更正）**：

> "子类必须挂载在类目下，因为子类是类目的细分"；"标记和类目平行，功能相似"；
> "在蓝图功能链路中子类不是必要节点，是补充节点"。
>
> **同日更正（关键）**："**子类节点可以随意创建，所有节点都可以随意创建，只规定连接方式
> 和层级**"。

- **子类与标记是补充节点**：功能链路（对象 → 操作 → 状态）**不要求**它们存在；
  一条链可以完全没有子类/标记节点。它们的价值是**把一种情况单独拎出来**。
- **所有节点都可随意创建**：编辑器**只规定连接方式与层级**，不限制"能不能建"。
  任何类型在**任何时机**都能落下来（**空图上 12 种类型全部可创建**，由
  `pnpm check:blueprint-nodes` 断言），**没有置灰、没有拒绝**。
- **层级约束体现在"连接方式"上，不是"创建许可"**：
  - **结构位置**：子类 → `class`（类目），标记 → `control`（面板）——由定义表的
    `parents` / `children` 声明，画布连线（`containmentAllows`）与后端
    （`can_contain`）据此判**非法边**；
  - **新增时的自动挂载**（`blueprintNodeFactory` 的 `requiresMountParent` /
    `resolveMountParent`）：有可用父级就**顺手挂上**（显式选中优先，其次同层兜底复用
    **既有**父节点，**不新建节点**）；**没有就留空引用**——节点在画布上灰显
    「未接通」，由使用者拖线或在属性面板补上（与 `class` / `object` 同一口径）。
- **创建与连线是两件事**：早前版本曾把子类/标记在"层内无可用父级"时**拒绝新增**
  （连创建都拦住），那是把**层级约束误当成创建许可**——它会打断"先摆节点、后连线"
  这种正常搭图顺序。现已更正为**创建一律放行、缺父留空**（见 D105）。
- **父子约束是硬性的**：`subclass` 的 `parents` 只有 `["class"]`、`mark` 只有 `["control"]`，
  因此画布上**不可能**把子类连到面板下、或把标记连到类目下（`containmentAllows` 直接拒绝）。

**子类优先：类目链路自动排除已被子类定义的情况（2026-10-10 用户口径）**：

> "类目可以 类目1-对象-操作-状态 和 类目1-子类1-操作-状态 一起，因为子类是子集，只负责
> 一种情况，当有子类蓝图链路时，类目中无子类的链路就自动排除子类的情况，因为子类被定义了情况。"

因此 `class` 节点的运行期匹配判据是**该类目减去已被子类认领的细分**：

| 上报的 `format` | 该类目下有对应子类？ | 命中 |
| --- | --- | --- |
| `txt` | 有（`format = txt` 的子类挂在该类目下） | **只**走子类链路；类目链路被排除 |
| `epub` | 没有 | 走类目链路（子类没定义这种情况，仍归类目） |
| 未上报（非文本类） | — | 走类目链路 |

实现：引擎 `subclassClaimsFormat`（`blueprintEngine.ts`）；判据是**结构从属**
（子类的 `subclass` 字段或 `class --contains--> subclass` 边指向该类目）。
两侧（TS 引擎 / 文档）口径一致，由 `pnpm check:blueprint-engine` 断言。

**"标记可以交叉"的落点**：标记是**可多值**的集合（`file_marks` 表），一个文件可以**同时**
带多个标记；且标记节点匹配时**只看标记、不看 `media_type`**——因此

- 一个被标为 `manga` 的 `txt` **同时**命中「txt 子类」与「漫画标记」；
- 一个被标为 `manga` 的 `zip`（类目=压缩包，**未来扩展**）与那本 `txt` 命中**同一个**
  「漫画标记」规则 → 按漫画标记的蓝图设定打开（如漫画阅读器面板）。

这正是用户例子里"类目为压缩包、标记为 manga"能驱动同一套行为的原因：**标记是跨类目的**。

**`book` 与 `epub` 的关系**（最容易读错的一处）：`epub` 是**子类**（由扩展名判定，
用户不可改），`book` 是**标记**（用户可改，`epub` 默认带它）。两者**不是**同一维度的两个取值，
因此"一本 epub 不带 book 标记"是合法状态（用户取消了标记）。

**未接通的分级**：

- 子类缺 `format`（或 `format` 不在其类目分域内）→ 该类目分域内不存在时是**硬错误**；
  缺 `format` 本身是**软告警**（允许保存，补上即恢复）。
- 标记的 `mark` 取值**不在当前可注册清单**内 → **软告警**（与"插件缺失的节点类型"同口径：
  清单可注册，未注册不等于非法，**允许保存**，注册后自动生效）。

### 2.1 字段定义（逐一）

| 字段 | 所属类型 | 类型 | 取值域 / 约束 | 缺省 |
| --- | --- | --- | --- | --- |
| `key` | 全部 | string | 非空、蓝图内唯一 | —（必需） |
| `type` | 全部 | string | 已注册的节点类型（第 2.3 节） | —（必需） |
| `layer` | 全部 | string | 必须存在；单层文档可缺省 | 单层兜底层 key |
| `name` | 除 `interface` 外 | string | 非空（给了就必须非空） | 前端本地化生成 |
| `position` | 全部 | `{x, y}` | 数值；组节点还表示目标锚点 | 画布自动落位 |
| `panel_id` | `control` | string | 面板注册表内 id（后端不校验注册表，见第 6 节） | — |
| `title_key` | `control` | string | i18n 键（D27） | 取面板注册表标题 |
| `control` | `class` / `mark` | key 引用 | 必须指向 `control`（类目与标记都直接挂在面板下） | — |
| `media_type` | `class` | enum | `image` / `video` / `audio` / `text` | —（必需） |
| `format` | `subclass` | enum | **按所属类目的 `media_type` 分域**（`text` → `epub` / `txt` / `md`） | —（缺失按未接通软告警） |
| `mark` | `mark` | enum | **可注册标记清单** id（内置 `book` / `manga`）；未注册按未接通软告警 | —（必需） |
| `class` | `object` | key 引用 | 必须指向 `class`（三条轴之一，与下面两个**互斥**） | — |
| `subclass` | `subclass` / `object` | key 引用 | 在 `subclass` 节点上指**所属类目**；在 `object` 节点上指**所属子类**（同名不同义） | — |
| `mark_ref` | `object` | key 引用 | 必须指向 `mark`（三条轴之一；**不是**标记 id） | — |
| `class` | `object` | key 引用 | 必须指向 `class` | — |
| `scope` | `object` | string | `selected` / `clicked` / `double_clicked` / 具体 `file_id` | —（必需） |
| `mode` | `group` | enum | `exclusive` / `independent` | —（必需） |
| `default_visible` | `group` | key[] | 成员 key；互斥组**至多一个** | `[]` |
| `hide_direction` | `group` | string | `left` / `right` / `up` / `down` / `toward:<groupKey>`（必须指向同层 `group`） | `left`（前端） |
| `trigger` | `event` | enum | `click` / `double_click` / `selection_change` | —（必需） |
| `target` | `event` | key 引用 | 必须指向 `class` 或 `object`（兼容旧图；正常来源是 `on` 入边） | — |
| `expr` | `condition` | string | 固定最小集，见第 5 节 | —（必需） |
| `op` | `action` | enum | `show` / `hide` / `toggle` / `collapse` / `expand` / `navigate` | —（必需） |
| `target` | `action` | key 引用 | 按 `op` 决定，见 2.2 | —（必需） |
| `payload` | `action` | object | 已知键：`play`(bool)、`floating`(bool)；未知键忽略 | `{}` |
| `visible` | `overlay` | bool | 初始显隐 | `false` |
| `height` | `overlay` | int | 1–10（**叠放高度**，值大者在上，D57） | `1` |
| `size` | `overlay` | `{width, height}` | 正数、≤ 10000；小于最小 `240×160` 夹紧并软告警 | `240×160` |
| `anchor` | `overlay` | enum | 九宫格 `top_left`…`bottom_right` | `center` |
| `offset_x` / `offset_y` | `overlay` | number | `|v| ≤ 1` = 界面宽/高比例；`|v| > 1` = 像素；可为负 | `0` |
| `shadow` / `radius` | `overlay` | enum | `none` / `sm` / `md` / `lg`（宿主 token，D44） | `md` / `md` |
| `hide_label` | `overlay` | bool | 隐藏浮层自带标签/标题 | `false` |

### 2.2 `action.op` 与 `target` 的配对（硬约束）

| `op` | 允许的 `target` 类型 | 语义 |
| --- | --- | --- |
| `show` | `control` / `overlay` | 面板存在则激活、不存在则按 `panel_id` 创建；目标为浮层 = 把内容面板以浮动方式显示 |
| `hide` | `control` / `overlay` | `control` = 收起至 `PANEL_MIN_SIZE`（**不销毁**）；`overlay` = 关闭其内容面板 |
| `toggle` | `control` / `group` / `overlay` | 面板：存在则关闭/不存在则显示；组：收起/展开取反；浮层：期望可见态取反 |
| `collapse` | `group` | 组最小化至 6px（标签条保留，D25/D29） |
| `expand` | `group` | 恢复收起前记录的尺寸 |
| `navigate` | `interface` | 界面跳转（跨层，D48）；`target` **只能**由属性面板指定，画布连线不产生 |

`collapse` / `expand` / `navigate` 指向 `overlay`，或 `navigate` 指向非 `interface`，均为**硬错误**。

### 2.3 节点类型注册表：声明参数列表（RFC 0010 决策 5）

节点类型定义表升级为**注册表**。内置 **12** 种与插件注册项**同形**，只有 `origin` 不同。

| 声明参数 | 类型 | 取值域 / 约束 | 必需 | 来源 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `type` | string | 命名空间见第 2.4 节 | ✅ | 两者 | 节点稳定类型标识；文档里的 `type` 字段 |
| `label` | string | 显示名由 i18n 键提供（D27）；**manifest 贡献点里的字段名是 `label_key`**（见 `docs/spec/plugin-standard.md` 第 4 节），注册表项内称 `label` | ✅ | 两者 | 画布/属性面板显示名 |
| `role` | enum | `root` / `container` / `structural` / `logic` | ✅ | 两者 | 结构角色（沿用现有取值域） |
| `nameFromLayer` | bool | 缺省 `false` | — | 两者 | 显示名是否取自层名（仅 `interface`） |
| `providesName` | bool | 缺省 `true` | — | 两者 | 是否可带自定义 `name` |
| `fields` | object[] | `{ name, type, required?, softWhenMissing?, values?, note? }` | ✅ | 两者 | 专属字段（现有定义表字段规格） |
| `parents` | type[] | 可作为 `contains` 父的类型 | ✅ | 两者 | 空数组 = 不参与结构边 |
| `children` | type[] | 可作为 `contains` 子的类型 | ✅ | 两者 | 空数组 = 不参与结构边 |
| `events` | enum[] | `click` / `double_click` / `selection_change` | ✅ | 两者 | 可声明的事件（仅事件节点非空） |
| `ports` | object[] | `{ id, side, edge }` | — | 两者 | **端口与允许的边类型**；未声明即按 `role` + `parents`/`children` **推导**（保持内置 10 种行为不变） |
| `severity` | object | `{ fieldIssue, missingRef }` ∈ `hard` / `soft` | — | 两者 | **校验策略**：该类型的字段问题与引用缺失按硬错误还是软告警（缺省沿用第 6 节既有口径） |
| `evaluation_role` | enum | `structural` / `trigger` / `condition` / `action` | — | 两者 | **引擎语义**：是否进结构树、是否为规则节点、是否可做动作目标（缺省由 `role` 推导） |
| `origin` | object | `{ kind: "system" \| "plugin", plugin_id? }`；**宿主填充，插件不得自称** | ✅（宿主） | 宿主 | 来源与启用状态；用于灰显、审计与「全部设置」展示 |

规则：

- **声明是纯数据**：不含代码、自定义渲染、任意 CSS/像素、任意表达式（RFC 0010 决策 6）。
- **推导与显式声明并存**：`ports` / `severity` / `evaluation_role` 未声明时按现有规则推导——**内置节点类型的行为必须完全不变**（零回归；D102 新增的 `subclass` / `mark` 只是追加两个类型，既有的 10 种逐项不变）。
- **插件注册项的受控校验规则**：只能从宿主提供的**固定最小集**里选（同 `condition.expr` 的口径，D32）；不接受自定义表达式或自定义执行逻辑。
- `parents` / `children` / `ports` 的取值必须是**已注册**的节点类型或既有边类型；未命中即硬错误。
- **可承载面板的节点类型**必须在 `fields` 里允许 `panel_id`，并与面板注册表的 `blueprint_node` 互相对应（`docs/spec/panel-standard.md` 第 5.2 节）；两侧不一致即门禁失败。

### 2.4 命名空间（内置 vs 插件）

| 来源 | `type` 形式 | 示例 |
| --- | --- | --- |
| 宿主内置 | **裸 type** | `interface` / `control` / `class` / `overlay` |
| 插件注册 | **`plugin.<plugin_id>.<local_id>`** | `plugin.dev.hamsterpouch.music.waveform` |

- `plugin_id` 即 manifest 的 `id`（`^[a-z0-9][a-z0-9._-]{2,63}$`），与插件命令命名空间 `plugin.{pluginId}.{action}` 同源。
- 因此插件**不能**覆盖宿主内置类型，也不需要运行时"加前缀消歧"的猜测（RFC 0010「命名空间」）。
- 插件注册的节点类型**能否参与结构边**（作为 `contains` 父/子）列为开放点（第 12 节）；未开放前只能落在规则类位置。

## 3. 端口与连线规则（画布 / 校验共用）

端口按节点类型分为：

| 端口 | 节点类型 | 方向 | 可连目标 |
| --- | --- | --- | --- |
| `out.struct` | `interface` | 输出 | `layout_block` / `overlay` 的 `in.struct` |
| `out.struct` | `layout_block` / `overlay` | 输出 | `group` / `control` 的 `in.struct` |
| `out.struct` | `group` | 输出 | `control` 的 `in.struct` |
| `out.struct` | `control` | 输出 | `class` 的 `in.struct` |
| `out.struct` | `class` | 输出 | `object` 的 `in.struct` |
| `in.struct` | `layout_block` / `overlay` / `group` / `control` / `class` / `object` | 输入 | 见上（**只能一个**结构父） |
| `out.rule` | `control` / `class` / `object` | 输出 | `event` 的 `in.rule`（边类型 `on`） |
| `out.rule` | `event` | 输出 | `condition` / `action` 的 `in.rule`（边类型 `fires`） |
| `out.rule` | `condition` | 输出 | `action` 的 `in.rule`（边类型 `guards`） |
| `in.rule` | `event` / `condition` / `action` | 输入 | 规则三节点可按语义多条入边（见下） |

**结构父唯一性（构造性约束，编辑器必须校验）**：`layout_block` / `overlay` / `group` / `control` / `class` / `object` **只能有一个结构父**（否则"我属于谁"有歧义）。后端校验以 `control` / `class` 的字段引用为准（硬错误），画布连线即写字段。

**规则入边数量**：

- `event`：必须恰好一条 `on` 入边，**或**自带 `target` 字段（旧图兼容）；两者都没有即**软告警**（未接通）。
- `condition`：至少一条 `fires` 入边，否则软告警。
- `action`：至少一条 `fires` 或 `guards` 入边，否则软告警。
- `event` / `condition` / `action` **不限制出边数量**（一条事件可触发多个动作；求值"全部匹配"）。

## 4. 边类型定义

| `kind` | 方向 | 允许的端点类型 | 含义 |
| --- | --- | --- | --- |
| `contains` | 父 → 子 | `interface`→`layout_block`/`overlay`；`layout_block`/`overlay`→`group`/`control`；`group`→`control`；`control`→`class`；`class`→`object` | 结构包含（第 2 节表） |
| `memberOf` | `control` → `group` | 面板归属标签组（**兼容旧图**；新图一律用 `group --contains--> control`，D59） | — |
| `on` | (`control`/`class`/`object`) → `event` | 规则三元组：在对象上发生操作 | — |
| `fires` | `event` → `condition`/`action` | 操作触发后续求值 | — |
| `guards` | `condition` → `action` | 条件为真才执行该动作 | — |

- `from` / `to` 必须都存在（悬空边 = 硬错误）、边不得重复、端点类型不匹配 = 硬错误。
- **跨层禁止**：`contains` / `memberOf` / `on` / `fires` / `guards` 的端点必须**同层**；跨层唯一合法形式是 `navigate` 动作的 `target` 引用目标层的 `interface` 节点（D51）。
- 边不携带 `layer` 字段（由端点推导）；`order` 用于 `fires`/`guards` 求值顺序（升序），缺省 `0`。
- `fires`/`guards` 子图必须**无环**（DAG），成环 = 硬错误。

## 5. 条件表达式（`condition.expr`，固定最小集）

```text
media_type == image | video | audio | text
selection != empty
rating >= 0..5
has_tag == <tag_name>
```

- 语法固定，**不支持**任意表达式、括号、与或非、变量、数据加工（D32 边界）。
- 运行期 `context` 由调用方在 `dispatch` 时提供（`rating` 与人工/自动 tag 名）；缺 `context` 时该条件求值为假（不报错）。
- 插件注册的节点类型若声明受控校验规则，只能从这个**固定最小集**里选（第 2.3 节）。

## 6. 校验分级（硬错误 / 软告警 / 编辑器职责）

**硬错误（`blueprint.validate` 拒绝保存）**：

1. 节点 `key` 为空或重复；**未知 `type`**——**仅当 `type` 本身不合命名规则**（第 2.4 节）时为硬错误；**命名合法但当前无对应注册项**（插件未安装/未启用/API 不兼容）按**未接通软告警**处理（RFC 0010 决策 6，见下方软告警第 0 条）。
2. 悬空边、重复边、端点类型与边类型不匹配；`fires`/`guards` 成环。
3. 取值域非法：`trigger` / `op` / `mode` / `media_type` / `expr` / `hide_direction` / `anchor` / `shadow` / `radius` 不在白名单。
4. 引用**存在但类型不符**：`class.control` 非 `control`、`object.class` 非 `class`、`action.target` 与 `op` 不配对、`default_visible` / `hide_direction` 指向错误类型。
4b. **`format` 用在非子类节点上**，或子类的 `format` **不在其所属类目的分域内**
    （如 `image` 类目下建子类、或 `text` 类目下写 `format = "png"`）——与"字段用在错误的
    类型上"同级（第 2.0.1 节）。
4c. **对象的三个结构父同时声明**（`class` / `subclass` / `mark_ref` 多于一个）：
    对象只能挂在**三条轴之一**下（与"结构父唯一性"同一条约束）。
5. 必备字段缺失：`class.media_type`、`object.scope`、`group.mode`、`condition.expr`、`action.op`、`control.panel_id`（缺 `panel_id` 见软告警例外）。
6. 互斥组 `default_visible` 多于一个成员。
7. 分层：层 `key` 唯一非空、层 `name` 非空且蓝图内唯一（D60）、至少一层；节点 `layer` 指向不存在的层（**`layers` 存在而节点缺 `layer` 也是硬错误**，不静默压成单层）；跨层结构/规则边。
8. `overlay`：`height` 不在 1–10；`size` 非正数或 > 10000；`collapse`/`expand`/`navigate` 指向浮层。
9. 版本闸门：`schema_version > 当前版本`（`>` 而非 `!=`；低于当前版本先迁移再校验）。
10. **同界面同对象同触发多状态冲突**（D66）：一次交互不可能同时落到两个互斥状态——
    - **互斥状态**：同一目标被同时赋予互斥操作。`show`/`hide`、`show`/`toggle`；
      标签组 `collapse`/`expand`；界面 `navigate` 到两个**不同**界面。
      重复同一操作（`show` 两次）**不算**冲突；`toggle` 与 `hide` 的组合**允许**。
    - **互斥组多成员同时显示**：同一次交互把同一互斥组（`mode = exclusive`）的两个不同成员
      面板都置为 `show`/`toggle`，违反"同一时间至多一个成员显示"。
    - 判定范围：**同层**（同界面）+ **同对象**（面板/类目/对象）+ **同触发**；沿
      `on` → `fires`/`guards` 收集可达动作（经条件的动作同样纳入）。不同触发之间不判冲突
      （用户可在不同交互下给同一目标相反状态）。
    - 实现：后端 `blueprint_validate::find_state_conflicts`（权威，保存时拒绝）、
      前端 `packages/config/src/blueprintConflicts.ts`（装载时提示 + 画布可用）；
      互斥操作清单在 `blueprintNodes.ts` 的 `MUTUALLY_EXCLUSIVE_OPS` / `VISIBLE_OPS`，
      两侧一致由 `pnpm check:blueprint-nodes` 断言。
11. **主界面标记重复**（D67）：`layers` 里多于一个层带 `is_home: true` → 硬错误（同层至多一个）。
12. **类目挂在无类目的面板下**（RFC 0010 / `docs/spec/panel-standard.md` 第 5.1 节）：**宿主内置**面板的 `has_class = false` 时出现 `control → class` 的 `contains` 边 → 硬错误（宿主声明是不变量）。**插件注册面板**的同类情形按**未接通软告警**处理（见下方软告警第 7 条），因为插件的 `has_class` 会随版本变化。
13. **浮层内容不合法**：面板声明 `mount.overlay_content = false` 却被浮层 `contains` → 硬错误。

**软告警（`warnings`，不阻塞保存，画布灰显「未接通」）**：

0. **节点类型当前无注册项**（插件未安装/未启用/宿主 API 不兼容）：该节点及其边**原样保留**、不参与求值与结构对账、画布灰显标注「未接通」，**允许保存**；插件恢复后**自动恢复**，无需用户重建（RFC 0010 决策 6）。这是"未知 `type`"的第二种情形，与硬错误第 1 条区分。
1. 必填引用缺失或指向已删除节点：`control.panel_id`、`class.control`、`object.class`、`action.target`。
2. 求值链缺触发来源：`event` 无 `on` 入边且无 `target`；`condition` 无 `fires` 入边；`action` 无 `fires`/`guards` 入边。
3. 无根层（`interface` 被软删除，D55）；`navigate` 跳转失效（D55）。
4. `overlay` 未连接到界面（缺 `界面 --contains--> 浮层`，D50 修订）。
5. `overlay.size` 被夹紧到最小值。
6. 面板 `mount.multiple_per_interface = false` 但同一界面出现多个实例（`docs/spec/panel-standard.md` 第 5.4 节）。
7. **插件注册面板**的 `has_class = false` 但文档里已有类目节点（插件升级改了声明）：灰显「未接通」、**允许保存**，与插件缺失同口径（第 12 条硬错误只适用于**宿主内置**面板）。
8. **子类缺 `format`**（说不出收哪些文件、运行时不命中任何条目）与**标记不在可注册清单内**
   （清单可注册，未注册不等于非法）：都按未接通软告警处理 → 灰显「未接通」、**允许保存**，
   补上细分 / 注册清单后自动恢复（第 2.0.1 节）。

**编辑器职责（后端不校验，避免耦合面板注册表）**：`panel_id` 是否在面板注册表内、`hide_direction: toward:<groupKey>` 引用的组是否存在、结构父唯一性、候选引用按**同层**过滤（`navigate` 例外）、**补充节点（子类/标记）新增时自动解析挂载父**（§2.0.1：解析不到就**留空引用**，不拒绝创建）。

## 7. 命名与生成规范

- **节点 `key`**：全蓝图唯一；由编辑器**自动生成**，用户不手填：优先「上级 key + 自身类型标识」（`c_media` 下的图像类目 → `c_media_image`；其下双击对象 → `c_media_image_dbl`），冲突才追加序号。
- **新增节点只追加自身**：编辑器的"新增"只为**被点选的那一个类型**创建节点；缺上级/缺引用时**留空**（画布灰显「未接通」，按第 6 节软告警处理），**不得**为了"补合法链路"新建面板/类目/对象/操作/状态，也**不得**自动接到既有规则上。只有层级关系（`class → control`、`object → class`）允许在**同层内**兜底复用**既有**父节点，且复用只写引用字段、不新建节点。状态的 `action.target` 只由属性面板指定。
- **所有节点都可随意创建（2026-10-10 用户口径）**："子类节点可以随意创建，所有节点都可以随意创建，只规定连接方式和层级"。因此"新增"**永不拒绝**任何类型——包括子类与标记在层内没有可用父级时（那时**引用留空**、画布灰显「未接通」）。**层级约束管的是连线与引用的合法性**（`containmentAllows` 判非法边、后端 `can_contain` 拒绝非法边），**不是创建许可**；把两者混在一起会打断"先摆节点、后连线"的正常搭图顺序。
- **层 `key`**：`l_` 前缀 + 语义名（如 `l_browse`），蓝图内唯一且非空；**层名**（`name`，显示名）蓝图内唯一（D60）。
- **主界面（`is_home`，D67）**：层的可选布尔标记，标记"进入该仓库时默认显示的界面"；**同一蓝图至多一个**（多个为硬错误），**无标记时回退第一个层**。编辑器层工具条提供「设为主界面」按钮，下拉中主界面带 ★。解析优先级：`blueprint.currentLayer`（上次所在层，仍存在时优先）→ `is_home` 层 → 第一个层。
- **蓝图名**（`blueprints.name`）与层名互相独立（D60）。
- **`panel_id`** 用**面板注册表** id（内置：`media` / `viewer` / `player` / `metadata` / `color` / `tags` / `repo` / `sources` / `albums` / `tagtable` / `tasks` / `plugins` / `blueprint`；插件面板：`plugin.<plugin_id>.<local_id>`，见 `docs/spec/panel-standard.md` 第 6 节），不使用 key 形式。
- **`type`** 用节点类型注册表 id（内置裸 type；插件 `plugin.<plugin_id>.<local_id>`，第 2.4 节）。
- **i18n**：`title_key` 必须走键（D27），前端显示名走 `blueprintLabels.ts`，不得内联文案；插件注册的节点类型由插件在自己的语言资源里提供显示名。
- **默认蓝图**：唯一权威是 `packages/config/src/blueprintDefault.ts` 的 `DEFAULT_BLUEPRINT`；Rust 夹具由 `pnpm generate:blueprint-fixture` 生成，两侧不手工维护。

## 10. 验证

- **`pnpm check:blueprint-nodes`**（**72 项**）：结构层级/边类型一致性（`CONTAINMENT` ↔ `kindForEdge` ↔ `PORT_DEFS`，均由定义表派生）、**父子声明的双向对称性**（`children` 与 `parents` 逐项互指——只声明一侧会让该边静默连不出来，见第 2 节的实测缺口注记）、节点工厂**只追加自身**（不连带补链、不跨链路挂钩）、**所有节点都可随意创建**（**空图上 12 种类型全部可创建**；子类/标记缺父时照常创建且引用留空；**随意创建 ≠ 随意连线**，层级约束仍在）、上级推导、层归属、浮层容器与外观/定位/尺寸、层增删改名、结构骨架、**「一键整理」几何**（起始节点位置不变、同层间距 ≥ 卡片高 + 余量、全图不重叠且避让孤立节点）、状态冲突的 TS↔Rust 同结论，并用 hp-core 真实校验器复核全部夹具。
- **`pnpm check:blueprint-minimap`**（**11 项**）：画布右下角小地图的纯几何——内容包围盒、等比缩放与留边、只缩小不放大、世界↔小地图往返、视口指示框随缩放变小且平移到图外仍留在框内、视口矩形与 `viewportCenterToWorld` 同源、空图不崩。
- **RFC 0010 新增断言**：
  - 注册表声明参数完整性（第 2.3 节的必需项齐全；`ports` / `severity` / `evaluation_role` 缺省时推导结果与既有内置类型的现有行为**逐项相同**）。
  - 命名空间规则：插件注册项必须 `plugin.<plugin_id>.<local_id>`；不得与内置裸 type 冲突。
  - **未知 `type` 分流**：不合命名规则 → 硬错误；命名合法但无注册项 → **软告警且可保存**，且该节点与其边原样保留。
  - `control.panel_id` ↔ 面板注册表 `blueprint_node` 双向一致（`docs/spec/panel-standard.md` 第 5.2 节）。
  - `has_class = false` 的面板下 `control → class` 被拒（硬错误）。
- **端口推导一致性（两条门禁，防"连线被静默丢弃"）**：
  - `portIdFor 只返回 PORT_DEFS 声明过的端口`：遍历全部已注册类型 × 2 侧 × 5 边类型。画布渲染连线时按 `portMap.get(`${key}::${side}::${portIdFor(type, side, kind)}`)` 找端口坐标，而 DOM 标记用 `PORT_DEFS` 里的 id —— 返回一个未声明的 id 会让查表落空、连线被 `return null` 丢掉。**真实回归**：输入侧曾被边类型名覆盖（`action.in.fires` 返回 `"fires"`，而操作节点的输入口实际是 `"in"`），导致「操作 → 状态」在画布上永远没有线；同一处错误还让"拖线到操作输入口"永远判不等（`in !== contains`），即用户反馈的"操作节点接不到触发节点"。
  - `每种规则边两端都能在画布上连出来（on/fires/guards/memberOf）`：遍历允许的端点组合。
- 其余蓝图自检：`check:blueprint-engine`（**43 项**：求值/浮层/navigate/hide_direction/**子类优先**）、`check:blueprint-delete`（软删除）、`check:blueprint-runtime`（装载/升级/回退/补种）、`check:blueprint-geometry`、`check:blueprint-slots`。
- **解析层新增拦截**：字段用在**不支持它的节点类型**上即拒绝（由定义表驱动），与后端"引用存在但类型不符"的硬错误口径一致。
- `cargo test --workspace`：存储往返、仓库隔离、默认蓝图、模板、validate 拒绝（悬空边/环/未知类型/key 重复/互斥组多默认可见/非法 `hide_direction`/状态冲突/主界面标记重复/类目挂无类目面板）。

## 11. 与面板标准、控件标准的关系

三个词各有归属，**不得混用**（RFC 0010 决策 1）：

- **面板（Panel）**：蓝图节点 `control`，dockview 面板实例（`docs/spec/panel-standard.md`）。**可注册**（宿主内置 13 个 + 插件）。
- **控件（Control）**：面板**内部**的标准 UI 单元，26 种 `kind`，挂在面板**渲染树**里（`docs/spec/control-standard.md`）。**不可注册**（D62）。
- **类目（Category）**：蓝图节点 `class`，面板内条目分类（本文第 2 节）。挂在面板**结构树**里，受面板 `has_class` 约束。

两张表的关系：**面板注册表**声明 `blueprint_node`（该面板由哪种节点承载），**节点类型注册表**声明是否允许 `panel_id` 字段——两侧必须互相对应，由门禁断言。

浮层（`overlay`）是蓝图节点，承载**容器**的定位/尺寸/外观档位；浮层**内容**是面板/标签组，其内部 UI 仍归控件标准。

## 12. 开放点（实现期，与 RFC 0007 / RFC 0010 一致）

- 布局块嵌套（`contains` 是否支持 `layout_block → layout_block`）。
- 组位置 `position {x, y}` 的运行时语义（网格坐标 / 浮动窗口坐标 / 仅画布定位）。
- 页面栈与返回语义、入口层选择、跨层是否共享面板实例。
- 对账与事件驱动的边界（当前 `collapse`/`expand` 会被静态套用一次）。
- 条件表达式是否扩展（`album_member_of` / `source` 命中 / `tag_any_of`）。
- **插件注册的节点类型能否参与结构边**（作为 `contains` 的父/子），还是仅允许规则类位置（`event`/`condition`/`action`）。
- **`ports` 显式声明与推导冲突时**：报硬错误，还是以显式声明为准。
- **插件注册节点类型的画布外观**（图标/配色档位）：宿主按 `role` 统一给，还是允许声明 token 档位。
- **插件注册项的全局与单插件上限**（防注册表爆炸）。
