import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

const watchlistRecord = (added: boolean) => ({
  scopeId: 's',
  archiveId: 'a',
  addedAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
  deviceId: 'd',
  deletedAt: null,
  revision: 1,
  deleted: !added,
});

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

/** 写入命令改到 tokio 线程池上跑之后，「先发的先落库」不再由 UI 线程保证。写入的是
 * 绝对值（收藏、待看是 `added`，进度是页码），所以同一个键上的两次派发必须自己排好序，
 * 否则连点两次会倒着落库：界面上是取消收藏，库里还留着那一行。 */
describe('repository write ordering', () => {
  it('does not dispatch a second write for the same key before the first lands', async () => {
    const dispatched: string[] = [];
    let releaseFirst!: () => void;
    const firstLanded = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let call = 0;
    setInvokeAdapterForTests(async (command: string, args) => {
      call += 1;
      dispatched.push(`${command}:${(args as { added?: boolean } | undefined)?.added}`);
      if (call === 1) await firstLanded;
      return { ok: true, value: watchlistRecord(true) };
    });

    const repository = new NativeLibraryRepository();
    const first = repository.setWatchlist('s', 'a', true);
    const second = repository.setWatchlist('s', 'a', false);

    // 第一条还在路上：第二条**一个字节都不该发出去**。
    await Promise.resolve();
    expect(dispatched).toEqual(['set_watchlist:true']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(dispatched).toEqual(['set_watchlist:true', 'set_watchlist:false']);
  });

  it('lets a different archive write through immediately', async () => {
    // 串行只发生在同一个键上：串住整张表就等于把并发又收回去了。
    const dispatched: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    setInvokeAdapterForTests(async (command: string, args) => {
      dispatched.push(`${command}:${(args as { archiveId?: string } | undefined)?.archiveId}`);
      if (dispatched.length === 1) await gate;
      return { ok: true, value: watchlistRecord(true) };
    });

    const repository = new NativeLibraryRepository();
    const first = repository.setWatchlist('s', 'a', true);
    const other = repository.setWatchlist('s', 'b', true);
    await other;
    expect(dispatched).toEqual(['set_watchlist:a', 'set_watchlist:b']);
    releaseFirst();
    await first;
  });

  it('keeps running the queue when a write fails', async () => {
    // 前一次没写成（桥断了、响应读不出来）不该把后一次一起吞掉：桥把失败包成
    // `{ ok: false }`，所以链上看到的是一次「成功返回的失败」，第二次仍要发出去。
    const dispatched: boolean[] = [];
    setInvokeAdapterForTests(async (_command: string, args) => {
      const added = (args as { added?: boolean }).added;
      dispatched.push(added === true);
      return added === true
        ? { ok: false, error: { code: 'UNKNOWN', message: 'bridge down', retryable: true } }
        : { ok: true, value: watchlistRecord(false) };
    });
    const repository = new NativeLibraryRepository();
    const failed = await repository.setReadingList('s', 'a', true);
    expect(failed.ok).toBe(false);
    const recovered = await repository.setReadingList('s', 'a', false);
    expect(recovered.ok).toBe(true);
    expect(dispatched).toEqual([true, false]);
  });

  it('serialises reading progress per archive and keeps reads behind the writes', async () => {
    const order: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      const progress = (args as { progress?: { pageIndex: number } } | undefined)?.progress;
      order.push(progress ? String(progress.pageIndex) : command);
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: true, value: { scopeId: 's', archiveId: 'a', pageIndex: 0, pageCount: 10, layout: 'paged', direction: 'ltr', updatedAt: '2026-09-30T00:00:00Z', revision: 1 } };
    });
    const repository = new NativeLibraryRepository();
    const base = { scopeId: 's', archiveId: 'a', pageCount: 10, layout: 'paged' as const, direction: 'ltr' as const };
    const writes = [1, 2, 3].map((pageIndex) => repository.saveProgress({ ...base, pageIndex }));
    // 读进度要等在路上的写落定，否则「继续阅读」会读到上一页。
    await repository.loadProgress('s', 'a');
    await Promise.all(writes);
    expect(order).toEqual(['1', '2', '3', 'load_reading_progress']);
  });
});
