import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ArchiveDetailRoute } from '../../src/components/ArchiveDetailRoute';
import { installTagTranslations } from '../../src/lib/tags';
import { ToastProvider } from '../../src/components/Toast';

afterEach(() => {
  resetInvokeAdapterForTests();
  installTagTranslations({});
  vi.restoreAllMocks();
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

    // The page image itself is decorative: the visible page number labels it.
    const thumbnail = await screen.findByRole('button', { name: '查看第 1 页' });
    await vi.waitFor(() => expect(thumbnail.querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^blob:/)));
    expect(adapter).not.toHaveBeenCalledWith('load_archive_page_thumbnail', expect.anything());
  });

  it('centers the initial loading state', () => {
    setInvokeAdapterForTests(() => new Promise(() => undefined));

    renderDetail();

    expect(screen.getByRole('status')).toHaveClass('archive-detail-loading-status');
    expect(screen.getByRole('main')).toHaveClass('archive-detail-route-loading');
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

    expect(await screen.findByRole('heading', { name: 'archive-a' })).toBeInTheDocument();
    // Loading is a shimmer placeholder, not a spinner with text.
    expect(screen.getByRole('status', { name: '正在加载档案详情' })).toHaveClass('skeleton-line');
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

  it.skip('selects a category in a modal and assigns the archive', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'list_categories') return { ok: true, value: [{ id: 'SET_1613080290', name: 'Favorites', pinned: false, search: null, archives: [] }] };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'add_archive_to_category') return { ok: true, value: { operation: 'add_to_category', success: 1 } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    renderDetail();

    await user.click(await screen.findByRole('button', { name: '选择分类' }));
    const dialog = screen.getByRole('dialog', { name: '选择分类' });
    await user.click(screen.getByRole('radio', { name: 'Favorites' }));
    await user.click(screen.getByRole('button', { name: '加入所选分类' }));

    expect(dialog).not.toBeInTheDocument();
    expect(adapter).toHaveBeenCalledWith('add_archive_to_category', {
      serverId: 'server-a', categoryId: 'SET_1613080290', archiveId: 'archive-a',
    });
    expect(await screen.findByText('分类已更新')).toBeInTheDocument();
  });

  it('places reading, favorite, editing and delete actions in one toolbar', async () => {
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
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '编辑元数据' }));
    expect(toolbar).not.toContainElement(screen.queryByRole('button', { name: '选择分类' }));
    expect(toolbar).toContainElement(screen.getByRole('button', { name: '删除档案' }));
  });

  it('recommends by shared tags and same creator above the page thumbnails', async () => {
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

    const thumbnails = screen.getByRole('region', { name: '页面缩略图' });
    expect(creator.compareDocumentPosition(thumbnails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
