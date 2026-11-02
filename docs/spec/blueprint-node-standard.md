# 蓝图节点标准（节点类型定义表 + 注册表声明参数 + 端口/边规则）

状态：正式草案。本文是 RFC 0007「决策 1 节点分层与节点类型」的**标准化展开**，并经 **RFC 0010 决策 5/6 扩展**：把 **12 种**内置节点类型的字段、取值域、引用目标、端口与边规则收敛为**一份定义表**，并把该定义表升级为**注册表**（宿主内置 + **插件可注册**），供后端校验、前端解析层、画布端口表与属性面板**共用同一口径**。

**2026-09 术语修订（RFC 0010 决策 1，仅显示用语，JSON 不变）**：

| 原显示名 | 新显示名 | 枚举值 |
| --- | --- | --- |
| 面板控件（Panel Control） | **面板**（Panel） | `control`（不变） |
| 类（Class） | **类目**（Category） | `class`（不变） |

本文**不改变既有 JSON 字段名与枚举取值**（向后兼容）：内容全部来自 RFC 0007 / D28–D70、RFC 0010 与现有实现（`crates/hp-core/src/blueprint_*.rs`、`packages/config/src/blueprint*.ts`、`apps/desktop/src/app_ui/panels/blueprintPorts.ts`）。若本文与 RFC 0007 / RFC 0010 正文冲突，以 RFC 与 `docs/architecture/decision-checklist.md` 为准，并须修正本文。

## 0. 2026-11-02 结构修订：标记改挂到对象之下（文档 schema v2 → v3 / D137）

**标记（`mark`）不再挂在类目之下与子类并列，而是挂在对象（`object`）之下**——标记是**对单个对象**的细分。结构由 D136 的 `面板 ⊃ 类目 ⊃ {子类, 标记} ⊃ 对象` 改为：

```text
面板 ⊃ 类目 ⊃ { 子类, 对象 }
                     └ 对象 ⊃ 标记
```

逐项改动：

| 项 | D136（v2） | v3（D137） |
| --- | --- | --- |
| `mark.parents` | `["class"]` | **`["object"]`** |
| `mark.children` | `["object"]` | **`[]`** |
| `object.parents` | `["class", "subclass", "mark"]` | **`["class", "subclass"]`** |
| `object.children` | `[]` | **`["mark"]`** |
| `class.children` | `["subclass", "mark", "object"]` | **`["subclass", "object"]`** |
| `subclass.children` | `["object"]` | `["object"]`（不变） |
| 标记的结构父引用字段 | `class`（"所属类目"） | **`object`（"所属对象"）** |
| `object.mark_ref` | 三轴之一 | **废弃**（仅兼容旧文档） |
| `event.target` 取值域 | `["class", "object"]` | **`["class", "object", "mark"]`** |
| 文档 `schema_version` | 2 | **3** |

- **`RULE_EDGE_SOURCES.on` 保持五源**（`["control", "class", "subclass", "mark", "object"]`）：对象与标记**都能**发起操作——接**对象** = 不筛标记，接**标记** = 只对该标记命中时生效（`apps/desktop/src/app_ui/panels/blueprintPorts.ts:107`）。
- **为什么改**：D136 下 `object.children = []`，因此 `can_contain(object, mark) = false`——**画布上根本画不出「对象 → 标记」这条线**，用户在相册蓝图里手工搭"类目 → 对象 → 标记"时链路直接卡死（用户裁决原话："标记要接在对象后面，标记是对单个对象的分类……相册中，相册是类目，里面创建的真实相册则是对象，是执行的对象，标记也是对真实的相册进行细分"）。
- **自动迁移**：带**语义保持**的 v2 → v3 迁移规则见 `docs/rfc/0007-blueprint.md` 的「v2 → v3」一节与 D137；规范形态 `K --contains--> M --contains--> O` → `K --contains--> O --contains--> M`。
- **双向互指不变**（D104/D105 的教训）：`object.children` 必须含 `mark`，`mark.parents` 必须是 `["object"]`，`class.children` **不得**含 `mark`；同侧 `children` ↔ `parents` 的双向对称由 `pnpm check:blueprint-nodes` 断言，Rust 侧另有 cargo 测试 `builtin_parent_children_declarations_are_symmetric` 独立钉住（脚本扫不到 Rust）。

### 0.1 本节的实现状态（2026-11-02 落地后实测）

本轮 v3 改动**已全层落地并跑通门禁**——本文第 2–4 节的 v3 规范口径与实现一致：

| 层 | 文件 | 实测现状 |
| --- | --- | --- |
| 前端节点定义表（单一事实来源） | `packages/config/src/blueprintNodes.ts` | **v3**：`class.children = ["subclass", "object"]`（`:262`）、`mark.parents = ["object"]` / `mark.children = []`（`:329`-`330`）、`object.children = ["mark"]`（`:353`）、`object.parents = ["class", "subclass"]`（`:352`）、`mark` 字段 `object`（`:314`）、`event.target` 含 `mark`（`:365`） |
| 版本常量 | `packages/config/src/blueprintValues.ts:20` | **3**（`BLUEPRINT_SCHEMA_VERSION = 3`；注释 `:29` 记 D137）；Rust 同源 `crates/hp-core/src/blueprint.rs:56` |
| Rust 内置节点表 | `crates/hp-core/src/blueprint_builtin_nodes.rs` | **v3**：`class.children = ["subclass", "object"]`（`:101`）、`mark.parents = ["object"]`（`:124`）/ `mark.children = []`（`:126`）、`object.parents = ["class", "subclass"]`（`:140`）/ `object.children = ["mark"]`（`:142`） |
| Rust 迁移 | `crates/hp-core/src/blueprint_migrate.rs` | **v2 → v3 已落地**：`migrate_graph`（`:86`）改**逐版本推进**（`:91`-`99` v1→v2 后置 2、`:101`-`104` 跑 `migrate_marks_under_objects` 后置 3，故 v1 文档一次走到 v3）；`migrate_marks_under_objects`（`:150`）四阶段：只读快照 → 计划 → 孤儿启发式 → 字段/结构边/规则边改写。早退条件 `:87` 只对**已是 v3** 的文档生效 |
| 编辑器落库 | `apps/desktop/src/app_ui/panels/blueprintConnect.ts` | **v3**：新增「对象 → 标记 ⇒ `patch.object`」（`:82`-`99`，并自愈清掉残留 `class`/`control`）；「类目 → 标记 ⇒ `patch.class`」「标记 → 对象 ⇒ `patch.mark_ref`」两条**已删除** |
| 编辑器灰显判据 | `apps/desktop/src/app_ui/shared/blueprintLint.ts` | **v3**：`mark` 判 `!node.object \|\| !byKey.has(node.object) \|\| Boolean(node.class?.trim())` → `missing-class`（`:166`-`179`）；`object` 只看 `[node.class, node.subclass]`（`:191`-`199`，`mark_ref` 刻意不判灰） |
| 运行时匹配 | `apps/desktop/src/app_ui/core/blueprintEngine.ts` | **v3 两段式**：mark 分支先查 `target.marks` 含 `node.mark`，再递归 `node.object` 的父对象判定（`:299`-`319`）；object 的 `parentKey` 为 `node.class ?? node.subclass`（`:337`，已去掉 `mark_ref`） |
| 上报方 | `panels/mediaPreviewSelection.ts` / `panels/AlbumPanel.tsx` / `panels/SourcePanel.tsx` / `panels/bookpreview/bookPreviewView.ts` | 媒体预览三处（`:101`/`:154`/`:166` 一带）与图书预览均带 `marks`；**相册点击上报 `mediaType:"album"` + `effectiveMarksFor(…,"albums",…)`（用户标记 ∪ 派生标记）**；**源面板行点击首次上报 `mediaType:"source"` + `marksOf(…,"sources",node.key)`**（2026-11-02 / **D138**，详见 §2.0.1「标记的上报方」） |

**门禁实测（2026-11-02 17:2x，`$env:PATH` 前置 corepack 钉版 shim 后 `pnpm run <gate>`）全部 exit 0**：

