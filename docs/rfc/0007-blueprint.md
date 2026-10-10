# RFC 0007：蓝图（Blueprint）—— 节点式面板显隐与组布局控制

状态：正式草案。已确认方向（用户拍板）：蓝图是**节点式**的显隐与组布局配置系统，主要功能为**控制面板的显示与隐藏**（如一个组有多个标签页，只能有一个显示，其他默认隐藏）；典型场景为预览组件内**图像 / 音频 / 视频类**条目的单击 / 双击 → 显隐对应的**查看器**。节点分为**界面（Interface）**、**布局块（Layout Block）**、**标签组（Group）**、**面板（Panel）**、**类目（Class）**、**对象（Object）**，以及**浮层（Overlay）**等；逻辑节点见节点类型表。

> **实现状态摘要（2026-09）**：schema v2（分层）、`overlay` 浮层容器、九宫格定位与双模式偏移、外观档位、显隐对账、**容器宿主渲染**、解析层校验与回退提示**均已实现**；`hide_direction`（D29 的"指定邻居吸收空间"）运行时、`selection_change` 事件源与 `rating`/`has_tag` 运行期 `context`、D59 同步开关（默认开）也已落地。本节以下的"修订说明"按时间保留历史，其中被后续修订推翻的措辞已在原处标注**已被取代**，请以标注与后文正文为准。

> 术语变更（v4）：本 RFC 原用「控件（Control）」指绑定 dockview 面板的 UI 组件实例，与 `docs/spec/control-standard.md` 的「控件」（宿主提供的标准 UI 单元）**同名不同义**。现统一为**面板（Panel）**；插件可创建的控件标准见该规范，两者按层级区分：界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板 ⊃ 类目 ⊃ 对象，**普通控件**挂在面板之下。~~**浮动控件与布局块同级**（同为界面直接子级），显示高度**在布局块之上**（整体浮层覆盖，D49）~~ → **2026-09 修订**：插件控件类别「浮动控件」已取消，改为蓝图 **`overlay`（浮层）容器**与布局块同级、显示在布局块之上（D50/D56）。

> 边界（2026-09）：本 RFC 早期版本用「浮动控件」描述浮层的内容。**该概念已取消**（D56）：浮层是**容器**，直接 `contains` 面板（也可含标签组），不存在"绑定某个浮动控件 schema"这回事。下文中凡出现「浮动控件」的措辞，均按此口径理解为"浮层内容（面板）"。

修订说明（v2，用户拍板）：

- **布局能力边界扩展**：蓝图**不只控制"显隐"**，还在 `layout.*`（D1）提供的面板位置/大小/分组结构**基准**之上，叠加控制：
  - **面板组的拉伸 / 组的隐藏**：隐藏面板组 = 将组收起为最小尺寸（正文 6px、标签条保留，即 D25 的 `PANEL_MIN_SIZE` 机制），**组结构不删除**，释放的空间被相邻组吸收（拉伸）；
  - **x / y**：组节点的位置坐标（目标锚点，供画布编辑器定位与浮动组/收起停靠使用）；
  - **隐藏方向**：组收起时沿 x 轴或 y 轴让出空间；**若该组位于两组中间，隐藏方向决定哪一侧邻居拉伸吸收空间**（如 `A | B | C` 中 B 收起：方向向左 → A 吸收，向右 → C 吸收）。

修订说明（v3，用户拍板）：

- **编辑器形态：自阶段一即为节点式**。废除"表单/列表式为基础编辑器（过渡形态）"与"功能测试通过后才进入画布式拖拽连线编辑器"的划分；蓝图编辑器**从 M6 阶段一起就是节点式（画布式拖拽连线）**：节点画布（拖拽摆放，`position {x,y}` 落库）、节点间拖拽连线（`contains` / `memberOf` / `fires` / `guards` 按端口类型区分）、节点属性面板（编辑面板/类目/对象/组/事件/条件/动作字段）、JSON 视图仅作辅助核对。表单/列表式不再作为交付形态。

修订说明（v4，用户拍板）：

- **术语统一**：原「控件（Control）」→ **面板控件（Panel Control）**；节点类型枚举值 `control` 不变（**key 与 JSON 字段不改**，只改文档与 UI 显示用语）。**（2026-09 由 RFC 0010 决策 1 再次修订：显示名退回「面板」；本条记录保持 v4 当时的历史原文，见下方 v8 修订说明。）**
- **新增「界面」顶层节点**：`interface` 作为**界面容器**，是蓝图图的**顶层**，收纳**布局块**（`contains` 边 界面→布局块）；于是结构层级为 **界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板 ⊃ 类目 ⊃ 对象**，与面板标准（`docs/spec/panel-standard.md`）的「界面容器收纳面板」对齐。
- 布局块语义不变：仍是**界面上的一个区域（栏）**，只是其上多了界面容器这一层；界面节点不参与显隐与收起求值，是结构的根。

修订说明（v5，用户拍板）：

- **界面 = 页面，且是后续多页面的基础**。一个界面节点即一个页面；蓝图文档**可有多个界面**（多页面），界面之间用**界面跳转**连接。
- **行为新增「界面跳转」**：动作 `ActionOp` 增加 `navigate`，目标为一个**界面节点**；运行时执行页面切换。默认蓝图只含单页面（`ui`），多页面由用户自行添加界面节点与跳转规则。
- 校验随之调整：界面节点**不再限制唯一**（`interface` 可多个）；`navigate` 的 `target` 必须是界面节点，指向已删除界面属**未接通（软告警）**、指向非界面类型属**硬错误**。

修订说明（v6，用户拍板）：

- **新增 `overlay`（浮层）节点类型，用于承载浮动控件的显隐控制**（D50）。浮层与 `layout_block` **同级**（都是 `interface` 的直接子级），~~是**叶子节点**（不 contains 子节点）~~ ← **已被取代**：2026-09 修订后浮层是**容器**（可 contains 面板与标签组），见决策 1「浮层节点」；`show` / `hide` / `toggle` 的 `target` 允许指向浮层，`collapse` / `expand` / `navigate` 指向浮层为硬错误。
- **本次仅登记，不实现** ← **已被取代（2026-09）**：`overlay` 已实现（`hp-core` 的 `NodeType` 与前端取值域均已加入 `overlay`，见决策 1「浮层节点」的"实现状态"）。原文保留如下以存历史：~~`hp-core` 的 `NodeType` 与前端枚举**尚未加入** `overlay`，节点类型表与本节描述是**目标态**；实现时机与控件标准（`docs/spec/control-standard.md`）同步，且**校验放宽必须先于运行时能执行该动作**。~~

修订说明（v7，用户拍板）：

- **蓝图增加「分层（Layer）」**：**一个层 = 一个子蓝图 = 一张画布 = 一个界面（页面）**。一个蓝图文档下可有**多个层**，层名**可自定义**，**层名即该层界面的显示名**（不再于 `interface` 节点上另存名字）。
- **作用域不变**：**一个蓝图控制一个仓库**的界面与**面板**跳转；分层是蓝图**内部**的组织方式，不改变"蓝图按仓库持久化、模板应用级共享"（决策 2/4）。
- **跨层跳转**：既有的 `navigate`（界面跳转，D48）就是**跨层跳转**——`target` 指向目标层内的界面节点（界面与层 1:1，因此也可理解为"跳到某层"）。
- **JSON 形态**（目标态）：文档新增 `layers: [{ key, name }]`；每个节点带 `layer` 字段归属某层；`layers` 缺失或节点无 `layer` 时视为**单层文档**（向后兼容旧文档，自动兜底为一个层）。
- **校验**：层 `key` 唯一且非空；**每层有且仅有一个 `interface` 节点**（该层的根）；节点 `layer` 必须指向存在的层。schema 版本由 1 升至 **2**（旧文档加载时按单层兜底，保存时写 v2）。
- **编辑器**：画布新增**层切换**（同一时刻显示一层 = 一张画布），层支持**新增/重命名/删除/排序**；层名即界面显示名。

> 实现状态：**已实现**。`BlueprintGraph.layers` 与节点 `layer` 字段已落地，schema 版本为 **2**；
> 校验按 D51/D58 执行（`layers` 为空才单层兜底、节点缺 `layer` 为硬错误、每层至多一个界面、
> 跨层边硬错误），v1 旧文档在打开仓库库/全局库时**一次性迁移并回写**（`hp-core/blueprint_migrate.rs`），
> `panel_layouts` 增加 `layer_key`（每层一份布局），编辑器提供层切换/新增/重命名/删除/排序。
> 详见"落地顺序"一节的落地情况。

修订说明（v8，用户拍板，2026-09；RFC 0010 决策 1）：

- **术语二次修订**：v4 的「面板控件」**退回「面板（Panel）」**；蓝图原「类（Class）」改称「**类目（Category）**」。三个词此后各占一个概念：**面板** = 可注册的 dockview 承载单元；**控件** = 面板**内部**的 26 种宿主标准 UI 单元（**不是**蓝图节点）；**类目** = 面板内条目分类。
- **仅显示用语变更**：节点枚举值 `control` / `class`、字段名（`panel_id` / `media_type` / `control` / `class` / `class`）、key、库表与命令名一律不变（同 v4 / D68 口径）。
- **结构层级**写作 **界面 ⊃ 布局块 ⊃ 标签组 ⊃ 面板 ⊃ 类目 ⊃ 对象**；本 RFC 正文中凡 v4 起写作「面板控件」处，一律按「面板」理解（已就地更新，v4 修订说明保留原文以存历史）。
- **插件注册权同时确立**（RFC 0010 决策 2）：插件**可以**注册**面板**与**蓝图节点类型**，**不可以**注册**控件**。因此本文"插件自定义蓝图"一节（非目标）中"插件面板可被蓝图引用"改为按**面板注册表**的 `plugin.<plugin_id>.<local_id>` 引用。
- 「浮动控件」是已取消概念（D44/D49/D56），**不受本次改名影响**，全部文档原样保留。

## 背景

仓鼠颊 app_ui 目前的面板显隐与组行为是**硬编码联动**：`MediaPreviewPanel` 双击图片 → 激活/创建 `ViewerPanel`（图像查看器），双击视频 → 激活/创建 `MediaPlayerPanel` 并播放（见 `apps/desktop/src/app_ui/panels/MediaPreviewPanel.tsx` 与面板注册表 `core/panelRegistry.tsx`）。同时 dockview 下用户可以把面板/组压到最小尺寸（`PANEL_MIN_SIZE`：正文 6px、标签条 16px，D25），但"收起后空间让给哪一侧、隐藏方向如何配置"完全不可控，也散落在各面板组件里。这类问题：

1. **不可配置**：用户无法自定义"什么事件、什么条件 → 显示/隐藏哪个面板"，也无法组织"互斥标签页组"（同一时间只显示一个、其余默认隐藏）或"组收起方向"这类规则。
2. **随功能增长变复杂**：音频类目（一期仅占位行）、元数据、未来更多查看器加入后，两两联动的 if/else 会指数膨胀，且散落在各面板组件里。
3. **不可扩展**：插件（RFC 0004）后续要挂自己的受控面板时，没有统一机制声明"我的面板在何时显示、如何收起"。

蓝图把"面板显隐 + 组收起/拉伸/方向"行为从组件代码中抽出来，变成**仓库内可编辑的节点式配置**，由运行时求值引擎统一执行。

## 术语与定位

- **蓝图（Blueprint）**：仓库内的节点式配置文档（一个 JSON 文档 + schema 版本），**控制一个仓库的界面与面板跳转**。定义按仓库持久化；模板在应用级共享，可复制进仓库。
- **层（Layer）**：蓝图**内部**的分层，**一个层 = 一个子蓝图 = 一张画布 = 一个界面（页面）**；层名**可自定义**，且**层名即该层界面的显示名**。一个蓝图可有多个层，层之间用**界面跳转**（`navigate`）连接（D51）。
- **界面（Interface）**：蓝图顶层节点 `interface`，是**层的根节点**（与层 1:1），收纳布局块与浮层（`contains` 边）。一个层一个界面，因此蓝图可有多个界面（多页面）；界面不参与显隐/收起求值。命名从层取（层名即界面显示名），节点上不再另存名字。
- **布局块（Layout Block）**：界面上的一个区域（栏）（如默认左/中/右三栏），**包含标签组与面板**；对应 dockview 布局区块，作为区域的容器。
- **标签组（Tab Group）**：面板容器（互斥/独立），**包含面板**（`contains` 边 标签组→面板）；即 dockview 的一组标签页。
- **面板（Panel）**：dockview 面板实例（UI 组件实例），如媒体预览、图像查看器、媒体播放器、元数据。通过 `panel_id` 绑定到 dockview 面板实例。（旧称「面板控件」——v4 由「控件」改称，**RFC 0010 决策 1 再退回「面板」**；节点类型枚举值仍为 `control`。）
- **对象/操作/状态（规则三元组）**：规则表达为 **对象（面板或面板内的类目/对象）→ 操作（单击/双击/选中变化）→ 状态（显示/隐藏/切换/收缩/展开）**，对应事件（操作）与动作（状态）节点。
- **类目（Class）**：**面板内部**条目的分类，如媒体预览内的图像类目 / 视频类目 / 音频类目（对应 `media_type`：image / video / audio）。
- **对象（Object）**：**类目内部**的具体条目实例，如媒体预览中当前选中的文件项（`file_id` 或"当前选中/被单击/被双击项"）。
- **组（Group）**：面板容器，两种语义：
  - **互斥组（exclusive）**：同一时间至多一个面板显示（如多标签页只能显示一个，其余默认隐藏）；
  - **独立组（independent）**：各面板显隐互不影响；
  - 组节点另声明**收起行为**：`hide_direction`（隐藏方向）、`position {x, y}`（目标锚点）。
