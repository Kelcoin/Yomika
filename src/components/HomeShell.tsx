import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ArchiveDetailRoute } from './ArchiveDetailRoute';

/** 首页的「列表 + 详情」两栏，与档案库、书架同一套外壳。
 *
 * 从前首页的卡片把详情开在 `/library/:id` 上：在首页点开一个档案，屏幕后面其实
 * 跳进了档案库，于是返回首页再点档案库，看到的是刚才那份详情。首页现在有自己的
 * `/home/:id`，左边始终是首页自己那三排。
 *
 * 滚动分两态，闸门是 `is-home`：详情没开时首页还是随内容长高的（`is-flow`，见
 * `src/app/RetainedPage.tsx` 与 design-system-contract 的那条契约），整页滚、两栏跟着
 * 内容长；详情一开就换成档案库那样的钳定两栏——`is-flow` 的 `height: auto` 会让 Group
 * 的内联 `height: 100%` 退化成 auto，两栏被拉到较高那一栏的内容高度，详情栏于是永远
 * 不溢出、也就永远滚不动，滚哪里都是滚整页。shell.css 里 `.library-shell.is-home.has-detail`
 * 那三条规则负责这一态：整页收起滚动，左栏自己成为滚动容器。宽度则两态一样，由
 * `:has(.workspace-home)` 那条规则把 `.workspace` 放宽。
 *
 * 两态换的是「谁在滚」这个元素：没开详情时滚 `.workspace`，开了之后滚左栏自己。
 * 新容器从 0 开始，所以「读到一半点开详情」过去会自己跳回顶部（用户报的第 3 条）。
 * 下面这两个 effect 就是把这个位置接过去，写回新容器。 */
export function HomeShell({ children }: { children: ReactNode }) {
  const { archiveId } = useParams();
  const detailOpen = archiveId !== undefined;
  const listRef = useRef<HTMLElement>(null);
  /** 换容器之前，用户看到的那个位置。 */
  const offsetRef = useRef(0);
  const layout = useDefaultLayout({
    id: 'home-shell-split',
    panelIds: ['home-shell-list', 'home-shell-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** 当前在滚的是谁：详情开着是左栏自己，没开是整页。 */
  const scrollerFor = useCallback((section: HTMLElement) => (
    detailOpen ? section : section.closest<HTMLElement>('.workspace')
  ), [detailOpen]);

  useEffect(() => {
    const section = listRef.current;
    const scroller = section ? scrollerFor(section) : null;
    if (!scroller) return undefined;
    offsetRef.current = scroller.scrollTop;
    const remember = () => { offsetRef.current = scroller.scrollTop; };
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, [scrollerFor]);

  const wasDetailOpen = useRef(detailOpen);
  useLayoutEffect(() => {
    // 首次挂载不写：路由缓存（`src/app/RetainedPage.tsx`）自己会把位置恢复回来，
    // 这里再写一次 0 就把它抹掉了。
    if (wasDetailOpen.current === detailOpen) return;
    wasDetailOpen.current = detailOpen;
    const section = listRef.current;
    const scroller = section ? scrollerFor(section) : null;
    // 换过去之后旧的容器已经不再溢出（详情没开时是 `overflow: hidden` 的整页），
    // 它的 `scrollTop` 那一刻永远是 0——位置只能靠换之前记下来的这一份。
    if (scroller) scroller.scrollTop = offsetRef.current;
  }, [detailOpen, scrollerFor]);

  return (
    <Group className={`library-shell is-home${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="home-shell-list" defaultSize="58" minSize="40">
        {/* 详情打开时这一栏自己就是滚动容器（见 shell.css 里 `.library-shell.is-home.has-detail`
            那三条规则），所以它要像档案库的列表那样挂 `data-scroll-region`：回顶圆盘与浮动
            导航栏只认这个属性或 `.workspace`，不挂就等于「滚了半天导航栏不出现」。
            详情没开时这一栏并不滚（`overflow: visible`），属性在那儿是惰性的。 */}
        <section className="library-shell-list" data-scroll-region ref={listRef}>{children}</section>
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
