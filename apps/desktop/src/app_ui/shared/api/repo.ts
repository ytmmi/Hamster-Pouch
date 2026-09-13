/**
 * M1：仓库与设置命令封装。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  RepoCreateArgs,
  RepoDeleteArgs,
  RepoListItem,
  RepoOpenArgs,
  RepoRenameArgs,
  RepoSetDefaultArgs,
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

/** 重命名仓库 */
export function repoRename(args: RepoRenameArgs): Promise<void> {
  return invoke<void>("repo_rename", { repoId: args.repoId, name: args.name });
}

/** 删除仓库（注册行 + 仓库库文件；不删除真实图像源文件） */
export function repoDelete(args: RepoDeleteArgs): Promise<void> {
  return invoke<void>("repo_delete", { repoId: args.repoId });
}

/** 设为默认仓库（启动时自动打开） */
export function repoSetDefault(args: RepoSetDefaultArgs): Promise<void> {
  return invoke<void>("repo_set_default", { repoId: args.repoId });
}

/** 读取默认仓库 ID；未设置返回 null */
export function repoGetDefault(): Promise<string | null> {
  return invoke<string | null>("repo_get_default");
}
