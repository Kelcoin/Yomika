import { useEdgeBounce } from '../lib/useEdgeBounce';
import {
  Archive,
  Bookmark,
  Download,
  HardDrive,
  History,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Star,
  ArrowUp,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { getPlatformCapabilities } from '../bridge/platform';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { isMobileDevice } from '../lib/layoutMode';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { YomikaMark } from './YomikaMark';
import { usePreferences } from '../app/preferences';

/** 手机 / 平板外壳：Android WebView 与 iOS WKWebView 都会带这些标记，桌面
 * WebView2 不会。只用来决定第一帧画不画自绘标题栏。 */
const isMobileShell = isMobileDevice;

const navigation = [
  { to: '/', label: '首页', icon: Home },
  { to: '/library', label: '档案库', icon: Archive },
  { to: '/history', label: '历史', icon: History },
  { to: '/watchlist', label: '收藏夹', icon: Star },
  { to: '/to-read', label: '待看', icon: Bookmark },
  { to: '/downloads', label: '本地档案', icon: HardDrive },
  { to: '/settings', label: '设置', icon: Settings },
] as const;

type NavKey = (typeof navigation)[number]['to'];
/** Home hosts secondary navigation and settings; both home and library stay reachable. */
const PINNED_NAV_KEYS: NavKey[] = ['/', '/library'];
const NAV_KEY_ROUTES: Record<string, NavKey> = {
  home: '/',
  library: '/library',
  history: '/history',
  watchlist: '/watchlist',
  'to-read': '/to-read',
  downloads: '/downloads',
};

function compactNavItems(bottomNavItems: readonly string[]) {
  const routes = new Set(bottomNavItems.map((key) => NAV_KEY_ROUTES[key]).filter(Boolean));
  for (const to of PINNED_NAV_KEYS) routes.add(to);
  return navigation.filter(({ to }) => routes.has(to));
}

/** Secondary entries shown before the fixed settings link in the home header. */
export function compactNavHiddenItems(bottomNavItems: readonly string[] = []) {
  const items = compactNavItems(bottomNavItems);
  return navigation.filter(({ to }) => to !== '/settings' && !items.some((entry) => entry.to === to));
}

const routeTitles = Object.fromEntries(navigation.map(({ to, label }) => [to, label]));

/** 侧栏那一条指向哪儿（`to`）与它代表哪几段路径是两件事。
 *
 * 首页的详情是它自己的一条路由（`/home/:archiveId`），而侧栏那一条指向 `/`：`end`
 * 让 `/` 只认根路径，于是「在首页点开一张档案」会把首页图标熄灭。档案库、历史、收藏
 * 的详情都挂在自己的前缀下（`/library/:archiveId`、`/history/:archiveId` …），
 * react-router 本来就认，所以只有首页有这个毛病。
 *
 * 导出是为了能直接量这条规则——它是纯函数，不必把整棵树渲染起来。 */
const NAV_EXTRA_PREFIXES: Record<string, string> = { '/': '/home/' };

export function navEntryActive(to: string, isActive: boolean, pathname: string): boolean {
  if (isActive) return true;
  const prefix = NAV_EXTRA_PREFIXES[to];
  return prefix !== undefined && pathname.startsWith(prefix);
}

// DOM nodes are replaced when a route unmounts, but the user's reading position
// belongs to the route. Keep it outside React so switching tabs does not turn a
// scroll restoration into another render or request.

interface AppShellProps {
  children: ReactNode;
}

function Navigation({ compact = false, floating = false, hidden = false, bottomNavItems }: { compact?: boolean; floating?: boolean; hidden?: boolean; bottomNavItems?: readonly string[] }) {
  const location = useLocation();
  const items = compact && bottomNavItems ? compactNavItems(bottomNavItems) : navigation;
  return (
    <>
      <nav
        className={compact ? `compact-nav${floating ? ' is-floating' : ''}${hidden ? ' is-hidden' : ''}` : 'side-nav'}
        aria-label={compact ? '移动导航' : '主导航'}
      >
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            className={({ isActive }) => {
              const queryOnly = to.includes('?');
              const active = queryOnly
                ? isActive && location.search === to.slice(to.indexOf('?'))
                : navEntryActive(to, isActive, location.pathname);
              return `nav-link${active ? ' is-active' : ''}`;
            }}
            end={to === '/'}
            key={to}
            to={to}
            state={{ navigationTab: true }}
            title={label}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}

      </nav>
    </>
  );
}

