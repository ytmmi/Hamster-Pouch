/**
 * test_ui M1：仓库与设置命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

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
  return invoke<RepoSummary>("repo_create", {
    name: args.name,
    dbPath: args.dbPath,
  });
}

/** 打开已注册仓库 */
export function repoOpen(args: RepoOpenArgs): Promise<RepoSummary> {
  return invoke<RepoSummary>("repo_open", { repoId: args.repoId });
}

/** 关闭当前仓库 */
export function repoClose(): Promise<void> {
  return invoke<void>("repo_close");
}

/** 列出全部已注册仓库 */
export function repoList(): Promise<RepoListItem[]> {
  return invoke<RepoListItem[]>("repo_list");
}

/** 读取设置 */
export function settingGet(args: SettingGetArgs): Promise<string | null> {
  return invoke<string | null>("setting_get", { key: args.key });
}

/** 写入设置 */
export function settingSet(args: SettingSetArgs): Promise<void> {
  return invoke<void>("setting_set", { key: args.key, value: args.value });
}
