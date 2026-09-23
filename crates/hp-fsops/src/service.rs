//! 源间复制/剪切/移动服务门面（commands-events.md §3.6 / RFC 0001）。
//!
//! 所有真实文件操作都必须生成操作记录（`ops_history`），并返回记录 ID。

use hp_core::{FileId, HpError, HpResult};
use hp_store::RepoDb;
use serde_json::json;

use crate::copy;
use crate::move_ops;

/// 一次源间操作的成果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferOutcome {
    /// 操作历史记录 ID（必须返回，供前端追溯/撤销）。
    pub op_record_id: String,
    /// 受影响文件：复制为新建 ID，移动为原 ID。
    pub affected: Vec<FileId>,
}

/// 源间真实文件操作服务。
#[derive(Debug, Default, Clone, Copy)]
pub struct FsOpsService;

impl FsOpsService {
    /// 源间复制：真实复制文件，新建索引行并继承 tag / 评分 / 相册成员（RFC 0001）。
    pub fn copy_files(
        &self,
        db: &mut RepoDb,
        repo_id: &str,
        file_ids: &[String],
        target_source_id: &str,
        target_dir: Option<&str>,
    ) -> HpResult<TransferOutcome> {
        let target_source = self.target_source(db, target_source_id)?;
        let mut affected = Vec::new();
        let mut payload = Vec::new();

        for file_id in file_ids {
            let file = self.file(db, file_id)?;
            let source = self.source_of(db, &file)?;
            let (new_id, rel) = copy::copy_one(db, &source, &file, &target_source, target_dir)?;
            payload.push(json!({
                "op": "copy",
                "fileId": file_id,
                "newFileId": new_id.as_str(),
                "targetSourceId": target_source_id,
                "targetRelativePath": rel,
            }));
            affected.push(new_id);
        }

        let op_record_id = db.insert_ops_history(
            repo_id,
            "copy",
            &serde_json::to_string(&payload).unwrap_or_else(|_| "[]".into()),
            None,
        )?;
        Ok(TransferOutcome {
            op_record_id,
            affected,
        })
    }

    /// 源间剪切/移动：真实移动文件，更新索引路径并保留原 ID（解释数据不丢失）。
    pub fn move_files(
        &self,
        db: &mut RepoDb,
        repo_id: &str,
        file_ids: &[String],
        target_source_id: &str,
        target_dir: Option<&str>,
    ) -> HpResult<TransferOutcome> {
        let target_source = self.target_source(db, target_source_id)?;
        let mut affected = Vec::new();
        let mut payload = Vec::new();

        for file_id in file_ids {
            let file = self.file(db, file_id)?;
            let source = self.source_of(db, &file)?;
            let (moved_id, rel) =
                move_ops::move_one(db, &source, &file, &target_source, target_dir)?;
            payload.push(json!({
                "op": "move",
                "fileId": file_id,
                "targetSourceId": target_source_id,
                "targetRelativePath": rel,
            }));
            affected.push(moved_id);
        }

        let op_record_id = db.insert_ops_history(
            repo_id,
            "move",
            &serde_json::to_string(&payload).unwrap_or_else(|_| "[]".into()),
            None,
        )?;
        Ok(TransferOutcome {
            op_record_id,
            affected,
        })
    }

    fn target_source(&self, db: &RepoDb, source_id: &str) -> HpResult<hp_core::Source> {
        db.get_source(source_id)?
            .ok_or_else(|| HpError::NotFound(format!("目标媒体源不存在: {source_id}")))
    }

    fn file(&self, db: &RepoDb, file_id: &str) -> HpResult<hp_core::FileIndexRow> {
        db.get_file(file_id)?
            .ok_or_else(|| HpError::NotFound(format!("文件不存在: {file_id}")))
    }

    fn source_of(&self, db: &RepoDb, file: &hp_core::FileIndexRow) -> HpResult<hp_core::Source> {
        db.get_source(file.source_id.as_str())?.ok_or_else(|| {
            HpError::NotFound(format!("媒体源不存在: {}", file.source_id.as_str()))
        })
    }
}
