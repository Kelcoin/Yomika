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
  if (!archiveId) {
    return <div className="library-shell"><section className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section></div>;
  }
  return (
    <Group className="library-shell has-detail" orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <Panel id="library-shell-list" defaultSize="58" minSize="40"><section className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section></Panel>
      <Separator className="panel-separator" />
      <Panel id="library-shell-detail" defaultSize="42" minSize="24"><section className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} /></section></Panel>
    </Group>
  );
}
