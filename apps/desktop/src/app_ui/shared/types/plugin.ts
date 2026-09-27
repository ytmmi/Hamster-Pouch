/**
 * 插件**注册表视图**类型（RFC 0010；`plugin.contributions` 命令返回）。
 *
 * 手写而非由 `hp-dto` 生成的原因：这是宿主 → 前端的**注册表视图**（随插件安装与启用
 * 状态实时构造、不落库），不是持久化 DTO；`packages/shared-types` 只承载与库表/命令
 * 稳定契约对应的生成类型。
 */

/** 面板设置项声明（与 `docs/spec/panel-standard.md` 第 5.3 节同形）。 */
export interface PanelSettingDeclDto {
  key: string;
  kind: string;
  title_key: string;
  default?: unknown;
  scope?: string;
  requires_capability?: string;
}

/** 宿主约束（第 5.4 节）。 */
export interface PanelMountDto {
  overlay_content: boolean;
  blueprint_ref: boolean;
  multiple_per_interface: boolean;
}

/** 插件注册的面板声明。 */
export interface PanelContributionItem {
  plugin_id: string;
  /** **完整** `plugin.<plugin_id>.<local_id>`。 */
  id: string;
  title_key: string;
  category: string;
  has_class: boolean;
  blueprint_node: string;
  settings: PanelSettingDeclDto[];
  read_only: boolean;
  mount: PanelMountDto;
}

/** 插件注册的蓝图节点类型声明（纯声明；不含代码）。 */
export interface BlueprintNodeDeclDto {
  /** 注册它的插件 id（宿主填充）。 */
  plugin_id: string;
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

/** 插件注册的设置分节声明。 */
export interface SettingsSectionItem {
  plugin_id: string;
  title_key: string;
  /** 归入的**既有**大类（插件不得新增或改名大类）。 */
  category: string;
  settings: PanelSettingDeclDto[];
}

/** 三张注册表的插件注册视图。 */
export interface PluginContributions {
  panels: PanelContributionItem[];
  node_types: BlueprintNodeDeclDto[];
  settings_sections: SettingsSectionItem[];
}
