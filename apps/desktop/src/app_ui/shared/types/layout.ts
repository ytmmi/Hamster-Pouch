/**
 * M4-7：面板布局持久化类型（panel_layouts，D1）。
 */

/** layout_list 返回元素 */
export interface LayoutItem {
  id: string;
  name: string;
  /** 布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。 */
  blueprint_ids: string[];
  updated_at: string;
}

export interface LayoutSaveArgs {
  repoId: string;
  name: string;
  layoutJson: string;
  /** 可选：该布局绑定的蓝图 ID 列表。 */
  blueprintIds?: string[];
}

export interface LayoutBlueprintsArgs {
  repoId: string;
  name: string;
}

export interface LayoutListArgs {
  repoId: string;
}

export interface LayoutGetArgs {
  repoId: string;
  name: string;
}

export interface LayoutRenameArgs {
  repoId: string;
  name: string;
  newName: string;
}

export interface LayoutDeleteArgs {
  repoId: string;
  name: string;
}

export interface LayoutSetDefaultArgs {
  repoId: string;
  name: string;
}

export interface LayoutGetDefaultArgs {
  repoId: string;
}