- **事件（Event）**：触发求值的交互，如单击、双击、选中变化（事件挂在类目或对象上）。
- **条件（Condition）**：基础判定，如 `media_type == image`、评分阈值、tag 命中、文件选中态。
- **动作（Action）**：操作，面板级 `show` / `hide` / `toggle`，组级 `collapse` / `expand` / `toggle`，**界面级 `navigate`（界面跳转）**；可附带非显隐联动（如显示播放器时同时发起播放）。
- **运行时引擎（BlueprintEngine）**：前端求值器，订阅 UI 事件 → 按图求值 → 驱动 dockview 面板显隐与组收起/拉伸。

## 目标

1. 定义节点式蓝图数据模型：**层（Layer）** 下的 **界面 / 布局块 / 标签组 / 面板 / 类目 / 对象 / 事件 / 条件 / 动作**（另预留**浮层**），以及"包含（contain）""触发（fires）""守卫（guards）""归属（memberOf）"等边语义。
2. 定义运行时求值语义：事件 → 条件 → 动作，确定性、幂等；**互斥组表现为标签激活互斥**（同 dockview 组的成员共享显示区域，同一时间仅一个激活），**不自动隐藏跨 dockview 组的面板**（避免破坏用户布局）。
3. **布局能力边界**：在 `layout.*`（D1）的位置/大小/分组结构基准之上，蓝图叠加控制**面板组收起（组的隐藏 = 最小化至 6px，标签条保留）、组拉伸（释放空间按隐藏方向被相邻组吸收）、组位置（x/y）、隐藏方向（两组中间时指定侧吸收）**；蓝图不重写布局持久化机制本身。
4. 默认蓝图随仓库初始化写入，**完整复现当前硬编码行为**（双击图像→图像查看器、双击视频→媒体播放器并播放），保证现有 UX 零回归；用户可编辑/替换/恢复默认。
5. **节点式编辑器（画布式拖拽连线）自 M6 阶段一落地**：节点画布拖拽摆放、端口拖拽连线、节点属性面板、JSON 视图辅助；无"过渡编辑器"形态。
6. 定义按仓库（同 D23 精神：解释数据按仓库隔离）；模板应用级共享（全局配置库）；蓝图**内部按层组织**（一层 = 一画布 = 一界面，D51）。
7. 节点能力边界收敛在"显隐控制 + 组收起/拉伸 + 基础条件"，阻止向通用脚本蔓延。

## 非目标

- **通用可视化脚本**：无循环、变量、数据加工、任意流程编排；条件限定为基础判定。
- **重写布局持久化机制**：面板位置/大小/分组结构的**基准**仍由 `layout.*`（D1）管理；蓝图只在其上叠加显隐与组收起/拉伸/方向行为（收起状态是否/何时回写 `layout_json` 见"实现期开放点"）。
- **插件自定义蓝图**（**2026-09 部分开放，RFC 0010 决策 2/5/6**）：插件**可以注册面板**与**蓝图节点类型**（纯声明式，无自定义渲染/逻辑），注册项因此可被蓝图引用（面板以 `panel_id`、节点类型以 `type`，命名空间均为 `plugin.<plugin_id>.<local_id>`）；但**插件自身不编写蓝图**，也不得覆盖宿主内置项。
- **跨仓库实时共享蓝图**：模板是一次性复制，复制后与模板脱离。

## 决策

### 1. 节点分层与节点类型（用户已确认分层）

节点图共 **10 类节点**：**6 类实体节点**（`interface` / `layout_block` / `group` / `control` / `class` / `object`）+ **3 类逻辑节点**（`event` / `condition` / `action`）+ **1 类容器节点**（`overlay` 浮层，D50，**已实现**）：

> **标准化（D64）**：本节的节点类型表与下方「边语义」表已收敛为**节点类型定义表**，权威展开版见
> `docs/spec/blueprint-node-standard.md`（字段取值域、引用目标、端口与边规则、校验分级）。
> 前端实现是 `packages/config/src/blueprintNodes.ts`（取值域在 `blueprintValues.ts`）：
> 画布端口表（`apps/desktop/src/app_ui/panels/blueprintPorts.ts`）、新节点工厂与**解析层校验**
> 都由它派生，避免各处手写一遍。**JSON 字段名与枚举取值一律不变**；本节仍是决策级描述。

| 节点类型 | 含义 | 关键字段 |
| --- | --- | --- |
| （全体节点） | —— | 每个节点都带 `layer`（所属**层**，D51；缺省视为单层兜底）与 `position {x, y}`（画布坐标） |
| `interface` 界面 | **层的根节点**（与层 1:1），一个界面 = 一个页面：收纳布局块与浮层（`contains`）；界面之间以**界面跳转**连接，是后续多页面的基础 | 归属 `layer`；显示名取自**层名**（不再另存 `name`）；`position`（{x, y}） |
| `layout_block` 布局块 | **界面上的一个区域（栏）**，如默认左/中/右三栏；一栏内可堆叠**一个或多个**标签组/独立面板，它们都属于这**一个**布局块 | 归属 `layer`；`name`（显示名）、`position`（{x, y}） |
| `group` 标签组 | 面板容器（互斥/独立），包含面板 | `mode`（exclusive / independent）、`default_visible`、`hide_direction`、`position` |
| `control` 面板 | dockview 面板实例（UI 组件实例） | `panel_id`（dockview 面板 id）、`title_key`、所属布局块/标签组 |
| `class` 类目 | 面板内部条目分类 | `control`（所属面板）、`media_type`（image/video/audio） |
| `object` 对象 | 类目内条目实例 | `class`（所属类目）、`scope`（selected / clicked / double_clicked / 具体 file_id） |
| `event` 操作 | 规则三元组之「操作」（触发求值） | `trigger`（click / double_click / selection_change）；对象来源 = `on` 入边（兼容 `target` 字段） |
| `condition` 条件 | 基础判定 | `expr`（见"条件表达式"） |
| `action` 状态 | 规则三元组之「状态」（显隐/收起/跳转结果） | `op`（show / hide / toggle / collapse / expand / **navigate**）、`target`（面板 / 标签组 / **界面** / **浮层**）、可选 `payload` |
| `overlay` **浮层**（D50/D57；**2026-09 修订：容器、取消浮动控件绑定、增加相对定位**） | **浮层容器**：`interface` 的直接子级，与 `layout_block` **同级**；可 contains **面板与标签组**（标签组再 contains 面板），声明**相对定位**（九宫格锚点 + 偏移）与**外观档位**（阴影/圆角/标签隐藏，取宿主 token）。**不再有「浮动控件」概念**（D56 取消） | `name`（显示名，如「浮层 1」）、`position`（画布坐标）、`visible`（初始显隐，可选）、`height`（**浮层高度参数，1–10，默认 1**，1 最低）、`size`（**框体宽×高 px**：不写 = 默认最小 `240×160`，小于最小值夹紧、非正数或 > 10000 为硬错误）、`anchor`（**九宫格：top_left / top_center / top_right / middle_left / center / middle_right / bottom_left / bottom_center / bottom_right**，缺省 center）、`offset_x` / `offset_y`（**双模式偏移**：`|v| ≤ 1` = 界面宽/高的比例，`|v| > 1` = 像素，可为负）、`shadow` / `radius`（**none / sm / md / lg**，宿主 token 档位）、`hide_label`（隐藏组件标签，布尔） |

边语义（结构 = 界面 ⊃ 布局块 ⊃ 标签组/面板；标签组 ⊃ 面板；面板 ⊃ 类目 ⊃ 对象；界面 ⊃ 浮层；规则 = 对象 → 操作 → 状态，全部连线）：

| 边类型 | 方向 | 含义 |
| --- | --- | --- |
| `contains` | 界面 → 布局块；布局块 → 标签组/面板；标签组 → 面板；面板 → 类目 → 对象；**界面 → 浮层；浮层 → 标签组/面板** | 包含关系（结构描述） |
| `memberOf` | 面板 → 标签组 | （兼容旧图）面板归属标签组 |
| `on` | 对象（面板/类目/对象）→ 操作 | 规则三元组：在对象上发生操作 |
| `fires` | 操作 → 条件/状态 | 操作触发后续求值链 |
| `guards` | 条件 → 状态 | 条件为真才执行该状态 |

#### 浮层节点（`overlay`，D50；2026-09 修订为容器、取消浮动控件）

- **用途**：把"浮在布局之上的一层显示"做成蓝图里可寻址、可显隐的**容器节点**。
- **同级**：与 `layout_block` 同级（都是 `interface` 的直接子级），因此结构上 `ui --contains--> overlay`；界面**不得** contains 面板/标签组/类目/对象（既有层级规则不变）。
- **绑定（D56）已取消**：**不再有「浮动控件」概念**，因此没有 `control_id`、也不需要"绑定某个插件声明的 schema"。
  浮层直接 `contains` **面板**（也可含标签组，标签组再含面板）——**浮层里放什么，就是蓝图里的连线**。
  旧文档里遗留的 `control_id` 字段在解析层被忽略，并在下次保存时清除（`forUserSave`）。
- **容器**：`interface --contains--> overlay --contains--> {面板, 标签组}`；
  浮层**不能** contains 布局块/浮层/类目/对象（类目与对象挂在面板之下），`overlay → 类目/对象` 为硬错误。
- **外观档位（D44 + 2026-09 修订）**：浮层节点声明 `shadow` / `radius`（**none / sm / md / lg**）与
  `hide_label`（隐藏组件标签，布尔）。三者在蓝图里只选**宿主设计 token 档位**，**像素由 `packages/ui`
  的 token 决定**（不写死像素，保证浅色/深色一致）；非法档位在解析层报错（同 `hide_direction` 口径）。
- **相对定位与尺寸（2026-09 用户新增）**：浮层以**界面（宿主内容区）**为参照系定位
  - `anchor`：**3×3 井字**九个位置（上/中/下 × 左/中/右），缺省 `center`。语义是"浮层的对应边/中轴贴住界面的对应边/中轴"。
  - `offset_x` / `offset_y`：**双模式偏移**——`|v| ≤ 1` 视为**界面宽 / 高的比例**（`0.25` = 右移 25%，`-0.5` = 左移 50%），`|v| > 1` 视为**像素**（`24` = 右移 24px，`-16` = 左移 16px）。
  - 计算顺序：锚点对齐 → 叠加偏移 → **越界贴边收拢**（浮层不得溢出界面，与控件标准一致）。
  - `size`：浮层框体**宽×高（px）**。**不写 = 默认最小尺寸 `240×160`**；写了但小于最小值 → **夹紧到最小值**并给软告警（不阻塞保存）；非正数或 > 10000 → 硬错误。**注意与 `height` 区分**：`height` 是**叠放高度参数**（1–10，值大者在上），不是像素高度。
  - 纯函数落在 `packages/config`：`resolveOverlayPosition` / `overlayOffsetToPx` / `anchorAxis` / `resolveOverlaySize`（`pnpm check:blueprint-nodes` 覆盖九宫格基准、比例与像素两种口径、负值、越界贴边、默认最小尺寸与夹紧）。
- **显隐与高度（D57）**：显隐复用既有动作 —— `show` / `hide` / `toggle` 的 `target` 允许指向浮层节点；`visible` 为初始显隐。
  - `height` 是**浮层高度参数（1–10，默认 1，1 最低）**，决定同界面内多个浮层的叠放次序（**值大者在上**）；与像素高度/尺寸无关，像素尺寸仍取 `packages/ui` 设计 token。
  - 全局约束不变：**浮层整体在布局块之上**（布局块 < 浮层），因此 `height` 只在浮层之间比较。
