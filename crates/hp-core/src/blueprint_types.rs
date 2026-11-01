//! 蓝图枚举与取值类型（RFC 0007 决策 1 / D29 / D46-D60）。
//!
//! 只承载**取值域**：节点类型、组模式、隐藏方向、触发、动作、边类型、外观档位、浮层锚点。
//! 每个枚举都提供 `as_str` / `from_str`（与 JSON 文档的字符串取值一一对应），
//! 另加一个语义谓词（如 `is_group_op`）以便校验层按语义而非硬编码字符串分类。
//!
//! 结构体（节点/边/层/尺寸）在 `blueprint_node.rs`，图文档在 `blueprint.rs`；
//! 本文件是纯数据，不依赖 Tauri/SQLite/文件系统。

use std::fmt;

use serde::{Deserialize, Serialize};

/// 节点类型（RFC 0007 决策 1；D46/D47/D50；RFC 0010 决策 5/6 改为**开放取值域**）。
///
/// **内置枚举 + 字符串扩展**：10 种宿主内置类型是枚举变体；
/// **命名合法但当前无注册项**的类型（插件未安装 / 未启用 / 宿主 API 不兼容）
/// 落在 [`NodeType::Other`] 里**原样保留**——节点与边不删、不参与求值与结构对账、
/// 画布灰显「未接通」、**允许保存**，插件恢复后自动恢复（RFC 0010 决策 6）。
///
/// **命名不合规则的 `type` 是硬错误**（由 `blueprint_validate.rs` 判定），
/// 与"命名合法但无注册项"（软告警）区分开：前者是语法非法，后者是暂时接不通。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum NodeType {
    /// 界面：层的根节点 + 页面（一个界面 = 一个页面；每层至多一个）。
    Interface,
    /// 布局块：界面上的一个区域（如左/中/右三栏），包含标签组与面板。
    LayoutBlock,
    /// 浮层：与布局块同级的**容器**（可 contains 面板与标签组），
    /// 并承载阴影/圆角/标签隐藏等外观档位。**不再有「浮动控件」绑定**（2026-09 取消）。
    Overlay,
    /// 面板：dockview 面板实例（枚举 `control` 不变；显示名由 D71 定为「面板」）。
    Control,
    /// 类目：面板内部条目分类（枚举 `class` 不变；按 media_type，显示名由 D71 定为「类目」）。
    Class,
    /// 子类（D102）：**类目之下**的细分（`class ⊃ subclass ⊃ object`），
    /// 取值域由所属类目的媒体类型决定（`text` → `epub` / `txt` / `md`）。
    Subclass,
    /// 标记（D102 / D136）：**类目之下**的从属轴（`class ⊃ mark ⊃ object`），
    /// 与**子类并列**；引用可注册的标记清单（`book` / `manga` …）。
    /// 语义上仍与类目**正交、可交叉**（`manga` 标记可跨类目命中），但那说的是
    /// **匹配维度**，不是结构位置——结构上它挂在类目下（D136，用户口径：
    /// 「标记连接到类目上，标记和子类类似」）。
    Mark,
    /// 对象：类目内条目实例。
    Object,
    /// 组：面板容器（互斥/独立）。
    Group,
    /// 事件：触发求值。
    Event,
    /// 条件：基础判定。
    Condition,
    /// 动作：显隐/收起/界面跳转操作。
    Action,
    /// 命名合法但不在宿主内置清单里的类型（插件注册项 / 当前无注册项）。
    Other(String),
}

impl NodeType {
    /// 宿主内置节点类型的 JSON 取值（顺序与 TS `BLUEPRINT_BUILTIN_NODE_TYPES` 一致）。
    ///
    /// 插件注册的节点类型（`plugin.<plugin_id>.<local_id>`）**不在**这张清单里：
    /// 它是**开放取值域**，由宿主按插件注册表判定（RFC 0010 决策 5/6）。
    ///
    /// 2026-10-10（D102）由 10 种扩为 **12 种**，加入 `subclass`（子类）与
    /// `mark`（标记）。**D136 只改它们的父子挂载位置，类型清单不变**（仍是 12 种）。
    pub const BUILTIN_NAMES: [&'static str; 12] = [
        "interface",
        "layout_block",
        "overlay",
        "control",
        "class",
        "subclass",
        "mark",
        "object",
        "group",
        "event",
        "condition",
        "action",
    ];