| 门禁 | 结果 |
| --- | --- |
| `check:blueprint-nodes` | **114/114 通过** |
| `check:blueprint-connect` | **24/24 通过** |
| `check:blueprint-engine` | **62/62 通过** |
| `check:blueprint-runtime` | **3/3 通过** |
| `check:panels` | **368/368 通过**（含 D138 的 6 条相册/源面板上报断言） |

（原 §0.1 的 7 条 FAIL 表已全部清零，故本节不再保留该表；历史明细可从 git 忽略前的版本或本轮讨论记录回溯。）

⚠️ **`object` 丢 `on` 端口这条真实回归：已修，但判据仍是"间接判据 + 兜底"的组合——不要误读成"完全按显式清单实现"**：
`packages/config/src/blueprintNodes.ts` 的 `resolveNodePorts` 仍以 `isObjectLike = hasParents && children.length === 0`（`:516`）为主判据，v3 给 `object` 加了 `mark` 子级后该判据对它**已失效**，`out:on` 目前**只靠** `:524`-`525` 的 `|| children.includes("mark")` 这一支保住；Rust 镜像 `crates/hp-core/src/blueprint_node_decl_validate.rs:221` 同样保留 `is_object_like` 并追加 `child_names.contains(&"mark")`。这与本节第 38 行/第 443 行一带要求的"按 `RULE_EDGE_SOURCES.on` 显式清单判定"**不完全一致**。
为防"将来 `object` 再加子级时端口静默消失"，`tools/blueprint-node-check.mjs:1460`-`1497` 新增了**数据驱动端口护栏**（两条断言）：① `RULE_EDGE_SOURCES.on` 的五个源 `control/class/subclass/mark/object` **逐个**必须真有 `out:on` 口，且五源名单逐字钉住；② 反例——7 个非规则源**一律不得**有 `out:on`，并逐个点名 `group` / `layout_block` / `overlay` 必须落在非规则源里。判据升级为显式清单仍列为后续清理项（见第 12 节开放点）。

**结论**：本文第 2–4 节的 v3 口径由 TS 定义表与 Rust 内置表**两侧同口径**承载，迁移/编辑器/运行时/门禁均已落地并由门禁钉住；端到端（GUI 拖线→保存→点击命中）仍需按第 10 节的运行时验证口径人工复核。

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
| `control` | Panel | **面板** | 面板实例 | `panel_id` | `title_key`、`name` | `layout_block`、`group`、`overlay` | `class` |
| `class` | Category | **类目** | 面板内条目分类（按类型） | `control`、`media_type` | `name` | `control` | `subclass`、`object` |
| `subclass` | Subclass | **子类** | 类目之下的细分（如文本 → epub/txt/md） | `subclass`、`format` | `name` | `class`（**必须**） | `object` |
| `mark` | Mark | **标记** | **对象之下**的细分（标记是对**单个对象**的细分，v3 / D137；内置 **10 项**：media / image / video / audio / music / document / text / book / manga / program） | `object`、`mark` | `name` | `object`（**必须**） | — |
| `object` | Object | 对象 | 条目实例（挂在**两条轴之一**下） | `scope` | `class` / `subclass`（二选一）、`name` | `class`、`subclass` | `mark` |
| `event` | Event | 操作（事件） | 规则起点 | `trigger` | `target`、`name` | 无结构边 | — |
| `condition` | Condition | 条件 | 规则中间 | `expr` | `name` | 无结构边 | — |
| `action` | Action | 状态（动作） | 规则终点 | `op`、`target` | `payload`、`name` | 无结构边 | — |

要点：

- `overlay` 与 `layout_block` **同级**（界面直接子级），且是**容器**（D50 修订）；界面**不得**直接 contains 标签组/面板/类目/对象。
- `layout_block` 不能嵌套 `layout_block`（布局块嵌套列为 RFC 0007 开放点）；`overlay` 不能 contains `layout_block` / `overlay` / `class` / `subclass` / `mark` / `object`。
- 规则三节点（`event`/`condition`/`action`）**不参与结构 `contains`**，只通过 `on` / `fires` / `guards` 连线。
- `interface` 的显示名取自**层名**（D51）；节点上**不存** `name`。
- `control`（面板）的 `panel_id` 引用**面板注册表**（`docs/spec/panel-standard.md`）；该面板的 `has_class` 决定其下**能否**挂 `class`（类目）节点——Rust `find_panel_class_violations`（`crates/hp-core/src/blueprint_validate.rs`）**只拦 `control → class`** 这一条边，别的不管（2026-11-01 / D134 按实现修正）。
- **v3 起标记不再直挂面板**（D137，**撤销** D134/D136 的"标记直挂面板、不受 `has_class` 约束"口径）：标记的结构父是**对象**，而对象的结构父是**类目或子类**。于是 `has_class = false` 的面板下**既**建不了类目、**也**到不了标记——"面板开关只管类目"这件事现在表现为"整条 `面板 ⊃ 类目 ⊃ 对象 ⊃ 标记` 链从类目处断开"。**D135 起**相册 / 源面板的 `has_class` 已是 `true`（它们各自有条目分类层）。

#### 2.0.1 三轴模型：类目 / 子类 / 标记（2026-10-10 / D102；标记取值域 2026-11-01 / D134 扩为 10 项）

用户口径（原话）：

> "**text 为类目，md、txt、epub 为子类，book 为标记，标记可以交叉**，例子：漫画.zip 文件的
> 类目为压缩包，可以标记为 manga（漫画），当漫画标记的文件被打开时，会按照漫画标记的蓝图
> 设定打开，如漫画阅读器面板。"

**标记的取值域由 2 项扩为 10 项**（2026-11-01 / D134）：`media`（媒体）/ `image`（图像）/
`video`（视频）/ `audio`（音频）/ `music`（音乐）/ `document`（文档）/ `text`（文本）/
`book`（图书）/ `manga`（漫画）/ `program`（程序）。**顺序即清单顺序**，也是蓝图属性面板
下拉与面板右键标记树的顺序。树形（`媒体 ⊃ {图像, 视频, 音频 ⊃ {音乐}}`、
`文档 ⊃ {文本, 图书, 漫画}`、`程序`）**只用于 UI 呈现**——节点模型与存储都是**扁平**的 10 个
id，标记之间不建立父子引用（D102 已定"可多值、互不嵌套"）。原话里提到的"图片"**不单设 id**：
用户明确"图像就是图片"。

**标记的结构位置（v3 / D137）**：`mark` 的结构父是**对象**（`object ⊃ mark`），**不再是面板、也不再与子类并列**。D134/D136 的"标记直挂面板、不受 `has_class` 约束"口径**已撤销**——标记现在只能经 `类目/子类 → 对象 → 标记` 出现（见第 2 节要点）。

因此条目由**三条正交的轴**定位，各有自己的节点类型：

| 轴 | 节点类型 | 取值来源 | 例子 |
| --- | --- | --- | --- |
| **类目** | `class` | `media_type`：`image` / `video` / `audio` / `text` / `pdf` / `album` / `source`（**7 项**，随面板分域，见 §2.0.2） | 「文本」类目 |
| **子类** | `subclass` | `format`：**按类目分域**（`text` → `epub` / `txt` / `md`） | 「txt」子类 |
| **标记** | `mark` | `mark`：**可注册清单**（内置 **10 项**，见上） | 「漫画」标记 |

三者的结构位置不同，这是本模型的关键（**结构位置 2026-11-02 / D137 已改，见下**）：

```
面板 ⊃ 类目 ⊃ { 子类, 对象 }
                     └── 对象 ⊃ 标记
  （类目—子类、类目/子类—对象是**层级**；对象—标记是**对象之下的细分**）
```

- **子类挂在类目之下**（`class ⊃ subclass`）：它是该类目的细分，因此 `format` 的取值域
  **由所属类目的 `media_type` 决定**（`text` → `epub`/`txt`/`md`；其余类目类型（含 `album` /
  `source` / `unlimited` / `empty`）当前**没有**子类取值域，即该类目下不能建子类）。挂在 `image` 类目下的子类 = **硬错误**。
- **标记挂在对象之下**（`object ⊃ mark`，**v3 / D137**）：标记是**对单个对象**的细分，它的
  结构父引用字段是 **`object`**（"所属对象"）。旧文档里的 `mark.class`（D136 口径）与
  `mark.control`（更早口径）都按 **未接通软告警**处理，并由 v2 → v3 迁移清除。
