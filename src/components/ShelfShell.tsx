import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { panelLayout } from '../lib/panelLayout';
import { ArchiveDetailRoute } from './ArchiveDetailRoute';

/** 书架的列表 + 详情：与档案库同一种两栏。
 *
 * 书架上的卡片从前把详情开在 `/library/:id`，于是左边那一栏跟着变成档案库——
 * 从历史点进一个档案，返回时看到的是档案库，而不是刚才那份历史。每个书架现在有
 * 自己的详情路由（`/history/:id`、`/watchlist/:id`、`/to-read/:id`），左边始终是
 * 书架自己。
 *
 * 类名与档案库那套（`.library-shell*`）复用：窄屏的「详情占满、列表先收起来」就是
 * 同一份 CSS，页面在手机上仍然是钻进去再退回来。（列表由调用方作为 children
 * 传进来，这一层只管那一栏怎么摆。） */
export function ShelfShell({ name, detailBasePath, children }: { name: string; /** 详情栏里那些卡片（推荐条）要落在哪个路由下：书架自己的前缀，由路由表传进来。 */ detailBasePath: string; children: ReactNode }) {
  const { archiveId } = useParams();
  const layout = useDefaultLayout({
    id: `shelf-shell-split-${name}`,
    panelIds: [`shelf-shell-list-${name}`, `shelf-shell-detail-${name}`],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** 没存过布局时书架两栏的比例，与首页、档案库、本地档案同一份（58/42）。 */
  const splitLayout: Layout = { [`shelf-shell-list-${name}`]: 58, [`shelf-shell-detail-${name}`]: 42 };
  return (
    <Group className={`library-shell${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={panelLayout(layout.defaultLayout, splitLayout)} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id={`shelf-shell-list-${name}`} minSize="40"><section className="library-shell-list">{children}</section></Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id={`shelf-shell-detail-${name}`} minSize="30"><section className="library-shell-detail" data-scroll-region><ArchiveDetailRoute archiveId={archiveId} detailBasePath={detailBasePath} /></section></Panel>}
    </Group>
  );
}
