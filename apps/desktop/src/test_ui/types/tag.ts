/**
 * test_ui M4：tag 类型。
 */

/** tag_list / tag_for_file 返回元素 */
export interface TagItem {
  id: string;
  repo_id: string;
  name: string;
  color: string | null;
}

export interface TagAddArgs {
  repoId: string;
  fileIds: string[];
  tagName: string;
}

export interface TagRemoveArgs {
  repoId: string;
  fileIds: string[];
  tagName: string;
}

export interface TagListArgs {
  repoId: string;
}

export interface TagForFileArgs {
  repoId: string;
  fileId: string;
}
