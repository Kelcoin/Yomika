/** 一页在路由缓存里的键：详情与列表同属一页（见 src/app/routes.tsx 的 RetainedPage），
 * 编辑器是临时去处、各自一页。返回手势要靠它找到「上一层」那一块已经挂着的页面。 */
export const PAGE_KEYS: Record<string, string> = {
  home: '/',
  library: '/library',
  history: '/history',
  watchlist: '/watchlist',
  'to-read': '/to-read',
};

export function pageKeyFor(path: string): string {
  if (path.endsWith('/edit')) return path;
  return PAGE_KEYS[path.split('/')[1] ?? ''] ?? path;
}
