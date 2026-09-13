/**
 * test_ui M2：图像源类型。
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
