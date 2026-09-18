-- 全局配置库迁移 0004：面板布局按层各存一份（RFC 0007 / D53）
-- `panel_layouts` 由 (repo_id, workspace) 扩展为 (repo_id, workspace, layer_key)：
-- 一个命名布局在每个层各有一行（层与布局 1:1），`layout.save` 写当前层那一份、
-- `layout.apply` 套用当前层的布局。
-- `layer_key = ''` 表示**迁移前的层无关行**：读取指定层时若该层没有专属行，
-- 回退到 '' 行（老预设继续可用，重新保存后写入显式 layer_key）。
-- forward-only：本文件发布后禁止修改。

ALTER TABLE panel_layouts ADD COLUMN layer_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_panel_layouts_layer
  ON panel_layouts(repo_id, workspace, layer_key);
