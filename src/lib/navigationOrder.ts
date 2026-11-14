/** The rendered navigation and its transitions must use the same order.
 * Compact navigation filters this sequence; it never reorders it. */
export const NAVIGATION_ENTRIES = [
  { to: '/', key: 'home', label: '首页', icon: 'home' },
  { to: '/library', key: 'library', label: '档案库', icon: 'archive' },
  { to: '/history', key: 'history', label: '历史', icon: 'history' },
  { to: '/watchlist', key: 'watchlist', label: '收藏夹', icon: 'star' },
  { to: '/to-read', key: 'to-read', label: '待看', icon: 'bookmark' },
  { to: '/downloads', key: 'downloads', label: '本地档案', icon: 'drive' },
  { to: '/settings', key: 'settings', label: '设置', icon: 'settings' },
] as const;

export const NAVIGATION_ROUTES = NAVIGATION_ENTRIES.map(({ to }) => to);

/** Home and library are pinned; settings is always a home-header shortcut. */
export function compactNavItems(bottomNavItems: readonly string[]) {
  const selected = new Set(bottomNavItems);
  return NAVIGATION_ENTRIES.filter(({ to, key }) => to !== '/settings'
    && (to === '/' || to === '/library' || selected.has(key)));
}

export function compactNavHiddenItems(bottomNavItems: readonly string[] = []) {
  const visible = new Set(compactNavItems(bottomNavItems).map(({ to }) => to));
  return NAVIGATION_ENTRIES.filter(({ to }) => to !== '/settings' && !visible.has(to));
}

/** Home owns /home/:id even though its navigation link points to /. */
export function navEntryActive(to: string, isActive: boolean, pathname: string): boolean {
  return isActive || (to === '/' && pathname.startsWith('/home/'));
}

export function navigationOwner(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/home/')) return '/';
  return `/${pathname.split('/')[1] ?? ''}`;
}
