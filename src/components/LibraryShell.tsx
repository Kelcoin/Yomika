import { useParams } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { panelLayout } from '../lib/panelLayout';
import { ArchiveDetailRoute } from './ArchiveDetailRoute';
import { LibraryRouteWorkspace } from './LibraryRouteWorkspace';

/** 没存过布局时档案库两栏的比例，与首页、书架、本地档案同一份（58/42）。 */
const LIBRARY_SPLIT_LAYOUT: Layout = { 'library-shell-list': 58, 'library-shell-detail': 42 };

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
    <Group className={`library-shell${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={panelLayout(layout.defaultLayout, LIBRARY_SPLIT_LAYOUT)} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-list" minSize="40"><section className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section></Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-detail" minSize="30"><section className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} /></section></Panel>}
    </Group>
  );
}
