/**
 * M4-7：面板布局持久化类型（panel_layouts，D1；D53 每层一份）。
 */

/** layout_list 返回元素（**层行**：同一布局名在每个层各一行）。 */
export interface LayoutItem {
  id: string;
  name: string;
  /** 所属层 key（D53）；空串 = 迁移前的层无关行。 */
  layer_key: string;
  /** 布局绑定的蓝图 ID 列表（1 个布局可绑定多个蓝图）。 */
  blueprint_ids: string[];
  updated_at: string;
}

export interface LayoutSaveArgs {
  repoId: string;
  name: string;
  layoutJson: string;
  /** 所属层 key（D53）；缺省 = 层无关行。 */
  layerKey?: string;
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
  /** 所属层 key（D53）；缺省 = 层无关行，读取时按层兜底。 */
  layerKey?: string;
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
