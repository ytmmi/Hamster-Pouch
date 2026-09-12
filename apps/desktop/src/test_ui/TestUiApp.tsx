/**
 * TestUiApp — 功能测试 UI 主组件。
 *
 * 共享状态：当前仓库 ID、选中文件、刷新计数器。
 * 布局：顶部标题栏 + 3 行 2 列面板网格 + 底部状态栏。
 */

import { useCallback, useState } from "react";

import type { FileItem, StatusType } from "./types";
import { RepoPanel } from "./panels/RepoPanel";
import { SourcePanel } from "./panels/SourcePanel";
import { SourceSelectPanel } from "./panels/SourceSelectPanel";
import { GridPanel } from "./panels/GridPanel";
import { ViewerPanel } from "./panels/ViewerPanel";
import { MetadataPanel } from "./panels/MetadataPanel";
import { AlbumPanel } from "./panels/AlbumPanel";
import { TagRatingPanel } from "./panels/TagRatingPanel";
import { ColorPanel } from "./panels/ColorPanel";
import "./styles.css";

interface StatusState {
  message: string;
  type: StatusType;
}

export function TestUiApp(): JSX.Element {
  // 共享状态
  const [repoId, setRepoId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<StatusState | null>(null);

  const handleRepoChange = useCallback((id: string | null) => {
    setRepoId(id);
    setSelectedFile(null);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleStatus = useCallback(
    (message: string, type: StatusType = "info") => {
      setStatus({ message, type });
    },
    [],
  );

  const handleSelectFile = useCallback((file: FileItem) => {
    setSelectedFile(file);
  }, []);

  return (
    <div className="test-app">
      <div className="test-header">
        <h1>仓鼠颊 — 功能测试 UI</h1>
        <span className="repo-info">
          仓库: {repoId ? repoId.slice(0, 12) + "..." : "未打开"} | 选中文件:{" "}
          {selectedFile ? selectedFile.id.slice(0, 8) : "无"}
        </span>
      </div>

      <div className="test-body">
        <RepoPanel
          repoId={repoId}
          onRepoChange={handleRepoChange}
          onRefresh={handleRefresh}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <SourcePanel
          repoId={repoId}
          onRefresh={handleRefresh}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <SourceSelectPanel
          repoId={repoId}
          selectedFileId={selectedFile?.id ?? null}
          onSelectFile={handleSelectFile}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <GridPanel
          repoId={repoId}
          selectedFileId={selectedFile?.id ?? null}
          onSelectFile={handleSelectFile}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <ViewerPanel
          selectedFile={selectedFile}
          repoId={repoId}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <MetadataPanel
          selectedFile={selectedFile}
          repoId={repoId}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <AlbumPanel
          repoId={repoId}
          selectedFile={selectedFile}
          onRefresh={handleRefresh}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <TagRatingPanel
          repoId={repoId}
          selectedFile={selectedFile}
          onRefresh={handleRefresh}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
        <ColorPanel
          repoId={repoId}
          selectedFile={selectedFile}
          onRefresh={handleRefresh}
          onStatus={handleStatus}
          refreshKey={refreshKey}
        />
      </div>

      <div className="status-bar">
        {status ? (
          <span className={`status-${status.type}`}>
            [{status.type === "error" ? "错误" : status.type === "ok" ? "成功" : "信息"}]{" "}
            {status.message}
          </span>
        ) : (
          <span className="status-info">就绪</span>
        )}
      </div>
    </div>
  );
}
