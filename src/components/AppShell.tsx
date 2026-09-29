import {
  Archive,
  Bookmark,
  Download,
  HardDrive,
  History,
  Home,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Star,
  ArrowUp,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { getPlatformCapabilities } from '../bridge/platform';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { YomikaMark } from './YomikaMark';
import { usePreferences } from '../app/preferences';

/** 手机 / 平板外壳：Android WebView 与 iOS WKWebView 都会带这些标记，桌面
 * WebView2 不会。只用来决定第一帧画不画自绘标题栏。 */
function isMobileShell(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

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
/** The compact bar's entries are a preference keyed by these route ids. 档案库 is
 * load-bearing — without it there is no way into the library — so it is always
 * present. 设置 is not: an unselected entry reappears under 更多, which is where
 * the bar sends whatever it has no room for. */
const PINNED_NAV_KEYS: NavKey[] = ['/library'];
const NAV_KEY_ROUTES: Record<string, NavKey> = {
  home: '/',
  library: '/library',
  history: '/history',
  watchlist: '/watchlist',
  'to-read': '/to-read',
  downloads: '/downloads',
  settings: '/settings',
};

function compactNavItems(bottomNavItems: readonly string[]) {
  const routes = new Set(bottomNavItems.map((key) => NAV_KEY_ROUTES[key]).filter(Boolean));
  for (const to of PINNED_NAV_KEYS) routes.add(to);
  return navigation.filter(({ to }) => routes.has(to));
}

/** The entries the bottom bar has no room for: the 更多 page lists exactly these,
 * and the 更多 entry itself only exists while the list is not empty. */
export function compactNavHiddenItems(bottomNavItems: readonly string[] = []) {
  const items = compactNavItems(bottomNavItems);
  return navigation.filter(({ to }) => !items.some((entry) => entry.to === to));
}

const routeTitles = Object.fromEntries(navigation.map(({ to, label }) => [to, label]));

// DOM nodes are replaced when a route unmounts, but the user's reading position
// belongs to the route. Keep it outside React so switching tabs does not turn a
// scroll restoration into another render or request.

interface AppShellProps {
  children: ReactNode;
}

function Navigation({ compact = false, floating = false, hidden = false, bottomNavItems }: { compact?: boolean; floating?: boolean; hidden?: boolean; bottomNavItems?: readonly string[] }) {
  const location = useLocation();
  const items = compact && bottomNavItems ? compactNavItems(bottomNavItems) : navigation;
  // 底栏放不下的页面收进「更多」——它现在是独立页面（/more），不再是弹出菜单；
  // 底栏装得下全部时连这个入口都不出现，人在那些页面或 /more 上时保持选中。
  const hiddenItems = compact ? compactNavHiddenItems(bottomNavItems) : [];
  const showMore = compact && hiddenItems.length > 0;
  const moreActive = location.pathname === '/more' || hiddenItems.some(({ to }) => to === location.pathname);
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
                : isActive;
              return `nav-link${active ? ' is-active' : ''}`;
            }}
            end={to === '/'}
            key={to}
            to={to}
            title={label}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
        {showMore && (
          <NavLink
            className={`nav-link nav-more${moreActive ? ' is-active' : ''}`}
            to="/more"
            title="更多"
          >
            <MoreHorizontal aria-hidden="true" />
            <span>更多</span>
          </NavLink>
        )}
      </nav>
    </>
  );
}

/** Remembered so the rail opens the way it was left. */
const SIDEBAR_COLLAPSED_KEY = 'yomika.sidebar-collapsed';

export function AppShell({ children }: AppShellProps) {
  const { pathname } = useLocation();
  const { preferences } = usePreferences();
  const floatingNav = preferences.floatingNav;
  // The rail's collapsed state is a preference, not session state: it used to
  // snap back to expanded on every launch.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const workspaceRef = useRef<HTMLElement>(null);
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
      const current = region.scrollTop;
      const before = previous.get(region) ?? current;
      previous.set(region, current);
      if (current <= 8 || current >= before) {
        setShowScrollTop(false);
      } else {
        setShowScrollTop(true);
      }
      // Scroll direction drives the floating bar: down past the top hides it,
      // up — or back at the top — restores it. Only the floating bar answers
      // scrolling; the docked bar has its own row and stays put.
      if (floatingNav) {
        if (current > 8 && current > before) {
          setCompactNavHidden(true);
        } else if (current < before || current <= 8) {
          setCompactNavHidden(false);
        }
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
    <div className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${floatingNav ? ' is-floating-nav' : ''}`}>
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

      <div className="app-main">
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
          className={`workspace${/^\/(library|downloads|history|watchlist|to-read)(?:\/[^/]+)?$/.test(pathname) ? ' is-library-workspace' : ''}`}
          ref={workspaceRef}
          tabIndex={-1}
        >
          {children}
        </main>
        <button className={`scroll-to-top${showScrollTop ? '' : ' is-hidden'}`} type="button" aria-label="返回顶部" title="返回顶部" onClick={() => {
          workspaceRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
          document.querySelectorAll<HTMLElement>('[data-scroll-region]').forEach((region) => !region.closest('[hidden]') && region.scrollTo({ top: 0, behavior: 'smooth' }));
          setShowScrollTop(false);
        }}><ArrowUp aria-hidden="true" /></button>
        <StatusBar />
      </div>

          <Navigation compact floating={floatingNav} hidden={compactNavHidden} bottomNavItems={preferences.bottomNavItems} />
    </div>
  );
}