- **`object` 的结构父是二者之一**（`class` / `subclass`，**互斥**）：
  一个对象要么描述"某类目里的条目"、要么"某子类里的条目"。D136 的三轴之一
  `object.mark_ref` **v3 起废弃**，残留值按未接通软告警处理。

> ⚠️ **「语义正交」与「结构从属」是两件事（本轮最容易读错的地方）**：
> D102 说"标记与类目**正交**、可交叉"，那句话讲的是**匹配维度**——标记只看
> `mark` 值、不看类目的 `media_type`，因此 `manga` 可以跨类目匹配（一个被标为 manga 的
> zip 与一本被标为 manga 的 epub 命中**同一条**漫画规则），这条语义**原样保留**。
> D136 把标记挂到**类目**之下（与子类并列）；**D137（v3）再改一次**：标记挂到**对象**之下。
> 换句话说：**匹配上仍可交叉，结构上则层层从属**。把这两句混读会得出"标记要写在类目
> 节点里"的错误结论（类目节点仍**禁止**带 `mark` 字段，那是 D102 硬错误）。
>
> ⚠️ **v3 新增的一条运行时约束（与 D102 的"只看标记"是不同层次，必须分清）**：标记**节点自身**的
> 匹配判据仍是"`mark` 值在 `target.marks` 里"；但由于结构改挂对象之下，**一条标记规则要成立
> 还须它所属的那个对象也命中**——`node.object` 指向的父对象按 `object` 分支的判据与 `scope`
> 求值，父对象不存在即不命中。也就是说：**筛选维度没变（只看 `mark`），生效范围被对象收窄了**，
> 这正是用户要的"标记是对**单个对象**的细分"。迁移时把 `on` 边从对象改挂标记之所以**语义保持**，
> 是因为旧口径下"对象命中"**已经蕴含**"标记命中"（见 RFC 0007 的「v2 → v3」一节）。


**「文件夹标记」语义（2026-11-01 / D134）**：标记的**对象不一定是文件**。既有的
`file_marks` 表与 `media → mark` 的路径来自"媒体预览 / 图书预览的两个面板对象是文件"这一
具体实现，但标记的语义本身更宽——**漫画标记可以标一个文件夹**，表示"这一整个文件夹是
一本漫画，其中的图像就是这本漫画的页"。因此：

- 面板把标记打在**相册**（`albumId`）与**源目录节点**（`src:<id>` / `dir:<sourceId>/<rel>`）上
  时，用的是**面板视图状态**（`app_settings` 的 `panelMarks.<repoId>`），**不写 `file_marks`**
  ——`file_marks` 只表达"**某个文件**带某个标记"，把相册 id 或目录 key 塞进它会让"哪些文件
  带 manga"这类既有查询读到根本不是文件的 id；
- 蓝图节点（`object ⊃ mark`）本身就是**声明式**的：它描述"命中这个标记时按这套设定打开"，
  与标记的载体是文件还是文件夹无关。

**标记的上报方（v3 / D137 之后补齐，D138）**：标记节点能不能命中，取决于**上报方有没有把标记集合送进引擎**——`dispatch` 的 `target.marks` 是唯一入口（`BlueprintTargetRef.marks`，引擎只看这个集合、不看 `mediaType`）。补齐后各家如实如下：

| 上报方 | 对象身份 | 上报的 `mediaType` | `marks` 来源 |
| --- | --- | --- | --- |
| 媒体预览（选中变化 / 单击 / 双击） | 文件 | `file.media_type` | `file.marks`（`file_marks`，零额外 IPC） |
| 图书预览（单击 / 双击） | 文件 | `item.media_type` + `format` | `item.marks`（`bookDispatchTarget`） |
| **相册面板（行点击）** | 真实相册 | **字面量 `"album"`**（相册行的真实 `media_type` 是 multimedia / image / 空，与类目取值域不同名） | `effectiveMarksFor(marks, "albums", 相册 id, derivedMarksForAlbum(有效媒体属性))` —— **用户标记 ∪ 派生标记** |
| **源面板（行点击）** | 源根 / 源内目录 | **字面量 `"source"`**（取值域 `sources: unlimited / source / empty`） | `marksOf(marks, "sources", 节点 key)`，节点 key 与 `src:<id>` / `dir:<sourceId>/<rel>` 及后端节点 key **三方同源** |
| 插件控件 | 控件 | 无 | 带 `panelId` 过滤，走控件级派发 |

两条配套口径：(a) **派生标记必须并入上报**——相册的派生标记（属性 → 同名标记，D134）在右键菜单里恒勾且不可取消，菜单说"带这个标记"而引擎收不到就是两套事实；(b) **标记是对象的可选限制条件**，因此上报缺标记只是"这条链不命中"（链上不接标记节点时行为完全不变），不会误命中，也不会改变对象所属的类目。相册与源的自定义标记**互不可见**（`albums` / `sources` 两个域各一份，D134 ⑨），两处都不写 `file_marks`。

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
  - **结构位置**：子类 → `class`（类目），标记 → `object`（对象，v3 / D137）——由定义表的
    `parents` / `children` 声明，画布连线（`containmentAllows`）与后端
    （`can_contain`）据此判**非法边**；
  - **新增时的自动挂载**（`blueprintNodeFactory` 的 `requiresMountParent` /
    `resolveMountParent`）：有可用父级就**顺手挂上**（显式选中优先，其次同层兜底复用
    **既有**父节点，**不新建节点**）；**没有就留空引用**——节点在画布上灰显
    「未接通」，由使用者拖线或在属性面板补上（与 `class` / `object` 同一口径）。
- **创建与连线是两件事**：早前版本曾把子类/标记在"层内无可用父级"时**拒绝新增**
  （连创建都拦住），那是把**层级约束误当成创建许可**——它会打断"先摆节点、后连线"
  这种正常搭图顺序。现已更正为**创建一律放行、缺父留空**（见 D106）。
- **父子约束是硬性的**：`subclass` 的 `parents` 只有 `["class"]`、`mark` 只有 `["object"]`，
  因此画布上**不可能**把子类连到面板下、或把标记连到类目/面板下（`containmentAllows` 直接拒绝）。
  这也是 D137 改结构的直接理由：D136 下 `mark.parents` 是 `["class"]` 且 `object.children` 是 `[]`，
  **「对象 → 标记」这条线在画布上根本画不出来**（`can_contain(object, mark) = false`）。

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

> **v3（D137）补充**：上面说的是**标记节点自身**的筛选维度（跨类目、只看 `mark`）。挂到对象之下后，
> 一条标记规则还须**它所属的那个对象**也命中（见上文 ⚠️ 的运行时约束）。因此"跨类目"仍成立，
> 但前提是两条链**各自把对象接对**——标记不再有"直挂面板、与对象无关"的形态。

**`book` 与 `epub` 的关系**（最容易读错的一处）：`epub` 是**子类**（由扩展名判定，
用户不可改），`book` 是**标记**（用户可改，`epub` 默认带它）。两者**不是**同一维度的两个取值，
因此"一本 epub 不带 book 标记"是合法状态（用户取消了标记）。

**未接通的分级**：

- 子类缺 `format`（或 `format` 不在其类目分域内）→ 该类目分域内不存在时是**硬错误**；
  缺 `format` 本身是**软告警**（允许保存，补上即恢复）。
- 标记的 `mark` 取值**不在当前可注册清单**内 → **软告警**（与"插件缺失的节点类型"同口径：
  清单可注册，未注册不等于非法，**允许保存**，注册后自动生效）。
- **标记缺 `object`（未接通）→ 软告警**（灰显，与"结构父缺失"同口径，见第 6 节软告警第 9 条）。
  **旧文档残留的 `mark.class` 与 `object.mark_ref` 也是软告警**（不是硬错误）——它们由 v2 → v3
  迁移清除；解析层与后端都按"旧字段存在 ⇒ 该节点按未接通灰显、但**允许保存**"处理，用户在
  画布上拖一条「对象 → 标记」的线即恢复彩色（下一条的既有口径）。

#### 2.0.2 类目「类型」取值域与按面板分域（2026-11-01 / D135，D136 扩为 9 项）

