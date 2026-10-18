import { ArrowLeft } from 'lucide-react';

export function MetadataEditorSkeleton({ onBack }: { onBack?: (() => void) | undefined }) {
  return <main className="metadata-edit-page" aria-label="编辑元数据">
    <header className="metadata-edit-header">
      <button className="reader-icon-button" type="button" disabled={!onBack} onClick={onBack} aria-label="返回上一页"><ArrowLeft aria-hidden="true" /></button>
      <div className="metadata-edit-heading"><h1>编辑元数据</h1></div>
    </header>
    <div className="metadata-edit-form metadata-edit-skeleton" role="status" aria-label="正在载入元数据">
      <div aria-hidden="true"><span>标题</span><span className="skeleton-block metadata-skeleton-input" /></div>
      <div aria-hidden="true"><span>标签</span><span className="skeleton-block metadata-skeleton-tags" /><span className="skeleton-block metadata-skeleton-input" /></div>
      <div aria-hidden="true"><span>简介</span><span className="skeleton-block metadata-skeleton-summary" /></div>
      <div className="metadata-edit-actions" aria-hidden="true"><span className="skeleton-block metadata-skeleton-input" /></div>
    </div>
  </main>;
}