    /// 全部 12 种内置类型（顺序与 [`NodeType::BUILTIN_NAMES`] 一致）。
    pub const BUILTINS: [NodeType; 12] = [
        NodeType::Interface,
        NodeType::LayoutBlock,
        NodeType::Overlay,
        NodeType::Control,
        NodeType::Class,
        NodeType::Subclass,
        NodeType::Mark,
        NodeType::Object,
        NodeType::Group,
        NodeType::Event,
        NodeType::Condition,
        NodeType::Action,
    ];

    pub fn as_str(&self) -> &str {
        match self {
            NodeType::Interface => "interface",
            NodeType::LayoutBlock => "layout_block",
            NodeType::Overlay => "overlay",
            NodeType::Control => "control",
            NodeType::Class => "class",
            NodeType::Subclass => "subclass",
            NodeType::Mark => "mark",
            NodeType::Object => "object",
            NodeType::Group => "group",
            NodeType::Event => "event",
            NodeType::Condition => "condition",
            NodeType::Action => "action",
            NodeType::Other(name) => name.as_str(),
        }
    }

    /// **不校验命名规则**地从字符串构造（serde 反序列化用）。
    ///
    /// 语法非法的 `type` 也要能读进内存，才能由 `blueprint_validate.rs` 报出
    /// **可读的硬错误**（而不是让存储层读不出整篇文档）。
    pub fn from_raw(s: &str) -> Self {
        NodeType::BUILTINS
            .iter()
            .find(|t| t.as_str() == s)
            .cloned()
            .unwrap_or_else(|| NodeType::Other(s.to_string()))
    }

    /// 按命名规则解析：命名合法 → `Some`（未知类型落 [`NodeType::Other`]）；
    /// **命名不合规则 → `None`**（调用方按硬错误处理）。
    pub fn from_str(s: &str) -> Option<Self> {
        if !crate::namespace::is_valid_namespaced_id(s) {
            return None;
        }
        Some(Self::from_raw(s))
    }

    /// 是否是宿主内置的 10 种之一。
    pub fn is_builtin(&self) -> bool {
        !matches!(self, NodeType::Other(_))
    }
}

impl fmt::Display for NodeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 类目节点 `media_type` 的**取值域**（与 TS `BLUEPRINT_MEDIA_TYPES` 逐项一致，顺序也一致）。
///
/// `text` 于 2026-10 加入（与扫描器 `MediaType::Text` 同源，D93）；
/// `pdf` 于 2026-10-11 加入（与扫描器 `MediaType::Pdf` 同源）——PDF 是**独立的类目**
/// 而不是 `text` 的一种：它是二进制容器，编码判定 / 字符分页那一套对它不适用。
/// `album` / `source` 于 2026-11-01 加入（D135）：相册面板的条目是"相册"、源面板的条目是
/// "源目录"，这两个面板因此从"无类目"改为"有类目"并各获一个专属类型值。**它们不是
/// 扫描器的媒体类型**——这里描述的是「类目**类型**」（字段名 `media_type` 是历史命名）。
///
/// `unlimited` / `empty` 于 2026-11-01 加入（D136）：两端语义档位，**不是媒体类型**——
/// `unlimited` 匹配一切（排首项）、`empty` 排除全部（排末项，用于"暂时停用这条类目链"）。
///
/// 这是**并集**：具体面板能用哪些类型由 [`class_media_types_for_panel`] 按面板收窄。
pub const CLASS_MEDIA_TYPES: [&str; 9] = [
    "unlimited",
    "image",
    "video",
    "audio",
    "text",
    "pdf",
    "album",
    "source",
    "empty",
];

/// 匹配一切媒体类型的类目类型（D136 两端档位之一）。
pub const CLASS_MEDIA_UNLIMITED: &str = "unlimited";

/// 排除全部媒体类型的类目类型（D136 两端档位之一）。
pub const CLASS_MEDIA_EMPTY: &str = "empty";

