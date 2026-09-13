//! tag 关系仓储（D22：层级 + 关联，关系图谱数据源）。
//!
//! tag 之间为多对多关系，支持多父级（DAG）；层级与关联用 `relation_kind` 区分。

use hp_core::{HpError, HpResult, RepoId, Tag, TagId, TagRelation, TagRelationKind};
use rusqlite::{params, OptionalExtension, Row};

use crate::repo::repo_db::RepoDb;
use crate::util::{now_iso, require_nonempty, store_err, uuid};

impl RepoDb {
    /// 建立一条 tag 关系（幂等：同 `(repo, from, to, kind)` 已存在则返回已有关系）。
    pub fn add_tag_relation(
        &mut self,
        repo_id: &str,
        from_tag_id: &str,
        to_tag_id: &str,
        kind: TagRelationKind,
    ) -> HpResult<TagRelation> {
        require_nonempty(repo_id, "仓库 ID")?;
        require_nonempty(from_tag_id, "起点 tag ID")?;
        require_nonempty(to_tag_id, "终点 tag ID")?;
        if from_tag_id == to_tag_id {
            return Err(HpError::InvalidArgument("tag 不能与自身建立关系".into()));
        }
        // tag 按仓库独立：关系两端必须属于同一仓库。
        let from = self
            .get_tag(from_tag_id)?
            .ok_or_else(|| HpError::NotFound(format!("tag 不存在: {from_tag_id}")))?;
        let to = self
            .get_tag(to_tag_id)?
            .ok_or_else(|| HpError::NotFound(format!("tag 不存在: {to_tag_id}")))?;
        if from.repo_id.as_str() != repo_id || to.repo_id.as_str() != repo_id {
            return Err(HpError::InvalidArgument(
                "tag 关系两端必须属于同一仓库（tag 按仓库独立）".into(),
            ));
        }
        // 环检测：child（to）不能已是 parent（from）的祖先，否则形成环。
        if kind == TagRelationKind::Hierarchy && self.is_tag_ancestor(to_tag_id, from_tag_id)? {
            return Err(HpError::InvalidArgument(
                "不能建立该层级：会形成环".into(),
            ));
        }
        if let Some(existing) =
            self.find_tag_relation(repo_id, from_tag_id, to_tag_id, kind)?
        {
            return Ok(existing);
        }
        let relation = TagRelation {
            id: uuid(),
            repo_id: RepoId::from_raw(repo_id),
            from_tag_id: TagId::from_raw(from_tag_id),
            to_tag_id: TagId::from_raw(to_tag_id),
            relation_kind: kind,
            created_at: now_iso(),
        };
        self.conn()
            .execute(
                "INSERT INTO tag_relations (id, repo_id, from_tag_id, to_tag_id, relation_kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    relation.id,
                    relation.repo_id.as_str(),
                    relation.from_tag_id.as_str(),
                    relation.to_tag_id.as_str(),
                    relation.relation_kind.as_str(),
                    relation.created_at,
                ],
            )
            .map_err(|e| store_err("建立 tag 关系", e))?;
        Ok(relation)
    }

    /// 查询指定 `(repo, from, to, kind)` 关系；不存在返回 `None`。
    pub fn find_tag_relation(
        &self,
        repo_id: &str,
        from_tag_id: &str,
        to_tag_id: &str,
        kind: TagRelationKind,
    ) -> HpResult<Option<TagRelation>> {
        self.conn()
            .query_row(
                "SELECT id, repo_id, from_tag_id, to_tag_id, relation_kind, created_at
                 FROM tag_relations
                 WHERE repo_id = ?1 AND from_tag_id = ?2 AND to_tag_id = ?3 AND relation_kind = ?4",
                params![repo_id, from_tag_id, to_tag_id, kind.as_str()],
                row_to_relation,
            )
            .optional()
            .map_err(|e| store_err("查询 tag 关系", e))
    }

    /// 按 ID 删除一条 tag 关系。
    pub fn remove_tag_relation(&mut self, id: &str) -> HpResult<()> {
        require_nonempty(id, "关系 ID")?;
        let n = self
            .conn()
            .execute("DELETE FROM tag_relations WHERE id = ?1", params![id])
            .map_err(|e| store_err("删除 tag 关系", e))?;
        if n == 0 {
            return Err(HpError::NotFound(format!("tag 关系不存在: {id}")));
        }
        Ok(())
    }

    /// 列出仓库下全部 tag 关系（按创建时间升序）。
    pub fn list_tag_relations(&self, repo_id: &str) -> HpResult<Vec<TagRelation>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, from_tag_id, to_tag_id, relation_kind, created_at
                 FROM tag_relations WHERE repo_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| store_err("查询 tag 关系列表", e))?;
        let rows = stmt
            .query_map(params![repo_id], row_to_relation)
            .map_err(|e| store_err("读取 tag 关系列表", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 tag 关系列表", e))?;
        Ok(rows)
    }

    /// 列出与某 tag 相关的全部关系（含出边与入边）。
    pub fn list_tag_relations_for_tag(&self, tag_id: &str) -> HpResult<Vec<TagRelation>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, repo_id, from_tag_id, to_tag_id, relation_kind, created_at
                 FROM tag_relations WHERE from_tag_id = ?1 OR to_tag_id = ?1
                 ORDER BY created_at",
            )
            .map_err(|e| store_err("查询 tag 相关关系", e))?;
        let rows = stmt
            .query_map(params![tag_id], row_to_relation)
            .map_err(|e| store_err("读取 tag 相关关系", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析 tag 相关关系", e))?;
        Ok(rows)
    }

    /// 列出某 tag 的直接上级（层级关系中指向它的 tag）。
    pub fn list_parent_tags(&self, tag_id: &str) -> HpResult<Vec<Tag>> {
        self.query_related_tags(
            "SELECT t.id, t.repo_id, t.name, t.color
             FROM tags t JOIN tag_relations r ON r.from_tag_id = t.id
             WHERE r.to_tag_id = ?1 AND r.relation_kind = 'hierarchy' ORDER BY t.name",
            tag_id,
        )
    }

    /// 列出某 tag 的直接下级（层级关系中它指向的 tag）。
    pub fn list_child_tags(&self, tag_id: &str) -> HpResult<Vec<Tag>> {
        self.query_related_tags(
            "SELECT t.id, t.repo_id, t.name, t.color
             FROM tags t JOIN tag_relations r ON r.to_tag_id = t.id
             WHERE r.from_tag_id = ?1 AND r.relation_kind = 'hierarchy' ORDER BY t.name",
            tag_id,
        )
    }

    fn query_related_tags(&self, sql: &str, tag_id: &str) -> HpResult<Vec<Tag>> {
        let mut stmt = self
            .conn()
            .prepare(sql)
            .map_err(|e| store_err("查询关联 tag", e))?;
        let rows = stmt
            .query_map(params![tag_id], |row| {
                Ok(Tag {
                    id: TagId::from_raw(row.get::<_, String>(0)?),
                    repo_id: RepoId::from_raw(row.get::<_, String>(1)?),
                    name: row.get(2)?,
                    color: row.get(3)?,
                })
            })
            .map_err(|e| store_err("读取关联 tag", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| store_err("解析关联 tag", e))?;
        Ok(rows)
    }

    /// `candidate` 是否在 `node` 的祖先链上（含 `node` 自身；沿层级向上遍历）。
    pub fn is_tag_ancestor(&self, candidate: &str, node: &str) -> HpResult<bool> {
        let mut stack: Vec<String> = vec![node.to_string()];
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur.clone()) {
                continue;
            }
            if cur == candidate {
                return Ok(true);
            }
            for parent in self.list_parent_tags(&cur)? {
                stack.push(parent.id.as_str().to_string());
            }
        }
        Ok(false)
    }

    /// 解除某 tag 的全部层级上级（拖到根区域时调用，使其成为根）。
    pub fn detach_tag(&mut self, tag_id: &str) -> HpResult<()> {
        require_nonempty(tag_id, "tag ID")?;
        self.conn()
            .execute(
                "DELETE FROM tag_relations WHERE to_tag_id = ?1 AND relation_kind = 'hierarchy'",
                params![tag_id],
            )
            .map_err(|e| store_err("解除 tag 层级", e))?;
        Ok(())
    }

    /// 移动 tag：替换其层级上级（拖拽 = 移动）。
    ///
    /// `new_parent_id` 为 `None` 时解除全部上级（成为根）；为 `Some` 时先解除现有上级，
    /// 再挂到新上级下。会校验跨仓库与成环。
    pub fn move_tag(&mut self, tag_id: &str, new_parent_id: Option<&str>) -> HpResult<()> {
        require_nonempty(tag_id, "tag ID")?;
        let tag = self
            .get_tag(tag_id)?
            .ok_or_else(|| HpError::NotFound(format!("tag 不存在: {tag_id}")))?;
        let repo_id = tag.repo_id.as_str().to_string();

        // 先解除现有层级上级（移动语义：替换而非追加）。
        self.detach_tag(tag_id)?;

        if let Some(parent_id) = new_parent_id {
            if parent_id == tag_id {
                return Err(HpError::InvalidArgument("不能移动到自身".into()));
            }
            let parent = self
                .get_tag(parent_id)?
                .ok_or_else(|| HpError::NotFound(format!("tag 不存在: {parent_id}")))?;
            if parent.repo_id.as_str() != repo_id {
                return Err(HpError::InvalidArgument(
                    "不能跨仓库移动（tag 按仓库独立）".into(),
                ));
            }
            // 环检测：目标父级不能是本 tag 的后代。
            if self.is_tag_ancestor(tag_id, parent_id)? {
                return Err(HpError::InvalidArgument("不能移动到自己的下级".into()));
            }
            self.add_tag_relation(&repo_id, parent_id, tag_id, TagRelationKind::Hierarchy)?;
        }
        Ok(())
    }
}

fn row_to_relation(row: &Row) -> rusqlite::Result<TagRelation> {
    let kind: String = row.get(4)?;
    Ok(TagRelation {
        id: row.get(0)?,
        repo_id: RepoId::from_raw(row.get::<_, String>(1)?),
        from_tag_id: TagId::from_raw(row.get::<_, String>(2)?),
        to_tag_id: TagId::from_raw(row.get::<_, String>(3)?),
        relation_kind: TagRelationKind::from_str(&kind).unwrap_or(TagRelationKind::Related),
        created_at: row.get(5)?,
    })
}
