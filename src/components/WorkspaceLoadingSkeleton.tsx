import { ArchiveListSkeleton } from './ArchiveListSkeleton';
import { ContentSkeleton } from './ContentSkeleton';
import { MetadataEditorSkeleton } from './MetadataEditorSkeleton';

/** Code loading uses the same placeholders as data loading, with no spinner frame between. */
export function WorkspaceLoadingSkeleton({ path }: { path: string }) {
  if (path.endsWith('/edit')) return <MetadataEditorSkeleton />;
  if (path === '/downloads') return <div className="library-shell"><section className="library-shell-list"><div className="local-archives">
    <div className="library-controls local-archives-controls" aria-hidden="true"><span className="skeleton-block route-search-skeleton" /></div>
    <div className="library-toolbar" aria-hidden="true"><span className="skeleton-line select-placeholder" /><span className="skeleton-line select-placeholder" /></div>
    <div className="archive-list is-wide local-archives-list"><div className="archive-list-skeleton-layer"><ArchiveListSkeleton mode="wide" label="正在读取本地档案" /></div></div>
  </div></section></div>;
  return <ContentSkeleton label="正在加载页面" rows={6} />;
}
