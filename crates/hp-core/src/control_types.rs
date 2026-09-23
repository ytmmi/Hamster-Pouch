//! 控件取值域与**控件类型注册表**（`docs/spec/control-standard.md`「控件 schema 规范」第 4 节）。
//!
//! 本文件是控件类型白名单的**单一事实来源**（Rust 侧）：每种 `kind` 允许的专属字段、
//! 可声明事件、是否容器，都在 [`control_registry`] 的表里声明一次；schema 校验
//! （`control.rs`）与前端 `packages/config/src/controlRegistry.ts` 都以此为准，
//! 一致性由 `pnpm check:controls` 守住。
//!
//! 纯数据：不依赖 Tauri/SQLite/文件系统。**插件不能新增控件类型**（D44：只有宿主
//! 提供的标准 UI 单元，映射到受信任组件集渲染）。

/// 控件 schema 的 API 版本（与宿主 API 版本同源，见 `plugin::HOST_API_VERSION`）。
///
/// 宿主只接受 `api_version <= 当前`；高于当前即拒绝（与蓝图版本闸门同为 `>` 才报错）。
pub const CONTROL_API_VERSION: u32 = 1;

/// 面板控件 schema 的节点数建议上限（超出只给软告警，不阻塞）。
pub const CONTROL_NODE_SOFT_LIMIT: usize = 64;

/// 表格控件的列数上限（硬错误）。
pub const TABLE_COLUMN_MAX: usize = 8;

/// 控件类别（仅用于文档/编辑器分组，**不是** JSON 字段：`kind` 直接取具体类型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlCategory {
    /// 布局容器：行、列、区块、可折叠区、占位。
    Layout,
    /// 展示：文本、图标、图像、进度、键值。
    Display,
    /// 输入：按钮、开关、输入框、下拉、滑块、复选。
    Input,
    /// 集合：列表、树、表格、标签链、缩略图网格。
    Collection,
    /// 反馈：状态条、提示、空态、分隔线。
    Feedback,
}

impl ControlCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ControlCategory::Layout => "layout",
            ControlCategory::Display => "display",
            ControlCategory::Input => "input",
            ControlCategory::Collection => "collection",
            ControlCategory::Feedback => "feedback",
        }
    }
}

/// 控件类型白名单（第一版 26 种，宿主内置；插件不得扩展）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlKind {
    // —— 布局容器 ——
    Row,
    Column,
    Panel,
    Section,
    Spacer,
    // —— 展示 ——
    Text,
    Icon,
    Image,
    Progress,
    KeyValue,
    // —— 输入 ——
    Button,
    Switch,
    TextInput,
    NumberInput,
    Select,
    Slider,
    Checkbox,
    // —— 集合 ——
    List,
    Tree,
    Table,
    TagChain,
    ThumbGrid,
    // —— 反馈 ——
    Status,
    Notice,
    Empty,
    Divider,
}

impl ControlKind {
    /// JSON 取值（即 schema 里的 `kind`）。
    pub fn as_str(&self) -> &'static str {
        match self {
            ControlKind::Row => "row",
            ControlKind::Column => "column",
            ControlKind::Panel => "panel",
            ControlKind::Section => "section",
            ControlKind::Spacer => "spacer",
            ControlKind::Text => "text",
            ControlKind::Icon => "icon",
            ControlKind::Image => "image",
            ControlKind::Progress => "progress",
            ControlKind::KeyValue => "keyValue",
            ControlKind::Button => "button",
            ControlKind::Switch => "switch",
            ControlKind::TextInput => "textInput",
            ControlKind::NumberInput => "numberInput",
            ControlKind::Select => "select",
            ControlKind::Slider => "slider",
            ControlKind::Checkbox => "checkbox",
            ControlKind::List => "list",
            ControlKind::Tree => "tree",
            ControlKind::Table => "table",
            ControlKind::TagChain => "tagChain",
            ControlKind::ThumbGrid => "thumbGrid",
            ControlKind::Status => "status",
            ControlKind::Notice => "notice",
            ControlKind::Empty => "empty",
            ControlKind::Divider => "divider",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        CONTROL_KINDS.iter().copied().find(|k| k.as_str() == s)
    }

    /// 全部类型（与 [`control_registry`] 的表顺序一致）。
    pub const ALL: [ControlKind; 26] = [
        ControlKind::Row,
        ControlKind::Column,
        ControlKind::Panel,
        ControlKind::Section,
        ControlKind::Spacer,
        ControlKind::Text,
        ControlKind::Icon,
        ControlKind::Image,
        ControlKind::Progress,
        ControlKind::KeyValue,
        ControlKind::Button,
        ControlKind::Switch,
        ControlKind::TextInput,
        ControlKind::NumberInput,
        ControlKind::Select,
        ControlKind::Slider,
        ControlKind::Checkbox,
        ControlKind::List,
        ControlKind::Tree,
        ControlKind::Table,
        ControlKind::TagChain,
        ControlKind::ThumbGrid,
        ControlKind::Status,
        ControlKind::Notice,
        ControlKind::Empty,
        ControlKind::Divider,
    ];
}

