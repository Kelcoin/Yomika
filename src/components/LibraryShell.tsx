import { useParams } from 'react-router-dom';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ArchiveDetailRoute } from './ArchiveDetailRoute';
import { LibraryRouteWorkspace } from './LibraryRouteWorkspace';

export function LibraryShell({ archiveId: archiveIdProp }: { archiveId?: string | undefined } = {}) {
  const { archiveId: routeArchiveId } = useParams();
  const archiveId = archiveIdProp ?? routeArchiveId;
  const layout = useDefaultLayout({
    id: 'library-shell-split',
    panelIds: ['library-shell-list', 'library-shell-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group className={`library-shell${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-list" defaultSize="58" minSize="40"><section className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section></Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-detail" defaultSize="42" minSize="30"><section className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} /></section></Panel>}
    </Group>
  );
}
