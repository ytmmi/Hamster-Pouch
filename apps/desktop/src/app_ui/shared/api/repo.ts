/**
 * M1：仓库与设置命令封装。
 *
 * **D76 迁移状态：已包装**（批次 `setting` 与 `repo/layout`，2026-09）。本文件全部命令
 * 返回 `{ ok, data?, error? }`，这里经 [`unwrapApi`] 解包：调用方拿到的仍是原来的领域值，
 * 失败时抛带 `code` 的 `HpApiFailure`，界面按 `code` 走 i18n（D27）。
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
import { unwrapApi, type ApiResponse } from "./response";

/** 创建仓库（自动打开） */
export function repoCreate(args: RepoCreateArgs): Promise<RepoSummary> {
  return invoke<ApiResponse<RepoSummary>>("repo_create", {
    name: args.name,
    dbPath: args.dbPath,
  }).then(unwrapApi);
}

/** 打开已注册仓库 */
export function repoOpen(args: RepoOpenArgs): Promise<RepoSummary> {
  return invoke<ApiResponse<RepoSummary>>("repo_open", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 关闭当前仓库 */
export function repoClose(): Promise<void> {
  return invoke<ApiResponse<void>>("repo_close").then(unwrapApi);
}

/** 列出全部已注册仓库 */
export function repoList(): Promise<RepoListItem[]> {
  return invoke<ApiResponse<RepoListItem[]>>("repo_list").then(unwrapApi);
}

/**
 * 读取单个设置值（`{ value | null }`，标量）。
 *
 * 契约见 `docs/spec/commands-events.md` 3.13：**已按 D76 包装并解包**。
 * 未知键 → `validation`；`scope = "repo"` 项缺 `repoId` → `validation`。
 */
export function settingGet(args: SettingGetArgs): Promise<SettingValueResult> {
  return invoke<ApiResponse<SettingValueResult>>("setting_get", {
    key: args.key,
    repoId: args.repoId ?? null,
  }).then(unwrapApi);
}

/**
 * 写入单个设置值（标量；返回 `{ ok }`）。
 *
 * 失败码（按 D76 闭集）：未知键 / 类型不符 / `select` 越界 → `validation`；
 * 插件项未获 `requires_capability` → `permission`。
 */
export function settingSet(args: SettingSetArgs): Promise<SettingOkResult> {
  return invoke<ApiResponse<SettingOkResult>>("setting_set", {
    key: args.key,
    value: args.value,
    repoId: args.repoId ?? null,
  }).then(unwrapApi);
}

/** 列出全部设置值（`{ items }`；「全部设置」界面一次读完）。已按 D76 包装并解包。 */
export function settingList(): Promise<SettingListResult> {
  return invoke<ApiResponse<SettingListResult>>("setting_list").then(unwrapApi);
}

/** 把某项设置恢复为声明缺省值（删除该键；返回 `{ ok }`）。已按 D76 包装并解包。 */
export function settingReset(args: SettingResetArgs): Promise<SettingOkResult> {
  return invoke<ApiResponse<SettingOkResult>>("setting_reset", {
    key: args.key,
    repoId: args.repoId ?? null,
  }).then(unwrapApi);
}

/** 重命名仓库 */
export function repoRename(args: RepoRenameArgs): Promise<void> {
  return invoke<ApiResponse<void>>("repo_rename", {
    repoId: args.repoId,
    name: args.name,
  }).then(unwrapApi);
}

/** 删除仓库（注册行 + 仓库库文件；不删除真实媒体源文件） */
export function repoDelete(args: RepoDeleteArgs): Promise<void> {
  return invoke<ApiResponse<void>>("repo_delete", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 设为默认仓库（启动时自动打开） */
export function repoSetDefault(args: RepoSetDefaultArgs): Promise<void> {
  return invoke<ApiResponse<void>>("repo_set_default", {
    repoId: args.repoId,
  }).then(unwrapApi);
}

/** 读取默认仓库 ID；未设置返回 null */
export function repoGetDefault(): Promise<string | null> {
  return invoke<ApiResponse<string | null>>("repo_get_default").then(unwrapApi);
}

/**
 * 备份仓库库文件到目标路径，返回备份 ID。
 *
 * **D76**：`repo.backup` 此前**没有前端封装**（对账把它记为「仅代码」），本批一并补上——
 * 契约记录了能力却拿不到，与 D79 处理 tag 关系缺口是同一类问题。
 */
export function repoBackup(repoId: string, destPath: string): Promise<string> {
  return invoke<ApiResponse<string>>("repo_backup", { repoId, destPath }).then(unwrapApi);
}
