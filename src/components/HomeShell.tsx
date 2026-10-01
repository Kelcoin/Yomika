import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ArchiveDetailRoute } from './ArchiveDetailRoute';

/** 首页的「列表 + 详情」两栏，与档案库、书架同一套外壳。
 *
 * 从前首页的卡片把详情开在 `/library/:id` 上：在首页点开一个档案，屏幕后面其实
 * 跳进了档案库，于是返回首页再点档案库，看到的是刚才那份详情。首页现在有自己的
 * `/home/:id`，左边始终是首页自己那三排。
 *
 * 与档案库的区别只有滚动：首页那一页的面板要随内容长高（`is-flow`，见
 * `src/app/RetainedPage.tsx` 与 design-system-contract 的那条契约），所以整页滚，
 * 两栏跟着内容长；档案库的面板被钳在视口高度上，两栏各自滚。宽度则两边一样，
 * 由 shell.css 里 `:has(.workspace-home)` 那条规则把 `.workspace` 放宽。 */
export function HomeShell({ children }: { children: ReactNode }) {
  const { archiveId } = useParams();
  const layout = useDefaultLayout({
    id: 'home-shell-split',
    panelIds: ['home-shell-list', 'home-shell-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group className={`library-shell${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="home-shell-list" defaultSize="58" minSize="40">
        <section className="library-shell-list">{children}</section>
      </Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && (
        <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="home-shell-detail" defaultSize="42" minSize="30">
          <section className="library-shell-detail" data-scroll-region>
            {/* 详情里的推荐条也归首页：从前它一律指向 `/library/:id`，点一条推荐就会
                把左边那三排换成档案库，等于又从首页溜进档案库。 */}
            <ArchiveDetailRoute archiveId={archiveId} detailBasePath="/home" />
          </section>
        </Panel>
      )}
    </Group>
  );
}