- **运行时语义**：`show` 浮层 = 把它 `contains` 的**面板以浮动方式显示**（已停靠的移入浮动组、不存在则按尺寸浮动创建，**尺寸取 `size` 或默认最小尺寸**），`hide` = 关闭这些面板，`toggle` = 取反（以引擎记录的期望可见态为准）；同时把**浮层容器**的期望可见态告知宿主，由宿主按定位/外观档位渲染容器本身（圆角/阴影/标签隐藏）。
- **初始显隐必须被对账**（缺陷修复）：`visible` 不能只是数据——装载蓝图 / 套用布局 / 切换层时，引擎按蓝图对账一次：`visible === true` 且从未显示过 → 显示；之前显示过而蓝图改成不显示 → 隐藏；`visible !== true` 且从未显示过 → **什么都不做**（不去关掉使用者布局里本来就有的面板），并且**幂等**（状态未变不重复执行）。
- **校验**：`overlay` 作为 `interface` 的 `contains` 目标为**合法**（与布局块同级）；`overlay → 面板/标签组` 为**合法**（容器）；`show`/`hide`/`toggle` 指向浮层为**合法**；`collapse`/`expand`/`navigate` 指向浮层为**硬错误**；`height` 超出 1–10、外观档位非法、`size` 非正数或超上限为**硬错误**；**未连接到界面**（缺 `界面 --contains--> 浮层`）= **未接通（软告警）**，空浮层不再是"未接通"，两者都可保存。
- **连接是显示的前提**（缺陷修复）：浮层必须由**界面** `contains` 才"属于本页"。断开 `界面 → 浮层` 的连接后，运行时会把它**收起来**（关闭其内容面板），
  且**不再响应显示动作**（`show`/`toggle` 指向未连接的浮层不执行，日志给出"未连接到界面（未接通）"）；重新连上即恢复。画布也会把该浮层灰显为未接通。
- **实现状态**：**已实现**（模型 + 校验 + 画布端口 + 属性面板 + 引擎显隐动作 + 浮动面板驱动）。`hp-core` 的 `NodeType` 与前端枚举已加入 `overlay`，
  新增 `TokenLevel`（none/sm/md/lg）承载 `shadow`/`radius`；画布上浮层既有输入端口也有输出端口，**选中浮层后新增面板/标签组即落进浮层**（`contains`，与"只连上级"规则一致）。
  **浮层容器本身的渲染**（把内容面板按圆角/阴影/标签隐藏包成一层浮层）**已于 2026-09 落地**：引擎把「期望可见态 + 内容面板 + 外观档位」交给宿主，
  宿主按 `packages/ui` 的 token 装饰 dockview 浮动窗口（`apps/desktop/src/app_ui/shared/overlayChrome.ts`）；缺省档位取 `md`，与既有浮动窗口观感一致（未声明档位 = 零视觉变化）。

#### 分层（Layer，D51–D60）

- **一个层 = 一个子蓝图 = 一张画布 = 一个界面（页面）**。蓝图文档由**多个层**组成，层名**可自定义**、**蓝图内唯一**（D60），**层名即该层界面的显示名**。
- **作用域**：一个蓝图控制**一个仓库**的界面与**面板**跳转（决策 2/4 不变）；层是蓝图**内部**的组织方式，因此**层不新增数据库列、不新增表**（`repo_id` 属于蓝图行）。
- **命名**：蓝图名（`blueprints.name`，配置文档名）与层名**互相独立**；跳转候选显示层名，层名唯一保证候选无歧义（D60）。
- **每层的根**：有且仅有一个 `interface` 节点（该层的结构根）；层内的其它节点（布局块、标签组、面板、类目、对象、浮层、规则节点）都归属该层。
- **跨层跳转**：`navigate` 指向**目标层**内的界面节点（界面与层 1:1，等价于"跳到某层"）。
- **每层一份布局（D53）**：面板布局（位置/大小/分组结构）**按 `(repo_id, workspace, layer_key)` 各存一份**；切换层 = 切换该层的布局快照；保存布局写的是**当前层**那一份。层与布局是 **1:1**，不做"共用一份再叠加"。
- **当前层按仓库持久化（D54）**：应用记住每个仓库的**当前层**（会话态 + 持久化），重启回到该层；多窗口各自读取同一记录（后写覆盖）。`navigate` 的幂等性以"当前层"为判据。
- **层的删除（D55）**：**删除层 = 直接删除该层**（连同层内节点），语义**类似删除蓝图**，不是软删除；**禁止删除最后一层**（至少保留一层）。
- **界面节点被单独删除（D55）**：`interface` 节点的删除与其它节点**一致走软删除**；软删后该层成为**无根层**（等于"无此界面"），此时该层为**未接通（软告警，不阻塞保存）**，指向它的 `navigate` **跳转失效**（同样软告警，不执行）。
- **JSON 形态**（目标态）：

```jsonc
{
  "schema_version": 2,
  "layers": [
    { "key": "l_browse", "name": "浏览层" },
    { "key": "l_edit",   "name": "编辑层" }
  ],
  "nodes": [
    { "key": "ui_browse", "type": "interface", "layer": "l_browse", "position": { "x": 40, "y": 40 } },
    { "key": "ui_edit",   "type": "interface", "layer": "l_edit",   "position": { "x": 40, "y": 40 } }
    // …其余节点同样带 layer 字段
  ],
  "edges": [ /* 边不带 layer：由端点所属层推导；跨层只允许 navigate 目标引用 */ ]
}
```

- **兜底与兼容（D51/D58）**：
  - **仅当 `layers` 缺失或为空**时，按**单层文档**兜底（层名取 `interface.name`，无则「主界面」）；
  - `layers` 存在但**某个节点缺 `layer`** → **硬错误**（不静默压成单层，否则会摧毁多层结构）；
  - **v1 旧文档**加载时在 Rust 侧**一次性迁移**：每个 `interface` 自动拆为一个层（层名取该 `interface.name`，缺省「界面 N」），迁移后回写为 v2（D58）。
- **与模板的关系**：模板同样整文档复制，**层一并复制**（复制后与模板脱离）；安装/新建时把文档**归一化到当前 `schema_version`** 并同步版本列。

条件表达式（基础集，一期固定，不支持任意表达式）：

```text
media_type == image | video | audio         # 条目媒体类型
selection != empty                           # 存在选中/被单击对象
rating >= 0..5                               # 当前对象评分阈值
has_tag == <tag_name>                        # 当前对象含某人工 tag
```

### 2. 存储：仓库库 `blueprints` 表 + 全局库 `blueprint_templates` 表（对齐 D1 的 `panel_layouts` 先例）

- 仓库库新增迁移 `0006_blueprint.sql`；蓝图文档整存 `blueprint_json`（含图结构与 schema 版本），**save = 整文档替换**（与 `layout.save` 一致），不做节点/边的逐行 CRUD。
- **版本权威（D58）**：以**文档内的 `schema_version` 为权威**，数据库 `schema_version` 列必须**同步写入**（`blueprint.create` / `blueprint.save` / `template.install` 都必须写当前版本，不得依赖列默认值）；写库前统一走 `hp_core::normalize_document`——它把低版本文档迁移到当前版本，并在**文档缺 `schema_version` 字段时补上**（否则列写 2、文档没有版本，"文档内版本为权威"就不成立）；`default_version`（内置默认图版本）与文档 schema 版本**解耦**，各自独立演进。
- **每层一份布局（D53）**：`panel_layouts` 由 `(repo_id, workspace)` 扩展为**按层各存一份**（全局迁移 `0004_layout_layers.sql` 新增 `layer_key` 维度 + 唯一索引）；`layout.save` 写**当前层**那一份，`layout.apply` 套用当前层的布局。布局 → 蓝图绑定见全局迁移 `0003_layout_blueprints.sql`（`panel_layouts.blueprint_ids_json`）；**这两列的权威定义在 `docs/spec/database-schema.md`**，本节 SQL 块只覆盖蓝图自己的两张表。
- 全局配置库新增迁移 `0002_blueprint_templates.sql`，模板同样整文档存储。
- `is_default` 标记每仓库唯一默认蓝图（部分唯一索引）；无默认时由**消费层（前端运行时）**回退到**内置默认蓝图**（`packages/config` 的 `DEFAULT_BLUEPRINT` 常量，随应用分发）并在装载时补种为库存默认——命令层 `blueprint.getDefault` 只返回库存行，**不做**常量回退（避免在 Rust 侧复制一份默认图）。
- 节点 `position {x, y}` 一期随文档落库（供节点画布编辑器直接使用，避免二次迁移）。
- 两张表的 `schema_version` **列默认值 1 只是历史遗留**：迁移文件 forward-only 不改默认值，所有写库路径都必须显式写入版本（上一条已保证）。

