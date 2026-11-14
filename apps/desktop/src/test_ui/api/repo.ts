/**
 * test_ui M1：仓库与设置命令封装。
 *
 * **D76**：这些命令已全量包成 `{ ok, data?, error? }`（2026-09 批次），这里与同目录的
 * `source.ts` / `file.ts` 一样复用主界面的**统一解包层**——信封只有一处实现，两个前端
 * 按同一个 `code` 走 i18n。调用统一走 `invokeApi`（`app_ui/shared/api/call.ts`），
 * 裸 `invoke<T>` 会把信封当数据用。
 */

import { invokeApi } from "../../app_ui/shared/api/call";

import type {
  RepoCreateArgs,
  RepoListItem,
  RepoOpenArgs,
  RepoSummary,
  SettingGetArgs,
  SettingSetArgs,
} from "../types";

/** 创建仓库（自动打开） */
export function repoCreate(args: RepoCreateArgs): Promise<RepoSummary> {
  return invokeApi<RepoSummary>("repo_create", {
    name: args.name,
    dbPath: args.dbPath,
  });
}

/** 打开已注册仓库 */
export function repoOpen(args: RepoOpenArgs): Promise<RepoSummary> {
  return invokeApi<RepoSummary>("repo_open", { repoId: args.repoId });
}

/** 关闭当前仓库 */
export function repoClose(): Promise<void> {
  return invokeApi<void>("repo_close");
}

/** 列出全部已注册仓库 */
export function repoList(): Promise<RepoListItem[]> {
  return invokeApi<RepoListItem[]>("repo_list");
}

/** 读取设置 */
export function settingGet(args: SettingGetArgs): Promise<string | null> {
  return invokeApi<string | null>("setting_get", { key: args.key });
}

/** 写入设置 */
export function settingSet(args: SettingSetArgs): Promise<void> {
  return invokeApi<void>("setting_set", { key: args.key, value: args.value });
}
