import { useParams, useSearchParams } from 'react-router-dom';
import { useLayoutEffect, useRef } from 'react';
import { useDetailListScroll } from '../lib/useDetailListScroll';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import type { Layout } from 'react-resizable-panels';
import { useDefaultLayout } from 'react-resizable-panels';
import { Group, Panel, Separator } from './AdaptivePanels';

import { panelLayout } from '../lib/panelLayout';
import { ArchiveDetailRoute } from './ArchiveDetailRoute';
import { LibraryRouteWorkspace } from './LibraryRouteWorkspace';

/** 没存过布局时档案库两栏的比例，与首页、书架、本地档案同一份（58/42）。 */
const LIBRARY_SPLIT_LAYOUT: Layout = { 'library-shell-list': 58, 'library-shell-detail': 42 };

export function LibraryShell({ archiveId: archiveIdProp }: { archiveId?: string | undefined } = {}) {
  const { archiveId: routeArchiveId } = useParams();
  const archiveId = archiveIdProp ?? routeArchiveId;
  const [searchParams] = useSearchParams();
  const serverId = searchParams.get('server');
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  useDetailListScroll(Boolean(archiveId), listRef);

  useLayoutEffect(() => {
    if (!archiveId) return;
    const detail = detailRef.current;
    const scroller = compact ? detail?.closest<HTMLElement>('.workspace') : detail;
    if (!scroller || scroller.scrollTop === 0) return;
    const previous = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';
    scroller.scrollTop = 0;
    scroller.style.scrollBehavior = previous;
  }, [archiveId, serverId, compact]);

  const layout = useDefaultLayout({
    id: 'library-shell-split',
    panelIds: ['library-shell-list', 'library-shell-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group className={`library-shell${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={panelLayout(layout.defaultLayout, LIBRARY_SPLIT_LAYOUT)} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-list" minSize="40"><section ref={listRef} className="library-shell-list"><LibraryRouteWorkspace showDetail={false} /></section></Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-shell-detail" minSize="30"><section ref={detailRef} className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} /></section></Panel>}
    </Group>
  );
}
