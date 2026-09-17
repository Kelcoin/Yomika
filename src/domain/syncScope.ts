/** 同步范围：账户上勾了哪几类，同步就只推拉哪几类。
 *
 * 这是 Rust 侧 `SYNC_SCOPE_CATEGORIES` 的镜像，顺序即界面顺序。前五项是历史数据面，
 * 默认勾选；后三项带着服务器地址、E-H 账号名与应用偏好，默认不勾——是否让它们上
 * 远端该由使用者自己决定。 */
export const SYNC_SCOPE_CATEGORIES = [
  { id: 'progress', label: '阅读进度' },
  { id: 'history', label: '历史' },
  { id: 'watchlist', label: '待看' },
  { id: 'search_presets', label: '搜索预设' },
  { id: 'dedup', label: '非重复标记' },
  { id: 'lrr_servers', label: 'LRR 服务器' },
  { id: 'eh_account', label: 'E-H 账户' },
  { id: 'app_settings', label: '应用设置' },
] as const;

export type SyncScopeCategory = (typeof SYNC_SCOPE_CATEGORIES)[number]['id'];

export const DEFAULT_SYNC_SCOPE: readonly SyncScopeCategory[] = [
  'progress',
  'history',
  'watchlist',
  'search_presets',
  'dedup',
];

const KNOWN = new Set<string>(SYNC_SCOPE_CATEGORIES.map((entry) => entry.id));

/** 账户里存的是类别数组的 JSON（空值＝默认集合，旧账户的列是空串）。 */
export function parseSyncScope(value: string | undefined): SyncScopeCategory[] {
  if (!value) return [...DEFAULT_SYNC_SCOPE];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_SYNC_SCOPE];
    const known = parsed.filter((item): item is SyncScopeCategory => typeof item === 'string' && KNOWN.has(item));
    return known.length > 0 ? known : [...DEFAULT_SYNC_SCOPE];
  } catch {
    return [...DEFAULT_SYNC_SCOPE];
  }
}

export function scopeLabel(scope: readonly SyncScopeCategory[]): string {
  if (scope.length === SYNC_SCOPE_CATEGORIES.length) return '全部数据';
  const labels = SYNC_SCOPE_CATEGORIES.filter((entry) => scope.includes(entry.id)).map((entry) => entry.label);
  return labels.length > 0 ? labels.join('、') : '不同步任何数据';
}

/** 账户行的副标题：勾了几类、都是哪几类。 */
export function scopeSummary(value: string | undefined): string {
  const scope = parseSyncScope(value);
  return `同步：${scopeLabel(scope)}`;
}

