import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { useDefaultLayout } from 'react-resizable-panels';
import { Group, Panel, Separator } from './AdaptivePanels';

import { panelLayout } from '../lib/panelLayout';
import { ArchiveDetailRoute } from './ArchiveDetailRoute';
import { useDetailListScroll } from '../lib/useDetailListScroll';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { DETAIL_RETURN_ALIGNED, DETAIL_RETURN_PREVIEW } from '../lib/detailReturn';

/** 换容器后重写位置的帧数上限：60 帧 ≈ 1s。
 *
 * 正常情况下用不到它——连续两帧读到目标值就收手了。它管的是「写进去收不下」的那一段：
 * 新容器头几百毫秒还装不下那么高（左栏里的封面还在解码，内容高度还没长起来），写进去
 * 的值会被浏览器夹成 0，得一直试到它真的装得下为止（真机上这可能是半秒级的事）。窗口
 * 长一点不会跟在滚的人较劲：用户一动手这一轮就立刻收手（见 [`USER_INPUT_EVENTS`]）。 */
const POSITION_RETRY_FRAMES = 60;

/** 用户自己动手的信号：出现一个就说明位置该由他决定了，这一轮的改写立刻停。 */
const USER_INPUT_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;

/** 换容器前记下的内容锚：从滚动口顶端数起第一排还没滚过去的轨道 + 它离顶端的距离。
 *
 * 只搬 `scrollTop` 的数值是不够的：左栏在详情打开时会变窄，内容的**高度**也会变
 * （横向滚动条出现、标题换行、图片落位都会把下面整排东西搬十几像素），同一个数值
 * 落到新布局上就是另一个画面——用户报的「打开详情页时页面滚动一点点」。对齐到内容
 * 本身才稳。没有布局信息（量不出高度）时退回数值，见 [`homeScrollAnchor`]。 */
type HomeScrollAnchor = { index: number; top: number };

/** 量一次锚点：优先取「顶端还没滚过去的」那一排轨道。
 *
 * `rect.height > 0` 是「这一排真的被排版了」的判据：量不出高度（jsdom、还没定高
 * 的那一帧）就不记锚，换容器时退回数值路径。 */
function homeScrollAnchor(scroller: HTMLElement): HomeScrollAnchor | null {
  const rails = scroller.querySelectorAll('.archive-rail');
  const origin = scroller.getBoundingClientRect().top;
  for (let index = 0; index < rails.length; index += 1) {
    const rect = rails[index]?.getBoundingClientRect();
    if (!rect || rect.height <= 0) continue;
    const top = rect.top - origin;
    if (top >= -1) return { index, top };
  }
  return null;
}

/** 锚点在新布局里对应的滚动位置；量不出来时 `null`，调用方退回记下的数值。
 *
 * `rect.top` 是**视口**坐标，而锚记的 `top` 是「离滚动口顶端多远」——两者要先放进同一个
 * 参考系里才能相减，所以这里也得减去滚动口自己的视口 `top`。少了这一步，滚动口在窗口里的
 * 那个 y（标题栏、状态栏、`.workspace` 的内边距加起来上百像素）就被当成了滚动量：每一帧
 * 收敛到同一个偏大的值，用户看到的是开关详情两侧都多滚一段（「程度更大了，关闭也会触发」）。 */
