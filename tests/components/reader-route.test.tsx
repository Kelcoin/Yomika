import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

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

  it('drops the oldest derived result once the session is holding too much', async () => {
    // The hold is bounded: the shared image cache only evicts what nobody
    // references, so an unbounded hold would pin every upscaled page in memory.
    const release = enhancedReader(6, async (index) => ({ key: `enhanced-${index}`, url: `blob:enhanced-${index}`, bytes: 40 * 1024 * 1024 }));
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));

    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    fireEvent.keyDown(reader, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:enhanced-1'));
    await waitFor(() => expect(release).toHaveBeenCalledWith({ key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 40 * 1024 * 1024 }));
    // The page just enhanced is never the one dropped for room.
    expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', 'blob:enhanced-1');
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
    // and that progress is written after the page turn.
    expect(new Set(calls)).toEqual(new Set([
      'list_servers', 'load_preferences', 'load_reader_manifest', 'load_archive_metadata',
      'load_reading_progress', 'load_archive_thumbnail', 'cache_read_image', 'load_reader_page',
      'save_reading_progress',
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
    // has to reach the shared toast.
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
  });

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
});