> **术语**：类目字段 `media_type` 的**显示名**由「媒体类型」改为「**类型**」（i18n 键 `blueprint.mediaType` 的**值**改了，**键名不变**）。JSON 字段名 `media_type` **一律不变**（向后兼容）。`album` / `source` / `unlimited` / `empty` 都不是"媒体"，所以旧叫法在 9 项取值域下已经不准确。

**取值域 9 项（全量，顺序即下拉顺序）**：
`unlimited`（无限制）/ `image`（图像）/ `video`（视频）/ `audio`（音频）/
`text`（文本）/ `pdf`（PDF）/ `album`（相册）/ `source`（源）/ `empty`（空）。权威两处：TS
`packages/config/src/blueprintValues.ts` 的 `BLUEPRINT_MEDIA_TYPES` 与 Rust
`crates/hp-core/src/blueprint_types.rs` 的 `CLASS_MEDIA_TYPES`（`[&str; 9]`），由
`pnpm check:blueprint-nodes` **逐项比对含顺序**。

- 中间 5 项来自扫描判定（D101 / D110）；
- `album` / `source`（D135）**不是文件媒体类型**——它们是「相册 / 源」这两类**面板条目**的分类；
- **`unlimited` / `empty`（D136）是两端的语义档位**，不是媒体类型：
  `unlimited`（**首项**）表示"该类目**匹配一切**媒体类型"（最粗一档）；
  `empty`（**末项**）表示"该类目**排除全部**媒体类型"（最窄一档）。
  `empty` 的用途是**暂时停用这条类目链**——不删节点、不破坏连线，只把命中集清空，
  比删节点更适合"先留着但先别生效"。**位置不是装饰**：首/末两项让下拉呈现
  "最粗 → 具体 → 最窄"的梯度；插在中间会让"越来越窄"的直觉失效。

**按面板分域（候选收窄）**：全量表回答"哪些取值合法"，**分域**回答"这个面板下该出现哪几个"。
唯一权威是 TS `classMediaTypesForPanel(panelId)` 与 Rust 镜像
`class_media_types_for_panel(panel_id) -> &'static [&'static str]`；两侧**逐面板逐项相等**
由 `pnpm check:blueprint-nodes` 断言。**每个分域都以 `unlimited` 开、`empty` 收**
（两端档位对任何面板都成立）。

| 面板 | 分域（顺序即候选顺序） | 理由 |
| --- | --- | --- |
| `media`（媒体预览） | `unlimited` / `image` / `video` / `audio` / `empty` | 它只收这三类，类目按这三类分 |
| `bookpreview`（图书预览） | `unlimited` / `text` / `pdf` / `empty` | 它收文本类与 PDF；`text` 下再分**子类**（epub / txt / md），`pdf` **无子类** |
| `albums`（相册） | `unlimited` / `album` / `empty` | 相册的条目分类层只有「相册」这一层（列表项 = 相册） |
| `sources`（源） | `unlimited` / `source` / `empty` | 源的条目分类层是目录树（源根 / 子目录），统一为「源」 |
| **未注册 / 无参 / 插件面板** | **全量 9 项** | 宿主不知道它内部有什么分类，**不设限**（与"未知面板不拦截"同一口径）；插件面板的候选由插件自述再收窄（开放点，第 12 节） |

规则：

- **⚠️ 缺省值 ≠ 分域首项（D136 的关键修正）**：D135 时缺省取分域第一项；D136 给首项加了
  `unlimited`，若沿用就会让四个面板的新建类目**静默**全部变成「无限制」（用户不会察觉，
  直到发现新建类目什么文件都收）。因此缺省值独立成表：
  TS `PANEL_CLASS_MEDIA_TYPE_DEFAULTS` / Rust `class_media_type_default_for_panel(panel_id)`，
  值仍是 `media` → `image`、`bookpreview` → `text`、`albums` → `album`、`sources` → `source`、
  未注册 → `image`（**与改动前逐项相同，零回归**）。旧导出 `PANEL_CLASS_MEDIA_TYPES`
  保留但改为指向缺省表。**门禁新增「缺省 ≠ 分域首项」断言**。
- **越域是硬错误**（第 6 节硬错误第 14 条）：类目有 `control` 且指向存在的面板、取值不在该面板分域
  → 拒绝保存。**`control` 缺失（未接通）不判分域**，只校验 9 项全量表——"还没接线"不得绑架数据
  （同 D109 口径）。
- **属性面板按分域出候选**（`BlueprintInspector`）：已选值**不在分域内时原样保留并标注未接通**
  （照抄 `panel_id` / `mark` 那种"不在清单的取值原样保留"的既有写法）；`control` 未连线 / 指向已删节点 /
  面板未注册 → **退回全量候选**（同样"缺失不得绑架数据"）。
- **`unlimited` / `empty` / `album` / `source` 都没有子类分域**：`BLUEPRINT_SUBCLASS_FORMATS`
  下不含这四项，因此它们下面**不能建子类**（`subclassFormatsFor("album")` 返回空数组，
  调用方据此拒绝建子类）。`unlimited` 类目下建子类是**硬错误**，与 `image` 类目同口径。
- **引擎命中（D136）**：`unlimited` 类目**跳过类型比较**（任何上报媒体类型都命中）；
  `empty` 类目**直接不命中**（排除全部）；其余取值保持精确比较。**`unlimited` 仍遵守
  「子类优先」**——若该类目下有覆盖某细分的子类，那个细分只走子类链，其余才走 `unlimited` 类目链
  （否则"无限制"会吞掉子类认领的细分，子类链永远轮不到）。
- **条件表达式同源**：`condition.expr` 的 `media_type == <值>` 与类目取值域同一份判据
  （`is_valid_class_media_type`），因此**自动接受** `unlimited` / `empty`。


**类目的显示名（相册 / 源）**：`albums` 面板下的类目显示为「**相册**」、`sources` 面板下显示为「**源**」——
判定在 `blueprintLabels.nodeDisplayName` 的 **`class` 分支**（`type === "class"` 且其 `control` 指向的
面板 `panel_id` 是 `albums` / `sources`）。i18n 键 `blueprint.object.album` / `blueprint.object.source`
**沿用 D134 的字面量**（键名不改，**语义已于 D135 纠正为类目**——D134 曾把它加在 `object` 分支，
那是误实现）。自定义 `name` 仍**优先**于这个专用名；引用链任一环缺失（未接通）**返回空串**交回既有
回退链（不得把"接不上"显示成"它是相册"）。`object` 节点恢复**通用命名**（`结构父名 · 范围`）。

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
| `control` | `class` | key 引用 | 必须指向 `control`（类目直挂面板）。**v3 / D137 起 `mark` 不再用这个字段**——残留的 `mark.control` 按未接通软告警处理 | — |
| `media_type` | `class` | enum | `unlimited` / `image` / `video` / `audio` / `text` / `pdf` / `album` / `source` / `empty`（**9 项全量**；已接通面板时还须落在**该面板分域**内，见 §2.0.2） | —（必需） |
| `format` | `subclass` | enum | **按所属类目的 `media_type` 分域**（`text` → `epub` / `txt` / `md`） | —（缺失按未接通软告警） |
| `mark` | `mark` | enum | **可注册标记清单** id（内置 **10 项**：`media` / `image` / `video` / `audio` / `music` / `document` / `text` / `book` / `manga` / `program`）；未注册按未接通软告警 | —（必需） |
| `object` | `mark` | key 引用 | 必须指向 `object`（**所属对象**，v3 / D137 新增）；缺失或指向已删除节点 = 未接通软告警。**旧文档残留的 `class`（D136 口径）同样只报软告警**，由 v2 → v3 迁移清除 | —（必需） |
| `class` | `object` | key 引用 | 必须指向 `class`（两条轴之一，与 `subclass` **互斥**） | — |
| `subclass` | `subclass` / `object` | key 引用 | 在 `subclass` 节点上指**所属类目**；在 `object` 节点上指**所属子类**（同名不同义） | — |
| `mark_ref` | `object` | key 引用 | **v3 / D137 起废弃**（D136 的三条轴之一）；仅用于读取旧文档，残留值按未接通软告警处理，由 v2 → v3 迁移清除。**不是**标记 id | — |
| `scope` | `object` | string | `selected` / `clicked` / `double_clicked` / 具体 `file_id` | —（必需） |
| `mode` | `group` | enum | `exclusive` / `independent` | —（必需） |
| `default_visible` | `group` | key[] | 成员 key；互斥组**至多一个** | `[]` |
| `hide_direction` | `group` | string | `left` / `right` / `up` / `down` / `toward:<groupKey>`（必须指向同层 `group`） | `left`（前端） |
| `trigger` | `event` | enum | `click` / `double_click` / `selection_change` | —（必需） |
| `target` | `event` | key 引用 | 必须指向 `class` / `object` / `mark`（v3 / D137 扩；兼容旧图；正常来源是 `on` 入边） | — |
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
| `ports` | object[] | `{ id, side, edge }` | — | 两者 | **端口与允许的边类型**；未声明即按 `role` + `parents`/`children` **推导**（保持内置 12 种行为不变） |
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
| `out.struct` | `class` | 输出 | `subclass` / `object` 的 `in.struct` |
| `out.struct` | `subclass` | 输出 | `object` 的 `in.struct` |
| `out.struct` | `object` | 输出 | `mark` 的 `in.struct`（v3 / D137） |
| `in.struct` | `layout_block` / `overlay` / `group` / `control` / `class` / `subclass` / `object` / `mark` | 输入 | 见上（**只能一个**结构父） |
| `out.rule` | `control` / `class` / `subclass` / `mark` / `object` | 输出 | `event` 的 `in.rule`（边类型 `on`） |
| `out.rule` | `event` | 输出 | `condition` / `action` 的 `in.rule`（边类型 `fires`） |
| `out.rule` | `condition` | 输出 | `action` 的 `in.rule`（边类型 `guards`） |
| `in.rule` | `event` / `condition` / `action` | 输入 | 规则三节点可按语义多条入边（见下） |