/// 某面板下可用的**类目类型**清单（D135）——属性面板候选的来源。
///
/// **跨语言镜像点**：与 TS `packages/config/src/blueprintNodes.ts` 的
/// `classMediaTypesForPanel` **逐项一致**（含顺序），一致性由 `pnpm check:blueprint-nodes`
/// 断言。改一侧必须同时改另一侧，否则属性面板下拉的候选集会与后端校验判据分家：
/// 前端能选出的取值被后端判为"不属于该面板分域"（或者反过来，用户选了却没被拦）。
///
/// 判定顺序：
/// 1. 该面板有分域 → 返回分域（media 只列三个媒体类型、bookpreview 只列文本/PDF、
///    albums 只有 album、sources 只有 source；每项都以 `unlimited` 开、
///    `empty` 收——D136 的两端档位对任何面板都成立）；
/// 2. 其余（插件面板 / 未注册 / 无参 / 空串）→ 返回**全量** [`CLASS_MEDIA_TYPES`]。
///    插件面板的类型域由插件自己声明，宿主**不设限**；未注册面板无从判定，按未接通处理。
pub fn class_media_types_for_panel(panel_id: &str) -> &'static [&'static str] {
    match panel_id {
        "media" => &PANEL_CLASS_TYPES_MEDIA,
        "bookpreview" => &PANEL_CLASS_TYPES_BOOKPREVIEW,
        "albums" => &PANEL_CLASS_TYPES_ALBUMS,
        "sources" => &PANEL_CLASS_TYPES_SOURCES,
        _ => &CLASS_MEDIA_TYPES,
    }
}

/// **新建类目时的缺省类型**（D136）——与候选顺序**分开**的一处真相。
///
/// 为什么不能"取分域首项"：D136 给每个分域的首项加了 `unlimited`，若缺省跟着首项走，
/// 四个面板的新建类目会**静默**全部变成"无限制"（用户不再看到"图像/文本/相册/源"这类
/// 常见默认值，且"什么文件都收"的类目会悄悄出现）。
///
/// **跨语言镜像点**：与 TS `PANEL_CLASS_MEDIA_TYPE_DEFAULTS` 逐项一致，由
/// `pnpm check:blueprint-nodes` 断言。
pub fn class_media_type_default_for_panel(panel_id: &str) -> &'static str {
    match panel_id {
        "media" => "image",
        "bookpreview" => "text",
        "albums" => "album",
        "sources" => "source",
        _ => "image",
    }
}

/// 媒体预览的类目类型域（图像 / 视频 / 音频，首尾是 D136 的两端档位）。
const PANEL_CLASS_TYPES_MEDIA: [&str; 5] = ["unlimited", "image", "video", "audio", "empty"];

/// 图书预览的类目类型域（文本 / PDF，首尾是 D136 的两端档位）。
const PANEL_CLASS_TYPES_BOOKPREVIEW: [&str; 4] = ["unlimited", "text", "pdf", "empty"];

/// 相册面板的类目类型域：面板条目就是相册（首尾是 D136 的两端档位）。
const PANEL_CLASS_TYPES_ALBUMS: [&str; 3] = ["unlimited", "album", "empty"];

/// 源面板的类目类型域：面板条目就是源目录（首尾是 D136 的两端档位）。
const PANEL_CLASS_TYPES_SOURCES: [&str; 3] = ["unlimited", "source", "empty"];

/// 该类目类型在当前面板里是否**属于该面板的分域**（D135 硬错误判据）。
///
/// `panel_id` 为空（`control` 缺失/指向已删节点）时**不做分域判定**并返回 `true`：
/// 缺失是未接通软告警，不能反过来把用户的既有文档判成硬错误（"缺失不得绑架用户数据"）。
pub fn class_media_type_in_panel_domain(panel_id: &str, media_type: &str) -> bool {
    if panel_id.trim().is_empty() {
        return true;
    }
    class_media_types_for_panel(panel_id).contains(&media_type)
}

/// **子类取值域**（`subclass` 节点的 `format` 字段，D102）——**按类目的媒体类型分域**。
///
/// 目前只有 `text` 有分域（`epub` / `txt` / `md`）；其余媒体类型没有子类取值域，
/// 即"该类目下不能建子类"。与 TS `BLUEPRINT_SUBCLASS_FORMATS` 逐项一致。
///
/// **`pdf` 刻意不在表里**：PDF 只有一种格式，再分一层没有语义。
/// 这是"留空 = 该类目下不能建子类"的又一处落点，与 `image` / `video` / `audio` 同理。
pub const SUBCLASS_FORMATS_TEXT: [&str; 3] = ["epub", "txt", "md"];

/// 某类目媒体类型允许的子类取值域（空 = 该类目下不能建子类）。
pub fn subclass_formats_for(media_type: &str) -> &'static [&'static str] {
    match media_type {
        "text" => &SUBCLASS_FORMATS_TEXT,
        _ => &[],
    }
}

/// 某类目媒体类型下是否允许挂子类节点。
pub fn media_type_has_subclass(media_type: &str) -> bool {
    !subclass_formats_for(media_type).is_empty()
}

