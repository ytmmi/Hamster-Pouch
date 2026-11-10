-- 全局配置库迁移 0005：布局预设与仓库绑定（RFC 0011）
--
-- 模型：应用级预设 `layout_presets`（无仓库维度，一份布局 = 一行）
--     + 仓库覆盖 `layout_bindings`（`repo_id` → 预设；无行 = 走应用级默认）。
-- `layers_json` 的键是蓝图层 key，`""` 保留为层无关快照。
--
-- 本迁移做三件事：
-- 1. 建两张新表（替换旧的 `panel_layouts` 读取路径；旧表保留为历史，不再写入）；
-- 2. 按 RFC 0011 决策 10 把 `panel_layouts` 折算成应用级预设：
--    - 按 `workspace`（预设名）分组，每层取 `updated_at` 最新的一格
--      （跨仓库同名同层冲突时同样取最新，等价于「记一行后保留新者」；
--       迁移执行器没有日志通道，冲突处置结果可由本迁移的确定性排序复现）；
--    - `updated_at` 取该组最大值，`blueprint_ids_json` 取 `''` 行；
--    - **用户 2026-11-10 裁决**：组内存在 `l_main` 时把 `""` 对齐到 `l_main`
--      （RFC 决策 10 第 6 条原文是保留旧快照；裁决见 RFC 0011 修订注记）；
--    - 原 `layout.default.{repoId}` 折算成绑定行；应用级默认取最后写入
--      （`app_settings.rowid DESC`）的那一条，值写预设 id；
-- 3. 删除死键 `layout.names` / `layout.<名>`，保留 `layout.syncBlueprint`
--    与新的 `layout.default`。
--
-- forward-only：本文件发布后禁止修改。

CREATE TABLE IF NOT EXISTS layout_presets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  layers_json        TEXT NOT NULL,
  blueprint_ids_json TEXT NOT NULL DEFAULT '[]',
  origin             TEXT NOT NULL DEFAULT 'user',
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_bindings (
  repo_id    TEXT PRIMARY KEY,
  preset_id  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layout_bindings_preset ON layout_bindings(preset_id);

-- 1) `panel_layouts` → `layout_presets`（每层取最新一格，组内合并成一份布局）。
WITH ranked AS (
  SELECT workspace, layer_key, layout_json, blueprint_ids_json, updated_at,
         ROW_NUMBER() OVER (
           PARTITION BY workspace, layer_key
           ORDER BY updated_at DESC, rowid DESC
         ) AS rn
  FROM panel_layouts
),
picked AS (SELECT * FROM ranked WHERE rn = 1),
grouped AS (
  SELECT workspace,
         json_group_object(
           layer_key,
           json(CASE WHEN json_valid(layout_json) THEN layout_json ELSE '{}' END)
         ) AS layers_json,
         MAX(updated_at) AS updated_at
  FROM picked
  GROUP BY workspace
)
INSERT INTO layout_presets (id, name, layers_json, blueprint_ids_json, origin, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
    || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', abs(random()) % 4 + 1, 1)
    || substr(lower(hex(randomblob(2))), 2) || '-'
    || lower(hex(randomblob(6))),
  g.workspace,
  CASE
    WHEN json_extract(g.layers_json, '$."l_main"') IS NOT NULL
      THEN json_set(g.layers_json, '$.""', json_extract(g.layers_json, '$."l_main"'))
    ELSE g.layers_json
  END,
  COALESCE(b.blueprint_ids_json, '[]'),
  'user',
  g.updated_at
FROM grouped g
LEFT JOIN picked b ON b.workspace = g.workspace AND b.layer_key = '';

-- 2) 旧默认标记 → 仓库绑定（值从预设名换算成预设 id）。
INSERT OR REPLACE INTO layout_bindings (repo_id, preset_id, updated_at)
SELECT substr(s.key, length('layout.default.') + 1),
       p.id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM app_settings s
JOIN layout_presets p ON p.name = s.value
WHERE s.key LIKE 'layout.default.%';

-- 3) 应用级默认 = 最后写入的那条旧默认标记（跨仓库也不打架）。
INSERT OR REPLACE INTO app_settings (key, value)
SELECT 'layout.default',
       (SELECT p.id
          FROM app_settings s
          JOIN layout_presets p ON p.name = s.value
         WHERE s.key LIKE 'layout.default.%'
         ORDER BY s.rowid DESC
         LIMIT 1)
WHERE EXISTS (
  SELECT 1
    FROM app_settings s
    JOIN layout_presets p ON p.name = s.value
   WHERE s.key LIKE 'layout.default.%'
);

-- 4) 删旧键：带仓库后缀的默认标记、老通道残渣（`layout.names` 与 `layout.<名>`）。
DELETE FROM app_settings WHERE key LIKE 'layout.default.%';
DELETE FROM app_settings
 WHERE key = 'layout.names'
    OR (key LIKE 'layout.%'
        AND key <> 'layout.default'
        AND key <> 'layout.syncBlueprint');