**结构父唯一性（构造性约束，编辑器必须校验）**：`layout_block` / `overlay` / `group` / `control` / `class` / `subclass` / `object` / `mark` **只能有一个结构父**（否则"我属于谁"有歧义）。后端校验以字段引用为准（硬错误）：`class.control`、`subclass.subclass`、`object.class`/`object.subclass`（互斥）、`mark.object`；画布连线即写字段。

> ⚠️ **`object` 与 `mark` 的 `on` 输出端口（v3 实现注意）**：`object` 在 v3 仍有 `mark` 子级，**不得**再用"没有子级 ⇒ 像对象 ⇒ 给 `on` 口"这类**间接判据**推导它的规则输出口——那会让 `object` **静默丢掉** `on` 口、「对象 → 操作」画布上连不出来（本次实测已发生，见第 0.1 节）。判据必须是**显式清单** `RULE_EDGE_SOURCES.on`（`apps/desktop/src/app_ui/panels/blueprintPorts.ts:107`，五源不变）。

**规则入边数量**：

- `event`：必须恰好一条 `on` 入边，**或**自带 `target` 字段（旧图兼容）；两者都没有即**软告警**（未接通）。
- `condition`：至少一条 `fires` 入边，否则软告警。
- `action`：至少一条 `fires` 或 `guards` 入边，否则软告警。
- `event` / `condition` / `action` **不限制出边数量**（一条事件可触发多个动作；求值"全部匹配"）。

### 3.1 渲染端口推导与"可连端口清单"（2026-10-10 / D107）

画布上"这条边画在哪两个圆点之间"与"这个端口能不能落线"是**两个不同的问题**，
因此有**两个**推导函数——这是本条最容易读错的地方：

| 函数 | 回答的问题 | 推不出来时 | 用途 |
| --- | --- | --- | --- |
| `portIdFor(type, side, kind)` | "这条边**合不合规**、该落在哪个端口" | 返回**空串**（调用方据此拒绝该操作） | **契约**：门禁断言它只返回声明过的端口 |
| `portIdForRender(type, side, kind)` | "这条边**画在哪个端口上**" | **回落到该侧第一个声明端口**（该侧没有任何端口才返回空串） | **渲染与测量**：库里已有的边（历史文档 / JSON 手写 / 插件自定义端口名 / 未注册类型）也要如实画出来 |

- 用契约函数去渲染，就会在"边不合规但确实存在"时**静默丢线**（`return null`）——
  这正是缺陷 0034 的第二条根因：`portIdFor` 返回空串**本身是对的**，
  错在把它当成渲染函数用。**一个函数回答两个问题，就会在第二个问题上静默出错。**
- 端点坐标取不到时的**四级回落**（`blueprintGeometry.resolveEdgeAnchor`）：
  **端口实测 → 卡片矩形 + 端口偏移 → 卡片边沿（in 左 / out 右）→ 节点世界坐标**；
  只有四级全空（端点节点不在文档里）才画不出这条线。
  **不覆盖测量**：画布尺寸为 0（面板尚未布局）时跳过测量，保留上一份正确坐标。
- **未注册类型**（插件未安装/未启用，第 6 节软告警第 0 条）**没有端口表**：
  画布一律经 `portsOf(type)` 取表（返回空表），**不得**下标取 `PORT_DEFS[type]`
  （`undefined.filter` 会抛错把整块画布打崩）；该节点的边由**卡片锚点**兜底画出来。
- **可连端口清单**（`connectTargets(from, fromPort, nodes, edges)`，纯函数）：
  从某个**输出端口**拖出的线能落在哪些输入端口上——判据三条合一：
  ① `kindForEdge(源类型, 源端口, 目标类型)` 推得出边类型；② 目标该侧**确实声明了**这个端口；
  ③ 同 `(from, to, kind)` 的边**尚不存在**。它**同时**驱动四件事：拖拽时**可连端口的绿圈**、
  **承载可连端口的节点整体泛绿**（先看到"哪个节点能连"，再看"落在哪个圆点"）、
  临时线的**着色**（按将建立的边类型）、放开时的**落点**——清单只有一份，
  因此"亮着绿圈"与"放开真能连上"不可能各说各话。
- **命中与吸附是画布本地像素常数**（不是 DOM 盒边界）：连线点选容差 **10px**、
  端口就近吸附半径 **34px**、节点抓取余量 **6px**、端口可点范围由 `::after` 外扩到 **34px**。
  常数可调，判据不变（`pnpm check:blueprint-connect` 断言半径语义，大小由真机手感定）。
- **线一律从输出端口拉出**（方向确定、落点判据唯一）；从输入端口按下会**拖动节点**
  （不吞事件、不留死区）。反向连线为**开放点**（见第 12 节）。

## 4. 边类型定义

| `kind` | 方向 | 允许的端点类型 | 含义 |
| --- | --- | --- | --- |
| `contains` | 父 → 子 | `interface`→`layout_block`/`overlay`；`layout_block`/`overlay`→`group`/`control`；`group`→`control`；`control`→`class`；`class`→`subclass`；`class`/`subclass`→`object`；**`object`→`mark`** | 结构包含（第 2 节表） |
| `memberOf` | `control` → `group` | 面板归属标签组（**兼容旧图**；新图一律用 `group --contains--> control`，D59） | — |
| `on` | (`control`/`class`/`subclass`/`mark`/`object`) → `event` | 规则三元组：在对象上发生操作。**五源不变**（v3 / D137）：接**对象** = 不筛标记，接**标记** = 只在该标记命中且其父对象也命中时生效 | — |
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
4. 引用**存在但类型不符**：`class.control` 非 `control`、`object.class` 非 `class`、**`mark.object` 非 `object`**（v3 / D137）、`action.target` 与 `op` 不配对、`default_visible` / `hide_direction` 指向错误类型。
4b. **`format` 用在非子类节点上**，或子类的 `format` **不在其所属类目的分域内**
    （如 `image` 类目下建子类、或 `text` 类目下写 `format = "png"`）——与"字段用在错误的
    类型上"同级（第 2.0.1 节）。