```sql
-- 仓库库 migrations/repo/0006_blueprint.sql（**权威文本以该迁移文件为准**）
CREATE TABLE IF NOT EXISTS blueprints (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,               -- 按仓库隔离（D30）；is_default 每仓库唯一
  name           TEXT NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  blueprint_json TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blueprints_repo ON blueprints(repo_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blueprints_default
  ON blueprints(repo_id, is_default) WHERE is_default = 1;

-- 全局库 migrations/global/0002_blueprint_templates.sql（模板应用级共享，无 repo_id）
CREATE TABLE blueprint_templates (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  blueprint_json TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

蓝图图文档结构（示意，默认蓝图示例见后文）：

```jsonc
{
  "schema_version": 2,
  "layers": [
    { "key": "l_main", "name": "主界面" }
  ],
  "nodes": [
    { "key": "ui",        "type": "interface", "layer": "l_main", "position": { "x": 40, "y": 40 } },
    { "key": "blk_center", "type": "layout_block", "name": "中栏", "layer": "l_main", "position": { "x": 460, "y": 170 } },
    { "key": "c_preview", "type": "control", "panel_id": "media",  "title_key": "panel.media", "layer": "l_main" },
    { "key": "c_viewer",  "type": "control", "panel_id": "viewer", "title_key": "panel.viewer", "layer": "l_main" },
    { "key": "k_image",   "type": "class",   "control": "c_preview", "media_type": "image", "layer": "l_main" },
    { "key": "o_item",    "type": "object",  "class": "k_image", "scope": "double_clicked", "layer": "l_main" },
    { "key": "g_viewers", "type": "group",   "mode": "exclusive", "default_visible": [],
      "hide_direction": "left", "position": { "x": 0, "y": 0 }, "layer": "l_main" },
    { "key": "e_dbl_image", "type": "event", "trigger": "double_click", "target": "o_item", "layer": "l_main" },
    { "key": "a_show_viewer", "type": "action", "op": "show", "target": "c_viewer", "layer": "l_main" }
  ],
  "edges": [
    { "from": "ui", "to": "blk_center", "kind": "contains", "order": 1 },
    { "from": "blk_center", "to": "c_preview", "kind": "contains", "order": 2 },
    { "from": "c_preview", "to": "k_image", "kind": "contains", "order": 3 },
    { "from": "k_image", "to": "o_item", "kind": "contains", "order": 4 },
    { "from": "e_dbl_image", "to": "a_show_viewer", "kind": "fires", "order": 5 },
    { "from": "c_viewer", "to": "g_viewers", "kind": "memberOf", "order": 6 }
  ]
}
```

> 单层文档可省略 `layers` 与各节点的 `layer`（加载时兜底为一个层）；**多页面必须显式分层**。

### 3. 求值语义：事件驱动、确定性、幂等

- 事件触发后，从事件节点沿 `fires` 边收集求值链（按 `order` 排序），逐条：条件节点求值 → 动作节点执行。**默认全部匹配**（与顺序无关地执行所有可达且条件为真的动作）；"首个匹配"策略列入开放点。
- `show` / `hide` / `toggle` 幂等；重复触发不产生抖动。
- **互斥组 = 标签激活互斥**：互斥组不自动隐藏成员。同 dockview 组的多个成员共享一个显示区域，dockview 标签激活天然保证同一时间仅一个激活（其余为未激活标签，仍保留）；**跨 dockview 组的成员不做自动隐藏/收缩**（避免把用户布局里的面板/组弄丢）。如需隐藏/收起某面板，请使用显式的 `hide` / `collapse` 动作节点。`default_visible` 保留为编辑器语义字段，不参与运行时自动隐藏。
- **组收起（组的隐藏）**：`collapse` 组 = 将该组收起为**最小尺寸**（正文 6px、标签条保留，D25），**组结构不删除**（非关闭/移除面板）；释放的空间按该组 `hide_direction` **让给相邻组（拉伸）**；`expand` = 恢复收起前的尺寸分布。
  > **实现注记（2026-09）**：运行时目前只做"把本组压到 `PANEL_MIN_SIZE`，由 dockview 网格吸收释放的空间"，**没有**按 `hide_direction` 选择吸收邻居——精确邻居选择仍属"实现期开放点"（D29 的验收条款需要它，见 `decision-checklist.md`）。`expand` 恢复的是**本实现记录的收起前尺寸**（收起/展开共用同一份尺寸记忆，`blueprintLayout.collapseGroup` / `expandGroup`），不是"恢复网格分布快照"。
- **隐藏方向**：`hide_direction` ∈ `left` / `right`（沿 x 轴）/ `up` / `down`（沿 y 轴）/ `toward:<groupKey>`（指向具体邻居）。**若该组位于两组中间**（如 `A | B | C`），方向向左 → 左侧邻居 A 拉伸吸收 B 释放的空间，右侧 C 不动；方向向右 → C 吸收。`toward:` 用于非对称/多邻居场景精确指定吸收者。
  > **实现注记（2026-09）**：模型、校验（`toward:` 必须指向组）、编辑器（下拉 + 同层标签组候选）与悬空引用清理都已实现，**运行时尚不读取该字段**（见上一条与"实现期开放点"）。
- **位置（x/y）**：组节点 `position {x, y}` 记录目标锚点——节点画布编辑器中的节点定位与浮动组/收起标签条的停靠锚点（运行时映射见"实现期开放点"）。
- 对 dockview 的动作映射：`show` = 面板已存在则激活，否则按 `panel_id` 创建（默认**停靠**加入，`payload.floating = true` 时浮动创建）；`hide` = **收起至最小尺寸**（正文 6px、标签条保留，不销毁面板/标签；见"决策 3"与开放点，**不是关闭**）；`toggle` 对面板 = 存在则关闭、不存在则显示，对标签组 = 收起/展开**取反**；`collapse` / `expand` = 组最小化/恢复（`PANEL_MIN_SIZE` 约束 + 分隔条按 `hide_direction` 移动，实现细节见开放点）。**显隐/收起状态与 `layout.*` 对账**：套用布局或切换蓝图时，按默认蓝图语义重算一次，防止漂移。
  > **实现注记（2026-09）**：对账**只作用于当前层**（D51/D54），并且目前对账的是①互斥组 `default_visible` 的标签激活、②浮层 `visible` 的初始显隐、③图中**可达**的 `collapse`/`expand` 动作声明的组收起态。第③条是"静态套用"而非事件驱动（与"事件触发才执行"的严格语义有出入），列为开放点（改为仅在事件触发时改状态）。
- **界面跳转（`navigate`）**：动作 `navigate` 的目标是**界面节点**，表示切换到该页面（层）。跳转属**页面级**操作，与显隐/收起正交：切页时目标层按自身结构对账一次显隐与组收起状态。跳转是**幂等**的（已在该层则无操作），"当前层"**按仓库持久化**（D54）。页面栈/返回语义见"实现期开放点"。第一版**默认蓝图不含跳转规则**（只有单层 `主界面`），多页面由用户在编辑器中新增层与跳转规则自建。
- 蓝图无效时**不落库**（保存前 `blueprint.validate` 拒绝）；**装载**时先做**解析层校验**（取值域与结构，前端 `parseBlueprintDocument`），无效 → 回退内置默认蓝图并**向用户提示**（`blueprint.fallbackInvalid` / `blueprint.fallbackFailed`）。

### 4. 作用域：定义按仓库、模板应用级

- `blueprints` 在仓库库中，天然按仓库隔离（同 D23：解释数据按仓库独立）；两个仓库的蓝图互不可见。
- `blueprint_templates` 在全局配置库，应用级共享；`blueprint.template.install` 把模板 JSON **复制**进仓库（复制后与模板脱离，模板后续修改不影响已复制蓝图）。

### 5. 默认蓝图：随仓库初始化写入，复现现状行为

仓库创建时写入内置默认蓝图（或首次读取时惰性落库）。默认蓝图内容（复现当前 app_ui 硬编码联动）：

```jsonc
{
  "schema_version": 2,
  "layers": [
    { "key": "l_main", "name": "主界面" }
  ],
  "nodes": [
    { "key": "ui", "type": "interface", "layer": "l_main", "position": { "x": 460, "y": 40 } },

    { "key": "blk_left",   "type": "layout_block", "name": "左栏", "layer": "l_main", "position": { "x": 40,  "y": 170 } },
    { "key": "blk_center", "type": "layout_block", "name": "中栏", "layer": "l_main", "position": { "x": 460, "y": 170 } },
    { "key": "blk_right",  "type": "layout_block", "name": "右栏", "layer": "l_main", "position": { "x": 880, "y": 170 } },

    { "key": "c_preview", "type": "control", "panel_id": "media",   "title_key": "panel.media" },
    { "key": "c_viewer",  "type": "control", "panel_id": "viewer",  "title_key": "panel.viewer" },
    { "key": "c_player",  "type": "control", "panel_id": "player",  "title_key": "panel.player" },
    { "key": "c_meta",    "type": "control", "panel_id": "metadata","title_key": "panel.metadata" },

    { "key": "k_image", "type": "class", "control": "c_preview", "media_type": "image" },
    { "key": "k_video", "type": "class", "control": "c_preview", "media_type": "video" },
    { "key": "k_audio", "type": "class", "control": "c_preview", "media_type": "audio" },

    { "key": "o_img",  "type": "object", "class": "k_image", "scope": "double_clicked" },
    { "key": "o_vid",  "type": "object", "class": "k_video", "scope": "double_clicked" },
    { "key": "o_aud",  "type": "object", "class": "k_audio", "scope": "double_clicked" },
    { "key": "o_sel",  "type": "object", "class": "k_image", "scope": "clicked" },

    { "key": "g_viewers", "type": "group", "mode": "exclusive", "default_visible": [],
      "hide_direction": "left", "position": { "x": 0, "y": 0 } },

    { "key": "e_dbl_img", "type": "event", "trigger": "double_click", "target": "o_img" },
    { "key": "e_dbl_vid", "type": "event", "trigger": "double_click", "target": "o_vid" },
    { "key": "e_dbl_aud", "type": "event", "trigger": "double_click", "target": "o_aud" },
    { "key": "e_click_img", "type": "event", "trigger": "click", "target": "o_sel" },

    { "key": "c_img_cond", "type": "condition", "expr": "media_type == image" },

    { "key": "a_show_viewer", "type": "action", "op": "show", "target": "c_viewer" },
    { "key": "a_show_player", "type": "action", "op": "show", "target": "c_player", "payload": { "play": true } },
    { "key": "a_show_meta",   "type": "action", "op": "show", "target": "c_meta" }
  ],
  "edges": [
    { "from": "ui", "to": "blk_left",   "kind": "contains", "order": 1 },
    { "from": "ui", "to": "blk_center", "kind": "contains", "order": 2 },
    { "from": "ui", "to": "blk_right",  "kind": "contains", "order": 3 },

    { "from": "e_dbl_img", "to": "a_show_viewer", "kind": "fires", "order": 4 },
    { "from": "e_dbl_vid", "to": "a_show_player", "kind": "fires", "order": 5 },
    { "from": "e_dbl_aud", "to": "a_show_meta",   "kind": "fires", "order": 6 },
    { "from": "e_click_img", "to": "c_img_cond",  "kind": "fires", "order": 7 },
    { "from": "c_img_cond", "to": "a_show_meta",  "kind": "guards", "order": 8 },

    { "from": "c_preview", "to": "k_image", "kind": "contains", "order": 9 },
    { "from": "k_image",   "to": "o_img",   "kind": "contains", "order": 10 },
    { "from": "g_viewers", "to": "c_viewer", "kind": "contains", "order": 11 },
    { "from": "g_viewers", "to": "c_player", "kind": "contains", "order": 12 },
    { "from": "g_viewers", "to": "c_meta",   "kind": "contains", "order": 13 }
  ]
}
```

> ⚠️ **上例是"结构示意（12 节点 / 13 边）"，不是真实内置默认图。**
> 真实内置默认蓝图是 **27 节点 / 26 边**（`default_version` 当前 = 7，单层「主界面」），权威来源只有一个：
> **`packages/config/src/blueprint.ts` 的 `DEFAULT_BLUEPRINT` 常量**，其 JSON 由 `pnpm generate:blueprint-fixture`
> 导出为 `crates/hp-store/tests/default_blueprint.json`（Rust 侧 `include_str!` 引用，测试断言 27/26）。
> 本节示例仅用于说明**字段与边形状**（含 `overlay` 目标类型等目标态字段），**不得据此落库**；
> 真实结构以「实现注记（零回归）」与上述常量为准。

行为（与现状一致）：双击预览中的图像 → 显示图像查看器（同 dockview 组则激活其标签、其余标签保持未激活，跨组面板不动）；双击视频 → 显示播放器；双击音频（一期占位）→ 显示元数据。**互斥组 = 标签激活互斥：同一 dockview 组同一时间仅一个激活，其他标签保留（"一个组多个标签页只能显示一个、其他默认隐藏"的落地形态），不自动隐藏跨组面板。** 组级收起/拉伸（`collapse`/`expand` 动作）由用户在编辑器中按需添加，默认图不强制。

> 上例为**单层**结构示意（`layers` 仅一项「主界面」，全部节点归属 `l_main`；示例为省篇幅只在首部节点上标出 `layer`，落库时**每个节点都带该字段**）。

> **实现注记（零回归）**：内置默认蓝图（`packages/config` 的 `DEFAULT_BLUEPRINT`，`default_version` 当前=7）**如实表达当前默认「媒体-测试」布局**：**单层**（`layers = [{key:"l_main", name:"主界面"}]`，每个节点都带 `layer: "l_main"`）内顶层为界面节点 `ui`；左栏（区域）＝仓库/媒体源/相册三个独立面板，布局块直接连三个面板；中栏（区域）＝一个标签组 `g_media`（成员：媒体预览/查看器/媒体播放器），媒体预览内部再分 图像/视频/音频 类目→对象；右栏（区域）＝**只有一个标签组** `g_inspector`（成员：色彩参考 / 标签·评分 / 元数据，三者同属一个 dockview 标签组）——即右栏**没有**"单面板直连布局块"的成员；**标签组优先**：布局块只连**标签组**（成员由标签组 `contains`）与**单面板**；一栏内同时存在"单面板 + 标签组"时，两者都直接挂在布局块下。界面节点只连布局块（`ui → blk_left/blk_center/blk_right`）；界面显示名取自**层名**（界面节点不再另存 `name`）。规则三元组（对象→操作→状态，全部连线）：双击 图像·双击对象 → 显示 查看器；双击 视频 → 播放器并播放；双击 音频 → 元数据。节点 `position` 按栏分列排布、互不重叠（Rust 测试 `default_blueprint_nodes_do_not_overlap` 守住该不变量）；夹具由 `pnpm generate:blueprint-fixture` 从 TS 常量生成，不在两侧手工维护。旧版内置默认由引擎按 `default_version` 自动升级（v5 → v6 引入界面节点、v6 → v7 引入分层）；用户一旦在编辑器保存即移除该标记（`forUserSave`），此后不再被自动升级覆盖。不保留旧模式兼容。

### 6. 校验：服务端 `blueprint.validate`（硬错误 + 软告警）

编辑器保存前先校验（也作为命令独立暴露）。校验分两级：

**硬错误（拒绝保存）**：

- 节点 `key` 重复、`key` 为空。
- 悬空边（边端点不存在）、重复边、非法边（端点类型与边类型不匹配）。
- 未知节点类型 / 未知 `op` / 未知 `trigger` / 未知 `expr` / 未知 `hide_direction`（解析层）。
- **环**：`fires`/`guards` 子图必须无环（求值链为 DAG）。
- 互斥组内 `default_visible` 多于一个成员。
- 引用**存在但类型不符**：类目 `control` 指向非面板、对象 `class` 指向非类目、动作 `target` 与 `op` 不匹配、组 `default_visible`/`hide_direction` 指向错误类型。
- 类目 `media_type` 不在 image/video/audio；对象缺 `scope`；组缺 `mode`；条件缺 `expr`。
- **schema 版本**：`schema_version > 当前版本` → 硬错误（`>`，**不是** `!=`）；`< 当前版本` → 先走**迁移**（D58），迁移后再校验，不得直接拒绝。
- **界面节点唯一性（按层）**：**每层至多一个** `interface` 节点（同层出现两个 → 硬错误）；"某层没有 `interface`"（被软删除）**不是硬错误**，按未接通处理（见软告警）。蓝图可有多个层，因此可有多界面（多页面，D51）。
- **界面层级**：`contains` 边只能由界面指向**布局块 / 浮层**、布局块指向**标签组/面板**、**浮层指向标签组/面板**、标签组指向**面板**、面板指向**类目**、类目指向**对象**；界面不得直接连标签组/面板/类目/对象，浮层不得 contains 类目/对象。（浮层分支随 D50 落地，2026-09 修订为容器。）
- **界面跳转**：`navigate` 的 `target` 存在时必须指向**界面节点**（指向其他类型为硬错误）；指向已删除的界面属**未接通（软告警，`warnings`）**。
- **浮层（`overlay`，D50，**2026-09 修订为容器**）**：作为 `interface` 的 `contains` 目标为合法，且可 contains **面板/标签组**；`show` / `hide` / `toggle` 指向浮层为合法，`collapse` / `expand` / `navigate` 指向浮层为硬错误；`height` 不在 1–10 为硬错误；`size` 非正数或超过 10000 为硬错误；外观档位 `shadow`/`radius` 不在 none/sm/md/lg 为硬错误（解析层）。
  > `control_id` 属**已取消**的「浮动控件」绑定（D56），模型与校验里都已不存在该字段；旧文档里的遗留字段在保存时被清除（`forUserSave`），**不再有任何相关软告警**。
- **分层（`layers`，D51/D58，**已实现**）**：层 `key` 唯一且非空、层 `name` 非空且**蓝图内唯一**（D60）、至少一层；节点 `layer` 必须指向存在的层。**`layers` 缺失/为空**才按单层兜底；**`layers` 存在而某节点缺 `layer` → 硬错误**（不静默压成单层）。**跨层只允许 `navigate` 引用**：同一层内的 `contains`/`memberOf`/`on`/`fires`/`guards` 端点必须同层，跨层即硬错误（跳转除外）。
- **解析层校验（前端 `parseBlueprintDocument`，装载路径用）**：取值域非法（未知节点类型 / `op` / `trigger` / `mode` / `media_type` / `hide_direction` / 浮层锚点与外观档位 / 边类型）、结构不是对象、`nodes`/`edges`/`layers` 类型不对、`schema_version` **高于**当前版本 → 视为无效文档。装载时发现无效 → **回退内置默认蓝图并向用户提示**（决策 3）；**业务级**硬错误（悬空边、环、引用类型不符、每层界面数…）仍由服务端 `blueprint.validate` 在保存前判定。

**软告警（`BlueprintGraph::warnings`，不阻塞保存）**——即"未接通"：

- 必填引用**缺失或指向已删除节点**：面板缺 `panel_id`、类目缺 `control`、对象缺 `class`、状态缺 `target`。
- 求值链缺触发来源：操作无 `on` 入边且无 `target`；条件无 `fires` 入边；状态无 `fires`/`guards` 入边。
- **无根层（D55）**：某层的 `interface` 节点被**软删除**后，该层没有根 → 该层标记"未接通"（等于"无此界面"），**不阻塞保存**。
- **跳转失效（D55）**：`navigate` 指向的界面节点已被软删除 / 该层无根 → 软告警，运行时不执行该跳转。
- **浮层未连接到界面（D50 修订）**：没有 `界面 --contains--> 浮层` 这条边时，该浮层"未接通"（软告警，不阻塞保存）；运行时不显示它、也不响应指向它的 `show`/`toggle`，断开连接时把内容收起来。
  > 原「浮层未绑定（D56）：`overlay.control_id` 缺失或指向的浮动控件 schema 不存在」已随「浮动控件」概念一并取消——浮层直接 contains 面板，不存在需要绑定的外部 schema。

分级的理由：删除节点/断线后应允许先存下**中间状态**（关联节点保留、画布灰显"未接通"），
而不是逼用户一次接完；同时"引用类型不符"这类**数据错误**仍必须拦住。

> 注：`panel_id` 是否在当前面板注册表内、`hide_direction: toward:<groupKey>` 引用的组是否存在，由前端编辑器与画布交互负责（后端只校验结构与类型），据此避免后端耦合面板注册表。

### 7. 编辑器形态：节点式（画布式拖拽连线，仿 ComfyUI）

蓝图编辑器**自 M6 阶段一即为节点式**（无"过渡编辑器"形态），视觉与交互风格**仿 ComfyUI**：

- **层切换（D51/D54，目标态）**：画布同一时刻只渲染**一个层**（一张画布 = 一个层 = 一个界面）；工具栏提供层下拉/标签切换，并支持**新增层、重命名层、删除层、层排序**。**层名即该层界面的显示名**（改名即改界面显示名；层名蓝图内唯一，D60）；**当前层按仓库持久化**（D54）。**删除层 = 直接删除该层（含层内节点），语义类似删除蓝图**（非软删除；禁止删除最后一层，D55）。
- **界面节点的删除（D55）**：与其它节点一致走**软删除**；软删后该层成为**无根层**（未接通软告警），指向它的 `navigate` 跳转失效（同样软告警，不执行）。
- **节点画布**：深色画布 + 点阵网格背景，支持平移与缩放（滚轮）；**中键按住拖动 = 平移画布**（空白处左键拖动同样平移）。节点为圆角矩形卡片，按类型着不同颜色头部，标题为节点局部名，正文展示关键字段摘要。**新增节点落在当前渲染画布的视口中心附近**（按 `viewportCenterToWorld` 把视口中心反解为世界坐标，再找不冲突的空槽），不落到隐藏区域。画布**右下角有小地图**（`BlueprintMinimap`）：缩略**当前层**全部节点/连线（与画布同一色板，未接通同样灰显）、叠加**视口指示框**，**拖动小地图即把视口中心移到该处**；图例相应移到**左下角**（不再与小地图抢右下角）。
- **端口连线**：节点左侧为**输入端口**、右侧为**输出端口**（ComfyUI 式小圆点）；从输出端口拖拽到兼容输入端口建立边，**边类型按端口类型自动判定**（`contains` / `memberOf` / `fires` / `guards`）；边以 SVG 贝塞尔曲线绘制并按类型着色；点选边高亮、可删除。
- **节点属性面板**：只暴露**本节点必须设定**的字段；**key 型引用默认只读展示并标注「自动」**，由上级节点/连线推导（用户不手填 key）。各类型可编辑项：界面=（显示名取自层名，节点上不另存）；布局块=名称；面板=面板；类目=媒体类型；对象=作用范围；组=模式/默认可见成员/隐藏方向/位置；操作=触发；条件=表达式；状态=**动作 + 目标（手动指定）** + 载荷。状态目标按 `op` 给合法候选（显示/隐藏→面板/浮层，收缩/展开→标签组，切换→面板/标签组/浮层，**跳转→界面**），候选名称用**本地化显示名**（面板→面板标题、标签组→自定义名/「标签组 N」、界面→层名、浮层→自定义名/「浮层 N」），不暴露裸 key，且候选按**同层**过滤（`navigate` 例外——它本就是跨层跳转，跨层引用是硬错误）。`node.key` 自动生成：优先「上级 key + 自身类型标识」（如 `c_media` 下的图像类目 → `c_media_image`，其下双击对象 → `c_media_image_dbl`），冲突才追加序号。在画布上**连线的同时**会把子节点的引用字段落好（界面→布局块 写结构边、面板→类目 写 `control`、类目→对象 写 `class`、对象→操作 写 `target`）；状态的 `target` **只由属性面板手动指定**——边类型表里没有"指向界面"的边，因此 `navigate` 的目标不可能由画布连线产生。
- **新增节点只追加自身，不跨链路挂钩、也不连带补链**（**2026-10 缺陷修复**）：点一次"新增"只落下**那一个节点**——**不再**为了"补最小合法链路"顺手新建 面板/类目/对象/操作/状态（旧行为里新增"状态"会一次冒出 4 个辅助节点、新增"操作"会冒出 5 个，表现为"点一个类型却出现好几个节点"）。上级只认**使用者显式指定**（选中某节点后新增，或直接拖线）；没有上级时**引用留空**（缺 `control`/`class`/`target` 或求值链缺来源）→ 画布灰显「未接通」，由使用者拖线或在属性面板指定，而不是自动猜。只有**层级关系**（类目→面板、对象→类目）允许在**同层内**兜底复用**既有**父节点——复用只填引用字段，**同样不新建节点**。状态的 `target` 不再自动指向"图里第一个面板"，只由属性面板指定。
- **补充节点的层级位置（2026-10-10 用户口径；同日更正）**：**子类**的结构父是**类目**（"子类是类目的细分"）、**标记**的结构父是**面板**（"标记和类目平行，功能相似"）。两者在功能链路里都是**补充节点**（不是必要节点，可以完全没有）。
  **更正（关键）**："**子类节点可以随意创建，所有节点都可以随意创建，只规定连接方式和层级**"。因此：
  - **创建一律放行**——任何类型在任何时机都能落下来（**空图上 12 种类型全部可创建**），**永不拒绝、没有置灰**；
  - **层级约束体现在"连接方式"上**：结构位置由定义表的 `parents`/`children` 声明，画布连线（`containmentAllows`）与后端（`can_contain`）据此判**非法边**；
  - **新增时顺手挂载**：有可用父级就自动挂上（显式选中优先，其次同层兜底复用**既有**父节点，**不新建节点**）；**没有就留空引用**（画布灰显「未接通」），由使用者拖线或属性面板补上。
  早前版本曾在"层内无可用父级"时**拒绝新增**（调色板置灰），那是把**层级约束误当成创建许可**——会打断"先摆节点、后连线"的正常搭图顺序，已更正（D105）。
- **子类优先：类目链路自动排除已被子类定义的情况（2026-10-10 用户口径）**：类目链路（类目→对象→操作→状态）与子类链路（类目→子类→对象→操作→状态）**可以并存**；因为**子类是子集、只负责一种情况**，所以当某细分已有子类蓝图链路时，**类目中无子类的链路自动排除该细分**。运行期判据 = 该类目**减去已被子类认领的 `format`**（子类的 `subclass` 字段或 `class --contains--> subclass` 边指向该类目）：`text` 类目下建了 `txt` 子类后，`txt` 条目只走子类链路，`epub`/`md`（无对应子类）仍走类目链路；删掉子类后同一 `txt` 上报**回落到类目链路**（不丢行为）。
- **新建蓝图自带结构骨架**：按**当前布局**生成「界面 → 布局块 → 标签组 → 面板」（骨架生成**一个**界面节点作为当前页面的根；多页面由用户自行新增界面节点）；面板上有「带当前布局结构」勾选项（默认开），取消则从空图起步。骨架生成见 `blueprintStructure`，**跨窗口**取布局结构：主窗口订阅 `onDidLayoutChange` 把结构快照发布到共享存储（共享宿主对象自定义事件 + `localStorage`），因此开在**独立窗口**的蓝图面板也能拿到（那里没有 dockview 实例）。
- **节点名称**：节点为"包装"的独立单元，含可选 `name` 显示名字段；缺省时前端按类型本地化生成（如「界面」「面板 1」「事件 2」，随语言切换），用户可在属性面板自定义。
- **位置持久化与一键整理**：节点拖拽摆放 `position {x,y}` 落库，**拖拽结束/整理后自动持久化**（静默保存整文档）；工具栏「整理」以**选中节点为起始节点**，沿边（任意类型）BFS 分层**树状展开**布局。整理有三条硬约束（2026-10-10 用户口径）：①**起始节点位置不变**（旧实现把根固定落在世界原点，表现为"整理后选中节点跳回原点"）；②**上下间距加大、节点不拥挤不重叠**（同层间距 ≥ 节点卡片高 + 余量，落位时避让任何已占用位置，**包括不参与整理的孤立节点**）；③间距差异**仅限整理**——新增节点的槽位分配口径不变。
- **工具栏「刷新」**（2026-10-10 用户要求）：重新对齐**派生状态**（未接通灰显 / 连线端口位置 / JSON 文本），**不改动文档内容**。派生状态本应随文档变化自动重算；这条按钮是兜底——用户反馈"连线后节点状态仍显示未接通，要刷新一下才对"，根因是连线时**边**与**引用字段**分成两次编辑、后一次基于同一份旧文档把前一次覆盖掉（已修：`onConnect` 改为在**一份文档**上原子落好边 + 引用字段）。
- **连线即刷新**（缺陷修复）：画布不再"先 `onChange` 加边、再回调 `onConnect` 改引用"，而是把两件事交给**同一次原子编辑**完成，因此连线后节点状态（未接通灰显）**立即**正确，不需要手动刷新。
- **JSON 视图**：仅作辅助核对与批量编辑，不再是主编辑形态。
- 保存前调用 `blueprint.validate`，失败不保存并给出错误列表。

## 运行时集成（前端）

- **BlueprintEngine**（`apps/desktop/src/app_ui/core/`，职责单一文件）：加载当前仓库默认蓝图 → 提供 `dispatch(trigger, targetRef)` 入口 → 求值 → 输出 dockview 操作序列（面板激活/关闭 + 组收起/展开）→ 由 `DockController` 执行并维护显隐/收起状态。
- 事件源接线：
  - `MediaPreviewPanel`：条目单击 / 双击时，把 `{ media_type, file_id }` 与 trigger 发给引擎（取代现有硬编码联动）。**选中变化（`selection_change`）已上报**：单击/多选后异步取 `rating` 与人工/自动 tag 名作为 `context`（令牌防过期），供 `rating >=` / `has_tag ==` 条件求值。
  - 查看器 / 播放器 / 元数据：不再自行决定"谁显隐/是否收起"，只消费引擎发来的激活/数据指令（播放指令仍走 `media.*`）。
- dockview 映射：`show` → 面板存在则激活，不存在则按 `panel_id` 创建（默认**停靠**加入，`payload.floating = true` 时浮动）；`hide` → **收起至最小尺寸（`setSize(PANEL_MIN_SIZE)`，不销毁面板/标签；网格约束下失败也不关闭）**；`toggle` → 面板按"存在则关闭 / 不存在则显示"，标签组按记忆态收起/展开取反；`collapse` / `expand` → 组最小化/恢复（`PANEL_MIN_SIZE` 约束 + 分隔条按 `hide_direction` 移动，实现细节见开放点）。**套用布局后按默认蓝图对账一次显隐与收起状态**（只对当前层）。
- **装载即校验**：`blueprintRuntime` 用 `BlueprintEngine.parse`（= `packages/config` 的 `parseBlueprintDocument`）做**解析层校验**；无效 → 回退内置默认蓝图 + 提示用户（`setBlueprintFallbackNotifier` → `app.status`）。业务级硬错误由 `blueprint.validate` 在保存前拦截。
- 与 `layout.*` 的关系：布局管位置/大小/分组结构**基准**（D1），蓝图在基准上叠加显隐与组收起/拉伸/方向；二者通过 `panel_id` / 组结构关联。
- **对账只作用于当前层（D51/D54）**：`reconcileLayout(graph, dv, layerKey)` 先按层切出子图（`nodesOfLayer` / `edgesOfLayer`）再对账，避免把别的页面的 `default_visible` 或组收起态套到当前布局上。
- **布局绑定蓝图**：`panel_layouts` 行携带 `blueprint_ids_json`（**1 个布局可绑定多个蓝图**，迁移 0003）；保存布局时自动把当前 dockview 组结构**同步进默认蓝图**（缺失面板补 `control` 节点、多面板组补 `group` 节点与 `contains` 边，仅增量不动用户节点），并绑定该蓝图；**应用布局时激活其绑定的第一个蓝图**。该同步受 **D59 设置开关（默认开）**控制：关闭时只保存布局本身、不碰蓝图。
- **热更新（保存即生效）**：蓝图变更命令（`blueprint.save/create/delete/setDefault/template.install`）发出 `blueprint.changed` 事件；前端 `blueprintRuntime` 订阅该事件（并配合本窗口保存后的即时通知），**重新装载生效蓝图并把默认可见/组收起语义对账到当前 dockview 布局**；`layout.*` 保持显隐/大小的基准地位（D29），对账只叠加蓝图语义，且只作用于成员面板齐全的组、跳过浮动组。蓝图编辑器拖拽节点位置后的静默保存同样走该链路。
- **热更新必须与"谁保存"解耦**：蓝图面板可被拖成**独立窗口**，此时 `window` 级通知只在该 WebView 内广播，主窗口收不到。因此运行时同时使用三条互相独立的触发路径：① 本窗口通知；② **跨窗口令牌**（`blueprintRevision`，绑在 Tauri 注入的共享宿主对象 `document` + `localStorage` 上，任何窗口保存都会广播）；③ 后端 `blueprint.changed` 事件；另加**轮询安全网**（定期比对库里蓝图指纹与本窗口已装载指纹，不一致即重载，约 1.5s 周期）。任一路径可用热更新即成立，不依赖事件桥接是否在宿主环境里工作。
- **编辑器语义：删除 = 软删除；未接通 = 灰色**：删除节点/连线**不级联删除关联节点**，只移除该节点及其关联边，并把指向它的字段引用就地清空；因此无法工作的节点（缺必填引用、引用已删除、求值链缺触发来源）在画布上显示为**灰色「未接通」**，重新接好即恢复彩色。相应地在服务端校验中，这类"未接通"问题降级为**软告警**（`BlueprintGraph::warnings`）**不阻塞保存**——允许先存下中间状态；仍为硬错误（拒绝保存）的是：字段值非法、**引用存在但类型不符**、悬空边、key 重复、求值链成环。未接通状态由 `blueprintLint` 从图结构**派生**（不落库），保证保存/装载后表现一致。
- **画布删除快捷键：右键直线刀痕**：按住右键拖拽，刀痕是一条**直线**——**起点固定为右键按下处（刀头），终点跟随指针（刀尾）**；这条直线扫过的连线标红、压住的节点标红高亮。命中在指针移动时**即时重算**，因此指针移开就取消标记（不是留下轨迹），**放开右键**才真正删除（节点走软删除）。**一次划线删除的是划痕扫过的全部节点与连线**（批量、**一次原子应用**，2026-10 修复）：早前画布对每个命中项各回调一次 `removeNode`/`removeEdgeAt`，而两者都从**同一份旧文档**派生新文档 → 后一次覆盖前一次，实际只剩最后一项生效（用户看到的"划线只能删一个"）；现由 `softRemoveMany`（`blueprintDelete`）在**一份文档**上一次算出结果（边按整文档下标一次过滤、节点在演进后的文档上逐个软删除，重复 key/越界下标忽略，被删节点不再计入未接通提示）。命中判定用纯几何模块 `blueprintGeometry`（连线按贝塞尔采样成折线 + 点到线段容差；节点按卡片矩形相交），有 `pnpm check:blueprint-geometry`（命中/移开取消/容差/掠过）与 `pnpm check:blueprint-delete`（批量原子删除/去重/越界）覆盖。左键语义不变（端口拖拽连线 / 节点拖动 / 空白平移），画布右键菜单已禁用。
- **保存即脱离内置默认**：编辑器保存会移除文档的 `default_version` 标记——用户改过的默认蓝图不再被新版内置默认自动覆盖；只有仍带旧 `default_version` 的库存默认才自动升级。

## 命令与事件

新增 `blueprint.*` 命令域（Tauri 桥接，载荷经 hp-dto 生成 shared-types）：

| 命令 | 用途 | 请求 | 响应 |
| --- | --- | --- | --- |
| `blueprint.list` | 列出仓库蓝图 | `{ repoId }` | `BlueprintItem[]`（hp-dto：id / name / is_default / schema_version / updated_at） |
| `blueprint.get` | 读取蓝图文档 | `{ repoId, blueprintId }` | `string \| null`（蓝图 JSON 文本；含归属校验） |
| `blueprint.getDefault` | 读取库存默认蓝图文档 | `{ repoId }` | `string \| null`（**无默认返回 `null`**，常量回退由前端运行时补种，见决策 2） |
| `blueprint.create` | 新建蓝图（可带结构骨架） | `{ repoId, name, fromTemplateId?, blueprintJson? }` | `BlueprintItem`（内容优先级：`blueprintJson` > `fromTemplateId` > 空图） |
| `blueprint.save` | 整文档保存（校验后） | `{ repoId, blueprintId, name?, blueprintJson }` | `BlueprintItem`（`name` 省略/空白时**沿用库中现有名称**） |
| `blueprint.delete` | 删除蓝图 | `{ repoId, blueprintId }` | `void`（删默认 → 消费层回退内置默认；含归属校验） |
| `blueprint.setDefault` | 设为默认 | `{ repoId, blueprintId }` | `void` |
| `blueprint.validate` | 校验图文档 | `{ repoId, blueprintJson }` | `BlueprintValidateResult`（`{ errors, warnings }`） |
| `blueprint.currentLayer.get` | 读取该仓库当前层（D54） | `{ repoId }` | `string \| null` |
| `blueprint.currentLayer.set` | 记住该仓库当前层（D54） | `{ repoId, layerKey }` | `void` |
| `blueprint.template.list` | 列出全局模板 | `{}` | `BlueprintTemplateItem[]` |
| `blueprint.template.install` | 模板复制进仓库 | `{ repoId, templateId, name? }` | `BlueprintItem` |

> 命令参数键用 camelCase（Tauri v2 自动映射），**返回值字段用 snake_case**（与 `hp-dto` 生成的
> `packages/shared-types` 同一份契约）。命令返回的 `BlueprintItem` / `BlueprintValidateResult` /
> `BlueprintTemplateItem` **就是** `hp-dto` 的类型（桥接层不再另定义同形结构体）。

事件：`blueprint.changed`（本仓库蓝图被修改/默认切换时广播，前端刷新引擎；载荷 `{ repoId, blueprintId }`）。

## 模块边界

| 层 | 落点 | 职责 |
| --- | --- | --- |
| Rust 领域模型 | `crates/hp-core/src/blueprint.rs` | 图文档 `BlueprintGraph`（整文档 JSON）、schema 版本与浮层尺寸常量、层归属推导（`effective_layers` / `node_layer_key`）、校验入口 `validate()` / `warnings()`（分别转发给下面两个模块）；纯数据，无 Tauri/SQLite/fs 依赖 |
| Rust 领域模型 | `crates/hp-core/src/blueprint_types.rs` | **取值域枚举**：`NodeType`（含 `interface` / `overlay`）、`GroupMode`、`HideDirection`、`Trigger`、`ActionOp`（含 `collapse`/`expand`/`navigate`）、`EdgeKind`、`TokenLevel`、`OverlayAnchor` / `AnchorAxis`；每个枚举带 `as_str` / `from_str` |
| Rust 领域模型 | `crates/hp-core/src/blueprint_node.rs` | 结构体：`BlueprintNode`（含 `layer` 归属与浮层字段）、`BlueprintEdge`、`BlueprintLayer`、`BlueprintPosition`、`OverlaySize`、`NodeKey` |
| Rust 领域模型 | `crates/hp-core/src/blueprint_row.rs` | **存储行**（持久化形态）：`BlueprintRow` / `BlueprintTemplateRow`（与两张表一一对应，供 hp-store 返回、命令层转 DTO） |
| Rust 领域模型 | `crates/hp-core/src/blueprint_validate.rs` | **全部硬错误**（拒绝保存）：图级入口 `validate_graph`（版本闸门 / key 唯一 / 节点字段与引用 / 边端点与类型 / 重复边 / 分层规则 / 互斥组默认可见 / 求值链无环）+ 条件表达式校验 |
| Rust 领域模型 | `crates/hp-core/src/blueprint_warnings.rs` | **未接通软告警**（不阻塞保存）：缺必填引用、缺触发来源、无根层（D55）、跳转失效（D55）、浮层未连接到界面（D50 修订）、浮层尺寸被夹紧 |
| Rust 领域模型 | `crates/hp-core/src/blueprint_migrate.rs` | 文档版本迁移（v1 → v2 引入分层，D52/D58）：`migrate_document` / `migrate_graph` / `normalize_document`（写库前归一化，并补齐缺失的 `schema_version`） |
| Rust 领域模型（测试） | `crates/hp-core/src/blueprint_tests.rs` | 蓝图**这一个功能域**的测试夹具，由 `blueprint.rs` 以 `include!` 挂载（不按被测子模块再拆） |
| 存储 | `crates/hp-store` | 迁移 `repo/0006_blueprint.sql`、`global/0002_blueprint_templates.sql`（+ 布局侧 `global/0003_layout_blueprints.sql` / `0004_layout_layers.sql`）；`repo/blueprint_repo.rs`（list/get/save/delete/setDefault/count + 打开库时的一次性文档迁移）、`global/blueprint_template_repo.rs`（list/install/upsert） |
| 跨层 DTO | `crates/hp-dto` | 蓝图 DTO（`BlueprintItem` / `BlueprintValidateResult` / `BlueprintTemplateItem`），前端 `packages/shared-types` 由同一批类型生成。**桥接层直接使用这些类型**（`src-tauri` 依赖 `hp-dto`），不得再定义同形结构体；`BlueprintDoc` 类型**不存在**，勿引用 |
| Tauri 桥接 | `apps/desktop/src-tauri/src/commands/blueprint.rs` | `blueprint.*` 命令：参数校验、仓库归属校验、调用 hp-store、广播 `blueprint.changed`；`commands/shared.rs` 的 `debug_log` 提供打包运行下的诊断通道 |
| 前端配置 | `packages/config/src/blueprint.ts` | 图文档类型、**取值域常量**（节点类型/trigger/op/group mode/edge kind/media type/hide direction）、分层工具（`effectiveLayers` / `nodeLayerKey` / `edgesOfLayer` / `normalizeLayersForSave`…）、**解析层校验** `parseBlueprintDocument`、`forUserSave`、`isObsoleteDefaultBlueprint` |
| 前端配置 | `packages/config/src/blueprintOverlay.ts` | 浮层外观档位与相对定位**纯函数**（RFC 0007 明确落在 `packages/config`）：`resolveOverlayPosition` / `overlayOffsetToPx` / `overlayOffsetLabel` / `anchorAxis` / `resolveOverlaySize` / `overlaySizeLabel` + `OVERLAY_ANCHORS` / `TOKEN_LEVELS` / `OVERLAY_MIN_SIZE` 等常量 |
| 前端配置 | `packages/config/src/blueprintDefault.ts` | **内置默认图** `DEFAULT_BLUEPRINT`（当前 v7）与 `makeEmptyBlueprint`；Rust 夹具的唯一来源 |
| 前端运行时 | `apps/desktop/src/app_ui/shared/blueprintRuntime.ts` | 生效蓝图加载/升级/回退 + **解析层校验与回退提示**、当前层与每层布局（D53/D54：`loadCurrentLayer` / `applyLayerLayout` / `switchLayer`）、对账入口、热更新订阅（本窗口 + 跨窗口令牌 + 后端事件 + 轮询安全网） |
| 前端运行时 | `apps/desktop/src/app_ui/shared/blueprintLayout.ts` | 蓝图 → dockview 对账（**只对账当前层**）：互斥组默认可见标签、组收起/展开（`PANEL_MIN_SIZE`）与**共用的收起/展开尺寸记忆**（`collapseGroup` / `expandGroup`） |
| 前端运行时 | `apps/desktop/src/app_ui/shared/blueprintRevision.ts` | 跨窗口"已保存"令牌（共享宿主对象 + localStorage） |
| 前端运行时 | `apps/desktop/src/app_ui/shared/blueprintLint.ts` | 从图结构派生「未接通」节点（不落库，供画布灰显） |
| 前端运行时 | `apps/desktop/src/app_ui/shared/blueprintSync.ts` | 保存布局时把当前 dockview 结构**增量同步进蓝图**（补 `control`/`group` 节点与 `contains` 边；D59：需广播 `blueprint.changed`） |
| 前端运行时 | `apps/desktop/src/app_ui/core/blueprintEngine.ts` | 求值引擎：解析层校验入口（`parse`）、事件匹配（**只匹配当前层**）→ fires/guards 链求值 → 输出 dockview 操作序列；浮层显隐与初始显隐对账 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/BlueprintPanel.tsx`（装配）+ `BlueprintDocList.tsx` / `BlueprintToolbar.tsx` / `BlueprintJsonView.tsx` / `BlueprintPalette.tsx` + `useBlueprint*.ts` | 编辑器主面板：蓝图列表/新建（含结构骨架）/保存/删除/设为默认/恢复内置默认/JSON 视图/层工具接线（2026-09 按 1200 行规则分文件，主面板只留装配） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/BlueprintCanvas.tsx` | 节点画布：拖拽摆放、端口连线、平移缩放（中键）、右键直线刀痕删除、未接通灰显（**只渲染当前层**）、挂载右下角小地图 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/BlueprintMinimap.tsx` | 小地图组件：缩略当前层节点/连线 + 视口指示框，拖动即把画布视口中心移到该处（指针事件 `stopPropagation`，不触发画布的平移/刀痕） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintMinimapGeometry.ts` | 小地图**纯几何**：内容包围盒、等比缩放与留边、世界↔小地图坐标、视口世界矩形与布局（见 `pnpm check:blueprint-minimap`） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintNodeColors.ts` | 节点/边配色纯数据（画布与小地图**共用同一份色板**，缩略图才能与画布一一对应；`nodeColor` / `edgeColor` 对未知/插件类型给中性兜底色） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/BlueprintInspector.tsx` | 节点属性面板（只暴露必填字段 + 只读自动引用；引用候选按**同层**过滤，`navigate` 例外） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintLabels.ts` | 节点的**本地化显示层**：`nodeDisplayName` / `nodeSummary` / `resolveControlTitle` / 各字段标签；画布与属性面板共用（属性面板不再从同级组件 import 文案函数） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintPorts.ts` | 画布**端口与边类型契约**（纯数据/纯函数）：`PORT_DEFS` / `CONTAINMENT` / `kindForEdge` / `portIdFor` / `portLabel`；画布交互与 `pnpm check:blueprint-nodes` 的共同依据 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintNodeFactory.ts` | 新节点工厂：key/引用由（显式指定的）上级推导、**只追加自身**（不补最小链、不跨链路挂钩）、缺引用留空（未接通）、**兜底引用只在本层内找**；**所有类型都可随意创建**（`appendNode` 永不拒绝），子类/标记新增时用 `requiresMountParent` / `resolveMountParent` **顺手解析挂载父**，解析不到即**留空引用** |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintDelete.ts` | 软删除：只删该节点与其关联边，关联节点保留（交 `blueprintLint` 灰显）；`softRemoveMany` 为**一次划线批量删除**的纯函数（边按下标一次过滤 + 节点逐个软删除，**原子**）；`removeLayer` 为层硬删除（D55） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintSlots.ts` | 画布槽位：以目标点为中心的环形就近空槽分配（不堆叠） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintArrange.ts` | 「一键整理」纯算法：以选中节点为**起始节点** BFS 分层、按列树状展开；**起始节点位置不变**、同层间距 ≥ 卡片高 + 余量、落位避让任何已占用位置（含孤立节点） |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintGeometry.ts` | 纯几何：视口中心→世界坐标、贝塞尔采样、刀痕命中判定 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintStructure.ts` | 由当前布局生成结构骨架（区域聚类 + 界面/布局块/标签组/面板 + **单层**）与其跨窗口快照 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/blueprintLayers.ts` | 层操作纯函数（D51/D55/D60）：新增层（自带界面根）、重命名（层名唯一）、排序、补根 |
| 前端编辑器 | `apps/desktop/src/app_ui/panels/BlueprintLayerBar.tsx` | 层工具条（D51/D54）：切换当前层、新增/重命名/删除/排序、标出无根层 |
| 前端编辑器 | `apps/desktop/src/app_ui/shared/api/blueprint.ts`、`shared/types/blueprint.ts` | 蓝图命令封装与参数/返回类型（返回类型重导出 hp-dto 生成物；命令参数键 camelCase） |

