export interface LegacyImport {
  history: Array<{ archiveId: string; pageIndex: number }>;
  watchlist: Array<{ archiveId: string; deleted: boolean }>;
  dedupe: Array<{ path: string; hash: string }>;
}

export function parseLegacyExport(serialized: string): LegacyImport {
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { throw new Error('Invalid legacy export'); }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid legacy export');
  const value = raw as Record<string, unknown>;
  const history = parseArray(value.history, (item) => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    return typeof record.archiveId === 'string' && typeof record.pageIndex === 'number' && Number.isInteger(record.pageIndex) && record.pageIndex >= 0
      ? { archiveId: record.archiveId, pageIndex: record.pageIndex } : null;
  });
  const watchlist = parseArray(value.watchlist, (item) => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    return typeof record.archiveId === 'string' && typeof record.deleted === 'boolean'
      ? { archiveId: record.archiveId, deleted: record.deleted } : null;
  });
  const dedupe = parseArray(value.nonDuplicate ?? value.dedupe, (item) => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    return typeof record.path === 'string' && typeof record.hash === 'string' && record.path.length > 0 && record.hash.length > 0
      ? { path: record.path, hash: record.hash } : null;
  });
  return { history, watchlist, dedupe };
}

function parseArray<T>(value: unknown, parser: (item: unknown) => T | null): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid legacy export');
  const result: T[] = [];
  for (const item of value) { const parsed = parser(item); if (!parsed) throw new Error('Invalid legacy export'); result.push(parsed); }
  return result;
}