4c. **对象的两个结构父同时声明**（`class` / `subclass` 都写了）：
    对象只能挂在**两条轴之一**下（与"结构父唯一性"同一条约束）。`mark_ref` 属 **v3 废弃字段**，
    残留值**只报软告警**、不参与这条硬错误判定（D136 时代的"三轴互斥"已随 D137 收窄为两轴）。
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
14. **类目的类型不属于其面板分域**（D135，D136 扩为 9 项）：类目**有** `control` 且指向**存在**的面板节点、而其 `media_type` 不在该面板的**分域**内（如 `albums` 面板下挂 `image` 类目）→ 硬错误（`§2.0.2`）。**`control` 缺失（未接通）不做分域判定**——那时取值只须在 9 项全量表内（缺字段本身按软告警第 1 条处理），缺失不得绑架既有数据。
15. **`mark` 的结构父不是对象**（**v3 / D137**，取代 D136 的"不是类目"）：`mark.object` 指向**存在的节点但类型不是 `object`** → 硬错误（引用存在但类型不符，同第 4 条）；**缺 `object` = 未接通软告警**（不是硬错误）。**`unlimited` / `empty` 类目下建子类** → 硬错误（该类目没有子类分域，同第 4b 条）。

**软告警（`warnings`，不阻塞保存，画布灰显「未接通」）**：

0. **节点类型当前无注册项**（插件未安装/未启用/宿主 API 不兼容）：该节点及其边**原样保留**、不参与求值与结构对账、画布灰显标注「未接通」，**允许保存**；插件恢复后**自动恢复**，无需用户重建（RFC 0010 决策 6）。这是"未知 `type`"的第二种情形，与硬错误第 1 条区分。
1. 必填引用缺失或指向已删除节点：`control.panel_id`、`class.control`、**`mark.object`**（v3 / D137）、`object.class` / `object.subclass`、`action.target`。
2. 求值链缺触发来源：`event` 无 `on` 入边且无 `target`；`condition` 无 `fires` 入边；`action` 无 `fires`/`guards` 入边。
3. 无根层（`interface` 被软删除，D55）；`navigate` 跳转失效（D55）。
4. `overlay` 未连接到界面（缺 `界面 --contains--> 浮层`，D50 修订）。
5. `overlay.size` 被夹紧到最小值。
6. 面板 `mount.multiple_per_interface = false` 但同一界面出现多个实例（`docs/spec/panel-standard.md` 第 5.4 节）。
7. **插件注册面板**的 `has_class = false` 但文档里已有类目节点（插件升级改了声明）：灰显「未接通」、**允许保存**，与插件缺失同口径（第 12 条硬错误只适用于**宿主内置**面板）。
8. **子类缺 `format`**（说不出收哪些文件、运行时不命中任何条目）与**标记不在可注册清单内**
   （清单可注册，未注册不等于非法）：都按未接通软告警处理 → 灰显「未接通」、**允许保存**，
   补上细分 / 注册清单后自动恢复（第 2.0.1 节）。
9. **结构父缺失（D108）**：`layout_block` / `group` / `control` **没有 `contains` 入边** →
   它不属于任何页面/容器，套用布局时不会被对账到 → 灰显「未接通」、**允许保存**，拖一条线
   接回去即恢复。判据与例外：
   - **父节点必须存在**（悬空边不算接好；悬空边本身是硬错误，由硬错误第 5 条拒）；
   - **兼容旧图**：面板另可用 `面板 --memberOf--> 标签组`（D59 之前的写法）表达归属，同样放行；
   - `interface` **不参与**（它是层的根，本来就没有父；"无根层"按**层**报，见第 3 条）；
   - `overlay` **不参与**（它有更严的同族判据：父必须是界面，见第 4 条），避免重复标记；
   - **为什么加**：D107「新增节点一律不建边」之后，新摆下的结构节点默认是**断开**的；
     这条把"刚摆下还没接好"与"缺引用"统一成**同一种可见状态**，而不是悄悄不生效；
   - **两侧同步**：前端 `blueprintLint.analyzeUnlinked`（画布灰显 / 顶部提示）与后端
     `blueprint_warnings::collect_issues`（保存时软告警）**逐项同结论**，由
     `pnpm check:blueprint-nodes` 的"结构父缺失"断言块用**同一批夹具**跑两侧钉住。
10. **旧文档残留的废弃结构字段（v3 / D137）**：`mark.class`（D136 口径的"所属类目"）、
    `mark.control`（更早口径的"所属面板"）、`object.mark_ref`（D136 的三条轴之一）——这三个
    字段 v3 起**不再是任何节点的结构父**。它们**只报未接通软告警、允许保存**（沿用 D136 时代
    残留 `mark.control` 的同一条先例），并由 v2 → v3 迁移清除。**不要为它们加硬错误**——否则
    旧文档一打开就被拒保存。判定还要与**引用类型不符**区分开：字段**指向了存在的节点但类型
    不对**（如 `mark.object` 指向类目）= 硬错误（第 4 条）；指向不存在/未设置 = 软告警。
11. **`scope` 与 `trigger` 不配对（D138）**：`event` 的触发方式与它来源对象的 `scope` 错开
    （`click` ↔ `clicked`、`double_click` ↔ `double_clicked`、`selection_change` ↔ `selected`）→
    图**合法**（引用齐全、`validate` 不报），但运行时的判定顺序是「`trigger` 决定本次上报的 `scope`」，
    再要求对象的 `scope` 相等，所以这条链**永远不会命中**：用户看到的是「点了没反应、也没有任何提示」。
    它与「缺引用」同级 → 画布灰显「未接通」、**允许保存**，把对象 `scope` 改对即恢复。判据：
    - **只判「全部落空」**：同一事件只要还有一条来源能配上（例如既有 `clicked` 对象、又有面板直连），就不报；
    - `scope` 写成**具体 `file_id`**（如相册 id）是对实例的精确匹配，**不算**错配；
    - **兼容旧图**：没有 `on` 入边、只在事件上写 `target` 时同样判定（与运行时 `eventMatches` 的候选顺序一致）；
    - 来源若是 `mark`，按它的 `object` 取对象（v3 / D137：`对象 ⊃ 标记`）；
    - **两侧同步**：前端原因码 `scope-trigger-mismatch`，后端文案「触发方式 … 与来源对象的 scope … 不配对」，
      由 `pnpm check:blueprint-nodes` 的「scope 错配」断言块用**同一批夹具**跑两侧钉住。

**编辑器职责（后端不校验，避免耦合面板注册表）**：`panel_id` 是否在面板注册表内、`hide_direction: toward:<groupKey>` 引用的组是否存在、结构父唯一性、候选引用按**同层**过滤（`navigate` 例外）、**补充节点（子类/标记）新增时自动解析挂载父**（§2.0.1：解析不到就**留空引用**，不拒绝创建）。

## 7. 命名与生成规范

- **节点 `key`**：全蓝图唯一；由编辑器**自动生成**，用户不手填：优先「上级 key + 自身类型标识」（`c_media` 下的图像类目 → `c_media_image`；其下双击对象 → `c_media_image_dbl`），冲突才追加序号。
- **新增节点只追加自身**：编辑器的"新增"只为**被点选的那一个类型**创建节点；缺上级/缺引用时**留空**（画布灰显「未接通」，按第 6 节软告警处理），**不得**为了"补合法链路"新建面板/类目/对象/操作/状态，也**不得**自动接到既有规则上。状态的 `action.target` 只由属性面板指定。
- **引用字段不在新增时落定，只由「连线」落定（2026-10-10 用户口径 / D109）**：`class.control`、`subclass.subclass`、**`mark.object`**（v3 / D137）、`object.class`/`subclass` 这些 key 型引用**一律留空**（属性面板里只读展示、用户永不手填）——新增的四类节点因此**必然灰显「未接通」**，使用者在画布上**拖一条线**才接上。连线时由 `blueprintConnect.applyConnect` 在**一份文档**上把**边 + 字段**一次落好。
  - **为什么**：这四类的"未接通"判据**只看字段**（第 6 节软告警第 1 条），而运行期认的也是字段；若新增时就偷偷写好字段，节点就**画布上没线、却不灰显**（用户反馈："类目、子类、标记、对象没有灰显"）。让字段只由连线产生，则四者等价：**画布上没线 ⇔ 字段为空 ⇔ 运行期真的不生效 ⇔ 灰显**（与 D108 给结构节点的口径一致）。
  - **显式选中的上级只用于两件事**：① key 命名（选中 `c_media` 后新增类目 → `c_media_image`）；② 缺省字段取值（类目的 `media_type` 按选中面板取，图书预览下默认 `text`）。**不再"同层兜底复用既有父节点"**——那正是"不可见绑定"的来源。
  - **子类例外一条**：连线到类目时，若子类缺 `format`，按**所属类目的分域**补第一项（text → `epub`，与属性面板下拉缺省同源，可改）；否则"一条线接完仍灰显"（缺 `format` = 未接通，第 6 节软告警第 8 条）。
