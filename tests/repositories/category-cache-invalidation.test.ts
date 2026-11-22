import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { readRouteCache, resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

/** 分类镜像写（收藏/取消收藏）落库之后必须作废两类快照：收藏夹那条名单、以及
 * 书架（`home:`/`state:`）。只作废其中一半时症状是单向的——移出收藏立刻正确，
 * 加进去却要等下一次手动刷新，因为书架在 PUT 发出之前就已经重读过一次。
 *
 * 失败时一份都不许作废：那一刻服务器上的名单还是旧的，作废只会让界面立刻用
 * 「加之前」的数据重画，看起来像写成功了。 */
const written = { ok: true, value: { operation: 'add', success: 1 } } as const;
const rejected = { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '服务器没回应', retryable: true } } as const;

function seed() {
  writeRouteCache('favorites:s', ['a']);
  writeRouteCache('home:s', ['a']);
  writeRouteCache('state:s', { ready: true });
}

function expectDropped() {
  expect(readRouteCache('favorites:s')).toBeUndefined();
  expect(readRouteCache('home:s')).toBeUndefined();
  expect(readRouteCache('state:s')).toBeUndefined();
}

function expectKept() {
  expect(readRouteCache('favorites:s')).toEqual(['a']);
  expect(readRouteCache('home:s')).toEqual(['a']);
  expect(readRouteCache('state:s')).toEqual({ ready: true });
}

beforeEach(() => {
  resetRouteCacheForTests();
});

afterEach(() => {
  resetInvokeAdapterForTests();
  resetRouteCacheForTests();
  vi.restoreAllMocks();
});

describe('category mirror invalidation', () => {
  it('drops the favorites and shelf snapshots once a favourite lands', async () => {
    seed();
    setInvokeAdapterForTests(async () => written);
    const result = await new NativeLibraryRepository().addArchiveToCategory('s', 'c', 'a');
    expect(result.ok).toBe(true);
    expectDropped();
  });

  it('drops the same three after a removal', async () => {
    seed();
    setInvokeAdapterForTests(async () => written);
    const result = await new NativeLibraryRepository().removeArchiveFromCategory('s', 'c', 'a');
    expect(result.ok).toBe(true);
    expectDropped();
  });

  it('keeps every snapshot when the write is refused', async () => {
    seed();
    setInvokeAdapterForTests(async () => rejected);
    const result = await new NativeLibraryRepository().addArchiveToCategory('s', 'c', 'a');
    expect(result.ok).toBe(false);
    expectKept();
  });

  it('leaves the favourites snapshot alone when only metadata is written', async () => {
    seed();
    setInvokeAdapterForTests(async () => written);
    await new NativeLibraryRepository().updateArchiveMetadata('s', 'a', { title: 'x' });
    expect(readRouteCache('favorites:s')).toEqual(['a']);
    expect(readRouteCache('home:s')).toBeUndefined();
    expect(readRouteCache('state:s')).toBeUndefined();
  });
});