impl std::fmt::Display for ControlKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// 手写 serde：JSON 取值即 `as_str`，未知取值在解析层报错（与蓝图枚举同一口径）。
impl serde::Serialize for ControlKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for ControlKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        ControlKind::from_str(&raw)
            .ok_or_else(|| serde::de::Error::custom(format!("未知控件类型: {raw}")))
    }
}

/// 全类型清单（供解析层白名单与自检脚本比对）。
pub const CONTROL_KINDS: [ControlKind; 26] = ControlKind::ALL;

/// 控件可声明的事件名（固定谓词表，控件标准第 6 节）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ControlEvent {
    Click,
    DoubleClick,
    SelectionChange,
    ValueChange,
    Submit,
    Toggle,
}

impl ControlEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            ControlEvent::Click => "click",
            ControlEvent::DoubleClick => "double_click",
            ControlEvent::SelectionChange => "selection_change",
            ControlEvent::ValueChange => "value_change",
            ControlEvent::Submit => "submit",
            ControlEvent::Toggle => "toggle",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        CONTROL_EVENTS.iter().copied().find(|e| e.as_str() == s)
    }
}

/// 事件谓词表全清单。
pub const CONTROL_EVENTS: [ControlEvent; 6] = [
    ControlEvent::Click,
    ControlEvent::DoubleClick,
    ControlEvent::SelectionChange,
    ControlEvent::ValueChange,
    ControlEvent::Submit,
    ControlEvent::Toggle,
];

/// 间距档位（取宿主设计 token，不写像素）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapToken {
    None,
    Sm,
    Md,
    Lg,
}

impl GapToken {
    pub fn as_str(&self) -> &'static str {
        match self {
            GapToken::None => "none",
            GapToken::Sm => "sm",
            GapToken::Md => "md",
            GapToken::Lg => "lg",
        }
    }
}

/// 对齐档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlignToken {
    Start,
    Center,
    End,
    Stretch,
}

impl AlignToken {
    pub fn as_str(&self) -> &'static str {
        match self {
            AlignToken::Start => "start",
            AlignToken::Center => "center",
            AlignToken::End => "end",
            AlignToken::Stretch => "stretch",
        }
    }
}

/// 属性的取值类型（校验用它决定怎么检查值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropType {
    /// 字符串。
    Str,
    /// 布尔。
    Bool,
    /// 有限数值。
    Num,
    /// 字符串枚举（枚举值见 [`ControlProp`] 的 `enum_values`）。
    Enum,
    /// 字符串数组（如 `table.columns`）。
    StrArray,
}

/// 一个**专属属性**的规格（通用属性 `id` / `kind` / `visible` / `enabled` / `text_key`
/// / `bind` / `on` / `children` 不属于专属属性，由结构体统一承载）。
#[derive(Debug, Clone, Copy)]
pub struct ControlProp {
    /// JSON 字段名（snake_case）。
    pub name: &'static str,
    pub ty: PropType,
    /// `PropType::Enum` 的允许取值。
    pub enum_values: &'static [&'static str],
    /// 是否必需品（缺省视为缺省值，不报错）。
    pub required: bool,
}

impl ControlProp {
    const fn new(name: &'static str, ty: PropType) -> Self {
        Self {
            name,
            ty,
            enum_values: &[],
            required: false,
        }
    }

    const fn with_required(mut self, required: bool) -> Self {
        self.required = required;
        self
    }

    const fn with_enum(mut self, values: &'static [&'static str]) -> Self {
        self.enum_values = values;
        self
    }
}

/// 一种控件类型的定义（注册表的一行）。
#[derive(Debug, Clone, Copy)]
pub struct ControlKindSpec {
    pub kind: ControlKind,
    pub category: ControlCategory,
    /// 是否为容器（可带 `children`）。
    pub container: bool,
    /// 专属属性清单。
    pub props: &'static [ControlProp],
    /// 可声明的事件清单。
    pub events: &'static [ControlEvent],
}

impl ControlKindSpec {
    /// 该属性是否是本类型的专属属性（合法字段名）。
    pub fn find_prop(&self, name: &str) -> Option<&'static ControlProp> {
        self.props.iter().find(|p| p.name == name)
    }

    /// 该事件名是否可用于本类型。
    pub fn allows_event(&self, event: ControlEvent) -> bool {
        self.events.contains(&event)
    }

    /// 该类型专属属性的字段名清单（供 JSON 视图/前端表比对）。
    pub fn prop_names(&self) -> Vec<&'static str> {
        self.props.iter().map(|p| p.name).collect()
    }
}

