import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ArchiveDetailRoute } from '../../src/components/ArchiveDetailRoute';
import { installTagTranslations } from '../../src/lib/tags';
import { ToastProvider } from '../../src/components/Toast';
import { resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';

afterEach(() => {
  resetInvokeAdapterForTests();
  installTagTranslations({});
  vi.restoreAllMocks();
  resetRouteCacheForTests();
});

const server = { id: 'server-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' };
const metadata = {
  archiveId: 'archive-a',
  title: 'Archive detail',
  filename: 'archive.cbz',
  tags: 'female:big breasts, artist:sample artist',
  summary: 'Summary',
  extension: 'cbz',
  progress: 0,
  pageCount: 12,
  lastReadTime: 0,
  size: 1024,
};

function renderDetail() {
  return render(
    <MemoryRouter>
      <ArchiveDetailRoute archiveId="archive-a" />
    </MemoryRouter>,
  );
}

describe('archive detail route', () => {
  it('paints the last detail snapshot before server lookup completes', async () => {
    const cached = { ...metadata, title: 'Cached detail' };
    writeRouteCache('archive-detail:last:archive-a', cached);
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return new Promise(() => undefined);
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Cached detail' })).toBeInTheDocument();
  });

  it('uses a persistent cached cover without requesting LANraragi', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: { bytes: [255, 216, 255, 224], mime: 'image/jpeg' } };
      if (command === 'load_archive_thumbnail') throw new Error('network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const view = renderDetail();

    expect(await screen.findByRole('img', { name: 'Archive detail 封面' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(adapter).not.toHaveBeenCalledWith('load_archive_thumbnail', expect.anything());
    view.unmount();
  });

  it('shows only the cover over a blurred backdrop and closes from any click', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: { bytes: [255, 216, 255, 224], mime: 'image/jpeg' } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    const trigger = await screen.findByRole('button', { name: '查看Archive detail大图' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-label', 'Archive detail封面大图');
    const preview = within(dialog).getByRole('img', { name: 'Archive detail 封面大图' });
    expect(preview).toBeInTheDocument();
    expect(within(dialog).queryByRole('heading')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button')).not.toBeInTheDocument();
    fireEvent.click(preview);
    expect(screen.queryByRole('dialog', { name: 'Archive detail封面大图' })).not.toBeInTheDocument();
  });

  it('links translated detail tags to an exact library search', async () => {
    installTagTranslations({ female: { 'big breasts': '巨乳' } });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories' || command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    expect(await screen.findByRole('link', { name: '搜索标签 巨乳' })).toHaveAttribute(
      'href',
      '/library?q=female%3Abig+breasts%24%2C+',
    );
  });

  it('uses persistent page thumbnails without requesting LANraragi', async () => {
    const adapter = vi.fn(async (command: string, args?: Record<string, any>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 1 } };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'cache_read_image') {
        return args?.identity?.rendition === 'page-thumbnail'
          ? { ok: true, value: { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' } }
          : { ok: true, value: null };
      }
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'load_archive_page_thumbnail') throw new Error('page network should not be called');
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderDetail();

    fireEvent.click(await screen.findByRole('tab', { name: '详情' }));
    // The page image itself is decorative: the visible page number labels it.
    const thumbnail = await screen.findByRole('button', { name: '查看第 1 页' });
    await vi.waitFor(() => expect(thumbnail.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^blob:/)));
    expect(adapter).not.toHaveBeenCalledWith('load_archive_page_thumbnail', expect.anything());
  });

  it('uses the real detail structure for its initial skeleton', () => {
    setInvokeAdapterForTests(() => new Promise(() => undefined));

    renderDetail();

    expect(screen.getByRole('status', { name: '正在加载档案详情' })).toHaveClass('skeleton-line-title');
    expect(screen.getByRole('toolbar', { name: '档案操作' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: '详情内容' })).toBeInTheDocument();
    expect(document.querySelectorAll('.archive-detail-facts svg')).toHaveLength(4);
  });

  it('renders metadata without waiting for secondary requests', async () => {
    const pending = new Promise<never>(() => undefined);
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories' || command === 'load_archive_thumbnail') return pending;
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Archive detail' })).toBeInTheDocument();
  });

  it('keeps the detail shell visible while metadata is still loading', async () => {
    const pending = new Promise<never>(() => undefined);
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata' || command === 'load_archive_thumbnail' || command === 'list_watchlist' || command === 'list_categories') return pending;
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    // Two loading phases: the whole-page skeleton paints until the server scope
    // is known, then the inline skeleton takes over in the real layout — the
    // title slot holds a skeleton of its own size (it used to show the raw
    // archive id), and the copy column mirrors the tag rows it will hold.
    expect(await screen.findByRole('status', { name: '正在加载档案详情' })).toHaveClass('skeleton-line-title');
    await waitFor(() => expect(document.querySelector('.archive-detail-copy-skeleton')).not.toBeNull());
    expect(screen.getByRole('status', { name: '正在加载档案详情' })).toHaveClass('skeleton-line-title');
    expect(screen.queryByText('正在加载档案详情…')).not.toBeInTheDocument();
  });

  it('leaves a detail route when LANraragi confirms the archive is missing', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: '档案不存在', retryable: false } };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: '档案不存在', retryable: false } };
      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <MemoryRouter initialEntries={['/library/archive-a']}>
        <ToastProvider>
          <Routes>
            <Route path="/library/:archiveId" element={<ArchiveDetailRoute archiveId="archive-a" />} />
            <Route path="/library" element={<main>档案库已恢复</main>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('档案库已恢复')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('该档案已从 LANraragi 移除');
  });

  it('uses an image MIME type for LANraragi thumbnail bytes', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [255, 216, 255, 224] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    expect(await screen.findByRole('img', { name: 'Archive detail 封面' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(createObjectUrl.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/jpeg' });
  });

  it('keeps the server thumbnail MIME when the cover is PNG', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: true, value: [0x89, 0x50, 0x4e, 0x47] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    expect(await screen.findByRole('img', { name: 'Archive detail 封面' })).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(createObjectUrl.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'image/png' });
  });

  it('keeps spaces inside tags so translations can match', async () => {
    installTagTranslations({ female: { 'big breasts': '巨乳' }, artist: { 'sample artist': '示例作者' } });
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    expect(await screen.findByText('巨乳')).toBeInTheDocument();
    expect(screen.getByText('示例作者')).toBeInTheDocument();
    expect(screen.queryByText('breasts')).not.toBeInTheDocument();
  });

  it('defaults to reading, reading list, favorites and download in the toolbar', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'list_categories') return { ok: true, value: [{ id: 'SET_1613080290', name: 'Favorites', pinned: false, search: null, archives: [] }] };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    const toolbar = await screen.findByRole('toolbar', { name: '档案操作' });
    expect(toolbar).toContainElement(screen.getByRole('link', { name: '阅读' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '收藏' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '下载档案' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '加入待看' }));
    expect(within(toolbar).queryByRole('button', { name: '编辑元数据' })).not.toBeInTheDocument();
    expect(toolbar).not.toContainElement(screen.queryByRole('button', { name: '选择分类' }));
    expect(within(toolbar).queryByRole('button', { name: '删除档案' })).not.toBeInTheDocument();
  });

  it('offers incognito by long-pressing 阅读 rather than a button of its own', async () => {
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    // The separate 无痕 button spent a permanent toolbar slot on a rare choice and
    // sat a second reading entry point next to the real one.
    const read = await screen.findByRole('link', { name: '阅读' });
    expect(screen.queryByRole('link', { name: '无痕阅读' })).not.toBeInTheDocument();

    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(read);
      vi.advanceTimersByTime(600);
    } finally {
      vi.useRealTimers();
    }

    // Incognito changes what the app records, so it says what it will not do.
    expect(await screen.findByRole('dialog', { name: '无痕阅读' })).toBeInTheDocument();
    expect(screen.getByText('本次阅读不会记录进度，也不会写入历史。')).toBeInTheDocument();
  });

  it('switches between recommendations and page thumbnails below the action toolbar', async () => {
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_archive_metadata') {
        return { ok: true, value: {
          archiveId: 'archive-a', title: 'Source', filename: 'a.cbz',
          tags: 'artist:someone, female:glasses, female:futanari, category:manga',
          extension: 'cbz', progress: 0, pageCount: 1, lastReadTime: 0, size: 1,
        } };
      }
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'list_archives_page') {
        const query = String((args?.input as { query?: string } | undefined)?.query ?? '');
        const rows = query.startsWith('artist:')
          ? [{ serverId: 'scope-a', archiveId: 'by-same-artist', title: 'By same artist', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['artist:someone'] }]
          : [
            { serverId: 'scope-a', archiveId: 'strong', title: 'Strong match', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'female:futanari', 'category:manga'] },
            { serverId: 'scope-a', archiveId: 'weak', title: 'Weak match', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['language:chinese'] },
          ];
        return { ok: true, value: { items: rows, total: rows.length, hasMore: false } };
      }
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_tasks' || command === 'list_webdav_accounts') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    const similar = await screen.findByRole('region', { name: '猜你喜欢' });
    expect(await within(similar).findByRole('link', { name: /Strong match/ })).toBeInTheDocument();
    // Sharing only a zero-weight namespace is not a recommendation.
    expect(within(similar).queryByRole('link', { name: /Weak match/ })).not.toBeInTheDocument();

    // Same-creator results live behind a tab in the same rail, so the section
    // costs one card row instead of two.
    const creatorTab = await screen.findByRole('tab', { name: '同作者' });
    fireEvent.click(creatorTab);
    const creator = await screen.findByRole('region', { name: '同作者作品' });
    expect(await within(creator).findByRole('link', { name: /By same artist/ })).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: '页面缩略图' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '同作者作品' })).toBeInTheDocument();
  });

  it('requests page thumbnails only when they approach the viewport', async () => {
    const OriginalObserver = window.IntersectionObserver;
    const observed: Array<() => void> = [];
    window.IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) { observed.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
      observe() {}
      takeRecords() { return []; }
      unobserve() {}
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    } as unknown as typeof IntersectionObserver;
    const adapter = vi.fn(async (command: string, args?: Record<string, any>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 4 } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'load_archive_page_thumbnail') return { ok: true, value: [255, 216, 255, 224] };
      throw new Error(`Unexpected command: ${command} ${JSON.stringify(args)}`);
    });
    setInvokeAdapterForTests(adapter);
    try {
      renderDetail();
      await screen.findByRole('button', { name: '查看第 4 页' });
      expect(adapter.mock.calls.filter(([command]) => command === 'load_archive_page_thumbnail')).toHaveLength(0);
      observed.forEach((intersect) => intersect());
      await vi.waitFor(() => {
        expect(adapter.mock.calls.filter(([command]) => command === 'load_archive_page_thumbnail')).toHaveLength(4);
      });
    } finally {
      window.IntersectionObserver = OriginalObserver;
    }
  });

  it('offers comments only for a verified active E-Hentai account', async () => {
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'source:https://e-hentai.org/g/12345/abc/, artist:sample' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_eh_accounts') return { ok: true, value: [{ id: 'eh-a', label: 'EH', host: 'e-hentai.org', cookieRef: 'ref', isActive: true, status: 'verified', createdAt: '', updatedAt: '' }] };
      if (command === 'get_eh_comments') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderDetail();
    await vi.waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'get_eh_comments')).toBe(true));
    fireEvent.click(await screen.findByRole('tab', { name: '评论' }));
    expect(await screen.findByRole('region', { name: 'E-Hentai 评论' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '页面缩略图' })).not.toBeInTheDocument();
    const comments = screen.getByRole('region', { name: 'E-Hentai 评论' });
    fireEvent.click(screen.getByRole('tab', { name: '详情' }));
    fireEvent.click(screen.getByRole('tab', { name: '评论' }));
    expect(screen.getByRole('region', { name: 'E-Hentai 评论' })).toBe(comments);
    expect(adapter.mock.calls.filter(([command]) => command === 'get_eh_comments')).toHaveLength(1);
  });

  it('keeps both detail tabs available when the E-Hentai account is not verified', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'source:https://e-hentai.org/g/12345/abc/' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_eh_accounts') return { ok: true, value: [{ id: 'eh-a', label: 'EH', host: 'e-hentai.org', cookieRef: 'ref', isActive: true, status: 'error', createdAt: '', updatedAt: '' }] };
      if (command === 'cache_read_image') return { ok: true, value: null };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderDetail();
    await screen.findByRole('tab', { name: '详情' });
    const comments = screen.getByRole('tab', { name: '评论' });
    fireEvent.click(comments);
    expect(await screen.findByText('此档案没有可读取的 E-Hentai 评论。')).toBeInTheDocument();
  });

  it('does not render or cache recommendations confirmed missing by LANraragi', async () => {
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_page') return { ok: true, value: { items: [
        { serverId: server.id, archiveId: 'gone', title: 'Gone recommendation', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] },
        { serverId: server.id, archiveId: 'kept', title: 'Kept recommendation', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] },
      ], total: 2, hasMore: false } };
      if (command === 'verify_archives_exist') return { ok: true, value: ['gone'] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command} ${(args as any)?.input ?? ''}`);
    });
    renderDetail();
    const rail = await screen.findByRole('region', { name: '猜你喜欢' });
    expect(within(rail).getByRole('link', { name: /Kept recommendation/ })).toBeInTheDocument();
    expect(within(rail).queryByRole('link', { name: /Gone recommendation/ })).not.toBeInTheDocument();
  });

  it('reuses the recommendations it already searched for on a second visit', async () => {
    // The rail costs up to a dozen searches on the server, and the answer for one
    // archive does not change minute to minute.
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'artist:someone, female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_archives_page') {
        const query = String((args?.input as { query?: string } | undefined)?.query ?? '');
        return { ok: true, value: {
          items: [{ serverId: 'scope-a', archiveId: `for-${query}`, title: `命中 ${query}`, pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: [query] }],
          total: 1,
          hasMore: false,
        } };
      }
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const first = renderDetail();
    await screen.findByRole('region', { name: '猜你喜欢' });
    await vi.waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'list_archives_page').length).toBeGreaterThan(0));
    const searches = adapter.mock.calls.filter(([command]) => command === 'list_archives_page').length;
    first.unmount();

    const second = renderDetail();
    const rail = await screen.findByRole('region', { name: '猜你喜欢' });
    // A cached rail arrives with its cards already in it; one that had to search
    // again would still be a skeleton at this point.
    expect(within(rail).getByRole('link', { name: /命中/ })).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'list_archives_page')).toHaveLength(searches);
    second.unmount();
  });
});

it('retains detail DOM and thumbnail requests across repeated tab switches', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'category:manga, uploader:sample, female:example', pageCount: 1 } };
    if (command === 'cache_read_image') return { ok: true, value: { bytes: [255, 216, 255, 224], mime: 'image/jpeg' } };
    if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
    return { ok: true, value: [] };
  });
  setInvokeAdapterForTests(adapter);
  renderDetail();
  const page = await screen.findByRole('button', { name: '查看第 1 页' });
  await waitFor(() => expect(page.querySelector('img')).not.toBeNull());
  const tags = screen.getByLabelText('档案标签');
  // 上传者回到标签分组区里；分类不再是芯片，而是信息栅格的第三项。
  expect(tags).toHaveTextContent('sample');
  const facts = screen.getByLabelText('档案信息');
  expect(facts).toHaveTextContent('分类');
  expect(facts).not.toHaveTextContent('sample');
  const requests = adapter.mock.calls.filter(([command]) => command === 'cache_read_image').length;
  for (let i = 0; i < 3; i += 1) {
    fireEvent.click(screen.getByRole('tab', { name: '评论' }));
    expect(tags).not.toBeVisible();
    expect(page).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '详情' }));
    expect(screen.getByRole('button', { name: '查看第 1 页' })).toBe(page);
    expect(tags).toBeVisible();
  }
  expect(adapter.mock.calls.filter(([command]) => command === 'cache_read_image')).toHaveLength(requests);
});

it('opens the shared menu from the header and downloads from the default toolbar', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'source:https://example.com/gallery/1', pageCount: 0 } };
    if (command === 'download_archive') return { ok: true, value: 'C:/Downloads/archive.cbz' };
    if (command === 'open_external_url') return { ok: true, value: null };
    return { ok: true, value: [] };
  });
  setInvokeAdapterForTests(adapter);
  renderDetail();
  await screen.findByRole('heading', { name: 'Archive detail' });
  fireEvent.click(screen.getByRole('button', { name: '下载档案' }));
  expect(adapter).toHaveBeenCalledWith('download_archive', { serverId: 'server-a', archiveId: 'archive-a' });
  fireEvent.click(screen.getByRole('button', { name: '档案菜单' }));
  expect(await screen.findByRole('menuitem', { name: '编辑元数据' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: '跳转画廊' }));
  expect(adapter).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/gallery/1' });
});

it('places recommendations between detail tags and page thumbnails', async () => {
  setInvokeAdapterForTests(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 1, tags: 'artist:sample' } };
    if (command === 'cache_read_image') return { ok: true, value: null };
    if (command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
    return { ok: true, value: [] };
  });
  renderDetail();
  const tags = await screen.findByLabelText('档案标签');
  const thumbnails = await screen.findByRole('region', { name: '页面缩略图' });
  const detailPanel = screen.getByRole('tabpanel', { name: '详情' });
  expect(detailPanel.contains(tags)).toBe(true);
  expect(detailPanel.contains(thumbnails)).toBe(true);
  expect(tags.compareDocumentPosition(thumbnails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
