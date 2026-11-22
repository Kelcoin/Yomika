import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { pickServer } from '../domain/server';
import { readRouteCache, writeRouteCache } from '../lib/routeCache';
import type { ReadingHistoryRecord, WatchlistRecord } from '../domain/library';

const repository = new NativeLibraryRepository();
const pending = new Map<string, Promise<unknown>>();
let generation = 0;
if (typeof window !== 'undefined') window.addEventListener('yomika:route-cache-invalidated', () => {
  generation++;
  pending.clear();
});

/** Only in-flight reads are shared: mutations invalidate both requests and snapshots. */
export function shelfRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const request = load();
  pending.set(key, request);
  const clear = () => { if (pending.get(key) === request) pending.delete(key); };
  void request.then(clear, clear);
  return request;
}

/** Small complete shelves only. No per-archive remote metadata, covers or existence probes.
 * The default server is resolved afresh per task; invalidations cancel publication. */
export async function warmShelfSnapshot(name: 'history' | 'toRead' | 'watchlist', canRun: () => boolean): Promise<void> {
  const key = `state:${name}:default`;
  if (!canRun() || readRouteCache(key, Infinity)) return;
  const started = generation;
  const valid = () => canRun() && started === generation;
  const servers = await shelfRead('servers', () => repository.listServers());
  if (!valid() || !servers.ok) return;
  const server = pickServer(servers.value, null);
  if (!server) return;
  const shelf = await (name === 'history'
    ? shelfRead(`history:${server.scopeId}`, () => repository.listHistory(server.scopeId))
    : name === 'toRead'
      ? shelfRead(`toRead:${server.scopeId}`, () => repository.listReadingList(server.scopeId))
      : shelfRead(`favorites:${server.id}`, () => repository.readFavoritesCategory(server.id)));
  if (!valid() || !shelf.ok) return;
  const history = name === 'history' ? shelf.value as ReadingHistoryRecord[] : [];
  const watchlist = name === 'toRead' ? shelf.value as WatchlistRecord[] : [];
  const favoriteIds = name === 'watchlist' ? (shelf.value as { archives: string[] } | null)?.archives ?? [] : [];
  const ids = [...new Set(name === 'history' ? history.map(item => item.archiveId)
    : name === 'toRead' ? watchlist.filter(item => !item.deleted).map(item => item.archiveId) : favoriteIds)];
  // Do not publish a truncated shelf or fan out remote metadata for absent mirror rows.
  if (ids.length > 60) return;
  const archives = await shelfRead(`archives:mirror:${server.id}:${JSON.stringify(ids)}`, () => repository.listArchivesByIds(server.id, ids, { resolveMissing: false }));
  if (!valid() || !archives.ok || archives.value.some(item => item.serverId !== server.id)
    || ids.some(id => !archives.value.some(item => item.archiveId === id))) return;
  const snapshot = { history, watchlist: name === 'watchlist' ? favoriteIds.map(archiveId => ({
    scopeId: server.scopeId, archiveId, addedAt: '', deleted: false, deviceId: '', updatedAt: '', revision: 1,
  })) : watchlist, archives: archives.value.filter(item => ids.includes(item.archiveId)),
    serverId: server.id, scopeId: server.scopeId, query: '',
    ...(name !== 'watchlist' ? { needsForegroundVerification: true } : {}),
    ...(name === 'watchlist' ? { favoritesSource: 'remote', favoritesCategoryPresent: shelf.value !== null } : {}),
  };
  writeRouteCache(key, snapshot, { persist: name !== 'watchlist' });
  if (name === 'watchlist') {
    writeRouteCache(`favorites:last:${server.id}`, snapshot, { persist: true });
    if (server.id !== 'default') writeRouteCache('favorites:last:default', snapshot);
  }
}