## 落地顺序（路线图 M6/M7 已落地）

1. 领域模型 + 存储：`hp-core/blueprint.rs`、迁移 0006 / global 0002、两个仓储 + validate 校验、默认蓝图常量。
2. `blueprint.*` 命令 + `hp-dto` 类型生成。
3. BlueprintEngine + 默认蓝图接线（替换 MediaPreviewPanel 硬编码联动；含组收起/拉伸/隐藏方向的基础映射），验收"行为零回归"。
4. **节点式编辑器**（`BlueprintPanel` + `BlueprintCanvas`）：画布拖拽摆放（`position {x,y}` 落库）、端口拖拽连线（边类型按端口判定）、节点属性面板、JSON 辅助视图；保存前 `blueprint.validate`。
5. 模板（全局）与复制。
6. 测试与横切校验（见"验证"）。

### 分层（D51–D60）的落地前置与顺序（**已按序落地**）

**顺序不可颠倒**，否则"升到 v2"会变成"所有库存蓝图无法保存"：

1. ✅ **放宽版本闸门**：`validate()` 由 `!=` 改为 `> 当前版本` 才报错（`crates/hp-core/src/blueprint.rs`）。
2. ✅ **同一提交内同步三处常量**：`hp-core::BLUEPRINT_SCHEMA_VERSION`（=2）、`packages/config` 的 `BLUEPRINT_SCHEMA_VERSION`（=2）、内置默认图常量（`DEFAULT_BLUEPRINT_VERSION` 6 → 7，单层「主界面」）。
3. ✅ **字段先落模型**：`BlueprintGraph.layers`、`BlueprintGraph::effective_layers` 兜底、`BlueprintNode.layer`、`overlay` 的 `visible`/`height`（以及 2026-09 追加的 `anchor`/`offset_x`/`offset_y`/`size`/`shadow`/`radius`/`hide_label`）。（原文列的 `control_id` 属已取消的 D56 绑定，模型中已不存在。）
4. ✅ **迁移并回填**：`hp-core/blueprint_migrate.rs` 的 `migrate_document`；打开仓库库（`RepoDb::open`）与全局库（`GlobalDb::open`）时一次性遍历 `blueprints` / `blueprint_templates`：v1 → 每 `interface` 拆一层 → 回写 `blueprint_json` + **同步 `schema_version` 列**（D58）；写库路径（create/save/模板 upsert）同样归一化。
5. ✅ **存储维度**：全局迁移 `0004_layout_layers.sql` 给 `panel_layouts` 增加 `layer_key`（+ 唯一索引），实现"每层一份布局"（D53）；当前层按仓库持久化于应用设置键 `blueprint.currentLayer.{repoId}`（D54，命令 `blueprint.currentLayer.get/set`）。
6. ✅ **校验**：分层硬错误/软告警（层 key/名唯一、每层至多一个界面、节点 `layer` 必须存在、跨层边硬错误；无根层与 `navigate` 失效为软告警）；随后引擎才执行浮层显隐（D50 的"校验先于动作"）。