- **新增一律不建边（2026-10-10 用户口径 / D107）**：一次"新增"**不产生任何边**——返回值里的 `edges` 与传入文档**逐项相同**。连"选中界面/浮层/布局块/标签组后新增面板/标签组即落进该容器"的那条 `contains` 也**不自动建**；操作/条件/状态的 `on` / `fires` 同理。**连线只由使用者从输出端口拖出来**（或由属性面板写引用字段）。
  - **为什么**（两条都成立）：① 早前"自动连线"只覆盖**部分类型**（规则三节点补规则边、容器类型补 `contains`，而类目/对象只写引用字段）——同一次点击在不同类型上表现不一致；② 新节点落在**当前视口中心**（`blueprintSlot`），而自动边连的是**选中节点**（可能远在画布另一侧），那条线是横穿画布的长线，看起来像"点一下多了一条线"。
  - **引用字段与边是两层表达**：字段说"**我属于谁**"（属性面板可见可改，仍按上一条口径自动解析、缺父留空）；边说"**画布上连到谁**"（使用者拖出来）。二者不互相代偿。
  - **已知代价 → 已由 D108 闭合**：结构节点（面板/标签组/布局块）新增后没有结构父**也会灰显「未接通」**
    （前端 `blueprintLint` 与后端 `blueprint_warnings` **两侧同步**新增了"结构父缺失"软告警，
    见第 6 节软告警第 9 条）——"刚摆下还没接好"与"缺引用"因此是同一种可见状态。
- **所有节点都可随意创建（2026-10-10 用户口径）**："子类节点可以随意创建，所有节点都可以随意创建，只规定连接方式和层级"。因此"新增"**永不拒绝**任何类型——包括子类与标记在层内没有可用父级时（那时**引用留空**、画布灰显「未接通」）。**层级约束管的是连线与引用的合法性**（`containmentAllows` 判非法边、后端 `can_contain` 拒绝非法边），**不是创建许可**；把两者混在一起会打断"先摆节点、后连线"的正常搭图顺序。
- **层 `key`**：`l_` 前缀 + 语义名（如 `l_browse`），蓝图内唯一且非空；**层名**（`name`，显示名）蓝图内唯一（D60）。
- **主界面（`is_home`，D67）**：层的可选布尔标记，标记"进入该仓库时默认显示的界面"；**同一蓝图至多一个**（多个为硬错误），**无标记时回退第一个层**。编辑器层工具条提供「设为主界面」按钮，下拉中主界面带 ★。解析优先级：`blueprint.currentLayer`（上次所在层，仍存在时优先）→ `is_home` 层 → 第一个层。
- **蓝图名**（`blueprints.name`）与层名互相独立（D60）。
- **`panel_id`** 用**面板注册表** id（内置 **16** 个，按 `packages/config/src/panels.ts:157-174` 的 `BUILTIN_PANEL_IDS` 顺序：`repo` / `sources` / `albums` / `media` / `bookpreview` / `viewer` / `bookreader` / `imageviewer` / `metadata` / `tags` / `tagtable` / `color` / `player` / `tasks` / `plugins` / `blueprint`；插件面板：`plugin.<plugin_id>.<local_id>`，见 `docs/spec/panel-standard.md` 第 6 节），不使用 key 形式。
- **`type`** 用节点类型注册表 id（内置裸 type；插件 `plugin.<plugin_id>.<local_id>`，第 2.4 节）。
- **i18n**：`title_key` 必须走键（D27），前端显示名走 `blueprintLabels.ts`，不得内联文案；插件注册的节点类型由插件在自己的语言资源里提供显示名。
- **默认蓝图**：唯一权威是 `packages/config/src/blueprintDefault.ts` 的 `DEFAULT_BLUEPRINT`；Rust 夹具由 `pnpm generate:blueprint-fixture` 生成，两侧不手工维护。

## 10. 验证

- **`pnpm check:blueprint-nodes`**（**114 项**；2026-11-02 v3 + D138 落地后实测 **114/114 通过、exit 0**）：结构层级/边类型一致性（`CONTAINMENT` ↔ `kindForEdge` ↔ `PORT_DEFS`，均由定义表派生）、**父子声明的双向对称性**（`children` 与 `parents` 逐项互指——只声明一侧会让该边静默连不出来，见第 2 节的实测缺口注记；Rust 侧另有 cargo 测试独立钉住，脚本扫不到 Rust）、节点工厂**只追加自身**（不连带补链、**不产生任何边、也不落定引用字段**）、**所有节点都可随意创建**（**空图上 12 种类型全部可创建**；引用一律留空）、**新增绝不自动连线**（**12 种类型 × 默认蓝图每一个已选中节点**逐个新增后边集逐项不变；容器路径与规则路径各一条显式断言）、**引用型四类"新增即灰显、连线即恢复"**（`analyzeUnlinked` × `applyConnect`：四类新增全部灰显且原因码正确 → 四条线接上后都不再灰显 → 字段按父类型分流（v3 为 `mark.object`）→ 重复连线去重 → **后端逐 key 同口径**）、**结构父缺失的 TS ↔ Rust 同口径**（同一批夹具跑两侧：未接父的 布局块/标签组/面板 两侧都报 3 条、接好后两侧都 0 条、`memberOf` 兼容旧图两侧都放行、悬空边两侧都不算接好）、**`scope` ↔ `trigger` 错配的 TS ↔ Rust 同口径**（D138：同一批三夹具——错配 1 条 / 配对 0 条 / 具体 `file_id` 0 条——两侧逐项同结论且硬错误 0）、上级推导（只认显式选中）、层归属、浮层容器与外观/定位/尺寸、层增删改名、结构骨架、**「一键整理」几何**（起始节点位置不变、同层间距 ≥ 卡片高 + 余量、全图不重叠且避让孤立节点）、状态冲突的 TS↔Rust 同结论，并用 hp-core 真实校验器复核全部夹具。
- **`pnpm check:blueprint-connect`**（**24 项**；2026-10-10 / D107，v3 口径下 24/24 通过）：连线体验的**纯函数 + 源码锚点**——
  渲染端口推导（该侧有端口就**一定推得出**一个声明过的端口：12 类型 × 2 侧 × 5 边类型；
  **端口 id 与边类型不同名**的注册类型仍画得出；无端口的侧保持为空）、**可连端口清单**
  （21 组期望关系逐一命中；**默认蓝图 26 条既有边全部可重放**，即"能连出来 ⇔ 已经连上"同一判据；
  非法组合不命中；去重 / 自身 / 未注册类型不参与）、端点**四级回落**
  （端口实测 → 卡片+偏移 → 卡片边沿 → 世界坐标；**只有全空才 `null`**）、就近吸附与
  连线容差的纯函数行为，以及三条**源码锚点**：落点必须来自 `connectTargets`、
  端口表必须走 `portsOf`（不得下标取 `PORT_DEFS`）、样式里必须有绿圈与扩大命中区。
- **`pnpm check:blueprint-minimap`**（**11 项**）：画布右下角小地图的纯几何——内容包围盒、等比缩放与留边、只缩小不放大、世界↔小地图往返、视口指示框随缩放变小且平移到图外仍留在框内、视口矩形与 `viewportCenterToWorld` 同源、空图不崩。
- **RFC 0010 新增断言**：
  - 注册表声明参数完整性（第 2.3 节的必需项齐全；`ports` / `severity` / `evaluation_role` 缺省时推导结果与既有内置类型的现有行为**逐项相同**）。
  - 命名空间规则：插件注册项必须 `plugin.<plugin_id>.<local_id>`；不得与内置裸 type 冲突。
  - **未知 `type` 分流**：不合命名规则 → 硬错误；命名合法但无注册项 → **软告警且可保存**，且该节点与其边原样保留。
  - `control.panel_id` ↔ 面板注册表 `blueprint_node` 双向一致（`docs/spec/panel-standard.md` 第 5.2 节）。
  - `has_class = false` 的面板下 `control → class` 被拒（硬错误）；**`control → mark` 在 v3 下同样非法**，但理由不同——`mark` 的结构父是 `object`，`control.children` 只有 `class`，因此这条边被 `containmentAllows` 直接拒绝（**取代** D134 的"标记挂任何面板都合法"口径，见第 0 节）。
