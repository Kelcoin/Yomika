import {
  Archive,
  Bookmark,
  Download,
  History,
  Home,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Star,
  ArrowUp,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { YomikaMark } from './YomikaMark';
import { usePreferences } from '../app/preferences';

const navigation = [
  { to: '/', label: '首页', icon: Home },
  { to: '/library', label: '档案库', icon: Archive },
  { to: '/history', label: '历史', icon: History },
  { to: '/watchlist', label: '收藏夹', icon: Star },
  { to: '/to-read', label: '待看', icon: Bookmark },
  { to: '/downloads', label: '下载', icon: Download },
  { to: '/settings', label: '设置', icon: Settings },
] as const;

type NavKey = (typeof navigation)[number]['to'];
/** The compact bar's entries are a preference keyed by these route ids;
 * 档案库与设置 are load-bearing and always present. */
const PINNED_NAV_KEYS: NavKey[] = ['/library', '/settings'];
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
  // 底栏放不下的页面收进「更多」，悬浮在按钮上方；底栏装得下全部时不出现在导航里。
  const hiddenItems = compact
    ? navigation.filter(({ to }) => !items.some((entry) => entry.to === to))
    : [];
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [location.pathname, location.search]);
  const showMore = compact && hiddenItems.length > 0;
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
          <button
            className={`nav-link nav-more${moreOpen ? ' is-active' : ''}`}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <MoreHorizontal aria-hidden="true" />
            <span>更多</span>
          </button>
        )}
      </nav>
      {showMore && moreOpen && (
        <div className="nav-more-layer">
          <button className="nav-more-backdrop" type="button" aria-label="关闭页面菜单" onClick={() => setMoreOpen(false)} />
          <div className="nav-more-menu" role="menu" aria-label="更多页面">
            {hiddenItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                role="menuitem"
                to={to}
                end={to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
                onClick={() => setMoreOpen(false)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Remembered so the rail opens the way it was left. */
const SIDEBAR_COLLAPSED_KEY = 'yomika.sidebar-collapsed';

export function AppShell({ children }: AppShellProps) {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
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
      // up — or back at the top — restores it.
      if (current > 8 && current > before) {
        setCompactNavHidden(true);
      } else if (current < before || current <= 8) {
        setCompactNavHidden(false);
      }
    };
    const workspace = workspaceRef.current;
    if (workspace) previous.set(workspace, workspace.scrollTop);
    // Capture scroll events so dynamically mounted library/detail regions are
    // covered without needing a second effect or a fragile mount ordering.
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    setShowScrollTop(false);
    return () => document.removeEventListener('scroll', handleScroll, true);
  }, [pathname]);


  return (
    <div className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${floatingNav ? ' is-floating-nav' : ''}`}>
      <TitleBar />
      <a className="skip-link" href="#main-content">跳到主内容</a>
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
        <motion.main
          id="main-content"
          // The shelves render the library's own list, so they take the library's
          // workspace container too. With a separate one their compact layout
          // clamped at a fixed height with `overflow: hidden`, which left the last
          // card behind the bottom nav with nothing able to scroll it into view.
          className={`workspace${/^\/(library(?:\/[^/]+)?|history|watchlist|to-read)$/.test(pathname) ? ' is-library-workspace' : ''}`}
          ref={workspaceRef}
          tabIndex={-1}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.32, 0.72, 0, 1] }}
        >
          {children}
        </motion.main>
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
