/**
 * M4/M5：tag 类型。
 *
 * 返回值类型由 Rust DTO 生成（@hamster-pouch/shared-types）；命令参数类型本地定义。
 */

export type { FileTagItem, FileTagsResult, TagItem } from "@hamster-pouch/shared-types";

/** tag 层级树节点（tag.tree 返回；`is_cross` 为交叉 tag，D22）。 */
export interface TagTreeNode {
  id: string;
  name: string;
  color: string | null;
  count: number;
  is_cross: boolean;
  children: TagTreeNode[];
}

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

/**
 * tag 关系行（`tag.relation.*` 返回；D22/D24 的多父级 DAG 数据源）。
 *
 * 字段沿用后端 `TagRelationItem` 的**蛇形**序列化（D76 的包装只加外层
 * `{ ok, data }`，不改载荷字段名；字段名统一收敛属 D77 的另一条线）。
 */
export interface TagRelationItem {
  id: string;
  repo_id: string;
  from_tag_id: string;
  to_tag_id: string;
  /** `parent` / `related`（`docs/spec/database-schema.md` §4.5）。 */
  relation_kind: string;
  created_at: string;
}

/** `tag.relation.*` 的仓库级参数。 */
export interface TagRelationListArgs {
  repoId: string;
}

/** 建立 tag 关系的参数（`relationKind` ∈ `parent` / `related`）。 */
export interface TagRelationAddArgs {
  repoId: string;
  fromTagId: string;
  toTagId: string;
  relationKind: string;
}

/** 按关系 ID 删除。 */
export interface TagRelationRemoveArgs {
  relationId: string;
}

/** 按 tag 取直接上级 / 下级。 */
export interface TagRelationNeighborsArgs {
  tagId: string;
}

/** 摘挂 tag（脱离层级，`tag.detach`）。 */
export interface TagDetachArgs {
  tagId: string;
}
