/**
 * M1：仓库与设置命令封装。
 *
 * **D76 迁移状态**：`setting.*` 四条已按新口径返回 `{ ok, data?, error? }` 并在此解包
 * （它们要先落地契约 3.13 的四条规则——规则 3「插件项不满能力返回 `permission`」
 * 只有在**结构化错误**下才对前端可判定）。`repo.*` 仍属 D76 批次里的
 * `repo/layout` 批，**尚未迁移**（下表命令仍裸返回）。
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
