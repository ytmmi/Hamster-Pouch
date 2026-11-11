/**
 * Tauri 事件负载类型。
 *
 * **2026-11-11（第 37 轮裁决）**：事件载荷的权威定义搬进了 `crates/hp-dto/src/lib.rs`，
 * 这个文件改为再导出生成类型（`@hamster-pouch/shared-types`）——事件与命令返回值从此
 * 共用同一份单一事实来源，字段漂移由 `pnpm check:types` 守住（此前是后端私有结构体 +
 * 这里手写同名接口，靠人工对齐）。
 *
 * **D77（2026-09）**：全部事件 DTO 统一加 `#[serde(rename_all = "camelCase")]`，
 * 因此字段一律是**驼峰**（此前按 Rust 字段名逐字序列化成蛇形）。Rust 侧的文档注释随
 * 生成物一起过来，语义说明不会丢。
 *
 * 仍在这里手写的是**前端自己 emit** 的事件（不经 Rust DTO，故无生成类型）：
 * `repo.changed { repoId }`、`panel.restore { id }`。
 * （`media.surface.click` 曾在此列，2026-11-11 随 libmpv 休眠代码退役，D163。）
 *
 * **2026-11-11 追加 `file.backfill.*`**（0043 阶段 2）：图片尺寸回填的进度与收尾。
 *
 * **2026-11-11 追加 `file.created`**（第 37 轮裁决 4）：它带 `{ repoId, sourceId, relativePath }`，
 * 没有 `fileId`——文件还没进索引，索引行由随后的自动增量扫描建立。
 */

export type {
  AlbumSyncConflictPayload,
  AlbumSyncFailedPayload,
  AlbumSyncProgressPayload,
  BlueprintChangedPayload,
  ColorExtractedPayload,
  FileBackfillCompletedPayload,
  FileBackfillProgressPayload,
  FileChangedPayload,
  FileCreatedPayload,
  FileMissingPayload,
  FileRestoredPayload,
  PluginChangedPayload,
  PluginLoadedPayload,
  ScanCompletedPayload,
  ScanErrorPayload,
  ScanProgressPayload,
  SourceUnmountCompletedPayload,
  SourceUnmountErrorPayload,
  SourceUnmountProgressPayload,
} from "@hamster-pouch/shared-types";
