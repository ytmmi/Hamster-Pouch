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
