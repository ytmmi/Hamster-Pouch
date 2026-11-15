/**
 * 插件**注册表视图**类型（RFC 0010；`plugin.contributions` 命令返回）。
 *
 * 手写而非由 `hp-dto` 生成的原因：这是宿主 → 前端的**注册表视图**（随插件安装与启用
 * 状态实时构造、不落库），不是持久化 DTO；`packages/shared-types` 只承载与库表/命令
 * 稳定契约对应的生成类型。
 *
 * ## 两层命名（D221 的教训，别"统一"掉）
 *
 * - **桥接层视图字段是驼峰**：`panels` / `nodeTypes` / `settingsSections`，以及每项里的
 *   `pluginId` / `titleKey` / `hasClass` / `blueprintNode` / `readOnly`。桥接层的
 *   `#[derive(Serialize)]` 结构体一律 `#[serde(rename_all = "camelCase")]`（同族缺陷
 *   0042 的 `nextCursor`）。
 * - **内嵌的插件声明保持蛇形**：`settings[]` 的 `title_key` / `requires_capability`、
 *   `mount` 的三项、蓝图节点声明的 `label_key` / `name_from_layer` / `provides_name` /
 *   `evaluation_role`（只有 `severity` 的两个字段是驼峰）。它们是
 *   `hp_core::PanelSettingDecl` / `PanelMount` / `BlueprintNodeDecl` 的原始 JSON 形状，
 *   与 `docs/spec/plugin-standard.md` 第 3 节的 manifest 同形——改这里会连带改插件契约。
 *
 * 曾经两层被写反：前端全按蛇形读，`contributions.node_types.map(...)` 在真机上抛
 * `TypeError`，**整批插件注册一次都没生效**；夹具是手写驼峰字面量，只有真机能看见。
 * 回归网：`tools/check-plugin-wire.mjs`（含行为断言）+ `plugin_contributions.rs` 的
 * 序列化键名用例。
 */

/** 面板设置项声明（与 `docs/spec/settings-standard.md` 第 5 节同形；**蛇形**）。 */
export interface PanelSettingDeclDto {
  key: string;
  kind: string;
  title_key: string;
  default?: unknown;
  scope?: string;
  requires_capability?: string;
}

/** 宿主约束（`docs/spec/panel-standard.md` 第 5.4 节；**蛇形**，同 manifest）。 */
export interface PanelMountDto {
  overlay_content: boolean;
  blueprint_ref: boolean;
  multiple_per_interface: boolean;
}

/** 插件注册的面板声明（桥接层视图：**驼峰**字段 + 蛇形 `settings` / `mount`）。 */
export interface PanelContributionItem {
  /** 注册它的插件 id（宿主填充）。 */
  pluginId: string;
  /** **完整** `plugin.<plugin_id>.<local_id>`。 */
  id: string;
  titleKey: string;
  category: string;
  hasClass: boolean;
  blueprintNode: string;
  settings: PanelSettingDeclDto[];
  readOnly: boolean;
  mount: PanelMountDto;
}

/**
 * 插件注册的蓝图节点类型声明（纯声明；不含代码）。
 *
 * `pluginId` 是宿主平铺加上去的（桥接层驼峰）；其余字段来自
 * `hp_core::BlueprintNodeDecl`，与 manifest 同形：`label_key` / `name_from_layer` /
 * `provides_name` / `evaluation_role` 是蛇形，`fields[].softWhenMissing` 与
 * `severity.{fieldIssue,missingRef}` 是驼峰（Rust 侧的逐字段 `rename`）。
 */
export interface BlueprintNodeDeclDto {
  /** 注册它的插件 id（宿主填充）。 */
  pluginId: string;
  type: string;
  label_key: string;
  role: string;
  name_from_layer: boolean;
  provides_name: boolean;
  fields: {
    name: string;
    type: string;
    required: boolean;
    softWhenMissing: boolean;
    values: string[];
  }[];
  parents: string[];
  children: string[];
  events: string[];
  ports: { id: string; side: string; edge: string }[];
  severity?: { fieldIssue: string; missingRef: string };
  evaluation_role?: string;
}

/** 插件注册的设置分节声明（桥接层视图：**驼峰** `pluginId` / `titleKey`）。 */
export interface SettingsSectionItem {
  /** 注册它的插件 id（宿主填充）。 */
  pluginId: string;
  titleKey: string;
  /** 归入的**既有**大类（插件不得新增或改名大类）。 */
  category: string;
  settings: PanelSettingDeclDto[];
}

/** 三张注册表的插件注册视图（顶层三项都是**驼峰**）。 */
export interface PluginContributions {
  panels: PanelContributionItem[];
  nodeTypes: BlueprintNodeDeclDto[];
  settingsSections: SettingsSectionItem[];
}
