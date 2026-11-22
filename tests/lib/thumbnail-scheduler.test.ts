import { describe, expect, it, vi } from 'vitest';

import { ThumbnailScheduler, type ThumbnailRange } from '../../src/lib/thumbnailScheduler';

/** A loader whose answers land when the test says so. */
function controlled() {
  const pending = new Map<number, { resolve: (url: string | undefined) => void; reject: (error: Error) => void }>();
  const requests: number[] = [];
  const load = vi.fn((index: number) => new Promise<string | undefined>((resolve, reject) => {
    requests.push(index);
    pending.set(index, { resolve, reject });
  }));
  return {
    load,
    requests,
    settle(index: number, url: string | undefined) {
      const entry = pending.get(index);
      if (!entry) throw new Error(`page ${index} was never asked for`);
      pending.delete(index);
      entry.resolve(url);
    },
    fail(index: number) {
      const entry = pending.get(index);
      if (!entry) throw new Error(`page ${index} was never asked for`);
      pending.delete(index);
      entry.reject(new Error('offline'));
    },
    get outstanding() {
      return pending.size;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function range(start: number, end: number, visibleStart = start, visibleEnd = end): ThumbnailRange {
  return { start, end, visibleStart, visibleEnd };
}

describe('thumbnail scheduler', () => {
  it('spends its slots on the rows on screen before the buffer rows', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {} });
    // 300 页、四列、视口只容末行：窗口 288–300，真正看得见的是最后四格。
    scheduler.setRange(range(288, 300, 296, 300));
    await flush();
    // 中心在外，先要的是离看得见那一段最近的页，而不是缓冲行 288。
    expect(loader.requests.slice(0, 4).sort((left, right) => left - right)).toEqual([296, 297, 298, 299]);
    expect(scheduler.outstanding).toBe(4);
  });

  it('frees the slot whether the page comes back empty or rejects', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {}, concurrency: 2 });
    scheduler.setRange(range(0, 6));
    await flush();
    expect(scheduler.outstanding).toBe(2);
    loader.settle(loader.requests[0]!, undefined);
    loader.fail(loader.requests[1]!);
    await flush();
    // 空返回与 reject 都算失败：额度必须回来，否则后面四页永远排在门口。
    expect(scheduler.outstanding).toBe(2);
    expect(loader.requests.length).toBeGreaterThan(2);
  });

  it('asks a page again once the backoff runs out while it stays on screen', async () => {
    const loader = controlled();
    const loaded = vi.fn();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: loaded, concurrency: 1, attempts: 3, backoffMs: 1 });
    scheduler.setRange(range(12, 13, 12, 13));
    await flush();
    expect(loader.requests).toEqual([12]);
    loader.settle(12, undefined);
    // 退避有下限（16ms 一档），不是立刻重打。
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(loader.requests).toEqual([12, 12]);
    loader.settle(12, 'thumb-12');
    await flush();
    expect(loaded).toHaveBeenCalledWith(12, 'thumb-12');
    await new Promise((resolve) => setTimeout(resolve, 40));
    // 拿到了就不再问：成功是终态。
    expect(loader.requests).toEqual([12, 12]);
  });

  it('asks a page again once it leaves the window and comes back', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {}, concurrency: 2, attempts: 3, backoffMs: 4_000 });
    scheduler.setRange(range(12, 13, 12, 13));
    await flush();
    loader.settle(12, undefined);
    await flush();
    // 长退避挡着它：这时候滚到别处，回来才该重来一次。
    scheduler.setRange(range(20, 21, 20, 21));
    await flush();
    expect(loader.requests).toContain(20);
    loader.settle(20, 'thumb-20');
    await flush();
    scheduler.setRange(range(12, 13, 12, 13));
    await flush();
    expect(loader.requests.filter((index) => index === 12)).toHaveLength(2);
  });

  it('stops retrying a permanent failure until the window returns to it', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {}, concurrency: 1, attempts: 2, backoffMs: 1 });
    scheduler.setRange(range(0, 1, 0, 1));
    await flush();
    for (let round = 0; round < 2; round += 1) {
      const before = loader.requests.length;
      loader.fail(loader.requests[before - 1]!);
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (round === 0) expect(loader.requests.length).toBe(before + 1);
    }
    const spent = loader.requests.length;
    // 额度就是 attempts：两轮用尽后一次都不该再多。
    expect(spent).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 次数用尽之后不再自己转：忙循环会把一个永久错误变成每帧一次请求。
    expect(loader.requests.length).toBe(spent);
  });

  it('gives the slots that free up to the newest window after a fast scroll', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {}, concurrency: 4 });
    scheduler.setRange(range(0, 12, 0, 12));
    await flush();
    expect(loader.requests).toHaveLength(4);
    // 甩到末尾时前四笔还在路上：额度不能被越过，新窗口也不能抢跑。
    scheduler.setRange(range(288, 300, 296, 300));
    await flush();
    expect(loader.requests).toHaveLength(4);
    expect(scheduler.outstanding).toBeLessThanOrEqual(4);
    for (const index of [...loader.requests]) {
      loader.settle(index, `thumb-${index}`);
      await flush();
      expect(scheduler.outstanding).toBeLessThanOrEqual(4);
    }
    // 旧窗口那四页已经不在窗口里，空出来的额度全给看得见的那几页。
    expect(loader.requests.slice(4).every((index) => index >= 288)).toBe(true);
    expect(loader.requests.slice(4)).toContain(296);
  });

  it('ignores answers once this queue no longer belongs to the reader on screen', async () => {
    const loader = controlled();
    let live = true;
    const onLoaded = vi.fn();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded, isLive: () => live });
    scheduler.setRange(range(0, 4));
    await flush();
    const asked = [...loader.requests];
    // 换档案之后上一份队列的答案不许写进新的缩略图表。
    live = false;
    loader.settle(asked[0]!, 'thumb-a');
    await flush();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('shares slots and answers across a close and reopen', async () => {
    const loader = controlled();
    const loaded: number[] = [];
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: (index) => loaded.push(index), concurrency: 2 });
    scheduler.setRange(range(0, 8));
    await flush();
    expect(scheduler.outstanding).toBe(2);
    const asked = [...loader.requests];
    // 面板关掉再立刻打开：在途的那两笔还在跑，额度不能跟着新面板重置。
    scheduler.suspend();
    scheduler.resume();
    scheduler.setRange(range(0, 8));
    expect(loader.requests).toEqual(asked);
    expect(scheduler.outstanding).toBe(2);
    loader.settle(asked[0]!, 'thumb-a');
    loader.settle(asked[1]!, 'thumb-b');
    await flush();
    expect(loaded).toEqual(asked);
    expect(scheduler.outstanding).toBe(2);
    // 已经拿到的不再问第二次，空出来的额度交给后面两页。
    expect(loader.requests).toHaveLength(4);
    expect(loader.requests.filter((index) => asked.includes(index))).toHaveLength(2);
  });

  it('drops the answers that arrive after the reading session is gone', async () => {
    const loader = controlled();
    const onLoaded = vi.fn();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded });
    scheduler.setRange(range(0, 4));
    await flush();
    const asked = [...loader.requests];
    scheduler.dispose();
    loader.settle(asked[0]!, 'thumb-a');
    await flush();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('ignores a page the reader already holds when the panel reopens on it', async () => {
    const loader = controlled();
    const scheduler = new ThumbnailScheduler({ load: loader.load, onLoaded: () => {}, concurrency: 4 });
    scheduler.markLoaded(0);
    scheduler.setRange(range(0, 4));
    await flush();
    expect(loader.requests).not.toContain(0);
  });
});
