/**
 * M4-7：面板布局持久化类型（panel_layouts，D1）。
 */

/** layout_list 返回元素 */
export interface LayoutItem {
  id: string;
  name: string;
  updated_at: string;
}

export interface LayoutSaveArgs {
  repoId: string;
  name: string;
  layoutJson: string;
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
