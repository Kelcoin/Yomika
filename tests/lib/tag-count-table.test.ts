import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import {
  TAG_COUNT_DATA_KEY,
  TAG_COUNT_MIN_COUNT,
  TAG_COUNT_TABLE_COMMAND,
  TAG_COUNT_VERSION_KEY,
  createTagCountService,
  getTagCountForSort,
  getTagCountVersion,
  installTagCounts,
  refreshTagCounts,
  setTagCountOrderEnabled,
} from '../../src/lib/tagCountService';
import { installTagTranslations, searchTags } from '../../src/lib/tags';

/** 真实资产里的几行。数字来自 `debug_outputs/tagcount/real-data-check.mjs` 的读数：
 *  gz 1,326,369 字节 → 正文 3,306,354 字节 / 160,212 行，过了 5 次地板的 88,528 行，
 *  20,841 个命名空间。挑的都是 `big` 前缀：补全里相关度相同，排序只由频次那一档决定。 */
const REAL_ROWS: Array<[string, number]> = [
  ['female:big breasts', 1306417],
  ['female:big ass', 332586],
  ['female:big areolae', 84934],
  ['female:big penis', 84385],
];
const REAL_VERSION = 'Sat, 10 Oct 2026 16:54:00 GMT';
const rowsText = (rows: Array<[string, number]>) =>
  rows.map(([key, count]) => `${key}\t${count}`).join('\n');

function storageDouble(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  };
}

describe('tag count table transport', () => {
  beforeEach(() => {
    localStorage.clear();
    installTagCounts([]);
    setTagCountOrderEnabled(false);
  });

  afterEach(() => {
    resetInvokeAdapterForTests();
    setTagCountOrderEnabled(false);
    installTagCounts([]);
    localStorage.clear();
  });

  it('asks the native side for the table and orders suggestions by the real frequencies', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    setInvokeAdapterForTests(vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return { ok: true, value: { version: REAL_VERSION, unchanged: false, data: rowsText(REAL_ROWS) } };
    }));

    await refreshTagCounts();

    expect(calls[0]?.[0]).toBe(TAG_COUNT_TABLE_COMMAND);
    expect(calls[0]?.[1]).toEqual({ since: null });
    expect(getTagCountVersion()).toBe(REAL_VERSION);
    expect(localStorage.getItem(TAG_COUNT_VERSION_KEY)).toBe(REAL_VERSION);
    expect(localStorage.getItem(TAG_COUNT_DATA_KEY)).toContain('female:big breasts\t1306417');

    // 规则真的在按这份库排序：三条候选相关度相同，顺序与真实频次一致
    // （1,306,417 > 332,586 > 84,385）。频次方向写反时这条会红。
    installTagTranslations({
      female: { 'big breasts': 'Big Breasts', 'big ass': 'Big Ass', 'big penis': 'Big Penis' },
    });
    setTagCountOrderEnabled(true);
    expect(searchTags('big').map((item) => item.key)).toEqual(['big breasts', 'big ass', 'big penis']);

    // 第二次刷新：手里有表，于是把版本带回去让 Rust 别下正文；说没变就照旧用着旧的。
    setInvokeAdapterForTests(vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      return { ok: true, value: { version: REAL_VERSION, unchanged: true } };
    }));
    await refreshTagCounts();
    expect(calls[1]?.[1]).toEqual({ since: REAL_VERSION });
    expect(searchTags('big').map((item) => item.key)).toEqual(['big breasts', 'big ass', 'big penis']);
    expect(localStorage.getItem(TAG_COUNT_DATA_KEY)).toContain('female:big breasts');
  });

  it('reports a native answer that does not match the table shape instead of sorting on an empty table', async () => {
    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value: { version: REAL_VERSION } })));

    await expect(refreshTagCounts()).rejects.toThrow();
  });

  it('does not wedge the refresh button after a failure', async () => {
    // 这条钉的是一个真发生过的形状：`inFlight` 只用 `.finally` 包装后的那个
    // promise 去清，比较永远不成立，于是第一次失败之后每一次刷新都拿回同一份
    // 旧错误（设置页上就是连连弹同一个 toast），成功之后按刷新则毫无反应。
    let call = 0;
    const calls: Array<Record<string, unknown> | undefined> = [];
    setInvokeAdapterForTests(vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      calls.push(args);
      call += 1;
      if (call === 1) return { ok: false, error: { code: 'UNKNOWN', message: '网络不通', retryable: true } };
      return { ok: true, value: { version: REAL_VERSION, unchanged: false, data: rowsText(REAL_ROWS) } };
    }));

    await expect(refreshTagCounts()).rejects.toThrow();
    await refreshTagCounts();

    expect(calls).toHaveLength(2);
    expect(getTagCountVersion()).toBe(REAL_VERSION);
    setTagCountOrderEnabled(true);
    expect(getTagCountForSort('female:big breasts')).toBe(1306417);
  });

  it('will not claim a version it has no table for', async () => {
    const cold = storageDouble({ [TAG_COUNT_VERSION_KEY]: REAL_VERSION });
    const coldFetch = vi.fn(async () => ({ version: REAL_VERSION, unchanged: false, data: rowsText(REAL_ROWS) }));
    const coldService = createTagCountService({ storage: cold.storage, fetchTable: coldFetch });
    await coldService.refresh();
    expect(coldFetch).toHaveBeenCalledWith(undefined);
    expect(coldService.getCount('female:big ass')).toBe(332586);

    // 版本与表都在：这时才允许只问版本。
    const warm = storageDouble({
      [TAG_COUNT_VERSION_KEY]: REAL_VERSION,
      [TAG_COUNT_DATA_KEY]: rowsText(REAL_ROWS),
    });
    const warmFetch = vi.fn(async () => ({ version: REAL_VERSION, unchanged: true }));
    const warmService = createTagCountService({ storage: warm.storage, fetchTable: warmFetch });
    await warmService.refresh();
    expect(warmFetch).toHaveBeenCalledWith(REAL_VERSION);
  });

  it('keeps the frequency floor on rows that come back from the native side', async () => {
    const service = createTagCountService({
      storage: storageDouble().storage,
      fetchTable: async () => ({
        version: REAL_VERSION,
        unchanged: false,
        data: `female:rare\t${TAG_COUNT_MIN_COUNT - 1}\nfemale:common\t${TAG_COUNT_MIN_COUNT}`,
      }),
    });
    await service.refresh();

    // 搬数据的那一层不筛，筛的还是 install 这一处：低于地板的不进表。
    expect(service.getCount('female:rare')).toBeUndefined();
    expect(service.getCount('female:common')).toBe(TAG_COUNT_MIN_COUNT);
  });
});
