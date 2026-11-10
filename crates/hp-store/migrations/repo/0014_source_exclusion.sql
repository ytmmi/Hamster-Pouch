-- 仓库库迁移 0014：媒体源子目录排除（D149）。
-- forward-only：本文件发布后禁止修改。
--
-- 背景：「源」面板的目录树上，用户希望把某个子文件夹**暂时**排除出仓库视野
-- （例如素材堆里的一批临时文件、尚未整理完的子目录），但**不删任何数据**：
-- 文件索引、标签、评分、色彩参考、相册成员一律原样保留，取消排除后即刻完整还原。
-- 语义上类比「卸载媒体源」，但卸载作用于整个源且需要重新挂载才能回来，
-- 而本表的排除粒度是**源内相对目录**，且可随时取消。
--
-- 设计要点：
-- 1. 语义是**路径前缀**：记录 `a/b` 即排除 `a/b` 整棵子树（含全部后代）。
--    只存"被排除的那个目录"一行，不为每个后代各存一行——后代是扫描出来的，
--    随时会变，存快照必然与磁盘分叉。
-- 2. `relative_path` 归一化为 `/` 分隔、无首尾斜杠、非空（这些由写入端保证，
--    见 `repo/source_exclusion_repo.rs` 的 `normalize_relative_path`）。
-- 3. 主键 `(source_id, relative_path)` 天然去重：重复排除同一目录是幂等操作。
-- 4. 外键 `ON DELETE CASCADE`：源被**彻底**清除（purge）时，它的排除记录一并消失，
--    不留孤儿行；而普通卸载（`mounted = 0`）不动本表，重新挂载后排除依然有效。
-- 5. 本表**不影响扫描**：软排除只隐藏视图，扫描仍然索引被排除目录下的文件。
--    否则增量扫描会把它们的索引行判为 missing 并清掉——那就成了"删除数据"，
--    与"可恢复"的语义直接冲突。

CREATE TABLE IF NOT EXISTS source_exclusion (
    source_id     TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    excluded_at   TEXT NOT NULL,
    PRIMARY KEY (source_id, relative_path),
    FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

-- 不额外建索引：视图过滤只有"按源取排除前缀"与"按仓库 JOIN sources 取排除前缀"
-- 两种查法，前者由主键 `(source_id, relative_path)` 的前缀列直接覆盖，
-- 后者走 sources 的仓库索引后再按 source_id 回表，行数本来就少。
