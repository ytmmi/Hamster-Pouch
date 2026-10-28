-- 仓库库迁移 0012：同步相册的源镜像树 + 成员排除留痕（D128）。
-- forward-only：本文件发布后禁止修改。
--
-- 背景：用户口径把「跟随源」相册细分成两种创建方式——
--   * 「创建为相册（仅当前对象）」= 一次性快照，落成固定型相册，之后不再跟随源；
--   * 「创建为同步相册」= 持续同步，并按源目录层级自动镜像子相册。
-- 为了"更新位置与源保持一致"以及"源侧子相册被删了下次同步要重建"，
-- 每个镜像子相册必须记住自己是哪个同步根的哪个源目录：
--   * `sync_root_album_id`：所属同步根相册 ID；同步根自己指向自己，普通相册为 NULL；
--   * `sync_dir_path`：对应媒体源内的相对目录（已归一化为 `/`、无首尾斜杠，`''` 表示源根）。
-- 两者同时为 NULL 表示"不是源镜像相册"，走原有跟随源逻辑（向后兼容）。
--
-- 同步成员策略是「只增不删、尊重手动编辑」：用户手动移除的成员必须留痕，
-- 否则下一次同步会把源里仍在的文件原样加回来。`album_sync_exclusion` 记录这类显式排除，
-- 用户手动把文件加回相册时清除对应记录。

ALTER TABLE albums ADD COLUMN sync_root_album_id TEXT;
ALTER TABLE albums ADD COLUMN sync_dir_path TEXT;

-- 同一同步根下，一个源目录只允许有一个镜像相册（重建时据此判定"已存在"）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_sync_dir
    ON albums(sync_root_album_id, sync_dir_path)
    WHERE sync_root_album_id IS NOT NULL AND sync_dir_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS album_sync_exclusion (
    album_id    TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    excluded_at TEXT NOT NULL,
    PRIMARY KEY (album_id, file_id),
    FOREIGN KEY (album_id) REFERENCES albums(id),
    FOREIGN KEY (file_id)  REFERENCES files(id)
);
