/** 同步范围：账户上勾了哪几类，同步就只推拉哪几类。
 *
 * 这是 Rust 侧 `SYNC_SCOPE_CATEGORIES` 的镜像，顺序即界面顺序。六类都是记录与设置，
 * 默认全勾——**凭据不在这张表里**：服务器条目、E-H 账户与 API Key/Cookie/同步口令
 * 只在本机，由「导入导出范围」单独管（见 domain/dataTransferScope），同步永远不带
 * 它们。
 *
 * `watchlist` 这个 id 是「待看」（本地 reading_list 表），不是本地那张 watchlist 表
 * （收藏夹）——待看先占了这个词，改名字会让老账户里存着的范围少一项，所以留着。
 * 收藏夹不在表里：它镜像的是服务器上的收藏分类，服务器才是它的真相来源，本机这份
 * 只是镜像的落点，既不进同步也不进导入导出。
 */
export const SYNC_SCOPE_CATEGORIES = [
  { id: 'progress', label: '阅读进度' },
  { id: 'history', label: '历史' },
  { id: 'watchlist', label: '待看' },
  { id: 'search_presets', label: '搜索预设' },
  { id: 'dedup', label: '非重复标记' },
  { id: 'app_settings', label: '应用设置' },
] as const;

export type SyncScopeCategory = (typeof SYNC_SCOPE_CATEGORIES)[number]['id'];

/** 能勾的那些：默认集合与「全部数据」都按它算。表里没有不可勾的类别，留这个名字是
 * 为了让调用方读起来仍然是「可选集合」。 */
export const SELECTABLE_SYNC_SCOPE: readonly SyncScopeCategory[] =
  SYNC_SCOPE_CATEGORIES.map((entry) => entry.id);

/** 默认全勾：记录与设置都同步。 */
export const DEFAULT_SYNC_SCOPE: readonly SyncScopeCategory[] = [...SELECTABLE_SYNC_SCOPE];

const KNOWN = new Set<string>(SELECTABLE_SYNC_SCOPE);

/** 账户里存的是类别数组的 JSON（空值＝默认集合，旧账户的列是空串）。属于凭据的旧
 * 类别 id 也在这里被丢掉：它们不再是可选项。 */
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
  if (SELECTABLE_SYNC_SCOPE.every((id) => scope.includes(id))) return '全部数据';
  const labels = SYNC_SCOPE_CATEGORIES.filter((entry) => scope.includes(entry.id)).map((entry) => entry.label);
  return labels.length > 0 ? labels.join('、') : '不同步任何数据';
}

/** 账户行的副标题：勾了几类、都是哪几类。 */
export function scopeSummary(value: string | undefined): string {
  const scope = parseSyncScope(value);
  return `同步：${scopeLabel(scope)}`;
}
