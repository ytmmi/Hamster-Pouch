/**
 * 蓝图运行时链路自检（开发期验证，不参与打包）。
 *
 * 验证对象是真实实现 `apps/desktop/src/app_ui/shared/blueprintRuntime.ts` 的装载链路
 * （Node 原生类型擦除直接 import TS 源码），用 `node:sqlite` 对一个**临时仓库库副本**
 * 提供蓝图命令替身，覆盖三条链路：
 * 1. 旧库存内置默认（default_version 落后）→ 升级为新版内置默认**并落库**；
 * 2. 用户编辑过的默认蓝图（无 default_version）→ 原样装载，不被自动升级覆盖；
 * 3. 无默认蓝图 → 补种内置默认并设为默认。
 *
 * 用法：node --import ./tools/blueprint-check-register.mjs tools/blueprint-runtime-check.mjs [仓库库路径]
 * （`blueprint-check-register.mjs` 注册解析钩子，补齐目录导入与宿主依赖 stub。）
 */

import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const ROOT = "E:/Hamster Pouch";
const REPO = "repo-check";
const defaultDb =
  "C:/Users/wxlxt/AppData/Roaming/dev.hamsterpouch.desktop/repos/00c37ce8-8464-4808-8c51-c9af38e86516.sqlite3";
const sourceDb = process.argv[2] ?? defaultDb;

const { loadActiveBlueprint } = await import(
  pathToFileURL(`${ROOT}/apps/desktop/src/app_ui/shared/blueprintRuntime.ts`).href
);
const config = await import(
  pathToFileURL(`${ROOT}/packages/config/src/blueprint.ts`).href
);

/** 用临时库副本造一个蓝图命令替身。 */
function makeClient(dbPath) {
  const db = new DatabaseSync(dbPath);
  const read = (id) =>
    db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) ?? null;
  return {
    db,
    client: {
      async blueprintGet({ blueprintId }) {
        const row = read(blueprintId);
        return row ? row.blueprint_json : null;
      },
      async blueprintGetDefault() {
        const row = db
          .prepare("SELECT * FROM blueprints WHERE repo_id = ? AND is_default = 1 LIMIT 1")
          .get(REPO);
        return row ? row.blueprint_json : null;
      },
      async blueprintList() {
        return db
          .prepare("SELECT id, name, is_default FROM blueprints WHERE repo_id = ?")
          .all(REPO)
          .map((r) => ({ id: r.id, name: r.name, is_default: r.is_default === 1 }));
      },
      async blueprintCreate({ name, blueprintJson }) {
        const id = `bp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO blueprints
             (id, repo_id, name, is_default, schema_version, blueprint_json, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
        ).run(id, REPO, name, blueprintJson, now, now);
        return { id, name, is_default: false };
      },
      async blueprintSave({ blueprintId, name, blueprintJson }) {
        db.prepare(
          "UPDATE blueprints SET name = ?, blueprint_json = ?, updated_at = ? WHERE id = ?",
        ).run(name, blueprintJson, new Date().toISOString(), blueprintId);
      },
      async blueprintSetDefault({ blueprintId }) {
        db.prepare("UPDATE blueprints SET is_default = 0 WHERE repo_id = ?").run(REPO);
        db.prepare("UPDATE blueprints SET is_default = 1 WHERE id = ?").run(blueprintId);
      },
    },
  };
}

/** 复制一份只含指定默认蓝图文档的库。 */
function seedDb(defaultJson) {
  const dir = mkdtempSync(join(tmpdir(), "hp-bp-check-"));
  const path = join(dir, "repo.sqlite3");
  copyFileSync(sourceDb, path);
  const db = new DatabaseSync(path);
  db.prepare("DELETE FROM blueprints").run();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO blueprints
       (id, repo_id, name, is_default, schema_version, blueprint_json, created_at, updated_at)
     VALUES ('bp-default', ?, '默认蓝图', 1, 1, ?, ?, ?)`,
  ).run(REPO, defaultJson, now, now);
  db.close();
  return path;
}

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. 旧库存内置默认（v3）→ 升级并落库 ----
{
  const legacy = { ...config.DEFAULT_BLUEPRINT, default_version: 3 };
  const path = seedDb(JSON.stringify(legacy));
  const { db, client } = makeClient(path);
  const loaded = await loadActiveBlueprint(REPO, null, client);
  const stored = JSON.parse(
    db.prepare("SELECT blueprint_json FROM blueprints WHERE id = 'bp-default'").get()
      .blueprint_json,
  );
  check(
    "旧默认(v3) 升级为内置默认(v4) 并落库",
    stored.default_version === config.DEFAULT_BLUEPRINT_VERSION &&
      loaded.graph.nodes.length === config.DEFAULT_BLUEPRINT.nodes.length,
    `落库 default_version=${stored.default_version}, 装载节点数=${loaded.graph.nodes.length}`,
  );
  db.close();
}

// ---- 2. 用户编辑过的默认蓝图（无 default_version）→ 原样装载 ----
{
  const userDoc = {
    schema_version: 1,
    nodes: [
      { key: "c_media", type: "control", panel_id: "media", position: { x: 0, y: 0 } },
      {
        key: "e_x",
        type: "event",
        trigger: "double_click",
        position: { x: 300, y: 0 },
      },
      {
        key: "a_x",
        type: "action",
        op: "show",
        target: "c_media",
        position: { x: 600, y: 0 },
      },
    ],
    edges: [
      { from: "c_media", to: "e_x", kind: "on", order: 1 },
      { from: "e_x", to: "a_x", kind: "fires", order: 2 },
    ],
  };
  const path = seedDb(JSON.stringify(userDoc));
  const { db, client } = makeClient(path);
  const loaded = await loadActiveBlueprint(REPO, null, client);
  const stored = JSON.parse(
    db.prepare("SELECT blueprint_json FROM blueprints WHERE id = 'bp-default'").get()
      .blueprint_json,
  );
  check(
    "用户编辑过的默认蓝图不被自动升级覆盖",
    stored.nodes.length === 3 && loaded.graph.nodes.length === 3,
    `装载节点数=${loaded.graph.nodes.length}`,
  );
  db.close();
}

// ---- 3. 无默认蓝图 → 补种内置默认 ----
{
  const path = seedDb(JSON.stringify(config.makeEmptyBlueprint()));
  const { db, client } = makeClient(path);
  db.prepare("UPDATE blueprints SET is_default = 0").run();
  const loaded = await loadActiveBlueprint(REPO, null, client);
  const row = db
    .prepare("SELECT blueprint_json FROM blueprints WHERE is_default = 1")
    .get();
  const stored = row ? JSON.parse(row.blueprint_json) : null;
  check(
    "无默认蓝图 → 补种内置默认并设为默认",
    !!stored &&
      stored.default_version === config.DEFAULT_BLUEPRINT_VERSION &&
      loaded.graph.nodes.length === config.DEFAULT_BLUEPRINT.nodes.length,
    `补种节点数=${stored ? stored.nodes.length : "无"}`,
  );
  db.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
