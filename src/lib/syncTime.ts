/** 「上次同步」怎么念。
 *
 * 原生侧的时间戳是 SQLite 的 UTC 串（`YYYY-MM-DD HH:MM:SS`，没有 `Z`），直接交给
 * `Date` 会被当成本地时间——这里补上 `Z` 再解析，和 DeduplicationWorkspace 的读法一致。
 */
export function parseSyncTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const millis = Date.parse(normalized);
  return Number.isNaN(millis) ? undefined : millis;
}

export function formatSyncAge(value: string | null | undefined, now = Date.now()): string {
  const at = parseSyncTimestamp(value);
  if (at === undefined) return '还没同步过';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚同步';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前同步`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前同步`;
  const days = Math.round(hours / 24);
  return `${days} 天前同步`;
}