// 专用枚举取值表（与文档第 4 节表格逐项对齐）。
const TEXT_VARIANTS: [&str; 4] = ["body", "dim", "heading", "code"];
const BUTTON_VARIANTS: [&str; 3] = ["default", "primary", "danger"];
const FIT_VALUES: [&str; 2] = ["contain", "cover"];
const OPTIONS_KINDS: [&str; 2] = ["static", "bound"];
const ITEM_TEXTS: [&str; 3] = ["none", "name", "hex"];
const STATUS_VARIANTS: [&str; 4] = ["info", "ok", "warn", "error"];
const EMPTY_VARIANTS: [&str; 3] = ["empty", "loading", "error"];
const GAP_VALUES: [&str; 4] = ["none", "sm", "md", "lg"];
const ALIGN_VALUES: [&str; 4] = ["start", "center", "end", "stretch"];

// 常用属性组合（避免每行重复书写）。
const GAP_ALIGN: [ControlProp; 2] = [
    ControlProp::new("gap", PropType::Enum).with_enum(&GAP_VALUES),
    ControlProp::new("align", PropType::Enum).with_enum(&ALIGN_VALUES),
];

const NO_PROPS: [ControlProp; 0] = [];

/// 控件类型注册表（第一版 26 种；**唯一事实来源**，文档第 4 节表与之逐项对应）。
pub const CONTROL_REGISTRY: [ControlKindSpec; 26] = [
    ControlKindSpec {
        kind: ControlKind::Row,
        category: ControlCategory::Layout,
        container: true,
        props: &GAP_ALIGN,
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Column,
        category: ControlCategory::Layout,
        container: true,
        props: &GAP_ALIGN,
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Panel,
        category: ControlCategory::Layout,
        container: true,
        props: &[
            ControlProp::new("title_key", PropType::Str),
            ControlProp::new("bordered", PropType::Bool),
        ],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Section,
        category: ControlCategory::Layout,
        container: true,
        props: &[
            ControlProp::new("title_key", PropType::Str),
            ControlProp::new("collapsed", PropType::Bool),
        ],
        events: &[ControlEvent::Toggle],
    },
    ControlKindSpec {
        kind: ControlKind::Spacer,
        category: ControlCategory::Layout,
        container: false,
        props: &NO_PROPS,
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Text,
        category: ControlCategory::Display,
        container: false,
        props: &[
            ControlProp::new("text", PropType::Str),
            ControlProp::new("variant", PropType::Enum).with_enum(&TEXT_VARIANTS),
        ],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Icon,
        category: ControlCategory::Display,
        container: false,
        props: &[ControlProp::new("icon", PropType::Str).with_required(true)],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Image,
        category: ControlCategory::Display,
        container: false,
        props: &[ControlProp::new("fit", PropType::Enum).with_enum(&FIT_VALUES)],
        events: &[ControlEvent::Click],
    },
    ControlKindSpec {
        kind: ControlKind::Progress,
        category: ControlCategory::Display,
        container: false,
        props: &[ControlProp::new("max", PropType::Num)],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::KeyValue,
        category: ControlCategory::Display,
        container: false,
        props: &NO_PROPS,
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Button,
        category: ControlCategory::Input,
        container: false,
        props: &[ControlProp::new("variant", PropType::Enum).with_enum(&BUTTON_VARIANTS)],
        events: &[ControlEvent::Click, ControlEvent::DoubleClick],
    },
    ControlKindSpec {
        kind: ControlKind::Switch,
        category: ControlCategory::Input,
        container: false,
        props: &NO_PROPS,
        events: &[ControlEvent::ValueChange],
    },
    ControlKindSpec {
        kind: ControlKind::TextInput,
        category: ControlCategory::Input,
        container: false,
        props: &[
            ControlProp::new("placeholder_key", PropType::Str),
            ControlProp::new("multiline", PropType::Bool),
        ],
        events: &[ControlEvent::ValueChange, ControlEvent::Submit],
    },
    ControlKindSpec {
        kind: ControlKind::NumberInput,
        category: ControlCategory::Input,
        container: false,
        props: &[
            ControlProp::new("min", PropType::Num),
            ControlProp::new("max", PropType::Num),
            ControlProp::new("step", PropType::Num),
        ],
        events: &[ControlEvent::ValueChange],
    },
    ControlKindSpec {
        kind: ControlKind::Select,
        category: ControlCategory::Input,
        container: false,
        props: &[ControlProp::new("options_kind", PropType::Enum).with_enum(&OPTIONS_KINDS)],
        events: &[ControlEvent::ValueChange],
    },
    ControlKindSpec {
        kind: ControlKind::Slider,
        category: ControlCategory::Input,
        container: false,
        props: &[
            ControlProp::new("min", PropType::Num),
            ControlProp::new("max", PropType::Num),
            ControlProp::new("step", PropType::Num),
        ],
        events: &[ControlEvent::ValueChange],
    },
    ControlKindSpec {
        kind: ControlKind::Checkbox,
        category: ControlCategory::Input,
        container: false,
        props: &NO_PROPS,
        events: &[ControlEvent::ValueChange],
    },
    ControlKindSpec {
        kind: ControlKind::List,
        category: ControlCategory::Collection,
        container: false,
        props: &[ControlProp::new("item_text", PropType::Enum).with_enum(&ITEM_TEXTS)],
        events: &[
            ControlEvent::Click,
            ControlEvent::DoubleClick,
            ControlEvent::SelectionChange,
        ],
    },
    ControlKindSpec {
        kind: ControlKind::Tree,
        category: ControlCategory::Collection,
        container: false,
        props: &[ControlProp::new("item_text", PropType::Enum).with_enum(&ITEM_TEXTS)],
        events: &[
            ControlEvent::Click,
            ControlEvent::DoubleClick,
            ControlEvent::SelectionChange,
        ],
    },
    ControlKindSpec {
        kind: ControlKind::Table,
        category: ControlCategory::Collection,
        container: false,
        props: &[ControlProp::new("columns", PropType::StrArray)],
        events: &[
            ControlEvent::Click,
            ControlEvent::DoubleClick,
            ControlEvent::SelectionChange,
        ],
    },
    ControlKindSpec {
        kind: ControlKind::TagChain,
        category: ControlCategory::Collection,
        container: false,
        props: &NO_PROPS,
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::ThumbGrid,
        category: ControlCategory::Collection,
        container: false,
        props: &[ControlProp::new("item_text", PropType::Enum).with_enum(&ITEM_TEXTS)],
        events: &[
            ControlEvent::Click,
            ControlEvent::DoubleClick,
            ControlEvent::SelectionChange,
        ],
    },
    ControlKindSpec {
        kind: ControlKind::Status,
        category: ControlCategory::Feedback,
        container: false,
        props: &[ControlProp::new("variant", PropType::Enum).with_enum(&STATUS_VARIANTS)],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Notice,
        category: ControlCategory::Feedback,
        container: true,
        props: &[ControlProp::new("variant", PropType::Enum).with_enum(&STATUS_VARIANTS)],
        events: &[],
    },
    ControlKindSpec {
        kind: ControlKind::Empty,
        category: ControlCategory::Feedback,
        container: false,
        props: &[ControlProp::new("variant", PropType::Enum).with_enum(&EMPTY_VARIANTS)],
        events: &[ControlEvent::Click],
    },
    ControlKindSpec {
        kind: ControlKind::Divider,
        category: ControlCategory::Feedback,
        container: false,
        props: &NO_PROPS,
        events: &[],
    },
];

