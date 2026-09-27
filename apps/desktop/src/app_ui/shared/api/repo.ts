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
  SettingListResult,
  SettingOkResult,
  SettingResetArgs,
  SettingSetArgs,
  SettingValueResult,
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

/**
 * 读取单个设置值（`{ value | null }`，标量）。
 *
 * 契约见 `docs/spec/commands-events.md` 3.13：本命令已**就地迁移**为
 * 标量值 + `repoId`（`scope = "repo"` 的项按仓库隔离）。
 */
export function settingGet(args: SettingGetArgs): Promise<SettingValueResult> {
  return invoke<SettingValueResult>("setting_get", {
    key: args.key,
    repoId: args.repoId ?? null,
  });
}

/** 写入单个设置值（标量；返回 `{ ok }`）。 */
export function settingSet(args: SettingSetArgs): Promise<SettingOkResult> {
  return invoke<SettingOkResult>("setting_set", {
    key: args.key,
    value: args.value,
    repoId: args.repoId ?? null,
  });
}

/** 列出全部设置值（`{ items }`；「全部设置」界面一次读完）。 */
export function settingList(): Promise<SettingListResult> {
  return invoke<SettingListResult>("setting_list");
}

/** 把某项设置恢复为声明缺省值（删除该键；返回 `{ ok }`）。 */
export function settingReset(args: SettingResetArgs): Promise<SettingOkResult> {
  return invoke<SettingOkResult>("setting_reset", {
    key: args.key,
    repoId: args.repoId ?? null,
  });
}

/** 重命名仓库 */
export function repoRename(args: RepoRenameArgs): Promise<void> {
  return invoke<void>("repo_rename", { repoId: args.repoId, name: args.name });
}

/** 删除仓库（注册行 + 仓库库文件；不删除真实媒体源文件） */
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
