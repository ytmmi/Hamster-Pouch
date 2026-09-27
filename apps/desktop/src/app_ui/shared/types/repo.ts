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
  /** 只对 `scope = "repo"` 的设置项有意义（键为 `{key}.{repoId}`，3.13）。 */
  repoId?: string;
}

export interface SettingSetArgs {
  key: string;
  /** 设置值**一律是标量**（string / number / bool，同 D32 口径）。 */
  value: string | number | boolean;
  repoId?: string;
}

/** `app_settings` 的一行（`setting.list` 的 `items` 元素）。 */
export interface SettingRow {
  key: string;
  value: string | number | boolean;
}

/** `setting.list` 响应（`{ items }`）。 */
export interface SettingListResult {
  items: SettingRow[];
}

/** `setting.get` 响应（标量或 `null`）。 */
export interface SettingValueResult {
  value: string | number | boolean | null;
}

/** `setting.set` / `setting.reset` 响应。 */
export interface SettingOkResult {
  ok: boolean;
}

export interface SettingResetArgs {
  key: string;
  repoId?: string;
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
