/**
 * M1：仓库与设置类型。
 */

/** repo_create / repo_open 返回 */
export interface RepoSummary {
  id: string;
  name: string;
  schema_version: number;
}

/** repo_list 返回元素 */
export interface RepoListItem {
  id: string;
  name: string;
  repo_db_path: string;
  created_at: string;
  last_opened_at: string | null;
}

export interface RepoCreateArgs {
  name: string;
  dbPath?: string;
}

export interface RepoOpenArgs {
  repoId: string;
}

export interface SettingGetArgs {
  key: string;
}

export interface SettingSetArgs {
  key: string;
  value: string;
}

export interface RepoRenameArgs {
  repoId: string;
  name: string;
}

export interface RepoDeleteArgs {
  repoId: string;
}

export interface RepoSetDefaultArgs {
  repoId: string;
}