/// **book 标记**的取值名（`epub` / `pdf` 默认带它；与库表存储值同字面量）。
pub const BOOK_MARK: &str = "book";

/// **漫画标记**的取值名（用户口径的例子）。
pub const MANGA_MARK: &str = "manga";

/// **媒体标记**的取值名（父级标记：图像 / 视频 / 音频的并集）。
pub const MEDIA_MARK: &str = "media";

/// **图像标记**的取值名（"图像就是图片"，不再另设 `picture` 这类同义 id）。
pub const IMAGE_MARK: &str = "image";

/// **视频标记**的取值名。
pub const VIDEO_MARK: &str = "video";

/// **音频标记**的取值名（其下细分出音乐）。
pub const AUDIO_MARK: &str = "audio";

/// **音乐标记**的取值名（音频之下的细分语义，而非"音频"的同义词）。
pub const MUSIC_MARK: &str = "music";

/// **文档标记**的取值名（父级标记：文本 / 图书 / 漫画的并集）。
pub const DOCUMENT_MARK: &str = "document";

/// **文本标记**的取值名。
pub const TEXT_MARK: &str = "text";

/// **程序标记**的取值名（可执行 / 脚本 / 工程目录这类"非媒体、非文档"的条目）。
pub const PROGRAM_MARK: &str = "program";

/// **宿主内置标记清单**（`mark` 节点的 `mark` 字段引用它，D102 / D134）——**可注册**。
///
/// 标记与类目**正交、可交叉**（用户口径：`漫画.zip` 的类目是压缩包、可标记为
/// `manga`，据此走漫画阅读器蓝图）。与 TS `BLUEPRINT_BUILTIN_MARKS` 逐项一致，
/// **顺序也一致**——这里的顺序即"系统标记"的展示顺序（蓝图属性面板下拉、相册/源
/// 面板的标记右键菜单都按它排列），两处顺序错开不会报错、只会让下拉悄悄分家。
///
/// **2026-11-01（D134）由 2 项扩为 10 项**：标记不只用于"文件级"打标（媒体预览 /
/// 图书预览当初就是这么实现的），也用于**文件夹级**（把某个漫画文件夹标记为一本漫画，
/// 其内的图像就是这本漫画的页）。因此清单覆盖"媒体 / 文档 / 程序"三层常见语义，
/// 不只是电子书与漫画两项。
///
/// 注意：树形分组（`媒体 ⊃ {图像, 视频, 音频 ⊃ {音乐}}`、`文档 ⊃ {文本, 图书, 漫画}`、
/// `程序`）只是 **UI 呈现**用的嵌套关系（TS 侧有 `BLUEPRINT_MARK_TREE` 同源）。节点模型
/// 与这里是**扁平**的 10 个 id，**不要**据此推出"标记可以挂标记"。
pub const BUILTIN_MARKS: [&str; 10] = [
    MEDIA_MARK,
    IMAGE_MARK,
    VIDEO_MARK,
    AUDIO_MARK,
    MUSIC_MARK,
    DOCUMENT_MARK,
    TEXT_MARK,
    BOOK_MARK,
    MANGA_MARK,
    PROGRAM_MARK,
];

/// 类目的 `media_type` 是否在取值域内。
pub fn is_valid_class_media_type(value: &str) -> bool {
    CLASS_MEDIA_TYPES.contains(&value)
}

/// 是否为**宿主内置**标记（可注册清单的内置部分，恒在）。
pub fn is_builtin_mark(value: &str) -> bool {
    BUILTIN_MARKS.contains(&value)
}

impl Serialize for NodeType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NodeType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(NodeType::from_raw(&s))
    }
}

/// 组模式（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupMode {
    /// 互斥组：同一时间至多一个成员显示，其余默认隐藏。
    Exclusive,
    /// 独立组：各成员显隐互不影响。
    Independent,
}

impl GroupMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            GroupMode::Exclusive => "exclusive",
            GroupMode::Independent => "independent",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "exclusive" => Some(GroupMode::Exclusive),
            "independent" => Some(GroupMode::Independent),
            _ => None,
        }
    }
}

impl fmt::Display for GroupMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 组隐藏方向（RFC 0007 决策 1 / D29）。
///
/// 组收起时释放的空间沿该方向让给相邻组；`toward:<groupKey>` 精确指定吸收者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HideDirection {
    Left,
    Right,
    Up,
    Down,
    /// 指向具体邻居组（`toward:<groupKey>`）。
    Toward(String),
}

