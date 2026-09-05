import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(() => {
  resetInvokeAdapterForTests();
  vi.restoreAllMocks();
});

describe('reader route', () => {
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

  it('loads the restored page first and preloads ahead of it, not behind', async () => {
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
    // The default budget is one page, and reading runs forward, so it goes
    // ahead: 2.jpg has already been passed.
    expect(new Set(loadedPaths)).toEqual(new Set(['3.jpg', '4.jpg']));
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

    expect(await screen.findByRole('alert')).toHaveTextContent('服务器暂时不可用');
    // The route is shell-free, so it has to offer its own exit; the message also
    // has to reach the shared toast.
    expect(await screen.findByRole('link', { name: '返回档案库' })).toHaveAttribute('href', '/library');
    expect(screen.getAllByText('服务器暂时不可用').length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: '重试加载' }));
    await waitFor(() => expect(attempts).toBe(2));
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
    await waitFor(() => expect(commands).toContain('inference_upscale_page'));
    view.unmount();

    // A failing upscale must leave the plain page on screen.
    upscaleWorks = false;
    const failed = render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);
    expect(await screen.findByRole('img', { name: '第 1 页' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
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
