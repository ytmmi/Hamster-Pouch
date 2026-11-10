/**
 * M2：媒体源类型。
 */

/** source_mount / source_list 返回元素 */
export interface SourceItem {
  id: string;
  repo_id: string;
  local_path: string;
  alias: string | null;
  parent_source_id: string | null;
  mounted: boolean;
  mounted_at: string;
}

/** source_tree 返回元素 — 递归目录树（源节点 + 子文件夹） */
export interface SourceTreeNode {
  key: string;
  name: string;
  local_path: string | null;
  relative_path: string | null;
  source_id: string | null;
  file_count: number;
  children: SourceTreeNode[];
}

export interface SourceMountArgs {
  repoId: string;
  localPath: string;
  alias?: string;
  parentSourceId?: string;
}

export interface SourceUnmountArgs {
  repoId: string;
  sourceId: string;
}

/** source_unmount_preview 返回：完全卸载影响预估（警告弹窗据此如实告知用户） */
export interface SourceUnmountPreview {
  /** 该源的文件索引行数。 */
  file_count: number;
  /** 受影响的相册（含各自成员数）。 */
  albums: { album_id: string; name: string; members: number }[];
  /** 将被删除的相册成员关系总数。 */
  member_count: number;
  /** 将被删除的人工 + 自动 tag 关联数。 */
  tag_count: number;
  /** 将被删除的评分数。 */
  rating_count: number;
  /** 将被删除的色彩参考数。 */
  color_count: number;
  /** 将被删除的 AI 覆盖撤销记录数。 */
  ai_undo_count: number;
  /** 因该源被卸载而改为普通相册的跟随相册数。 */
  sync_album_count: number;
  /** 被摘挂为顶层源的子源数。 */
  child_source_count: number;
}

export interface SourceRenameArgs {
  repoId: string;
  sourceId: string;
  alias: string;
}

export interface SourceListArgs {
  repoId: string;
}

export interface SourceScanArgs {
  repoId: string;
  sourceId: string;
  full?: boolean;
}

/** 一条子目录排除记录（source_exclusions / source_exclude 返回元素） */
export interface SourceExclusionItem {
  source_id: string;
  /** 源内相对目录，已归一化为 `/` 分隔、无首尾斜杠；命中它自身与全部后代。 */
  relative_path: string;
  excluded_at: string;
}

/** source_exclusions / source_exclude 返回：该范围内的最新排除清单 */
export interface SourceExclusionList {
  items: SourceExclusionItem[];
}

/** source_unexclude 返回：实际取消的条数 + 该源剩余清单 */
export interface SourceUnexcludeResult {
  removed: number;
  items: SourceExclusionItem[];
}

/** 列出排除清单：`sourceId` 省略 = 整个仓库（面板据此决定菜单项是否显示） */
export interface SourceExclusionsArgs {
  repoId: string;
  sourceId?: string;
}

export interface SourceExcludeArgs {
  repoId: string;
  sourceId: string;
  /** 子文件夹相对路径（源根不参与排除，排除整个源请用卸载）。 */
  relativePath: string;
}

export interface SourceUnexcludeArgs {
  repoId: string;
  sourceId: string;
  /** 要恢复的相对目录清单（逐个勾选）。 */
  relativePaths: string[];
}