function homeScrollTarget(scroller: HTMLElement, anchor: HomeScrollAnchor | null): number | null {
  if (!anchor) return null;
  const rail = scroller.querySelectorAll('.archive-rail')[anchor.index];
  const rect = rail?.getBoundingClientRect();
  if (!rect || rect.height <= 0) return null;
  const origin = scroller.getBoundingClientRect().top;
  return scroller.scrollTop + (rect.top - origin) - anchor.top;
}

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
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  useDetailListScroll(detailOpen, listRef);
  /** 换容器之前，用户看到的那个位置。 */
  const offsetRef = useRef(0);
  /** 换容器之前，那个位置对着的是哪一排内容（见 [`homeScrollAnchor`]）。 */
  const anchorRef = useRef<HomeScrollAnchor | null>(null);
  /** 现在这个 effect 盯的是哪个元素，用来分辨「第一次接管」与「换了容器」。 */
  const watchingRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const preview = () => {
      const section = listRef.current;
      const workspace = section?.closest<HTMLElement>('.workspace');
      if (!section?.closest('[data-detail-return]') || !workspace) return;
      const behavior = workspace.style.scrollBehavior;
      workspace.style.scrollBehavior = 'auto';
      workspace.scrollTop = homeScrollTarget(workspace, anchorRef.current) ?? offsetRef.current;
      workspace.style.scrollBehavior = behavior;
    };
    const aligned = () => {
      const section = listRef.current;
      const workspace = section?.closest<HTMLElement>('.workspace');
      if (!section?.closest('[data-detail-return]') || !workspace) return;
      offsetRef.current = workspace.scrollTop;
      anchorRef.current = homeScrollAnchor(workspace);
    };
    document.addEventListener(DETAIL_RETURN_PREVIEW, preview);
    document.addEventListener(DETAIL_RETURN_ALIGNED, aligned);
    return () => { document.removeEventListener(DETAIL_RETURN_PREVIEW, preview); document.removeEventListener(DETAIL_RETURN_ALIGNED, aligned); };
  }, []);
  const layout = useDefaultLayout({
    id: 'home-shell-split',
    panelIds: ['home-shell-list', 'home-shell-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** 当前在滚的是谁：详情开着是左栏自己，没开是整页。 */
  const scrollerFor = useCallback((section: HTMLElement) => (
    detailOpen ? (compact ? null : section) : section.closest<HTMLElement>('.workspace')
  ), [compact, detailOpen]);

  useEffect(() => {
    const section = listRef.current;
    const scroller = section ? scrollerFor(section) : null;
    if (!scroller) return undefined;
    // **换了容器就不许再读初值**：新容器那一刻还没定高，读出来的是被夹的 0，会把刚
    // 从旧容器记下的位置当场抹掉。位置只认事件里那一份——滚动，以及换容器那次点击的
    // 捕获阶段（见下）。
    if (watchingRef.current === null) offsetRef.current = scroller.scrollTop;
    watchingRef.current = scroller;
    const remember = () => {
      // 容器已经拆掉了就别再记：`querySelectorAll` 在残骸上会量出「没有轨道」，把一份
      // 好端端的锚覆盖成 null。
      if (!scroller.isConnected) return;
      offsetRef.current = scroller.scrollTop;
      anchorRef.current = homeScrollAnchor(scroller);
    };
    // 换容器是由一次点击或回车触发的，这里在**捕获阶段**补记一份：那一刻读到的必然还是
    // 旧容器。只认 scroll 事件会漏掉一类情况——内容自己挪了（封面解码完把下面整排推下去
    // 十几像素），却没有产生任何 scroll 事件，那份锚就是过期的；照它换算会把画面平白推
    // 回去十几像素，也就是用户报的「打开详情页时页面滚动一点点」。
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('keydown', remember, true);
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('keydown', remember, true);
      scroller.removeEventListener('scroll', remember);
    };
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
    // **这一轮只认换容器那一刻的快照。** 写 `scrollTop` 会让浏览器回一个 `scroll` 事件，
    // 它在下一次动画帧之前到达，`remember` 会把它记成「用户现在在这儿」——可那正是我们
    // 自己刚写进去的值（还可能已经被新容器夹小了）。目标跟着被改写成「当前位置」之后，
    // 循环下一帧就判定稳定并停在原地：用户看到的是「只要不在顶部，打开/关闭详情就跳到
    // 某个固定的位置」。所以这里读一次，之后一整轮都不再碰那份会回声的状态。
    const restore = { offset: offsetRef.current, anchor: anchorRef.current };
    // **每一帧都按内容锚重算**，不是算一次就照抄：换过去之后左栏变窄，横向滚动条可能
    // 出现、标题可能换行，下面整排东西会挪十几像素。锚算出来的位置对当前滚动是幂等的
    // （`rect.top` 跟着 `scrollTop` 走），所以它既能把内容按原样钉住，又不会跟浏览器
    // 自己的滚动锚定对着干——两边要的是同一件事。量不出内容时退回快照里的数值。
    const positionFor = () => homeScrollTarget(scroller, restore.anchor) ?? restore.offset;
    // 而且这一发不一定收得下：换容器那一帧新容器还没长到那么高时，浏览器会把这一写
    // 夹成 0；写进去之后重排还会再挪。所以每个动画帧重写一遍，直到**目标没变、位置也
    // 对上了**连续两帧（只比位置的话，目标自己还在挪的那一帧也会被当成稳定）。
    let frames = 0;
    let settled = 0;
    let lastTarget: number | null = null;
    let handle = 0;
    const behavior = scroller.style.scrollBehavior;
    const anchoring = scroller.style.overflowAnchor;
    scroller.style.scrollBehavior = 'auto';
    scroller.style.overflowAnchor = 'none';
    const restoreStyles = () => {
      scroller.style.scrollBehavior = behavior;
      scroller.style.overflowAnchor = anchoring;
    };
    const apply = () => {
      const target = positionFor();
      if (scroller.scrollTop !== target) {
        scroller.scrollTop = target;
        settled = 0;
      } else {
        settled = lastTarget === target ? settled + 1 : 0;
      }
      lastTarget = target;
      frames += 1;
      if (settled >= 2 || frames >= POSITION_RETRY_FRAMES) { restoreStyles(); return; }
      handle = requestAnimationFrame(apply);
    };
    const yieldToUser = () => {
      if (handle) cancelAnimationFrame(handle);
      handle = 0;
      restoreStyles();
    };
    for (const type of USER_INPUT_EVENTS) window.addEventListener(type, yieldToUser, { capture: true, passive: true });
    // Transfer before paint; deferring the first write exposes scrollTop=0.
    apply();
    return () => {
      if (handle) cancelAnimationFrame(handle);
      restoreStyles();
      for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, yieldToUser, { capture: true });
    };
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
            <ArchiveDetailRoute key={archiveId} archiveId={archiveId} detailBasePath="/home" />
          </section>
        </Panel>
      )}
    </Group>
  );
}