impl HideDirection {
    pub fn as_str(&self) -> String {
        match self {
            HideDirection::Left => "left".to_string(),
            HideDirection::Right => "right".to_string(),
            HideDirection::Up => "up".to_string(),
            HideDirection::Down => "down".to_string(),
            HideDirection::Toward(key) => format!("toward:{key}"),
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "left" => Some(HideDirection::Left),
            "right" => Some(HideDirection::Right),
            "up" => Some(HideDirection::Up),
            "down" => Some(HideDirection::Down),
            _ => s
                .strip_prefix("toward:")
                .filter(|k| !k.is_empty())
                .map(|k| HideDirection::Toward(k.to_string())),
        }
    }

    /// 是否为 `toward:<groupKey>` 形式。
    pub fn toward_target(&self) -> Option<&str> {
        match self {
            HideDirection::Toward(key) => Some(key.as_str()),
            _ => None,
        }
    }
}

impl fmt::Display for HideDirection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_str())
    }
}

impl Serialize for HideDirection {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.as_str())
    }
}

impl<'de> Deserialize<'de> for HideDirection {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        HideDirection::from_str(&s)
            .ok_or_else(|| serde::de::Error::custom(format!("未知隐藏方向: {s}")))
    }
}

/// 事件触发（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    Click,
    DoubleClick,
    SelectionChange,
}

impl Trigger {
    pub fn as_str(&self) -> &'static str {
        match self {
            Trigger::Click => "click",
            Trigger::DoubleClick => "double_click",
            Trigger::SelectionChange => "selection_change",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "click" => Some(Trigger::Click),
            "double_click" => Some(Trigger::DoubleClick),
            "selection_change" => Some(Trigger::SelectionChange),
            _ => None,
        }
    }
}

impl fmt::Display for Trigger {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 动作操作（RFC 0007 决策 1 / D29 / D48：show/hide/toggle + collapse/expand + navigate）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionOp {
    /// 显示面板控件。
    Show,
    /// 隐藏面板控件。
    Hide,
    /// 切换（面板控件或组）。
    Toggle,
    /// 收起组（组的隐藏 = 最小化至 6px，标签条保留）。
    Collapse,
    /// 展开组（恢复收起前尺寸）。
    Expand,
    /// 界面跳转：切换到目标界面（页面）。
    Navigate,
}

impl ActionOp {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionOp::Show => "show",
            ActionOp::Hide => "hide",
            ActionOp::Toggle => "toggle",
            ActionOp::Collapse => "collapse",
            ActionOp::Expand => "expand",
            ActionOp::Navigate => "navigate",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "show" => Some(ActionOp::Show),
            "hide" => Some(ActionOp::Hide),
            "toggle" => Some(ActionOp::Toggle),
            "collapse" => Some(ActionOp::Collapse),
            "expand" => Some(ActionOp::Expand),
            "navigate" => Some(ActionOp::Navigate),
            _ => None,
        }
    }

    /// 是否为组级操作（目标必须是组节点）。
    pub fn is_group_op(&self) -> bool {
        matches!(self, ActionOp::Collapse | ActionOp::Expand)
    }

    /// 是否为界面跳转（界面级操作，目标必须是界面节点，D48）。
    pub fn is_interface_op(&self) -> bool {
        matches!(self, ActionOp::Navigate)
    }
}

impl fmt::Display for ActionOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 边类型（RFC 0007 决策 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// 包含：界面 → 布局块/浮层；布局块/浮层 → 标签组/面板控件；
    /// 标签组 → 面板控件；面板控件 → 类 → 对象。
    Contains,
    /// 归属：面板控件 → 组（兼容旧图）。
    #[serde(rename = "memberOf")]
    MemberOf,
    /// 规则三元组之「对象 → 操作」：在对象（面板控件/类/对象）上发生操作。
    On,
    /// 触发：操作 → 条件/状态。
    Fires,
    /// 守卫：条件 → 状态。
    Guards,
}

impl EdgeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EdgeKind::Contains => "contains",
            EdgeKind::MemberOf => "memberOf",
            EdgeKind::On => "on",
            EdgeKind::Fires => "fires",
            EdgeKind::Guards => "guards",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "contains" => Some(EdgeKind::Contains),
            "memberOf" => Some(EdgeKind::MemberOf),
            "on" => Some(EdgeKind::On),
            "fires" => Some(EdgeKind::Fires),
            "guards" => Some(EdgeKind::Guards),
            _ => None,
        }
    }
}

