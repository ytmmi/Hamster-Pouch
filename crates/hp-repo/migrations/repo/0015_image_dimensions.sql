-- 仓库库迁移 0015：图片宽高进索引（缺陷 0043）。
-- forward-only：本文件发布后禁止修改。
--
-- 背景（0043 §1）：`files` 表从来没有宽高列，于是三处消费方各自为"索引里没有宽高"付费——
-- 媒体预览滚动条只能按 `DEFAULT_CELL_RATIO` 估计内容总高（随浏览收敛，0018 P1-A）、
-- 胶片栏按 1:1 占位再靠 Fenwick 修正（0018 P1-B ③）、`-lowres` 分流每张新大图
-- 多读一次文件头（0018 P1-E）。而扫描期**本来就把整张图解码过**，宽高就在手里。
--
-- 口径（2026-11-11 / 第 37 轮裁决 1）：只存**显示尺寸**——按 EXIF `Orientation`
-- 换算成"肉眼所见"的宽高（5/6/7/8 交换长短边），不另存存储尺寸。理由：消费方
-- （虚拟化布局、胶片栏、lowres 分流）要的是"这张图看起来多宽多高"；查看器与缩略图
-- 都已经按显示尺寸处理（`thumbnail.rs` 的 `apply_orientation`、`lowres.rs` 的
-- ffmpeg 自动旋转），再存一份存储尺寸只会制造第二个口径（0042 的教训：
-- 两处各存一份必然漂移）。
--
-- 可空（NULL）：既有行是历史数据，回填完成前为 NULL。消费方必须把 NULL 当作
-- "还没补"并降级到旧路径（估计值 / 读头），**不得**把 NULL 当成 0 或 1:1——那样
-- 会把"未知"渲染成错得确定的布局。回填是独立的后台任务（0043 §2 裁决 2），
-- 扫描与回填都只写这两列，互不覆盖：`upsert_file` 对这两列用
-- `COALESCE(excluded.width, files.width)`，读不到尺寸时不会把回填值抹掉。
--
-- orientation 列不在这里加：`media_info_json` 里已经有 EXIF 摘要（含 orientation），
-- 且显示尺寸已经把方向"吃进"宽高，消费方不需要单独判方向。

ALTER TABLE files ADD COLUMN width INTEGER;
ALTER TABLE files ADD COLUMN height INTEGER;

-- 回填任务按 `width IS NULL AND media_type = 'image'` 挑行：这是全表里唯一的
-- 稀疏条件，行数在回填期间单调递减。不加索引：frozen 的 `files` 行数级别是万，
-- 全表扫描一次的开销远低于多维护一个部分索引（SQLite 的部分索引还要额外迁移）。
