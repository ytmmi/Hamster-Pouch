-- 全局配置库迁移 0003：布局 ↔ 蓝图绑定（RFC 0007 / 用户需求）
-- 一个布局可以绑定多个蓝图（blueprint_ids_json 存蓝图 ID 数组）；
-- 布局内调整组后，保存布局时前端把 dockview 组结构自动同步进绑定/默认蓝图。
-- forward-only：本文件发布后禁止修改。

ALTER TABLE panel_layouts ADD COLUMN blueprint_ids_json TEXT NOT NULL DEFAULT '[]';
