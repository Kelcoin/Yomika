import { ArchiveListSkeleton } from './ArchiveListSkeleton';
import { ContentSkeleton } from './ContentSkeleton';
import { MetadataEditorSkeleton } from './MetadataEditorSkeleton';

/** Code loading uses the same placeholders as data loading, with no spinner frame between. */
export function WorkspaceLoadingSkeleton({ path, onBack }: { path: string; onBack?: (() => void) | undefined }) {
  if (path.endsWith('/edit')) return <MetadataEditorSkeleton onBack={onBack} />;
  if (path === '/tools/upload') return <div className="workspace-stack" aria-busy="true">
    <header className="workspace-heading"><h1>上传档案</h1></header>
    <div className="upload-panel" aria-hidden="true">
      <div className="segmented-control upload-mode-tabs"><span className="skeleton-line" /></div>
      <div className="upload-source-stage"><div className="upload-dropzone"><span className="skeleton-block content-skeleton-icon" /><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-block content-skeleton-control" /></div></div>
      <div className="upload-queue"><ContentSkeleton label="正在读取上传队列" rows={1} /></div>
    </div>
  </div>;
  if (path === '/tools/dedup' || path === '/dedup') return <div className="workspace-stack dedup-workspace" aria-busy="true">
    <section className="dedup-section"><ContentSkeleton label="正在读取检测范围" rows={2} /></section>
    <section className="dedup-section"><ContentSkeleton label="正在读取扫描状态" rows={2} /></section>
    <ContentSkeleton label="正在读取查重结果" rows={3} />
  </div>;
  if (path === '/downloads') return <div className="library-shell"><section className="library-shell-list"><div className="local-archives">
    <div className="library-controls local-archives-controls" aria-hidden="true"><span className="skeleton-block route-search-skeleton" /></div>
    <div className="library-toolbar" aria-hidden="true"><span className="skeleton-line select-placeholder" /><span className="skeleton-line select-placeholder" /></div>
    <div className="archive-list is-wide local-archives-list"><div className="archive-list-skeleton-layer"><ArchiveListSkeleton mode="wide" label="正在读取本地档案" /></div></div>
  </div></section></div>;
  return <ContentSkeleton label="正在加载页面" rows={6} />;
}