/** Pinned home chrome stays outside the overscrolling, retained page content. */
function MobileHomeTopbar({ bottomNavItems }: { bottomNavItems: readonly string[] }) {
  const hidden = compactNavHiddenItems(bottomNavItems);
  return <header className="mobile-home-topbar">
    <div className="mobile-home-brand" aria-label="Yomika"><YomikaMark size={30} /><span>Yomika</span></div>
    <nav className="mobile-home-shortcuts" aria-label="首页快捷导航">
      <div className="mobile-home-shortcuts-scroll">
        {hidden.map(({ to, label, icon: Icon }) => <Link key={to} to={to} state={{ homeEntry: true }} className="icon-button" aria-label={label} title={label}><Icon aria-hidden="true" /></Link>)}
      </div>
      <Link to="/settings" state={{ homeEntry: true }} className="icon-button mobile-home-settings" aria-label="设置" title="设置"><Settings aria-hidden="true" /></Link>
    </nav>
  </header>;
}

/** Remembered so the rail opens the way it was left. */
const SIDEBAR_COLLAPSED_KEY = 'yomika.sidebar-collapsed';

export function AppShell({ children }: AppShellProps) {
  const { pathname } = useLocation();
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const homeTopbar = compact && pathname === '/';
  const { preferences } = usePreferences();
  const floatingNav = preferences.floatingNav;
  // The rail's collapsed state is a preference, not session state: it used to
  // snap back to expanded on every launch.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const workspaceRef = useRef<HTMLElement>(null);
  useEdgeBounce(workspaceRef, pathname);
  const topButtonRef = useRef<HTMLButtonElement>(null);
  const [topPosition, setTopPosition] = useState<{ placement: string; bottom: number; right: number }>();
  /** 底栏收起时圆盘留在哪：见 `measure()` 里那段「收起期间不许挪」。 */
  const parkedTopPositionRef = useRef<{ placement: string; bottom: number; right: number }>();
  /** 正在滚的那一栏。两栏布局里圆盘要贴它、点击也只回它，而不是永远贴窗口右下角。 */
  const activeRegionRef = useRef<HTMLElement>();
  /** `measure()` 在另一个 effect 里，滚动处理要能在「换了活跃栏」时请它重算一次。 */
  const measureTopRef = useRef<(() => void) | undefined>(undefined);
  const [showScrollTop, setShowScrollTop] = useState(false);
  // The floating compact bar answers scrolling the way the scroll-to-top disc
  // does: scrolling down parks it out of the way, scrolling up — or reaching the
  // top — brings it back.
  const [compactNavHidden, setCompactNavHidden] = useState(false);
  /** 自绘标题栏是 Windows 专属：Windows 关了原生装饰、由应用自己画；macOS 有
   * 自己的红绿灯，iOS/Android 根本没有窗口按钮可点。平台探测是异步命令，先用
   * UA 判断一次，免得手机上一进应用先闪一条没有用的栏。 */
  const [showTitleBar, setShowTitleBar] = useState(() => !isMobileShell());
  /** 跳过链接是给键盘用户准备的。触屏上它没有用处，而 WebKit 会被点按命中
   * :focus-visible，把它常驻成状态栏那一角的胶囊；CSS 那边按 (hover/pointer)
   * 挡了一层，这里再按平台挡一层——拿到的是原生探测结果，不依赖媒体特性。 */
  const [showSkipLink, setShowSkipLink] = useState(() => !isMobileShell());
  useEffect(() => {
    void getPlatformCapabilities().then((result) => {
      if (!result.ok) return;
      setShowTitleBar(result.value.platform === 'windows');
      setShowSkipLink(result.value.platform !== 'android' && result.value.platform !== 'ios');
    });
  }, []);

  useEffect(() => {
    const previous = new Map<HTMLElement, number>();
    const handleScroll = (event: Event) => {
      const target = event.target;
      const region = target instanceof HTMLElement ? target : undefined;
      if (!region) return;
      if (region !== workspaceRef.current && !region.matches('[data-scroll-region]')) return;
      const maxScroll = Math.max(0, region.scrollHeight - region.clientHeight);
      const current = Math.min(maxScroll, Math.max(0, region.scrollTop));
      const before = previous.get(region) ?? 0;
      const bouncing = Boolean(region.closest('[data-edge-bounce]')
        || region.matches('.archive-list') && region.querySelector(':scope > [data-overscroll]'));
      if (bouncing) {
        previous.set(region, current);
        return;
      }
      // Ignore tiny reversals from touch noise / elastic settling. Accumulate
      // against the last accepted sample so slow intentional scrolling works.
      if (current > 8 && Math.abs(current - before) < 6) return;
      previous.set(region, current);
      if (current <= 8 || current >= before) {
        setShowScrollTop(false);
        // 这一栏回到顶上、或者改往上滚了：圆盘不该继续贴它。另一栏真在滚的话，
        // 下一个事件会立刻把活跃栏换过去，所以这里清掉是安全的。
        if (activeRegionRef.current === region) activeRegionRef.current = undefined;
      } else {
        const switched = activeRegionRef.current !== region;
        activeRegionRef.current = region;
        setShowScrollTop(true);
        // 换了栏就要重新量一次：圆盘贴的是栏，不是窗口。
        if (switched) measureTopRef.current?.();
      }
      // Scroll direction drives the floating bar: down past the top hides it,
      // up — or back at the top — restores it. Only the floating bar answers
      // scrolling; the docked bar has its own row and stays put.
      if (floatingNav) {
        setCompactNavHidden((hidden) => {
          // A short page cannot lose a whole bar's clearance without clamping
          // its scroll position. Keep it docked instead of a hide/clamp/show loop.
          if (maxScroll + (hidden ? 80 : 0) <= 80) return false;
          // Removing the hidden bar's spacer can clamp scrollTop at the end.
          // That layout correction is not an upward gesture to show it again.
          if (hidden && current < before && region.clientHeight > 0 && current >= region.scrollHeight - region.clientHeight - 1) return true;
          if (current > 8 && current > before) return true;
          if (current < before || current <= 8) return false;
          return hidden;
        });
      }
    };
    const workspace = workspaceRef.current;
    if (workspace) previous.set(workspace, workspace.scrollTop);
    // Capture scroll events so dynamically mounted library/detail regions are
    // covered without needing a second effect or a fragile mount ordering.
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    // Turning the floating bar off mid-session must not leave it parked.
    if (!floatingNav) setCompactNavHidden(false);
    setShowScrollTop(false);
    return () => document.removeEventListener('scroll', handleScroll, true);
  }, [pathname, floatingNav]);

  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('.compact-nav');
    const button = topButtonRef.current;
    if (!nav || !button || !floatingNav) { setTopPosition(undefined); return; }
    const measure = () => {
      // 底栏收起与圆盘淡出是同一次滚动的两个结果（都在 `handleScroll` 里），而两种停法
      // 的落点差着几百像素：贴着胶囊（`beside`）vs 贴屏幕右下角（`above`）。照常重算的
      // 话，用户看到的就是「淡出到一半往右瞬移再消失」。底栏一收起，圆盘就留在它刚才待
      // 的地方——此刻它自己也在淡出，没人看得见；等滚回来时底栏已经先回来，那时再重算。
      //
      // 这一段必须排在「量不到底栏就把圆盘藏起来」之前：底栏收起时它可能量出 0 宽（动画
      // 期间换合成层，或者将来某天改成 display:none），那时该做的是**停在原地**，而不是
      // 把按钮直接撤掉——撤掉同样会闪，只是闪的方向不同。
      if (compactNavHidden) {
        const parked = parkedTopPositionRef.current;
        if (parked) { setTopPosition(parked); return; }
      }
      const bar = nav.getBoundingClientRect();
      if (getComputedStyle(nav).display === 'none' || bar.width <= 0) { setTopPosition(undefined); return; }
      const disc = button.getBoundingClientRect();
      const tokens = getComputedStyle(document.documentElement);
      const safeRight = parseFloat(tokens.getPropertyValue('--safe-right')) || 0;
      const safeBottom = parseFloat(tokens.getPropertyValue('--safe-bottom')) || 0;
      const width = disc.width || 44;
      const height = disc.height || 44;
      // Use the stable layout dock rather than the bar's animated visual rect.
      const dockBottom = parseFloat(getComputedStyle(nav).bottom);
      const barTop = Number.isFinite(dockBottom) ? window.innerHeight - dockBottom - (nav.offsetHeight || bar.height) : bar.top;
      const travel = (nav.offsetHeight || bar.height) + (Number.isFinite(dockBottom) ? dockBottom : 12 + safeBottom);
      button.style.setProperty('--compact-nav-travel', `${travel}px`);
      // 两栏（首页/档案库/本地档案的双页档）里两栏各自是滚动容器：圆盘该贴的是
      // **正在滚的那一栏**，而不是窗口右下角。贴窗口的话，滚 A 栏时它会出现在 B 栏
      // 上面，点一下还会把两栏一起拉回顶部——用户报的正是这两条。
      const region = activeRegionRef.current;
      const panel = region && region !== workspaceRef.current ? region.getBoundingClientRect() : undefined;
      if (panel && panel.width > 0) {
        // 栏内右下角、离边 12px；底栏压着那一角时抬到底栏上面（与 `above` 同一套算法：
        // bottom 是离窗口底边的距离，越大越靠上）。
        const anchored = {
          placement: 'panel',
          bottom: Math.max(window.innerHeight - panel.bottom + 12, window.innerHeight - barTop + 12),
          right: Math.max(12 + safeRight, window.innerWidth - panel.right + 12),
        };
        parkedTopPositionRef.current = anchored;
        setTopPosition((current) => current?.placement === anchored.placement && current.bottom === anchored.bottom && current.right === anchored.right
          ? current : anchored);
        return;
      }
      const beside = !compactNavHidden && bar.right + 12 + width <= window.innerWidth - 16 - safeRight;
      const bottom = compactNavHidden ? 16 + safeBottom : beside
        ? window.innerHeight - (barTop + bar.height / 2) - height / 2
        : window.innerHeight - barTop + 12;
      const right = beside ? window.innerWidth - bar.right - 12 - width : 16 + safeRight;
      const next = { placement: beside ? 'beside' : 'above', bottom, right };
      parkedTopPositionRef.current = next;
      setTopPosition((current) => current?.placement === next.placement && current.bottom === next.bottom && current.right === next.right
        ? current : next);
    };
    measureTopRef.current = measure;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(nav); observer?.observe(button); observer?.observe(document.documentElement);
    const insets = new MutationObserver(measure);
    insets.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    const settled = (event: Event) => { if (event.target === nav) measure(); };
    nav.addEventListener('transitionend', settled);
    nav.addEventListener('transitioncancel', settled);
    window.addEventListener('resize', measure);
    return () => {
      measureTopRef.current = undefined;
      observer?.disconnect(); insets.disconnect();
      nav.removeEventListener('transitionend', settled);
      nav.removeEventListener('transitioncancel', settled);
      window.removeEventListener('resize', measure);
    };
  }, [floatingNav, compactNavHidden, preferences.bottomNavItems]);

  // Dead zones around and inside the workspace — the collapsed sidebar strip,
  // the title bar, a rail whose horizontal scroll has run out — have no scroll
  // chain that reaches the page scroller: Chromium latches the wheel onto the
  // rail's own axis and chains along it, into the workspace's overflow-x:
  // hidden, where the gesture dies. Walk the target chain and, when nothing
  // could consume the wheel, hand it to the workspace the way the library
  // panels forward to their list.
  useEffect(() => {
    // jsdom's ElementEventMap has no wheel entry; the runtime event is a WheelEvent.
    const forward = (raw: Event) => {
      const event = raw as WheelEvent;
      if (event.defaultPrevented || event.ctrlKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Overlays and the reader own their scrolling.
      if (target.closest('[role="dialog"], [role="menu"], .tag-suggest-panel, .reader-screen')) return;
      for (let node: Element | null = target; node && !node.matches('.app-shell'); node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        const atEdge = event.deltaY < 0
          ? node.scrollTop <= 0
          : node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
        // A box with room left in the wheel's direction consumes this event.
        if (!atEdge) return;
      }
      const workspace = workspaceRef.current;
      if (!workspace) return;
      workspace.scrollTop += event.deltaY;
      workspace.scrollLeft += event.deltaX;
      if (event.cancelable) event.preventDefault();
    };
    const shell = document.querySelector('.app-shell');
    if (!shell) return undefined;
    shell.addEventListener('wheel', forward, { passive: false });
    return () => shell.removeEventListener('wheel', forward);
  }, []);


  return (
    <div data-compact-nav-hidden={compactNavHidden || undefined} className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${floatingNav ? ' is-floating-nav' : ''}`}>
      {showTitleBar && <TitleBar />}
      {showSkipLink && <a className="skip-link" href="#main-content">跳到主内容</a>}
      <aside className="sidebar" aria-label="应用侧栏">
        <NavLink className="brand" to="/" aria-label="Yomika 首页">
          <YomikaMark size={38} />
          <span>Yomika</span>
        </NavLink>
        <Navigation />
        <div className="sidebar-footer">
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => setSidebarCollapsed((current) => {
              const next = !current;
              try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* private mode */ }
              return next;
            })}
          >
            {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          </button>
        </div>
      </aside>

      <div className={`app-main${homeTopbar ? ' has-home-topbar' : ''}`}>
        {homeTopbar && <MobileHomeTopbar bottomNavItems={preferences.bottomNavItems} />}
        <main
          id="main-content"
          // The shelves render the library's own list, so they take the library's
          // workspace container too. With a separate one their compact layout
          // clamped at a fixed height with `overflow: hidden`, which left the last
          // card behind the bottom nav with nothing able to scroll it into view.
          //
          // 详情路由（`/history/:id` 之类）也算在内：它们和列表同一页，只是右边多了一
          // 栏。原来只给 `library` 放行子路径，于是从书架点开一张卡时这一页立刻换成
          // 「普通工作区」——1320px 上限 + 48px 内边距 + 居中，两栏被挤进一个四周留
          // 空的盒子里，「四周有异常空隙」就是这一条。
          //
          // 首页不在这里：它也有两栏（`HomeShell`），但详情没开时那一页的面板必须随内容
          // 长高（`is-flow`），而这一条容器的 `overflow: hidden` 会把长出去的部分直接裁掉、
          // 滚不到。首页的全宽与内边距由 shell.css 里 `:has(.workspace-home)` 那条规则给；
          // 详情一开则由 `:has(.library-shell.is-home.has-detail)` 那三条把它钳成一屏两栏
          // （右栏要能自己滚），所以那一态同样不能套这条「整页滚」的容器。
          className={`workspace${/^\/(library|downloads|history|watchlist|to-read)(?:\/[^/]+)?$/.test(pathname) ? ' is-library-workspace' : ''}`}
          ref={workspaceRef}
          tabIndex={-1}
        >
          {children}
        </main>
        <button ref={topButtonRef} data-placement={topPosition?.placement} data-nav-hidden={compactNavHidden || undefined} style={topPosition ? { bottom: topPosition.bottom, right: topPosition.right } : undefined} className={`scroll-to-top${showScrollTop ? '' : ' is-hidden'}`} type="button" aria-label="返回顶部" title="返回顶部" onClick={() => {
          const region = activeRegionRef.current;
          if (region && region !== workspaceRef.current) {
            // 双页档：圆盘贴的就是那一栏，回顶也只回那一栏。两栏一起回顶会让人
            // 丢掉另一页正看到的位置。
            region.scrollTo({ top: 0, behavior: 'smooth' });
          } else {
            workspaceRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
            document.querySelectorAll<HTMLElement>('[data-scroll-region]').forEach((item) => !item.closest('[hidden]') && item.scrollTo({ top: 0, behavior: 'smooth' }));
          }
          activeRegionRef.current = undefined;
          setShowScrollTop(false);
        }}><ArrowUp aria-hidden="true" /></button>
        <StatusBar />
      </div>

          <Navigation compact floating={floatingNav} hidden={compactNavHidden} bottomNavItems={preferences.bottomNavItems} />
    </div>
  );
}
