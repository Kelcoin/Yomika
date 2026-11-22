import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  invalidateRouteCache,
  readRouteCache,
  resetRouteCacheForTests,
  routeCacheAge,
  routeCacheBytesForTests,
  simulateRouteCacheRestartForTests,
  writeRouteCache,
} from '../../src/lib/routeCache';

/** 落盘副本所在的那个 localStorage 键，测试直接检查它。 */
const PERSIST_KEY = 'yomika.route-cache.v1';

describe('route cache', () => {
  beforeEach(() => {
    resetRouteCacheForTests();
    // 先删掉磁盘副本，再走一次「重启」：内存与模块里那份落盘镜像一起回到干净状态。
    window.localStorage.removeItem(PERSIST_KEY);
    simulateRouteCacheRestartForTests();
  });

  it('returns a written snapshot and forgets an aged one', () => {
    resetRouteCacheForTests();
    writeRouteCache('library:workspace', { archives: ['a1'] });

    expect(readRouteCache<{ archives: string[] }>('library:workspace')?.archives).toEqual(['a1']);

    // Snapshots exist to avoid an empty first render, not to serve stale data
    // forever.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
    expect(readRouteCache('library:workspace')).toBeUndefined();
    vi.restoreAllMocks();

    expect(readRouteCache('never:written')).toBeUndefined();
  });

  it('keeps a bounded number of snapshots, dropping the oldest first', () => {
    resetRouteCacheForTests();
    // A detail snapshot is written per archive visited (three keys each), plus one
    // per recommendation page: without a bound this map grows with the library.
    for (let index = 0; index < 500; index += 1) writeRouteCache(`archive-detail:server:${index}`, { title: `archive ${index}` });

    expect(readRouteCache('archive-detail:server:0')).toBeUndefined();
    expect(readRouteCache('archive-detail:server:499')).toEqual({ title: 'archive 499' });
  });

  it('keeps a bounded number of bytes, not just a bounded number of snapshots', () => {
    resetRouteCacheForTests();
    // One library snapshot is a page of records and can be huge, so an entry cap
    // alone is not a bound. The count here is deliberately below the entry cap:
    // only a byte budget can evict under it.
    const heavy = { archives: 'x'.repeat(1_000_000) };
    for (let index = 0; index < 24; index += 1) writeRouteCache(`library:${index}`, heavy);

    // 24 entries of about 2MB each: the retained total has to come back under
    // the budget rather than sitting at the ~48MB that were written.
    expect(routeCacheBytesForTests()).toBeLessThan(24 * 2_000_000);
    expect(readRouteCache('library:0')).toBeUndefined();
    expect(readRouteCache('library:23')).toEqual(heavy);
  });

  it('invalidates by prefix and wholesale', () => {
    resetRouteCacheForTests();
    writeRouteCache('library:workspace', 1);
    writeRouteCache('detail:a1', 2);
    writeRouteCache('detail:a2', 3);

    invalidateRouteCache('detail:');
    expect(readRouteCache('library:workspace')).toBe(1);
    expect(readRouteCache('detail:a1')).toBeUndefined();
    expect(readRouteCache('detail:a2')).toBeUndefined();

    invalidateRouteCache();
    expect(readRouteCache('library:workspace')).toBeUndefined();
  });

  it('keeps a plain write in memory only', () => {
    // 默认行为不能变：不传 persist 的写入今天是一份纯内存快照，明天也一样。
    writeRouteCache('library:workspace', { archives: ['a1'] });

    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();

    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:workspace', Infinity)).toBeUndefined();
  });

  it('survives a restart with the write time it was given, not the hydrate time', () => {
    const writtenAt = Date.now();
    writeRouteCache('library:workspace:default', { archives: ['a1'] }, { persist: true });
    expect(window.localStorage.getItem(PERSIST_KEY)).not.toBeNull();

    simulateRouteCacheRestartForTests();

    expect(readRouteCache('library:workspace:default', Infinity)).toEqual({ archives: ['a1'] });
    expect(routeCacheAge('library:workspace:default')).toBeLessThan(1000);

    // TTL 语义跨重启成立：at 还是写入那一刻，而不是刚才 hydrate 的时刻。
    vi.spyOn(Date, 'now').mockReturnValue(writtenAt + 11 * 60 * 1000);
    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:workspace:default')).toBeUndefined();
    // 已经判定过期的副本不该在下次启动时复活。
    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:workspace:default', Infinity)).toBeUndefined();
  });

  it('drops persisted copies on a prefix invalidation and on a full one', () => {
    writeRouteCache('home:shelves', { servers: [] }, { persist: true });
    writeRouteCache('library:workspace:default', { archives: ['a1'] }, { persist: true });

    invalidateRouteCache('home:');
    simulateRouteCacheRestartForTests();
    expect(readRouteCache('home:shelves', Infinity)).toBeUndefined();
    expect(readRouteCache('library:workspace:default', Infinity)).toEqual({ archives: ['a1'] });

    invalidateRouteCache();
    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:workspace:default', Infinity)).toBeUndefined();
    // 无参全清之后，磁盘上连一个空壳都不该留下。
    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
  });

  it('silently discards a corrupt or malformed persisted payload', () => {
    window.localStorage.setItem(PERSIST_KEY, '{oops');
    expect(() => simulateRouteCacheRestartForTests()).not.toThrow();
    expect(readRouteCache('library:workspace:default', Infinity)).toBeUndefined();

    // 结构对不上（值不是 entry）同样只能被丢掉，不能把 undefined 灌进内存。
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify({ 'library:workspace:default': 42, 'home:shelves': { at: 'nope', size: 1, value: {} } }));
    expect(() => simulateRouteCacheRestartForTests()).not.toThrow();
    expect(readRouteCache('library:workspace:default', Infinity)).toBeUndefined();
    expect(readRouteCache('home:shelves', Infinity)).toBeUndefined();
  });

  it('never puts a single oversized snapshot on disk', () => {
    // 一条 6MB 的快照在内存那一档（8MiB）里装得下，但落盘的每一条上限是 2MiB：
    // localStorage 是同步 API，几 MB 的一条 JSON 串行化不该发生在启动路径上。
    const heavy = { archives: 'x'.repeat(3_000_000) };
    writeRouteCache('library:huge', heavy, { persist: true });

    expect(window.localStorage.getItem(PERSIST_KEY)).toBeNull();
    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:huge', Infinity)).toBeUndefined();
  });

  it('evicts the oldest persisted snapshots, first by count then by bytes', () => {
    // 条数：落盘上限 8 条，比内存那 64 条小——启动时要同步解析的是这份 JSON。
    for (let index = 0; index < 12; index += 1) writeRouteCache(`archive-detail:${index}`, { title: `archive ${index}` }, { persist: true });
    expect(readPersistedKeys()).toEqual([
      'archive-detail:4', 'archive-detail:5', 'archive-detail:6', 'archive-detail:7',
      'archive-detail:8', 'archive-detail:9', 'archive-detail:10', 'archive-detail:11',
    ]);

    // 字节：每条约 1MB，8 条就是 8MB，超过落盘的 4MiB 总预算，最旧的先走。
    invalidateRouteCache();
    const heavy = { archives: 'x'.repeat(500_000) };
    for (let index = 0; index < 8; index += 1) writeRouteCache(`library:page:${index}`, heavy, { persist: true });
    const keys = readPersistedKeys();
    expect(keys.length).toBeLessThan(8);
    expect(keys).toContain('library:page:7');
    expect(keys).not.toContain('library:page:0');

    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:page:0', Infinity)).toBeUndefined();
    expect(readRouteCache('library:page:7', Infinity)).toEqual(heavy);
  });

  it('degrades to memory when the storage refuses a write', () => {
    writeRouteCache('library:workspace:default', { archives: ['kept'] }, { persist: true });
    const onDisk = window.localStorage.getItem(PERSIST_KEY);

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => writeRouteCache('library:other', { archives: ['new'] }, { persist: true })).not.toThrow();
    setItem.mockRestore();

    // 写失败不能把上一次成功落盘的副本抹掉，也不能把异常抛给调用方。
    expect(window.localStorage.getItem(PERSIST_KEY)).toBe(onDisk);
    expect(readRouteCache('library:other', Infinity)).toEqual({ archives: ['new'] });

    simulateRouteCacheRestartForTests();
    expect(readRouteCache('library:other', Infinity)).toBeUndefined();
    expect(readRouteCache('library:workspace:default', Infinity)).toEqual({ archives: ['kept'] });
  });

  // 启动那一刻能不能读到，取决于「import 这个模块」本身就把副本灌回内存；
  // 只测 simulateRouteCacheRestartForTests() 测不到这条时间线。
  it('hydrates while the module is being evaluated', async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({ 'library:workspace:default': { at: Date.now(), size: 24, value: { archives: ['boot'] } } }),
    );

    vi.resetModules();
    const fresh = await import('../../src/lib/routeCache');

    expect(fresh.readRouteCache('library:workspace:default', Infinity)).toEqual({ archives: ['boot'] });
    fresh.resetRouteCacheForTests();
    window.localStorage.removeItem(PERSIST_KEY);
  });
});

function readPersistedKeys(): string[] {
  const raw = window.localStorage.getItem(PERSIST_KEY);
  return raw ? Object.keys(JSON.parse(raw) as Record<string, unknown>) : [];
}


it('uses persistent snapshots after memory eviction and protects reads from the next disk eviction', () => {
  invalidateRouteCache();
  writeRouteCache('disk:hot', { id: 'hot' }, { persist: true });
  for (let index = 0; index < 7; index += 1) writeRouteCache(`disk:${index}`, index, { persist: true });
  for (let index = 0; index < 65; index += 1) writeRouteCache(`memory:${index}`, index);
  expect(readRouteCache('disk:hot', Infinity)).toEqual({ id: 'hot' });
  writeRouteCache('disk:new', 8, { persist: true });
  simulateRouteCacheRestartForTests();
  expect(readRouteCache('disk:hot', Infinity)).toEqual({ id: 'hot' });
  expect(readRouteCache('disk:0', Infinity)).toBeUndefined();
  invalidateRouteCache();
});
