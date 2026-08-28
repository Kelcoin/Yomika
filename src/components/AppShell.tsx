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
  Waypoints,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { StatusBar } from './StatusBar';

const navigation = [
  { to: '/', label: '首页', icon: Home, mobile: true },
  { to: '/library', label: '档案库', icon: Archive, mobile: true },
  { to: '/history', label: '历史', icon: History, mobile: true },
  { to: '/watchlist', label: '待看', icon: Star, mobile: true },
  { to: '/eh', label: 'E-Hentai', icon: Globe, mobile: false },
  { to: '/downloads', label: '下载', icon: Download, mobile: false },
  { to: '/sync', label: '同步', icon: Waypoints, mobile: false },
  { to: '/settings', label: '设置', icon: Settings, mobile: true },
] as const;

const routeTitles = Object.fromEntries(navigation.map(({ to, label }) => [to, label]));
const markUrl = new URL('../../assets/yomika-icon.svg', import.meta.url).href;

interface AppShellProps {
  children: ReactNode;
}

function Navigation({ compact = false }: { compact?: boolean }) {
  return (
    <nav className={compact ? 'compact-nav' : 'side-nav'} aria-label={compact ? '移动导航' : '主导航'}>
      {navigation.filter((item) => !compact || item.mobile).map(({ to, label, icon: Icon }) => (
        <NavLink
          className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}
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
  const title = routeTitles[pathname] ?? 'Yomika';

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
          <p className="sidebar-footnote">LOCAL / 01</p>
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
            <span className="context-label">YOMIKA</span>
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
          className="workspace"
          tabIndex={-1}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.32, 0.72, 0, 1] }}
        >
          {children}
        </motion.main>
        <StatusBar />
      </div>

      <Navigation compact />
    </div>
  );
}
