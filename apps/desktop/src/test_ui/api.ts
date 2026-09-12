/**
 * test_ui API 层 — 包装所有 Tauri invoke 调用，提供类型安全接口。
 *
 * 命令名 snake_case；参数键 camelCase（Tauri v2 自动映射）。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  AlbumAddMemberArgs,
  AlbumCreateArgs,
  AlbumCreateResult,
  AlbumItem,
  AlbumListArgs,
  AlbumMembersArgs,
  AlbumMemberResult,
  AlbumRemoveMemberArgs,
  AlbumRemoveResult,
  AlbumSetMediaTypeArgs,
  AlbumSetMediaTypeResult,
  AlbumSyncArgs,
  ColorExtractArgs,
  ColorGetArgs,
  ColorSetArgs,
  FileItem,
  FileMetadataArgs,
  FileMetadataResult,
  FileQueryArgs,
  RepoCreateArgs,
  RepoListItem,
  RepoOpenArgs,
  RepoSummary,
  SettingGetArgs,
  SettingSetArgs,
  SourceItem,
  SourceListArgs,
  SourceMountArgs,
  SourceRenameArgs,
  SourceScanArgs,
  SourceUnmountArgs,
  TagAddArgs,
  TagForFileArgs,
  TagItem,
  TagListArgs,
  TagRemoveArgs,
  RatingSetArgs,
  RatingGetArgs,
} from "./types";

// ===== M1：仓库与设置 =====

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

// ===== M2：图像源 =====

/** 挂载图像源 */
export function sourceMount(args: SourceMountArgs): Promise<SourceItem> {
  return invoke<SourceItem>("source_mount", {
    repoId: args.repoId,
    localPath: args.localPath,
    alias: args.alias,
    parentSourceId: args.parentSourceId,
  });
}

/** 卸载图像源 */
export function sourceUnmount(args: SourceUnmountArgs): Promise<void> {
  return invoke<void>("source_unmount", {
    repoId: args.repoId,
    sourceId: args.sourceId,
  });
}

/** 重命名图像源别名 */
export function sourceRename(args: SourceRenameArgs): Promise<void> {
  return invoke<void>("source_rename", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    alias: args.alias,
  });
}

/** 列出仓库下全部图像源 */
export function sourceList(args: SourceListArgs): Promise<SourceItem[]> {
  return invoke<SourceItem[]>("source_list", { repoId: args.repoId });
}

/** 扫描图像源（后台执行，返回 taskId） */
export function sourceScan(args: SourceScanArgs): Promise<string> {
  return invoke<string>("source_scan", {
    repoId: args.repoId,
    sourceId: args.sourceId,
    full: args.full,
  });
}

/** 取消当前后台任务 */
export function taskCancel(): Promise<void> {
  return invoke<void>("task_cancel");
}

// ===== M3：虚拟相册 =====

/** 创建相册 */
export function albumCreate(args: AlbumCreateArgs): Promise<AlbumCreateResult> {
  return invoke<AlbumCreateResult>("album_create", {
    repoId: args.repoId,
    name: args.name,
    kind: args.kind,
    mediaType: args.mediaType,
    parentAlbumId: args.parentAlbumId,
    sourceId: args.sourceId,
    syncMode: args.syncMode,
    includeSubsources: args.includeSubsources,
    filterJson: args.filterJson,
    fileIds: args.fileIds,
  });
}

/** 设置相册媒体属性 */
export function albumSetMediaType(
  args: AlbumSetMediaTypeArgs,
): Promise<AlbumSetMediaTypeResult> {
  return invoke<AlbumSetMediaTypeResult>("album_set_media_type", {
    repoId: args.repoId,
    albumId: args.albumId,
    mediaType: args.mediaType,
  });
}

/** 添加相册成员 */
export function albumAddMember(
  args: AlbumAddMemberArgs,
): Promise<AlbumMemberResult> {
  return invoke<AlbumMemberResult>("album_add_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 移除相册成员 */
export function albumRemoveMember(
  args: AlbumRemoveMemberArgs,
): Promise<AlbumRemoveResult> {
  return invoke<AlbumRemoveResult>("album_remove_member", {
    repoId: args.repoId,
    albumId: args.albumId,
    fileIds: args.fileIds,
  });
}

/** 列出仓库下全部相册 */
export function albumList(args: AlbumListArgs): Promise<AlbumItem[]> {
  return invoke<AlbumItem[]>("album_list", { repoId: args.repoId });
}

/** 列出相册可见成员 */
export function albumMembers(args: AlbumMembersArgs): Promise<FileItem[]> {
  return invoke<FileItem[]>("album_members", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}

/** 执行相册同步（后台执行，返回 taskId） */
export function albumSync(args: AlbumSyncArgs): Promise<string> {
  return invoke<string>("album_sync", {
    repoId: args.repoId,
    albumId: args.albumId,
  });
}

// ===== M4：标签 / 评分 / 元数据 / 色彩 =====

/** 给文件批量添加 tag */
export function tagAdd(args: TagAddArgs): Promise<void> {
  return invoke<void>("tag_add", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 从文件批量移除 tag */
export function tagRemove(args: TagRemoveArgs): Promise<void> {
  return invoke<void>("tag_remove", {
    repoId: args.repoId,
    fileIds: args.fileIds,
    tagName: args.tagName,
  });
}

/** 列出仓库内全部 tag */
export function tagList(args: TagListArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_list", { repoId: args.repoId });
}

/** 列出文件已关联的 tag */
export function tagForFile(args: TagForFileArgs): Promise<TagItem[]> {
  return invoke<TagItem[]>("tag_for_file", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 设置文件评分（0-5） */
export function ratingSet(args: RatingSetArgs): Promise<void> {
  return invoke<void>("rating_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    rating: args.rating,
  });
}

/** 读取文件评分 */
export function ratingGet(args: RatingGetArgs): Promise<number | null> {
  return invoke<number | null>("rating_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 读取文件色彩参考 */
export function colorGet(args: ColorGetArgs): Promise<string | null> {
  return invoke<string | null>("color_get", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 手动设置文件色彩参考 */
export function colorSet(args: ColorSetArgs): Promise<void> {
  return invoke<void>("color_set", {
    repoId: args.repoId,
    fileId: args.fileId,
    colorJson: args.colorJson,
  });
}

/** 提取图片调色板（后台执行，返回 taskId） */
export function colorExtract(args: ColorExtractArgs): Promise<string> {
  return invoke<string>("color_extract", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 读取文件元数据 */
export function fileMetadata(args: FileMetadataArgs): Promise<FileMetadataResult> {
  return invoke<FileMetadataResult>("file_metadata", {
    repoId: args.repoId,
    fileId: args.fileId,
  });
}

/** 按仓库分页查询文件索引 */
export function fileQuery(args: FileQueryArgs): Promise<FileItem[]> {
  return invoke<FileItem[]>("file_query", {
    repoId: args.repoId,
    mediaType: args.mediaType,
    sourceId: args.sourceId,
    limit: args.limit,
    offset: args.offset,
  });
}