## 验证

- `cargo test --workspace`：蓝图存储往返 / 仓库隔离（两仓库蓝图互不可见）/ 默认蓝图落库与回退 / 模板 install 复制语义 / validate 拒绝（悬空边、环、未知类型、key 重复、互斥组多默认可见、非法 hide_direction）。
- 前端验收（节点式编辑器）：
  - 双击预览图像 → 显示图像查看器，且互斥组内播放器/元数据隐藏（**默认其他隐藏**）。
  - 双击视频 → 显示播放器；双击音频（占位）→ 显示元数据。
  - **组收起**：`collapse` 组 → 该组最小化至 6px（标签条保留）；`expand` 恢复收起前的尺寸。**空间按 `hide_direction` 让给指定侧邻居已实现**（轴向按几何找最近邻居、`toward:<组>` 直接指定，本组沿轴压到最小、邻居沿同轴放大；无法解析时回退为网格自行吸收）。
  - **隐藏方向**：`A | B | C` 中收起 B（方向向左）→ A 拉伸吸收、C 不动 —— **编辑器、模型与运行时均已支持**，此条验收可通过。
  - 套用已保存布局后，互斥组按默认蓝图对账，仅默认可见成员显示。
  - **热更新**：保存蓝图后**不重启**，双击行为立即改变；独立窗口（detached 蓝图面板）里保存同样对主窗口生效。
  - **删除**：右键直线刀痕扫过连线/节点 → 标红 → 放开即删；指针移开即取消标记；**一次划线可删多个节点与多条连线**（批量、原子，不再"只能删一个"）。删节点后关联节点保留并灰显「未接通」，重新接好即恢复。
  - **新增**：一次新增只追加**一个**节点（不连带链路、不接到既有规则上）；新增节点落在当前渲染视口中心附近，缺上级时灰显「未接通」。
  - **所有节点都可随意创建**：任何类型在任何时机都能新增（**空图上 12 种类型全部可创建**），**没有置灰、没有拒绝**；子类/标记有可用父级时顺手挂上、没有就**留空引用**（灰显「未接通」）。**随意创建 ≠ 随意连线**：子类仍只能连到类目下、标记仍只能连到面板下（层级约束在连线上）。
  - **子类优先**：`text` 类目下同时有「类目→对象→操作→状态」与「类目→子类(txt)→对象→操作→状态」两条链时，`txt` 条目**只走子类链路**；`epub`（无对应子类）仍走类目链路；删掉子类后 `txt` 回落到类目链路。
  - **一键整理**：以选中节点为起始节点整理后，该节点**位置不变**（不回到原点）；同层节点上下间距足够、**互不重叠**（含避让孤立节点）。
  - **刷新**：点「刷新」后未接通灰显与连线位置重新对齐，且**文档内容不变**。
  - **新建蓝图**：默认带当前布局的结构骨架（**一个层**（层名即界面显示名）为唯一顶层根节点 → 布局块 = 区域；多面板区域生成标签组、单面板直连面板）。
  - **界面节点**：默认蓝图与新建骨架都含 `interface` 节点（默认图一个：`ui`），且只连布局块；**多界面 = 多层**（多页面，D51：每层至多一个界面，同层两个界面是硬错误），`navigate` 指向非界面类型被 `validate` 拒绝、指向已删除界面报未接通软告警。
  - **分层（D51/D53/D54/D55/D60）**：编辑器层工具条可切换/新增/重命名/删除/排序层；画布同一时刻只画当前层；新增节点归属当前层；层名蓝图内唯一且即界面显示名；删除层 = 直接删除（禁止删最后一层）；删掉层的界面节点后该层标为「无界面（未接通）」；套用/保存布局按 `(布局名, 当前层)` 一份；重启后回到该仓库的当前层。
  - **浮层（D50/D57，2026-09 修订）**：`overlay` 节点与布局块同级且是**容器**（`interface --contains--> overlay --contains--> {面板, 标签组}`）；属性面板可设初始显隐、叠放高度（1–10）、框体尺寸、九宫格锚点与双模式偏移、外观档位（`shadow`/`radius`/`hide_label`）；`show`/`hide`/`toggle` 可指向浮层，`collapse`/`expand`/`navigate` 指向浮层被拒；**「浮动控件」绑定（`control_id`）已取消**，属性面板没有该字段。
  - **节点式编辑**：画布拖拽摆放/端口连线后保存，产出合法 `blueprint_json`；边类型按端口自动判定（contains/memberOf/fires/guards）；属性面板修改字段；JSON 视图往返一致。
  - 编辑器修改规则保存后，运行时立即生效；硬错误图被 validate 拒绝不落库，未接通（软告警）可保存。