/// 取某类型的定义（`kind` 一定在白名单内，故用 `expect` 表达该不变量）。
pub fn control_spec(kind: ControlKind) -> &'static ControlKindSpec {
    CONTROL_REGISTRY
        .iter()
        .find(|s| s.kind == kind)
        .expect("CONTROL_REGISTRY 必须覆盖全部 ControlKind")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_kinds_without_duplicates() {
        assert_eq!(CONTROL_REGISTRY.len(), ControlKind::ALL.len());
        for kind in ControlKind::ALL {
            let spec = control_spec(kind);
            assert_eq!(spec.kind, kind);
            assert_eq!(ControlKind::from_str(kind.as_str()), Some(kind));
        }
        let mut names: Vec<&str> = CONTROL_REGISTRY.iter().map(|s| s.kind.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), CONTROL_REGISTRY.len(), "kind 取值不得重复");
    }

    #[test]
    fn container_kinds_are_the_documented_five() {
        let containers: Vec<&str> = CONTROL_REGISTRY
            .iter()
            .filter(|s| s.container)
            .map(|s| s.kind.as_str())
            .collect();
        assert_eq!(containers, vec!["row", "column", "panel", "section", "notice"]);
    }

    #[test]
    fn event_names_round_trip_and_are_unique() {
        let mut names: Vec<&str> = CONTROL_EVENTS.iter().map(|e| e.as_str()).collect();
        for name in names.clone() {
            assert!(ControlEvent::from_str(name).is_some());
        }
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), CONTROL_EVENTS.len());
        assert_eq!(ControlEvent::from_str("cancel"), None);
    }

    #[test]
    fn props_belonging_to_specific_kinds_are_not_accepted_elsewhere() {
        assert!(control_spec(ControlKind::Table)
            .find_prop("columns")
            .is_some());
        assert!(control_spec(ControlKind::Button).find_prop("columns").is_none());
        assert_eq!(control_spec(ControlKind::Icon).prop_names(), vec!["icon"]);
    }
}
