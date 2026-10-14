import { afterEach, expect, it, vi } from 'vitest';
import { warmShelfSnapshot, shelfRead } from '../../src/app/shelfWarmup';
import { readRouteCache, invalidateRouteCache } from '../../src/lib/routeCache';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => { resetInvokeAdapterForTests(); invalidateRouteCache(); });
const member = (archiveId: string) => ({ scopeId: 'scope', archiveId, addedAt: '2026-01-01', updatedAt: '2026-01-01', deviceId: 'device', revision: 1, deleted: false });
const archive = { serverId: 's', archiveId: 'a', title: 'Warmed', pageCount: 4, updatedAt: '2026-01-01' };
const server = { id: 's', scopeId: 'scope', name: 'Home', baseUrl: 'https://example.com' };
it('prepares a complete reusable shelf with no covers, metadata, existence or navigation work', async () => {
  const calls: string[] = [];
  setInvokeAdapterForTests(async command => {
    calls.push(command);
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_reading_list') return { ok: true, value: [member('a')] };
    if (command === 'list_archives_by_ids') return { ok: true, value: [archive] };
    if (command === 'list_categories') return { ok: true, value: [] };
    throw Error(command);
  });
  await warmShelfSnapshot('toRead', () => true);
  expect(readRouteCache<{ archives: { title: string }[] }>('state:toRead:default')?.archives[0]?.title).toBe('Warmed');
  expect(calls).toEqual(['list_servers', 'list_reading_list', 'list_archives_by_ids']);
  expect(readRouteCache<{ categories?: unknown; needsForegroundVerification?: boolean }>('state:toRead:default')).toMatchObject({ needsForegroundVerification: true });
  expect(readRouteCache<{ categories?: unknown }>('state:toRead:default')?.categories).toBeUndefined();
});
it('does not publish after invalidation or resolve remote-only favorites in the background', async () => {
  let finish!: (value: unknown) => void;
  setInvokeAdapterForTests(async command => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'read_favorites_category') return { ok: true, value: { id: 'fav', archives: ['missing'] } };
    if (command === 'list_archives_by_ids') return new Promise(resolve => { finish = resolve; });
    throw Error(command);
  });
  const warming = warmShelfSnapshot('watchlist', () => true);
  await vi.waitFor(() => expect(finish).toBeDefined());
  invalidateRouteCache();
  finish({ ok: true, value: [] });
  await warming;
  expect(readRouteCache('favorites:last:s')).toBeUndefined();
  expect(readRouteCache('state:watchlist:default')).toBeUndefined();
});
it.each(['invalidation', 'navigation', 'unmount'])('discards an otherwise complete in-flight snapshot after %s', async reason => {
  let finish!: (value: unknown) => void;
  let allowed = true;
  setInvokeAdapterForTests(async command => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_reading_list') return { ok: true, value: [member('a')] };
    if (command === 'list_archives_by_ids') return new Promise(resolve => { finish = resolve; });
    throw Error(`must not start ${command}`);
  });
  const warming = warmShelfSnapshot('toRead', () => allowed);
  await vi.waitFor(() => expect(finish).toBeDefined());
  if (reason === 'invalidation') invalidateRouteCache();
  else allowed = false;
  finish({ ok: true, value: [archive] });
  await warming;
  expect(readRouteCache('state:toRead:default')).toBeUndefined();
});
it('skips large and foreground shelves before resolving archives', async () => {
  const calls: string[] = [];
  setInvokeAdapterForTests(async command => {
    calls.push(command);
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_reading_list') return { ok: true, value: Array.from({ length: 61 }, (_, i) => member(String(i))) };
    throw Error(command);
  });
  await warmShelfSnapshot('toRead', () => false);
  expect(calls).toEqual([]);
  await warmShelfSnapshot('toRead', () => true);
  expect(calls).toEqual(['list_servers', 'list_reading_list']);
  expect(readRouteCache('state:toRead:default')).toBeUndefined();
});
it('merges matching foreground reads while pending', async () => {
  let finish!: (value: number) => void;
  let count = 0;
  const load = () => { count++; return new Promise<number>(resolve => { finish = resolve; }); };
  const background = shelfRead('coalesced', load);
  const foreground = shelfRead('coalesced', load);
  finish(7);
  expect(await background).toBe(7);
  expect(await foreground).toBe(7);
  expect(count).toBe(1);
});
