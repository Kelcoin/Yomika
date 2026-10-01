import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { getNativeImageCache } from '../../src/lib/nativeImageCache';
import type { ImageHandle } from '../../src/lib/unifiedImageCache';

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

describe('reader route', () => {
  it('starts DLSSNR only from its reader control and keeps the final rendition', async () => {
    const cache = getNativeImageCache();
    const processed = { key: 'dlssnr-0', url: 'blob:dlssnr-0', bytes: 1 };
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? processed
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 2, upscaleBackend: 'off', upscaleModel: '', decensorModel: 'aletheia-lens', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    expect(load.mock.calls.some(([identity]) => identity.rendition === 'dlssnr')).toBe(false);
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:decensored-0'));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', processed.url));
    expect(release).not.toHaveBeenCalledWith(processed);
    expect(load.mock.calls.some(([identity]) => identity.rendition === 'dlssnr' && JSON.parse(identity.transform ?? '{}').source === 'decensored')).toBe(true);
    await waitFor(() => expect(load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex)).toEqual([0, 1, 2]));
  });
  it('preprocesses the whole archive, not just the pages in the viewport', async () => {
    // 用户报的问题：开着 DLSSNR，只有视口里那几页会被处理，后面的页要翻到才现算。
    // 队列原来每次可见页变化都把自己筛回「可见页 + 预取窗口」，所以整本档案里其余
    // 的页永远不会被排上。可见页那一档后面现在接着一条后台队列，这一条盯的就是它。
    const cache = getNativeImageCache();
    const pageCount = 12;
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'sweep', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/sweep']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0'));

    // 只翻过一页，可见页那一档碰得到的只有第 1、2 页；剩下的十页只有后台预处理会做。
    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });
    // 可见的那一页排在后台那些页前面——预处理不该让正在读的这页等。
    expect(dlssnrPages()[0]).toBe(0);
  });
  it('keeps the pages the reader is about to reach when the session budget overflows', async () => {
    // 用户报的问题：DLSSNR 明明预扫过了，翻到那一页却还要现算。会话预算 64MB、一页
    // 成品 3–6MB，装得下十来页；预扫是从当前页往后由近到远灌进来的，所以「最早算出来
    // 的那一页」正好是马上要翻到的那一页——按插入顺序淘汰，等于每翻一页都先把下一批
    // 要读的丢掉。这一条盯的是淘汰顺序：丢远的，留近的。
    const cache = getNativeImageCache();
    const pageCount = 24;
    const bytes = 6 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'budget', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/budget']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });

    const dropped = release.mock.calls
      .map(([handle]) => Number(handle.key.replace('dlssnr-', '')))
      .filter((index) => Number.isInteger(index));
    // 预扫把整本都做完了，但只留得住离第 1 页最近的那十来页：丢掉的必须是远端那些，
    // 第 1 页往后紧挨着的几页一页都不能丢（丢了就意味着翻过去要现算）。
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((index) => index >= 10)).toBe(true);
  });

  it('promotes a page the reader just turned to instead of leaving it in the prefetch tier', async () => {
    // 用户报的问题：翻页之后队列好像不跟着更新。已经在队列里、但还挂着 `neighbour`
    // 档的那一件，翻到它时不会被升成 `visible`，于是 worker 拿到的优先级是 background
    // ——正在看的那一页排在刚翻过去的那一页后面。这一条盯的就是那个换档。
    const cache = getNativeImageCache();
    const pageCount = 8;
    const processed: Array<{ pageIndex: number; priority?: 'foreground' | 'background' | undefined }> = [];
    let releaseFirst: (() => void) | undefined;
    const firstPageGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition !== 'dlssnr') {
        return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
      }
      processed.push({ pageIndex: identity.pageIndex, priority: identity.priority });
      // 第 1 页那一件挂住，队列里才会攒着预取窗口排进来的第 2、3 页。
      if (identity.pageIndex === 0) await firstPageGate;
      return { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 2, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'promote', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/promote']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.click(reader);
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));
    await waitFor(() => expect(processed.some((entry) => entry.pageIndex === 0)).toBe(true));

    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await act(async () => {});
    await act(async () => { releaseFirst?.(); });

    await waitFor(() => {
      const second = processed.find((entry) => entry.pageIndex === 1);
      expect(second?.priority).toBe('foreground');
    }, { timeout: 5_000 });
    // 只是路过预取窗口、用户没翻过去的那一页仍然是后台的事。
    const third = processed.find((entry) => entry.pageIndex === 2);
    expect(third?.priority).toBe('background');
  });

  it('keeps the pages right after the reader when one derived page takes a third of the budget', async () => {
    // 现场：这台机器的 DLSSNR 三档设置下一张成品 21–27MB（用户库里 133 页 2.9GB），
    // 而会话预算是按「一页 3–6MB」定的 64MB——只装得下两页。预扫从当前页往后由近到远
    // 灌进来，可「下一页」永远落在预算之外、刚算完就被挤掉，用户翻过去还是要现读一遍，
    // 看起来就是整本预处理没生效。这一条盯的是「可见页往后至少留住几页」那个下限。
    const cache = getNativeImageCache();
    const pageCount = 24;
    const bytes = 24 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'resident', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/resident']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(dlssnrPages())).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });

    const dropped = release.mock.calls
      .map(([handle]) => Number(handle.key.replace('dlssnr-', '')))
      .filter((index) => Number.isInteger(index));
    // 第 1 页往后紧挨着的四页一页都不能丢：翻过去时它们就是「已经预处理过」的那几页。
    expect(dropped.filter((index) => index <= 4)).toEqual([]);
  });

  it('retries a page whose source could not be read instead of writing it off', async () => {
    // 源页读失败（LRR 掉线 / 超时）时不能把「尝试过」记在那一页头上：记上以后整本预扫
    // 剩下的部分和用户真的翻到它时都会跳过它，于是这一页在这次阅读里永远是原图。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    let failOnce = true;
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'reader-page' && identity.pageIndex === 2 && failOnce) {
        failOnce = false;
        throw new Error('LANraragi dropped the page');
      }
      return identity.rendition === 'dlssnr'
        ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
        : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'lost-source', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/lost-source']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const sourceCalls = () => load.mock.calls.filter(([identity]) => identity.rendition === 'reader-page' && identity.pageIndex === 2).length;
    const dlssnrPages = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr').map(([identity]) => identity.pageIndex);
    // 预扫轮到第 3 页，源页读失败一次。
    await waitFor(() => expect(sourceCalls()).toBeGreaterThanOrEqual(1));
    // 用户翻到第 2 页：第 3 页进了预取窗口，这时候要再试一次。
    fireEvent.keyDown(screen.getByRole('main', { name: '漫画阅读器' }), { key: 'ArrowRight' });
    await screen.findByRole('img', { name: '第 2 页' });
    await waitFor(() => expect(dlssnrPages()).toContain(2), { timeout: 2_000 });
  });

  it('does not auto-enable upscaling when the pages already average above the threshold', async () => {
    // 用户报的 ⑨：平均体积**高于**阈值，超分还是自己开起来了。阈值是「糊得值不值得
    // 超分」那条线（默认 500KB/页）：这条档案一页 4MB，标签规则再匹配也不该自动开。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 }
    ));
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, upscaleBackend: 'cpu', upscaleModel: 'realcugan-2x-denoise3x', upscaleAutoEnable: true, upscaleAutoTagMode: 'whitelist', upscaleAutoWhitelist: 'category:manga', decensorModel: '', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'fat-pages', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'fat-pages', title: 'Reader', filename: 'fat.zip', tags: 'category:manga', summary: null, extension: 'zip', progress: 0, pageCount: 3, lastReadTime: 0, size: 12 * 1024 * 1024 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter initialEntries={['/reader/fat-pages']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    const upscaleRuns = () => load.mock.calls.filter(([identity]) => identity.rendition === 'enhanced').length;
    // 标签规则是匹配的（category:manga 在白名单里），所以只可能是体积那一半在挡。
    await waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'load_archive_metadata')).toBe(true));
    await act(async () => {});
    await act(async () => {});
    expect(upscaleRuns()).toBe(0);
    expect(screen.getByRole('button', { name: '开启超分' })).toBeInTheDocument();
  });

  it('auto-enables upscaling when the pages average below the threshold and the tags match', async () => {
    // 上一条的反面：阈值以下 + 白名单命中还是要自动开——修方向不是把自动开启关掉。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => (
      { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 }
    ));
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, upscaleBackend: 'cpu', upscaleModel: 'realcugan-2x-denoise3x', upscaleAutoEnable: true, upscaleAutoTagMode: 'whitelist', upscaleAutoWhitelist: 'category:manga', decensorModel: '', dlssnrEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'thin-pages', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: 'thin-pages', title: 'Reader', filename: 'thin.zip', tags: 'category:manga', summary: null, extension: 'zip', progress: 0, pageCount: 3, lastReadTime: 0, size: 300 * 1024 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/thin-pages']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));

    await waitFor(() => expect(load.mock.calls.some(([identity]) => identity.rendition === 'enhanced')).toBe(true));
    expect(await screen.findByRole('button', { name: '关闭超分' })).toBeInTheDocument();
  });

  it('marks the page in the viewport as foreground and the rest of the sweep as background', async () => {
    // 用户要的「超分、去码、DLSSNR 都无条件优先处理当前页」在前端这一侧就是这一个
    // 字段：队列按档位给每件活打上前台/后台，原生那侧据此插队并掐掉正在跑的后台。
    const cache = getNativeImageCache();
    const pageCount = 6;
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: 1 }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'priority', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/priority']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const derived = () => load.mock.calls.filter(([identity]) => identity.rendition === 'dlssnr');
    const pagesWith = (priority: string) => derived()
      .filter(([identity]) => identity.priority === priority)
      .map(([identity]) => identity.pageIndex);
    await waitFor(() => {
      expect(new Set(pagesWith('background'))).toEqual(new Set(Array.from({ length: pageCount - 1 }, (_, index) => index + 1)));
    }, { timeout: 10_000 });
    expect(new Set(pagesWith('foreground'))).toEqual(new Set([0]));
  });

  function enhancedReader(pageCount: number, enhanced: (index: number) => Promise<ImageHandle>) {
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'enhanced'
      ? enhanced(identity.pageIndex)
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:plain-${identity.pageIndex}`, bytes: 1 });
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, upscaleBackend: 'cpu', upscaleModel: 'test' } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'enhancement-test', title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/enhancement-test']}><App /></MemoryRouter>);
    return release;
  }

  it('discards enhancement completed after its switch is disabled', async () => {
    let complete!: (handle: ImageHandle) => void;
    const enhance = vi.fn(() => new Promise<ImageHandle>((resolve) => { complete = resolve; }));
    const release = enhancedReader(1, enhance);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(enhance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(enhance).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '关闭超分' }));
    const handle = { key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 1 };
    await act(async () => complete(handle));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:plain-0');
    expect(release).toHaveBeenCalledWith(handle);
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(enhance).toHaveBeenCalledTimes(2));
    await act(async () => complete(handle));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0');
  });

  it('keeps derived images for the whole session, so going back does not re-run inference', async () => {
    const enhance = vi.fn(async (index: number) => ({ key: `enhanced-${index}`, url: `blob:enhanced-${index}`, bytes: 1 }));
    const release = enhancedReader(14, enhance);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    const runsForPageOne = () => enhance.mock.calls.filter(([index]) => index === 0).length;

    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    for (let index = 1; index <= 10; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: `第 ${index + 1} 页` });
    }
    // Ten pages later the result is still held. It used to be released as its page
    // left the window, and since the attempt had already been spent, going back
    // showed the *plain* page for the rest of the sitting.
    expect(release).not.toHaveBeenCalledWith({ key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 1 });

    for (let index = 0; index < 10; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowLeft' });
      await screen.findByRole('img', { name: `第 ${10 - index} 页` });
    }
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(runsForPageOne()).toBe(1);
  });

  it('drops the derived results the reader is least likely to need once the session is holding too much', async () => {
    // The hold is bounded: the shared image cache only evicts what nobody
    // references, so an unbounded hold would pin every upscaled page in memory.
    // 一页 40MB 时预算 = 「可见页 + 4 页」× 一页的实测体积 = 200MB，正好五页；多出来
    // 的一律按离当前页最远先丢——远处的页重算一遍便宜，丢近的那几页才是翻页现算。
    const enhancedIndexes: number[] = [];
    const release = enhancedReader(12, async (index) => {
      enhancedIndexes.push(index);
      return { key: `enhanced-${index}`, url: `blob:enhanced-${index}`, bytes: 40 * 1024 * 1024 };
    });
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    // 预取窗口是 0，所以第 2 页往后的每一页都只有预扫会碰——等它整本做完。
    await waitFor(() => expect(enhancedIndexes).toContain(11), { timeout: 10_000 });

    const droppedKeys = release.mock.calls.map(([handle]) => handle.key);
    expect(droppedKeys).toContain('enhanced-11');
    // 紧挨着正在读的这一页的那几页一页都不能丢。
    expect(droppedKeys).not.toContain('enhanced-1');
    expect(droppedKeys).not.toContain('enhanced-2');

    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    const releasesBeforeTurning = release.mock.calls.length;
    for (let index = 1; index <= 5; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: `第 ${index + 1} 页` });
    }
    await waitFor(() => expect(screen.getByRole('img', { name: '第 6 页' })).toHaveAttribute('src', 'blob:enhanced-5'));
    // The page just enhanced is never the one dropped for room: 刚补算出来的正是正在读的
    // 这一页，腾地方腾的是身后最远的那一页。
    const droppedWhileReadingPageSix = release.mock.calls.slice(releasesBeforeTurning).map(([handle]) => handle.key);
    expect(droppedWhileReadingPageSix).toContain('enhanced-0');
    expect(droppedWhileReadingPageSix).not.toContain('enhanced-5');
  });

  it('loads native manifest and page bytes, then persists progress on navigation', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const progressScopes: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      calls.push(command);
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'server-native', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-real' }] };
      }
      if (command === 'load_reader_manifest') {
        return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['00.jpg', '01.jpg'] } };
      }
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      if (command === 'load_reading_progress') {
        progressScopes.push(String(args?.scopeId));
        return { ok: true, value: null };
      }
      if (command === 'save_reading_progress') {
        progressScopes.push(String((args?.progress as { scopeId?: string } | undefined)?.scopeId));
        return {
          ok: true,
          value: { scopeId: 'scope-real', archiveId: 'a1', pageIndex: 1, pageCount: 2, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    // The overview panel's facts (metadata + cover) load in the background, so
    // their exact interleaving is not fixed; what matters is which commands run
    // and that progress is written after the page turn. The app shell's startup
    // update check runs here too: it asks once for the release and the model
    // catalog, and a failure (offline, or a test adapter that does not know the
    // command) just goes quiet.
    expect(new Set(calls)).toEqual(new Set([
      'list_servers', 'load_preferences', 'load_reader_manifest', 'load_archive_metadata',
      'load_reading_progress', 'load_archive_thumbnail', 'cache_read_image', 'load_reader_page',
      'save_reading_progress',
      'app_release_latest', 'inference_list_models', 'model_release_list_upscalers',
    ]));
    expect(calls.filter((command) => command === 'load_reader_page')).toHaveLength(2);
    expect(calls.at(-1)).toBe('save_reading_progress');
    expect(progressScopes).toEqual(['scope-real', 'scope-real', 'scope-real']);
  });

  it('uses and releases persistent reader pages without requesting LANraragi', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-cache', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-reader-cache' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'cached-reader', title: 'Cached reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'load_reader_page') throw new Error('reader network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const view = render(<MemoryRouter initialEntries={['/reader/cached-reader']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(adapter).not.toHaveBeenCalledWith('load_reader_page', expect.anything());
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalled();
  });

  it('loads the restored page, one slot either side, and then ahead of it', async () => {
    const loadedPaths: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 } };
      if (command === 'load_reader_page') {
        loadedPaths.push(String(args?.path));
        return { ok: true, value: [1] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 4 页' })).toBeInTheDocument();
    expect(loadedPaths[0]).toBe('3.jpg');
    // The prefetch budget still runs forward — reading does — but the slots
    // either side are rendered for the swipe now, so both have to exist: a drag
    // used to pull the page off an empty background. That is one slot back, not a
    // window behind. This viewport is wide enough for a spread, so the restored
    // page shares its slot with page 5 and the slot in front of it is the pair 2–3.
    expect(new Set(loadedPaths)).toEqual(new Set(['1.jpg', '2.jpg', '3.jpg', '4.jpg']));
  });

  it('opens the restored page even when a neighbour prefetch fails', async () => {
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'load_reader_page') {
        return String(args?.path) === '1.jpg'
          ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '页面暂时不可用', retryable: true } }
          : { ok: true, value: [1] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByText('阅读页面加载失败')).not.toBeInTheDocument();
  });

  it('offers a way out and a retry when the reader cannot load', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') {
        attempts += 1;
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '服务器暂时不可用', retryable: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    // Scoped to the canvas: the same message also reaches the shared toast, which
    // carries its own alert role, so an unscoped query races the toast mounting.
    const canvas = await screen.findByRole('main');
    expect(await within(canvas).findByRole('alert')).toHaveTextContent('服务器暂时不可用');
    // The route is shell-free, so it has to offer its own exit; the message also
    // has to reach the shared toast. 顶栏本身默认隐藏（用户报的 ③），所以先按同一套
    // 手势把它唤出来，再问它给不给退路。
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 40 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    expect(screen.getAllByText('服务器暂时不可用').length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => expect(attempts).toBe(2));
  });

  it('shows the drawn loading indicator rather than a bare line or an empty state', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      // Never resolves: the reader stays in its loading state.
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    // One indicator with an accessible name, not "正在加载页面…" as body text.
    expect(await screen.findByRole('status', { name: '正在加载页面' })).toBeInTheDocument();
    expect(screen.queryByText('正在加载页面…')).not.toBeInTheDocument();
    // 用户报的 ⑥：加载态原来只是一个转圈，阅读器的顶栏要等第一页到达才唤得出来，
    // 加载慢或卡住时就没有退路。现在加载态自带和失败态同一条顶栏，但它和加载完成
    // 之后的顶栏一样是默认隐藏的（用户报的 ③），所以先唤出来。
    const canvas = screen.getByRole('main');
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 40 });
    const back = await screen.findByRole('button', { name: '返回上一页' });
    expect(back.closest('header')).not.toBeNull();
    expect(canvas.firstElementChild).toBe(back.closest('header'));
  });

  // 用户报的 ③：加载态的顶栏原来是常显的，而加载完成后那两条栏会自己藏起来——同一
  // 屏幕上前后两种行为，进阅读模式的第一眼就顶着一个常驻的栏。现在两条路径共用同一套
  // 判定：默认隐藏、指针进顶部感应带或点击附近出现、再点一下收起。
  it('keeps the loading bar hidden until the pointer or a tap in the top band calls for it', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      // Never resolves: the reader stays in its loading state.
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    const canvas = await screen.findByRole('main');
    expect(await screen.findByRole('status', { name: '正在加载页面' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument();

    // 指针移进顶部感应带——不是点击：和阅读态那条 hover 判定同一套。
    fireEvent.mouseMove(canvas, { buttons: 0, clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();

    // 移回画面中间，按同一条出场动画隐去。
    fireEvent.mouseMove(canvas, { buttons: 0, clientY: window.innerHeight / 2 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument());

    // 点击顶部附近也能唤出，再点一下收起。
    fireEvent.click(canvas, { clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();
    fireEvent.click(canvas, { clientY: 110 });
    await waitFor(() => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument());
  });

  // 加载态唤出来的栏和阅读态那两条栏用的是同一条计时（4.5s 无人理就自己走），否则
  // 「加载中」会变成一种要手动关掉的停留状态。这里用**真实**计时器跑一次：fake timers
  // 下 RTL 的 waitFor 会卡住，而这条断言本身就是「过一会儿会不会自己走」，等真实的
  // 4.5s + 0.26s 出场更可信。
  it('lets the summoned loading bar go away on its own', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return new Promise(() => undefined);
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    const canvas = await screen.findByRole('main');
    fireEvent.click(canvas, { clientY: 110 });
    expect(await screen.findByRole('button', { name: '返回上一页' })).toBeInTheDocument();

    await waitFor(
      () => expect(screen.queryByRole('button', { name: '返回上一页' })).not.toBeInTheDocument(),
      { timeout: 6_000 },
    );
  }, 10_000);

  it('applies the default layout and direction, and lets the archive override them', async () => {
    const preferences = { theme: 'system', defaultLayout: 'double', defaultDirection: 'rtl', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', customCss: '' };
    let stored: unknown = null;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: preferences };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: stored };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'save_reading_progress') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });

    // Both settings were read, shown and saved but consumed by nothing: the
    // reader always started on auto/ltr, so choosing either did nothing at all.
    // No long waits any more: the reader takes a changed layout from its props, so
    // the preferences arriving late no longer has to be noticed by an unmount —
    // which is what made this the flakiest test in the file, and what the reader's
    // new auto-hiding chrome turned into a certain failure.
    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(await screen.findByRole('button', { name: '阅读布局：双页，点击切换' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从右到左' })).toBeInTheDocument();
    view.unmount();

    // The archive's own record is the more specific answer, so it wins. 'paged'
    // cannot say whether it meant single or double, so only continuous overrides.
    stored = { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 0, pageCount: 3, layout: 'continuous', direction: 'ltr', updatedAt: '2026-09-05T00:00:00Z', revision: 1 };
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('region', { name: '连续阅读' })).toBeInTheDocument();
  });

  it('opens page 1 when the URL explicitly asks for page=0, even with saved progress', async () => {
    // A missing page param restores the saved progress; a PRESENT `page=0` is
    // an explicit request for the first page (the detail page's thumbnail
    // grid), and it used to be mistaken for "no page requested".
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 } };
      if (command === 'load_reader_page') return { ok: true, value: [1] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1?page=0']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
  });

  it('reads against the server the linking card carried, not the first one', async () => {
    // Two configured servers with the same archive id: without `?server=` the
    // reader always opened server 1's copy and wrote progress there too.
    const requestedServers: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [
        { id: 'server-a', name: 'First', baseUrl: 'https://first.example.com', scopeId: 'scope-first' },
        { id: 'server-b', name: 'Second', baseUrl: 'https://second.example.com', scopeId: 'scope-second' },
      ] };
      if (command === 'load_reader_manifest') {
        requestedServers.push(String(args?.serverId));
        return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      }
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'load_reader_page') return { ok: true, value: [1] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1?server=server-b']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(requestedServers).toEqual(['server-b']);
  });

  it('serves the upscaled page when a model is selected, and falls back when it fails', async () => {
    const commands: string[] = [];
    let upscaleWorks = true;
    let model = 'realesr-general-x4v3';
    setInvokeAdapterForTests(async (command: string) => {
      commands.push(command);
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: model } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'inference_upscale_page') {
        return upscaleWorks
          ? { ok: true, value: [137, 80, 78, 71, 13, 10, 26, 10] }
          : { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'Page is not cached yet', retryable: true } };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('inference_upscale_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(commands).toContain('inference_upscale_page'));
    view.unmount();

    // A failing upscale must leave the plain page on screen.
    upscaleWorks = false;
    commands.length = 0;
    const failed = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(commands).not.toContain('inference_upscale_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(commands).toContain('inference_upscale_page'));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    failed.unmount();

    // A backend with no model would run the nearest-neighbour fallback, which
    // returns the same pixels at four times the size. Not worth a round trip.
    upscaleWorks = true;
    model = '';
    commands.length = 0;
    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('inference_upscale_page');
  });

  it('runs the de-censoring bundle for the page on screen', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      commands.push(command);
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', decensorModel: 'aletheia-lens' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'inference_decensor_page') return { ok: true, value: [137, 80, 78, 71, 13, 10, 26, 10] };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(commands).not.toContain('inference_decensor_page');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));
    await waitFor(() => expect(commands).toContain('inference_decensor_page'));
  });

  it('says the page is being de-censored while the bundle runs', async () => {
    // 一页在 CPU 上要好几秒；这段时间页面上压着一枚「去码处理中」的胶囊，
    // 让等待有交代——不然按下「去码」看上去就是没反应。
    let releaseDecensor: ((value: { ok: true; value: number[] }) => void) | undefined;
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', decensorModel: 'aletheia-lens' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [255, 216, 255, 224] };
      if (command === 'inference_decensor_page') {
        return new Promise<{ ok: true; value: number[] }>((resolve) => { releaseDecensor = resolve; });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    expect(screen.queryByText('去码处理中…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));

    expect(await screen.findByText('去码处理中…')).toBeInTheDocument();
    await act(async () => { releaseDecensor?.({ ok: true, value: [137, 80, 78, 71, 13, 10, 26, 10] }); });
    await waitFor(() => expect(screen.queryByText('去码处理中…')).not.toBeInTheDocument());
  });

  it('keeps the local de-censored page when the DLSS5 step fails', async () => {
    // DLSS5 开着（设置里检测通过），但这一步在运行期失败（片段换了、驱动不对）。
    // 从前这一失败会把**本地那一版也丢掉**，页面上还是原图——看起来就是「去码失效」。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'dlssnr') throw new Error('DLSS5 跑不通');
      return {
        key: `${identity.rendition}-${identity.pageIndex}`,
        url: `blob:${identity.rendition}-${identity.pageIndex}`,
        bytes: 1,
      };
    });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      commands.push(command);
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', decensorModel: 'aletheia-lens', dlssnrEnabled: true } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      // 这台机器看着能跑（偏好里开着，检测也通过）：阅读器据此排队，失败发生在
      // 真正跑那一步的时候。
      if (command === 'dlssnr_status') {
        return {
          ok: true,
          value: {
            dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 165_840_496,
            gpu: { name: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community' },
            gpuName: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版',
            coreAvailable: true, installable: true, available: true,
            probe: { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null },
            probeValid: true, error: null,
          },
        };
      }
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:reader-page-0');
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:decensored-0'));
  });

  it('auto-disables DLSS5 when this machine cannot actually run it', async () => {
    // 偏好里那个开关是**持久化**的：另一台机器上打开过、或者 DLL 换过，本机这一刻
    // 跑不起来。阅读器不能照旧排队（每次都是一次原生失败），而该关掉并说清楚。
    const cache = getNativeImageCache();
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => ({
      key: `${identity.rendition}-${identity.pageIndex}`,
      url: `blob:${identity.rendition}-${identity.pageIndex}`,
      bytes: 1,
    }));
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    const saved: Array<Partial<{ dlssnrEnabled: boolean }>> = [];
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      commands.push(command);
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'off', upscaleModel: '', decensorModel: '', dlssnrEnabled: true } };
      }
      if (command === 'save_preferences') {
        const input = (args?.input ?? {}) as Partial<{ dlssnrEnabled: boolean }>;
        saved.push(input);
        return { ok: true, value: input };
      }
      if (command === 'dlssnr_status') {
        return {
          ok: true,
          value: {
            dllPresent: false, variant: null, variantLabel: null, dllBytes: null, gpu: null,
            gpuName: '', recommendedVariant: null, recommendedLabel: null, coreAvailable: false,
            installable: false, available: false, probe: null, probeValid: false,
            error: '没有找到 NVIDIA 显卡',
          },
        };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });

    // 说清楚为什么，并且把偏好写回 false（不然每次进阅读器都要重问一遍）。
    expect(await screen.findByText(/DLSSNR 不可用：没有找到 NVIDIA 显卡/)).toBeInTheDocument();
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ dlssnrEnabled: false })));
    // 也没有任何一步真的去跑它。
    expect(commands).not.toContain('dlssnr_apply_page');
  });

  it('shows the de-censored page first and swaps in the enlarged one when it lands', async () => {
    // 双开时这是**两步**：去码先出来（几秒），超分再它之上换成最终那一版。以前两步
    // 折在一次调用里，用户要么等全程、要么在超分失败时连去码结果一起丢。
    const cache = getNativeImageCache();
    const sources: Array<string | undefined> = [];
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    let releaseUpscale: ((handle: ImageHandle) => void) | undefined;
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'enhanced') {
        sources.push(identity.source);
        return new Promise<ImageHandle>((resolve) => {
          releaseUpscale = (handle) => resolve(handle);
        });
      }
      return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
    });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan', decensorModel: 'aletheia-lens', dlssnrEnabled: false } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    // 第一步的产物先上屏。
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:decensored-0'));
    // 超分读的正是这一步的产物（不是原图）。
    await waitFor(() => expect(sources).toContain('decensored'));
    await act(async () => { releaseUpscale?.({ key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 1 }); });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:enhanced-0'));
    expect(release).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:decensored-0' }));
    fireEvent.load(image);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ url: 'blob:decensored-0' }));
  });

  it('still enlarges the plain page when the de-censoring step fails', async () => {
    // 四种组合里这是最容易出错的一种：去码失败不该把超分一起带走。这一版没有去码，
    // 但它是可用的结果，而且用户会被告知去码那一步没跑成。
    const cache = getNativeImageCache();
    const sources: Array<string | undefined> = [];
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'decensored') throw new Error('去码模型包没装齐');
      if (identity.rendition === 'enhanced') {
        sources.push(identity.source);
        return { key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 1 };
      }
      return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
    });
    vi.spyOn(cache, 'release').mockImplementation(() => {});
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan', decensorModel: 'aletheia-lens', dlssnrEnabled: false } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:enhanced-0'));
    // 起点退回原图：没有去码产物可读。
    expect(sources).toEqual(['reader-page']);
    expect(await screen.findByText(/去码这一步没跑成/)).toBeInTheDocument();
  });

  it('keeps the de-censored page and its URL when the upscale step fails', async () => {
    // 去码结果先上屏，超分再失败——这时候页面上留着的就是去码那一版。它已经被入册
    // 过一次，第二次落到同一个句柄时**不能**当成「换新版」把它释放掉：释放到 0 引用
    // 会把 blob URL 撤销，页面上那一张就成了坏图。
    const cache = getNativeImageCache();
    const censored: ImageHandle = { key: 'decensored-0', url: 'blob:decensored-0', bytes: 1 };
    vi.spyOn(cache, 'load').mockImplementation(async (identity) => {
      if (identity.rendition === 'decensored') return censored;
      if (identity.rendition === 'enhanced') throw new Error('超分模型跑不起来');
      return { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 };
    });
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan', decensorModel: 'aletheia-lens' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启去码' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const image = screen.getByRole('img', { name: '第 1 页' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:decensored-0'));
    await waitFor(() => expect(screen.getByText(/超分这一步没跑成/)).toBeInTheDocument());
    expect(release).not.toHaveBeenCalledWith(censored);
    expect(image).toHaveAttribute('src', 'blob:decensored-0');
  });

  it('cancels the native task when the reader stops wanting it', async () => {
    // 前端丢掉结果不等于原生停手：一页 4K 在 CPU 上要十几秒，而全局只允许一件重活。
    // 离开阅读器 / 关掉开关时，那个任务号要发回原生让循环停下来。
    const calls: Array<{ command: string; args?: Record<string, unknown> | undefined }> = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      calls.push({ command, args });
      if (command === 'load_preferences') {
        return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 0, coverConcurrency: 4, upscaleBackend: 'cpu', upscaleModel: 'real-esrgan' } };
      }
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      // 超分这一步一直不回来（在 CPU 上就是这样），直到被取消。
      if (command === 'inference_upscale_page') return new Promise(() => undefined);
      if (command === 'inference_cancel_page') return { ok: true, value: true };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });

    const view = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));

    const upscale = await waitFor(() => {
      const call = calls.find((entry) => entry.command === 'inference_upscale_page');
      expect(call).toBeDefined();
      return call!;
    });
    const taskId = (upscale.args?.input as { taskId?: string } | undefined)?.taskId;
    expect(taskId).toBeTruthy();

    view.unmount();
    await waitFor(() => expect(calls.filter((entry) => entry.command === 'inference_cancel_page')).toContainEqual(
      expect.objectContaining({ args: { taskId } }),
    ));
  });

  it('hands back the derived renditions it holds once the reader stops being displayed', async () => {
    // 用户报的问题：读一本档案内存能到 8G，退出去过一段时间仍有 4G 回不来。派生
    // 渲染是最大的一份——这台机器 DLSSNR 一页成品 21–27MB（用户库里 133 页 2.9GB）。
    // 阅读器被切到后台时它一页都不显示，这些句柄就该当场放掉，而不是留给「也许还会
    // 切回来」；切回来时 ReaderScreen 会重新报可见页，按需再算一遍。
    const cache = getNativeImageCache();
    const pageCount = 6;
    const pageBytes = 24 * 1024 * 1024;
    const release = vi.spyOn(cache, 'release').mockImplementation(() => {});
    const commands: string[] = [];
    const load = vi.spyOn(cache, 'load').mockImplementation(async (identity) => identity.rendition === 'dlssnr'
      ? { key: `dlssnr-${identity.pageIndex}`, url: `blob:dlssnr-${identity.pageIndex}`, bytes: pageBytes }
      : { key: `${identity.rendition}-${identity.pageIndex}`, url: `blob:${identity.rendition}-${identity.pageIndex}`, bytes: 1 });
    setInvokeAdapterForTests(async (command, args) => {
      commands.push(command);
      if (command === 'trim_process_memory') return { ok: true, value: null };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'single', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648, prefetchPages: 1, decensorModel: '', dlssnrEnabled: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', name: 'Home', baseUrl: 'https://example.com', scopeId: 's' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: String(args?.archiveId ?? 'left'), title: 'Reader', pages: Array.from({ length: pageCount }, (_, index) => `${index}.jpg`) } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'dlssnr_status') return { ok: true, value: { dllPresent: true, variant: 'community', variantLabel: '社区兼容版', dllBytes: 100, gpu: { name: 'RTX 4070', recommendedVariant: 'community' }, gpuName: 'RTX 4070', recommendedVariant: 'community', recommendedLabel: '社区兼容版', coreAvailable: true, installable: true, available: true, probe: null, probeValid: false, error: null } };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/reader/left']}><ReaderNavigation /><App /></MemoryRouter>);
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启 DLSSNR' }));

    const derivedLoads = () => load.mock.calls.filter(([identity]) => identity.archiveId === 'left' && identity.rendition === 'dlssnr');
    // 等这一本整本预扫完，之后 release 里出现的就只可能是这次离开造成的。
    await waitFor(() => {
      expect(new Set(derivedLoads().map(([identity]) => identity.pageIndex))).toEqual(new Set(Array.from({ length: pageCount }, (_, index) => index)));
    }, { timeout: 10_000 });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:dlssnr-0'));

    release.mockClear();
    // 切到另一本：刚才那本还留着（App 的保留上限是 2），只是不再显示。
    fireEvent.click(screen.getByRole('button', { name: '换一本' }));
    const releasedKeys = () => release.mock.calls.map(([handle]) => handle.key);
    // 连屏幕上那一页的成品也要放：隐藏着的阅读器没有「不能闪」这回事。
    await waitFor(() => expect(releasedKeys()).toContain('dlssnr-0'));
    expect(releasedKeys().filter((key) => key.startsWith('dlssnr-'))).toEqual(expect.arrayContaining(['dlssnr-1', 'dlssnr-2']));

    // 句柄放掉只是一半：Rust 那边 free 了，Windows 不一定马上把页从进程工作集里收
    // 回去（实测退出后仍有 4GB 落不下来）。离开这一本的那一刻要叫一次工作集清理。
    await waitFor(() => expect(commands).toContain('trim_process_memory'));

    // 切回来要按需重算：尝试记录没被清掉的话，这里会一页都不算，屏幕上留着原图。
    const beforeReturn = derivedLoads().length;
    fireEvent.click(screen.getByRole('button', { name: '切回刚才那本' }));
    await waitFor(() => expect(derivedLoads().length).toBeGreaterThan(beforeReturn), { timeout: 10_000 });
  });
});

/** 只用来把阅读器切到后台再切回来：`pageActive` 由 App 的 RetainedPage 决定，
 * 而它只跟着路由走。 */
function ReaderNavigation() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate('/reader/other')}>换一本</button>
    <button onClick={() => navigate('/reader/left')}>切回刚才那本</button>
  </>;
}