- **开发期自检脚本**（脱离宿主跑真实实现，`tools/`）：
  - `pnpm check:blueprint-runtime`：装载/旧默认升级落库/用户图不被覆盖/无默认时补种（3 项）。
  - `pnpm check:blueprint-delete`：软删除语义（关联节点保留、灰显原因、引擎不再产出动作）+ **一次划线批量删除**（多处一次原子生效、去重/越界下标忽略、旧"逐个调用只剩最后一次"的回归对照）（**14 项**）。
  - `pnpm check:blueprint-nodes`：节点工厂**只追加自身**（不连带补链、不跨链路挂钩）、**所有节点都可随意创建**（空图 12 种全部可创建；子类/标记缺父时照常创建且引用留空）、上级推导、**层归属（D51）**、**端口/边类型一致性（CONTAINMENT ↔ kindForEdge ↔ PORT_DEFS 三者对齐）**、**父子声明的双向对称性**（`children` 与 `parents` 逐项互指）、**浮层容器与外观/定位/尺寸**（D50 修订）、**层增删改名与禁止删最后一层（D55/D60）**、九宫格锚点与双模式偏移（比例/像素/负值/越界贴边/默认最小尺寸夹紧）、结构骨架与快照、**「一键整理」几何（起始节点位置不变 / 间距 ≥ 卡片高 + 余量 / 全图不重叠且避让孤立节点）**（**项数以脚本断言为准**，当前 **72** 项，其中最后一项调用 cargo 用 hp-core 真实校验器复核 `crates/hp-store/tests/blueprint_factory/` 下的全部夹具）。**夹具目录只由脚本产出**：脚本每次运行先清空该目录再写盘（避免陈旧夹具被目录扫描当成有效样本），且写盘时去掉内置默认标记 `default_version`（否则一旦被真实装载会被判为"旧库存默认"并整篇覆盖）。

  - `pnpm check:blueprint-geometry`：刀痕命中/移开取消/容差/视口中心换算（7 项）。
  - `pnpm check:blueprint-slots`：新增节点就近落位、不堆叠、远处基准不回跳（5 项）。
  - `pnpm check:blueprint-minimap`：小地图纯几何——包围盒/等比缩放与留边/只缩小不放大、世界↔小地图往返、视口指示框随缩放变小且平移到图外也留在框内、视口矩形与 `viewportCenterToWorld` 同源、空图不崩（11 项）。
  - `pnpm check:blueprint-engine`：**合成用例断言**（当前 43 项）：D48 界面跳转、D50 浮层显隐（含内容面板按浮动方式显示、未写尺寸取默认最小、未写定位取居中）、**D50 容器宿主渲染**（档位 → `packages/ui` token、apply/clear 对称、幂等、`floatingWindowOf` 只认浮动组）、D51 只求值当前层、组收起；**浮层回归三条**——初始显隐对账（`visible: true` 在装载时即显示）、**套用布局后清空记忆并重显**（`fromJson` 重建内容会抹掉浮动面板）、**断开 `界面→浮层` 后收起且不再响应显示动作**；**子类优先三条**（`txt` 已被子类认领 → 类目链路被排除、`epub` 无对应子类 → 类目链路照常、移除子类后回落类目链路）；**D29 hide_direction 透传**（轴向 + `toward:<组>` 解析为成员面板 id）；**selection_change + `rating >=` / `has_tag ==` 运行时 context**（命中/不命中各一条）；**纯几何邻居选择**（水平/垂直邻 + 相邻轴判定，与运行时共用同一实现）；另加可选诊断（给仓库库路径时打印按当前生效蓝图跑出的操作序列）。
  - `pnpm generate:blueprint-fixture`：由 `packages/config` 的 TS 常量生成 Rust 侧默认蓝图夹具，避免两侧手工维护。
