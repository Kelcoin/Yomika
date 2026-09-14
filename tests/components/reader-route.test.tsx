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

  it('releases derived images after their pages leave the retention window', async () => {
    const release = enhancedReader(14, async (index) => ({ key: `enhanced-${index}`, url: `blob:enhanced-${index}`, bytes: 1 }));
    await screen.findByRole('img', { name: '第 1 页' });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    fireEvent.click(screen.getByRole('button', { name: '开启超分' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced-0'));
    const reader = screen.getByRole('main', { name: '漫画阅读器' });
    for (let index = 1; index <= 10; index += 1) {
      fireEvent.keyDown(reader, { key: 'ArrowRight' });
      await screen.findByRole('img', { name: `第 ${index + 1} 页` });
    }
    await waitFor(() => expect(release).toHaveBeenCalledWith({ key: 'enhanced-0', url: 'blob:enhanced-0', bytes: 1 }));
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
    expect(progressScopes).toEqual(['scope-real', 'scope-real']);
  });

  it('uses and releases persistent reader pages without requesting LANraragi', async () => {
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'server-cache', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-reader-cache' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'cached-reader', title: 'Cached reader', pages: ['0.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'cache_read_image') return { ok: true, value: { bytes: [255, 216, 255, 224], mime: 'image/jpeg' } };
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
    // window behind.
    expect(new Set(loadedPaths)).toEqual(new Set(['2.jpg', '3.jpg', '4.jpg']));
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
      if (command === 'cache_read_image') return { ok: true, value: null };
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
      if (command === 'cache_read_image') return { ok: true, value: null };
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
});
