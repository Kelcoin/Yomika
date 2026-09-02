import {
  Archive,
  Download,
  Globe,
  History,
  Home,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Star,
  ArrowUp,
  CopyCheck,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { StatusBar } from './StatusBar';

const navigation = [
  { to: '/', label: '首页', icon: Home, mobile: true },
  { to: '/library', label: '档案库', icon: Archive, mobile: true },
  { to: '/history', label: '历史', icon: History, mobile: true },
  { to: '/watchlist', label: '收藏夹', icon: Star, mobile: true },
  { to: '/eh', label: 'E-Hentai', icon: Globe, mobile: false },
  { to: '/downloads', label: '下载', icon: Download, mobile: false },
  { to: '/dedup', label: '查重', icon: CopyCheck, mobile: false },
  { to: '/settings', label: '设置', icon: Settings, mobile: true },
] as const;

const routeTitles = Object.fromEntries(navigation.map(({ to, label }) => [to, label]));
const markUrl = new URL('../../assets/yomika-icon.svg', import.meta.url).href;

interface AppShellProps {
  children: ReactNode;
}

function Navigation({ compact = false }: { compact?: boolean }) {
  const location = useLocation();
  return (
    <nav className={compact ? 'compact-nav' : 'side-nav'} aria-label={compact ? '移动导航' : '主导航'}>
      {navigation.filter((item) => !compact || item.mobile).map(({ to, label, icon: Icon }) => (
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
    </nav>
  );
}

export function AppShell({ children }: AppShellProps) {
  const { pathname } = useLocation();
  const reduceMotion = useReducedMotion();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const title = pathname.startsWith('/library/') ? '档案详情' : routeTitles[pathname] ?? 'Yomika';
  const workspaceRef = useRef<HTMLElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

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
    <div className={`app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">跳到主内容</a>
      <aside className="sidebar" aria-label="应用侧栏">
        <NavLink className="brand" to="/" aria-label="Yomika 首页">
          <img src={markUrl} alt="" width="38" height="38" />
          <span>Yomika</span>
        </NavLink>
        <Navigation />
        <div className="sidebar-footer">
          <span aria-hidden="true" />
          <button
            className="sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="context-bar">
          <div>
            <strong>{title}</strong>
          </div>
          <div className="context-actions">
            <Tooltip.Provider delayDuration={450}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild><Link className="icon-button" to="/library" aria-label="搜索"><Search aria-hidden="true" /></Link></Tooltip.Trigger>
                <Tooltip.Portal><Tooltip.Content className="tooltip-content" sideOffset={6}>搜索<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger asChild><Link className="icon-button" to="/downloads" aria-label="任务中心"><ListTodo aria-hidden="true" /></Link></Tooltip.Trigger>
                <Tooltip.Portal><Tooltip.Content className="tooltip-content" sideOffset={6}>任务中心<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        </header>

        <motion.main
          id="main-content"
          className={`workspace${/^\/library(?:\/[^/]+)?$/.test(pathname) ? ' is-library-workspace' : ''}`}
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
          document.querySelectorAll<HTMLElement>('[data-scroll-region]').forEach((region) => region.scrollTo({ top: 0, behavior: 'smooth' }));
          setShowScrollTop(false);
        }}><ArrowUp aria-hidden="true" /></button>
        <StatusBar />
      </div>

      <Navigation compact />
    </div>
  );
}
