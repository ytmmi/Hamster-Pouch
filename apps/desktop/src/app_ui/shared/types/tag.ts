/**
 * M4/M5：tag 类型。
 *
 * 返回值类型由 Rust DTO 生成（@hamster-pouch/shared-types）；命令参数类型本地定义。
 */

export type { FileTagItem, FileTagsResult, TagItem } from "@hamster-pouch/shared-types";

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