impl fmt::Display for EdgeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 浮层外观档位（D50 修订 / D44）：阴影与圆角只允许取**宿主设计 token 档位**，
/// 具体像素由 `packages/ui` 的设计 token 决定，蓝图不写死像素（保证浅色/深色一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenLevel {
    /// 无（无阴影 / 直角）。
    None,
    /// 小档。
    Sm,
    /// 中档。
    Md,
    /// 大档。
    Lg,
}

impl TokenLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenLevel::None => "none",
            TokenLevel::Sm => "sm",
            TokenLevel::Md => "md",
            TokenLevel::Lg => "lg",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "none" => Some(TokenLevel::None),
            "sm" => Some(TokenLevel::Sm),
            "md" => Some(TokenLevel::Md),
            "lg" => Some(TokenLevel::Lg),
            _ => None,
        }
    }
}

impl fmt::Display for TokenLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 浮层锚点（3×3 井字位置，D50 修订）：浮层相对**界面（宿主内容区）**的对齐位置。
///
/// 语义：`top_*` 表示浮层**上边**贴界面上边、`*_center` 表示水平居中 … 依此类推；
/// 再叠加 `offset_x` / `offset_y` 微调（见 `BlueprintNode::offset_x`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    MiddleLeft,
    Center,
    MiddleRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl OverlayAnchor {
    /// 全部锚点（按井字顺序：上排 → 中排 → 下排），供编辑器下拉与校验使用。
    pub const ALL: [OverlayAnchor; 9] = [
        OverlayAnchor::TopLeft,
        OverlayAnchor::TopCenter,
        OverlayAnchor::TopRight,
        OverlayAnchor::MiddleLeft,
        OverlayAnchor::Center,
        OverlayAnchor::MiddleRight,
        OverlayAnchor::BottomLeft,
        OverlayAnchor::BottomCenter,
        OverlayAnchor::BottomRight,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            OverlayAnchor::TopLeft => "top_left",
            OverlayAnchor::TopCenter => "top_center",
            OverlayAnchor::TopRight => "top_right",
            OverlayAnchor::MiddleLeft => "middle_left",
            OverlayAnchor::Center => "center",
            OverlayAnchor::MiddleRight => "middle_right",
            OverlayAnchor::BottomLeft => "bottom_left",
            OverlayAnchor::BottomCenter => "bottom_center",
            OverlayAnchor::BottomRight => "bottom_right",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "top_left" => Some(OverlayAnchor::TopLeft),
            "top_center" => Some(OverlayAnchor::TopCenter),
            "top_right" => Some(OverlayAnchor::TopRight),
            "middle_left" => Some(OverlayAnchor::MiddleLeft),
            "center" => Some(OverlayAnchor::Center),
            "middle_right" => Some(OverlayAnchor::MiddleRight),
            "bottom_left" => Some(OverlayAnchor::BottomLeft),
            "bottom_center" => Some(OverlayAnchor::BottomCenter),
            "bottom_right" => Some(OverlayAnchor::BottomRight),
            _ => None,
        }
    }

    /// 水平分量：左 / 中 / 右。
    pub fn horizontal(&self) -> AnchorAxis {
        match self {
            OverlayAnchor::TopLeft | OverlayAnchor::MiddleLeft | OverlayAnchor::BottomLeft => {
                AnchorAxis::Start
            }
            OverlayAnchor::TopCenter | OverlayAnchor::Center | OverlayAnchor::BottomCenter => {
                AnchorAxis::Middle
            }
            OverlayAnchor::TopRight | OverlayAnchor::MiddleRight | OverlayAnchor::BottomRight => {
                AnchorAxis::End
            }
        }
    }

    /// 垂直分量：上 / 中 / 下。
    pub fn vertical(&self) -> AnchorAxis {
        match self {
            OverlayAnchor::TopLeft | OverlayAnchor::TopCenter | OverlayAnchor::TopRight => {
                AnchorAxis::Start
            }
            OverlayAnchor::MiddleLeft | OverlayAnchor::Center | OverlayAnchor::MiddleRight => {
                AnchorAxis::Middle
            }
            OverlayAnchor::BottomLeft
            | OverlayAnchor::BottomCenter
            | OverlayAnchor::BottomRight => AnchorAxis::End,
        }
    }
}

/// 锚点在某一轴上的分量（起 / 中 / 末）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorAxis {
    Start,
    Middle,
    End,
}

impl fmt::Display for OverlayAnchor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