- **标记的上报与匹配（D138，2026-11-02）**：`pnpm check:panels` 新增 **6 条**（362 → **368**）——相册行必须上报 `mediaType:"album"` + `fileId: node.id`，`marks` 必须走 `effectiveMarksFor(marks,"albums",node.id,derivedMarksForAlbum(` 且**反面断言 `marks: []` 恒空形态不得再出现**；源面板行必须上报 `click` + `mediaType:"source"` + `fileId: node.key`，`marks` 必须走 `marksOf(marks,"sources",node.key)`；`effectiveMarksFor` 的**行为**断言（并集、去重保序、`serializePanelMarksState` 后派生标记**不落库**）；派生标记必须取自 `effectiveMediaType(node.id, albumById)`（沿父链继承后的有效属性，非节点自身字段）。`pnpm check:blueprint-engine` 新增 **7 条**（55 → **62**），用真实引擎跑合成图的"同一次点击只换一个变量"对照：标记命中+对象命中 ⇒ 命中；`marks=[]` ⇒ 不命中；不相干标记 ⇒ 不命中；**同一标记换成 `mediaType:"image"` 上报 ⇒ 不命中（标记不改变对象所属类目）**；派生标记可作条件；源面板三件套 ⇒ 命中；源无标记/换 key ⇒ 不命中（两个条件都不可省）。\n- **标记清单（D134，2026-11-01）**：系统标记 **10 项**的清单在 TS（`packages/config/src/blueprintValues.ts` 的 `BLUEPRINT_BUILTIN_MARKS`）与 Rust（`crates/hp-core/src/blueprint_types.rs` 的 `BUILTIN_MARKS`）**两处**，`pnpm check:panels` 逐项比对**含顺序**（数量对不上会被 `[&str; N]` 当场发现，但顺序对不上只会让两边下拉顺序悄悄错开、谁都不报错）；同一条断言还钉住 `blueprint.mark.<id>` × 10 × 三语（zh-CN / zh-TW / en）逐键存在——缺一个就是某种语言下菜单出现空白项。
- **类目「类型」取值域与分域（D135 起 7 项、D136 扩为 **9** 项，2026-11-01）**：`BLUEPRINT_MEDIA_TYPES`（**9 项**）↔ Rust `CLASS_MEDIA_TYPES`（`[&str; 9]`）**逐项相等且顺序一致**（数量对不上会被 `[&str; N]` 当场发现，**顺序**对不上只会让两边下拉顺序悄悄错开、谁都不报错）；TS `classMediaTypesForPanel` ↔ Rust `class_media_types_for_panel` **逐面板逐项相等**（`media` / `bookpreview` / `albums` / `sources` + 未注册）——这是**新增的跨语言镜像点**，两侧各写一份必然漂移。`pnpm check:panels` 另钉住 `defaultClassFieldsForPanel` 的四个面板缺省值、`PANEL_CLASS_MEDIA_TYPES` 键集 ↔ `has_class = true` 面板集相等、以及 `docs/spec/panel-standard.md` 第 5.1 节 has_class 表里四个面板的 `**true**` 字样。
- **端口推导一致性（两条门禁，防"连线被静默丢弃"）**：
  - `portIdFor 只返回 PORT_DEFS 声明过的端口`：遍历全部已注册类型 × 2 侧 × 5 边类型。画布渲染连线时按 `portMap.get(`${key}::${side}::${portIdFor(type, side, kind)}`)` 找端口坐标，而 DOM 标记用 `PORT_DEFS` 里的 id —— 返回一个未声明的 id 会让查表落空、连线被 `return null` 丢掉。**真实回归**：输入侧曾被边类型名覆盖（`action.in.fires` 返回 `"fires"`，而操作节点的输入口实际是 `"in"`），导致「操作 → 状态」在画布上永远没有线；同一处错误还让"拖线到操作输入口"永远判不等（`in !== contains`），即用户反馈的"操作节点接不到触发节点"。
  - `每种规则边两端都能在画布上连出来（on/fires/guards/memberOf）`：遍历允许的端点组合。
- 其余蓝图自检：`check:blueprint-engine`（**62 项**，2026-11-02 v3 + D138 落地后实测 62/62 通过：求值/浮层/navigate/hide_direction/**子类优先**/**标记两段式匹配**）、`check:blueprint-delete`（软删除，14/14）、`check:blueprint-runtime`（装载/升级/回退/补种，3/3）、`check:blueprint-geometry`（7/7）、`check:blueprint-slots`（5/5）、`check:blueprint-minimap`（11/11）、`check:blueprint-layout-sync`（43/43）。
- **解析层新增拦截**：字段用在**不支持它的节点类型**上即拒绝（由定义表驱动），与后端"引用存在但类型不符"的硬错误口径一致。
- `cargo test --workspace`：存储往返、仓库隔离、默认蓝图、模板、validate 拒绝（悬空边/环/未知类型/key 重复/互斥组多默认可见/非法 `hide_direction`/状态冲突/主界面标记重复/类目挂无类目面板）。

## 11. 与面板标准、控件标准的关系

三个词各有归属，**不得混用**（RFC 0010 决策 1）：

- **面板（Panel）**：蓝图节点 `control`，dockview 面板实例（`docs/spec/panel-standard.md`）。**可注册**（宿主内置 **16** 个 + 插件）。
- **控件（Control）**：面板**内部**的标准 UI 单元，26 种 `kind`，挂在面板**渲染树**里（`docs/spec/control-standard.md`）。**不可注册**（D62）。
- **类目（Category）**：蓝图节点 `class`，面板内条目分类（本文第 2 节）。挂在面板**结构树**里，受面板 `has_class` 约束。
- **标记（Mark）**：蓝图节点 `mark`，**对象之下的细分**（本文第 0 节与第 2.0.1 节，**v3 / D137**；结构父引用字段是 `object`）。在结构树里的位置是最内层：`面板 ⊃ 类目 ⊃ {子类, 对象} ⊃ 标记`——标记表达"对这个**具体对象**的进一步细分"，D134/D136 的"标记直挂类目 / 面板、位于类目之下"口径**已撤销**。

两张表的关系：**面板注册表**声明 `blueprint_node`（该面板由哪种节点承载），**节点类型注册表**声明是否允许 `panel_id` 字段——两侧必须互相对应，由门禁断言。

浮层（`overlay`）是蓝图节点，承载**容器**的定位/尺寸/外观档位；浮层**内容**是面板/标签组，其内部 UI 仍归控件标准。

## 12. 开放点（实现期，与 RFC 0007 / RFC 0010 一致）

- 布局块嵌套（`contains` 是否支持 `layout_block → layout_block`）。
- 组位置 `position {x, y}` 的运行时语义（网格坐标 / 浮动窗口坐标 / 仅画布定位）。
- 页面栈与返回语义、入口层选择、跨层是否共享面板实例。
- 对账与事件驱动的边界（当前 `collapse`/`expand` 会被静态套用一次）。
- 条件表达式是否扩展（`album_member_of` / `source` 命中 / `tag_any_of`）。
- **反向连线**（从**输入端口**拉线到输出端口）：现在线一律从输出端口拉出（方向确定、
  落点判据唯一），从输入口按下是**拖动节点**；若要做，`connectTargets` 需要一个
  "源是输入口"的对称版本（2026-10-10 明确不在本轮范围内）。
- **画布命中/吸附的手感常数**（连线 10px / 端口吸附 34px / 节点抓取 6px）是否需要用户可调
  （目前是代码内常数，判据由门禁锁住）。
- **插件注册的节点类型能否参与结构边**（作为 `contains` 的父/子），还是仅允许规则类位置（`event`/`condition`/`action`）。
- **`ports` 显式声明与推导冲突时**：报硬错误，还是以显式声明为准。
- **插件注册节点类型的画布外观**（图标/配色档位）：宿主按 `role` 统一给，还是允许声明 token 档位。
- **插件注册项的全局与单插件上限**（防注册表爆炸）。
