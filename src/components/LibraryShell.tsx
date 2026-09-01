import { useParams } from 'react-router-dom';

import { ArchiveDetailRoute } from './ArchiveDetailRoute';
import { LibraryRouteWorkspace } from './LibraryRouteWorkspace';

export function LibraryShell() {
  const { archiveId } = useParams();
  return (
    <div className={`library-shell ${archiveId ? 'has-detail' : ''}`}>
      <section className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section>
      {archiveId && <section className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} /></section>}
    </div>
  );
}