- `check-line-count` / `check-doc-status` / `pnpm typecheck` / `pnpm build` / `cargo test --workspace` 通过。
- 桌面应用构建走 `pnpm app:build`（tauri CLI）；直接 `cargo build --release` 会静默沿用旧的内嵌前端产物（见 `docs/architecture/file-structure.md`）。

## 暂不进入第一期

- 通用可视化脚本能力（循环、变量、数据加工、任意条件表达式）。
- 插件自定义蓝图（**2026-09 部分开放**：插件可注册面板与蓝图节点类型，见 RFC 0010；插件自身仍不编写蓝图）。
- 跨仓库实时共享蓝图（模板为一次性复制）。

> 注：节点式（画布拖拽连线）编辑器属于第一期，自 M6 阶段一落地（见"决策 7"与"落地顺序"）。

## 风险与边界

- **蓝图与 dockview 显隐/收起状态漂移**：套用布局 / 切换蓝图 / 用户手动拖动分隔条后，引擎状态可能与图不一致 → 每次套用布局与切换蓝图时按默认蓝图语义全量对账一次；收起状态是否回写 `layout_json` 见开放点。
- **收起/拉伸的 dockview 映射差异**：dockview 的网格 API 对"隐藏方向/指定邻居吸收"支持程度需要实现期验证（分隔条移动 vs 尺寸控制）；映射细节列为开放点，验收以"空间确实让给指定侧"为准则。
- **复杂度蔓延成通用脚本**：节点类型与条件表达式保持固定最小集；校验拒绝未知类型与任意表达式。
- **分层是后加的顶层结构**：旧库存蓝图（没有 `layers`/`layer`）属合法旧结构，加载时按**单层文档**兜底（层名取 `interface.name` 或默认「主界面」）；引擎按 `DEFAULT_BLUEPRINT_VERSION` 升级内置默认时补齐分层，用户自建图由用户决定是否加层（D51）。
- **多页面是后续主线**：层即页面，`navigate` 是跨层切换的唯一表达；第一版允许用户自建多层与跳转规则，但**不提供页面栈/返回与跨层共享状态**（列为开放点，避免过早定型）。
- **默认蓝图回归**：以"现状硬编码行为"为验收基线，引擎接线必须零回归后再放开编辑器（节点式编辑器改动不改变存储与求值）。
- **环导致死循环求值**：`fires`/`guards` 子图 DAG 校验，拒绝落库。
- **音频类目一期无播放器**：默认动作指向元数据/占位面板，音频播放器落地后再调整默认图。
- **面板可能在独立窗口**：蓝图面板是 dockview 面板，可被拖成独立窗口（独立 WebView）。凡"保存方通知主窗口""从当前布局取结构"这类逻辑都**不能假设同窗口可用**，必须走跨窗口共享（令牌 / 结构快照）或后端事件——这是本特性实现期踩过的两类真实缺陷（热更新不生效、结构骨架失效）的根因。

## 实现期开放点（非架构决策）

- 蓝图文档整 JSON 存储 vs 拆节点/边关系表（当前推荐整 JSON，对齐 `layout_json` 先例）。
- 求值策略：默认"全部匹配"；是否提供"首个匹配"开关。
- `hide` 语义（已定）：隐藏 = 收缩至最小尺寸（正文 6px、标签条保留，D25/D29），**不销毁面板/标签**；与目标同 dockview 组时仅切换激活（show 已处理），不同组时收缩该组。dockview `renderer` 权衡（媒体面板 `renderer=always`）保持现状。
- **组收起/拉伸的 dockview 实现方式（已落地：面板尺寸控制）**：`hide_direction`（含 `toward:<groupKey>`）通过**本组压到最小 + 邻居沿同轴放大**实现（`setSize`），不再移动分隔条；`x/y` 的运行时语义（网格坐标 vs 浮动窗口坐标 vs 仅画布定位）**仍为开放点**。
- **对账 vs 事件驱动**：`reconcileLayout` 目前会把图中**可达**的 `collapse`/`expand` 动作当成组的目标状态静态套用；严格按"事件触发才执行"的语义，应改为只在事件触发时改变组状态（`default_visible` 与浮层 `visible` 的初始对账保持不变）。
- **未接线的触发与条件（已接通）**：`selection_change` 已有事件源（`MediaPreviewPanel` 在选中变化时上报）；`rating >=` / `has_tag ==` 已由调用方在 `dispatch` 里提供 `context`（rating / 人工+自动 tag 名）。
- **D59 的同步开关（已实现）**：布局 → 蓝图自动同步受设置项 `layout.syncBlueprint` 控制（**默认开**）；关闭时只保存布局、不同步蓝图。
- **收起/展开状态的持久化**：蓝图驱动的组收起状态是否/何时回写 `layout_json`（当前布局保存时是否带上收起态；切换蓝图时如何处理）。
- 条件表达式是否增加 `album_member_of`、`source` 命中、`tag_any_of` 等扩展（首期保持最小集）。
- 蓝图 schema 版本升级策略与迁移（如节点类型演进时的旧文档兼容）。
- 节点画布编辑器的画布交互细节：缩放范围与步进、框选/多选、边拖拽改接等（首期不强制）。**迷你地图已落地（2026-10）**：画布右下角的小地图缩略当前层全部节点/连线（与画布同色板）、叠加视口指示框，**拖动小地图即把视口中心移到该处**；纯几何在 `apps/desktop/src/app_ui/panels/blueprintMinimapGeometry.ts`，组件 `BlueprintMinimap.tsx`，由 `pnpm check:blueprint-minimap` 覆盖。
- **布局块嵌套**：当前 `contains` 层级为 界面 → 布局块 → 标签组/面板，布局块不能套布局块（界面是**层的根**，一个蓝图可有多个层=多页面，D51）；因此"一栏里多个标签组"在默认图里表现为"布局块 → 组A、组B"。是否需要 `contains` 支持 布局块→布局块 的显式嵌套，待有真实需求再定。
- **界面（页面/层）的运行时**：层即页面，`navigate` 表达跳转，**当前层按仓库持久化**（D54）。仍待定：页面栈与返回语义（是否有"返回上一层"）、无跳转规则时如何选择**入口层**（建议首个层，或显式标记首页）、跨层是否共享面板实例与数据上下文。
- **界面级全局行为**：界面节点目前不参与显隐/收起求值。是否需要界面级"进入/离开"钩子（如进入界面时自动显示某面板），属后续评估。
- **面板与控件在蓝图中的位置**（RFC 0010 决策 1）：蓝图**结构树**里，**面板**（节点 `control`）挂在布局块/标签组/浮层之下，其下是**类目**（节点 `class`）→ 对象；**控件**（`docs/spec/control-standard.md` 的 26 种标准 UI 单元）**不是蓝图节点**，只在面板**内部**渲染，因此不受蓝图显隐规则直接管辖。**浮层与布局块同级**、显示在布局块**之上**（D49），其显隐由 `overlay`（浮层）节点承载（D50，**已实现**；「浮动控件」这一插件控件类别已取消）——蓝图控制的是"浮层是否显示"，浮层内部的控件 schema 仍归控件标准。
- **新建蓝图结构骨架的几何聚类**：按 dockview 组的 `boundingBox`（水平区间重叠）聚成"区域"；几何取不到时退化为"每组一块"。跨栏的复杂拖分布局（如浮动的组、上下分栏）聚类精度以实际体验为准。
