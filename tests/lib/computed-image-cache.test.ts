import { describe, expect, it, vi } from 'vitest';

import { ComputedImageCache } from '../../src/lib/computedImageCache';

function makeCache(options: { maxDecodedBytes?: number } = {}) {
  // 参数类型要写出来：`vi.fn(async () => undefined)` 的 `mock.calls` 是空元组，
  // 于是 `call[0]` 在类型上不存在（TS2493），断言读不到「还回去的是哪个租借号」。
  const releaseLease = vi.fn<(leaseId: string) => Promise<void>>(async () => undefined);
  const revokeObjectURL = vi.fn<(url: string) => void>();
  const cache = new ComputedImageCache({
    releaseLease,
    revokeObjectURL,
    ...(options.maxDecodedBytes === undefined ? {} : { maxDecodedBytes: options.maxDecodedBytes }),
  });
  return { cache, releaseLease, revokeObjectURL };
}

const lease = (leaseId: string, url: string, estimatedDecodedBytes = 1024) => ({
  kind: 'lease' as const,
  leaseId,
  url,
  estimatedDecodedBytes,
});

describe('computed image cache', () => {
  it('hands a lease back to the host instead of revoking its url', () => {
    const { cache, releaseLease, revokeObjectURL } = makeCache();
    const handle = cache.adopt('page-1', lease('a'.repeat(32), `yomika-image://asset/${'a'.repeat(32)}`));

    cache.release(handle);

    // 租借的 url 是宿主 scheme，`revokeObjectURL` 对它毫无意义：真正要做的是把
    // host 侧的 pin 还掉（§7.4：不能在内存 Map 里删掉就算完）。
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledWith('a'.repeat(32));
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes a blob url instead of pretending it was a lease', () => {
    const { cache, releaseLease, revokeObjectURL } = makeCache();
    const handle = cache.adopt('cover-1', { kind: 'blob', url: 'blob:test-1', bytes: 4096 });

    expect(cache.peekUrl('cover-1')).toBe('blob:test-1');
    cache.release(handle);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1');
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it('two consumers of one page share a single host lease', () => {
    const { cache, releaseLease } = makeCache();
    const first = cache.adopt('page-1', lease('b'.repeat(32), 'yomika-image://asset/x'));
    const second = cache.adopt('page-1', lease('b'.repeat(32), 'yomika-image://asset/x'));

    expect(second).toEqual(first);
    cache.release(first);
    // 还有人在看这一页：host 侧的 pin 一个都不能还。
    expect(releaseLease).not.toHaveBeenCalled();
    expect(cache.peekUrl('page-1')).toBe('yomika-image://asset/x');

    cache.release(second);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(cache.peekUrl('page-1')).toBeUndefined();
  });

  it('never releases the same lease twice', () => {
    const { cache, releaseLease } = makeCache();
    const handle = cache.adopt('page-1', lease('c'.repeat(32), 'yomika-image://asset/y'));

    cache.release(handle);
    cache.release(handle);
    cache.release(handle);

    // 卸载路径与错误路径会重叠（React 的清理 + 取图失败），重复释放必须是无操作的：
    // 多还一次会把别人手上的 pin 一起还掉。
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous page alive until the new one is adopted', () => {
    const { cache, releaseLease } = makeCache();
    const previous = cache.adopt('page-1', lease('d'.repeat(32), 'yomika-image://asset/old'));

    const next = cache.adopt('page-2', lease('e'.repeat(32), 'yomika-image://asset/new'));
    // 新一页还没解好之前，旧那一页必须仍然在表里、仍然有 pin。
    expect(cache.peekUrl('page-1')).toBe('yomika-image://asset/old');
    expect(releaseLease).not.toHaveBeenCalled();

    cache.release(previous);
    expect(releaseLease).toHaveBeenCalledWith('d'.repeat(32));
    expect(cache.peekUrl('page-2')).toBe('yomika-image://asset/new');
    expect(next.leaseId).toBe('e'.repeat(32));
  });

  it('releases every live entry when the reader closes', () => {
    const { cache, releaseLease, revokeObjectURL } = makeCache();
    cache.adopt('page-1', lease('f'.repeat(32), 'yomika-image://asset/1'));
    cache.adopt('page-2', lease('g'.repeat(32), 'yomika-image://asset/2'));
    cache.adopt('cover-1', { kind: 'blob', url: 'blob:test-2', bytes: 2048 });

    cache.dispose();

    expect(releaseLease.mock.calls.map((call) => call[0]).sort()).toEqual(['f'.repeat(32), 'g'.repeat(32)]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-2');
    expect(cache.peekUrl('page-1')).toBeUndefined();
  });

  it('counts the decoded budget rather than the compressed bytes', () => {
    const { cache } = makeCache();
    cache.adopt('page-1', lease('h'.repeat(32), 'yomika-image://asset/1', 12_582_912));
    cache.adopt('page-2', lease('i'.repeat(32), 'yomika-image://asset/2', 3_145_728));

    expect(cache.decodedBytes()).toBe(15_728_640);
    expect(cache.size()).toBe(2);
  });

  it('refuses to hold more decoded pixels than its budget', () => {
    // 预算管的是「同时留着几张」：超过上限时**拒绝新的**而不是偷偷丢掉正在显示的
    // 那一张（§9.3：最多留可见 + 邻页，谁该被丢由阅读器说了算，不是缓存背后删）。
    const { cache, releaseLease } = makeCache({ maxDecodedBytes: 4_194_304 });
    cache.adopt('page-1', lease('j'.repeat(32), 'yomika-image://asset/1', 3_145_728));

    expect(() => cache.adopt('page-2', lease('k'.repeat(32), 'yomika-image://asset/2', 3_145_728)))
      .toThrowError(/预算/);
    // 被拒绝的那张租借还没被拿走（命令层刚建的），调用方要自己还——这里不该由缓存代还。
    expect(releaseLease).not.toHaveBeenCalled();
    expect(cache.peekUrl('page-1')).toBe('yomika-image://asset/1');
  });

  it('returns the redundant lease when concurrent acquisitions adopt the same content', () => {
    const { cache, releaseLease } = makeCache();
    const a = cache.adopt('same-content', lease('a'.repeat(32), 'yomika-image://asset/a', 4096));
    const b = cache.adopt('same-content', lease('b'.repeat(32), 'yomika-image://asset/b', 4096));
    expect(b.url).toBe(a.url);
    expect(releaseLease).toHaveBeenCalledWith('b'.repeat(32));
    cache.release(a);
    expect(releaseLease).not.toHaveBeenCalledWith('a'.repeat(32));
    cache.release(b);
    expect(releaseLease).toHaveBeenCalledWith('a'.repeat(32));
    expect(releaseLease).toHaveBeenCalledTimes(2);
  });


  it('does not let a disposed handle release a new entry that reused the same key', () => {
    const { cache, releaseLease } = makeCache();
    const old = cache.adopt('reused', lease('a'.repeat(32), 'yomika-image://asset/old', 4096));
    cache.dispose();
    const fresh = cache.adopt('reused', lease('b'.repeat(32), 'yomika-image://asset/new', 8192));
    cache.release(old);
    expect(cache.peekUrl('reused')).toBe(fresh.url);
    expect(cache.decodedBytes()).toBe(8192);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    cache.release(fresh);
    expect(cache.decodedBytes()).toBe(0);
    expect(releaseLease).toHaveBeenCalledTimes(2);
  });

});
