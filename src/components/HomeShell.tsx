import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { panelLayout } from '../lib/panelLayout';
import { ArchiveDetailRoute } from './ArchiveDetailRoute';

/** 换容器后重写位置的帧数上限：8 帧 ≈ 130ms，够布局与重排落定，又不至于跟用户
 * 自己动手滚较劲。 */
const POSITION_RETRY_FRAMES = 8;

/** 没存过布局时首页两栏的比例，与档案库、书架、本地档案同一份（58/42）。 */
const HOME_SPLIT_LAYOUT: Layout = { 'home-shell-list': 58, 'home-shell-detail': 42 };

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
 * 下面这三个 effect 就是把这个位置接过去，写回新容器。 */
export function HomeShell({ children }: { children: ReactNode }) {
  const { archiveId } = useParams();
  const detailOpen = archiveId !== undefined;
  const listRef = useRef<HTMLElement>(null);
  /** 换容器之前，用户看到的那个位置。 */
  const offsetRef = useRef(0);
  /** 现在这个 effect 盯的是哪个元素，用来分辨「第一次接管」与「换了容器」。 */
  const watchingRef = useRef<HTMLElement | null>(null);
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
    // **换了容器就不许再读初值**：新容器那一刻还没定高，读出来的是被夹的 0，会把刚
    // 从旧容器记下的位置当场抹掉——真机上「点开详情跳回顶部」就是这么来的（一发式
    // 写 + 这一读，两次都踩在同一个还没定高的元素上）。位置只认滚动事件里那一份。
    if (watchingRef.current === null) offsetRef.current = scroller.scrollTop;
    watchingRef.current = scroller;
    const remember = () => { offsetRef.current = scroller.scrollTop; };
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, [scrollerFor]);

  const wasDetailOpen = useRef(detailOpen);
  useLayoutEffect(() => {
    // 首次挂载不写：路由缓存（`src/app/RetainedPage.tsx`）自己会把位置恢复回来，
    // 这里再写一次 0 就把它抹掉了。
    if (wasDetailOpen.current === detailOpen) return undefined;
    wasDetailOpen.current = detailOpen;
    const section = listRef.current;
    const scroller = section ? scrollerFor(section) : null;
    // 换过去之后旧的容器已经不再溢出（详情没开时是 `overflow: hidden` 的整页），
    // 它的 `scrollTop` 那一刻永远是 0——位置只能靠换之前记下来的这一份。
    if (!scroller) return undefined;
    const target = offsetRef.current;
    // 而且这一发不一定收得下：换容器那一帧新容器还没长到 target 那么高时，浏览器会
    // 把这一写夹成 0；卡片又因为左栏变窄而重排，滚动锚定随后还可能再挪一次。所以每
    // 个动画帧重写一遍，写进去了就收手（最多 `POSITION_RETRY_FRAMES` 帧 ≈ 130ms，
    // 再长就是在跟用户自己动手滚较劲了）。
    let frames = 0;
    let handle = 0;
    const apply = () => {
      if (scroller.scrollTop !== target) scroller.scrollTop = target;
      frames += 1;
      if (scroller.scrollTop === target || frames >= POSITION_RETRY_FRAMES) return;
      handle = requestAnimationFrame(apply);
    };
    handle = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(handle);
  }, [detailOpen, scrollerFor]);

  return (
    <Group className={`library-shell is-home${archiveId ? ' has-detail' : ''}`} orientation="horizontal" defaultLayout={panelLayout(layout.defaultLayout, HOME_SPLIT_LAYOUT)} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="home-shell-list" minSize="40">
        {/* 详情打开时这一栏自己就是滚动容器（见 shell.css 里 `.library-shell.is-home.has-detail`
            那三条规则），所以它要像档案库的列表那样挂 `data-scroll-region`：回顶圆盘与浮动
            导航栏只认这个属性或 `.workspace`，不挂就等于「滚了半天导航栏不出现」。
            详情没开时这一栏并不滚（`overflow: visible`），属性在那儿是惰性的。 */}
        <section className="library-shell-list" data-scroll-region ref={listRef}>{children}</section>
      </Panel>
      {archiveId && <Separator className="panel-separator" />}
      {archiveId && (
        <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="home-shell-detail" minSize="30">
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
