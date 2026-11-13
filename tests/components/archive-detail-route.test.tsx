import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { ArchiveDetailRoute } from '../../src/components/ArchiveDetailRoute';
import { installTagTranslations } from '../../src/lib/tags';
import { ToastProvider } from '../../src/components/Toast';
import { RetainedPage } from '../../src/app/RetainedPage';
import { PreferencesProvider } from '../../src/app/preferences';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { invalidateRouteCache, readRouteCache, resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';

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

function renderDetail(detailBasePath?: string) {
  return render(
    <MemoryRouter>
      <ArchiveDetailRoute archiveId="archive-a" {...(detailBasePath ? { detailBasePath } : {})} />
    </MemoryRouter>,
  );
}

describe('archive detail route', () => {
  it('refreshes the reading label after metadata hydrates missing server progress', async () => {
    let finishMetadata!: (value: unknown) => void;
    const request = new Promise(resolve => { finishMetadata = resolve; });
    let hydrated = false;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return request;
      if (command === 'load_reading_progress') return { ok: true, value: hydrated ? { scopeId: server.scopeId, archiveId: metadata.archiveId, pageIndex: 4, pageCount: 12, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } : null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    renderDetail();
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('load_reading_progress', { scopeId: server.scopeId, archiveId: metadata.archiveId }));
    hydrated = true;
    finishMetadata({ ok: true, value: { ...metadata, progress: 5 } });
    expect(await screen.findByRole('link', { name: '从 5 页继续' })).toBeInTheDocument();
  });
  it('swipes the content between details and comments without stealing vertical or rail gestures', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 0 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('heading', { name: metadata.title });
    const swipe = (target: HTMLElement, x: number, y: number) => {
      fireEvent.touchStart(target, { touches: [{ clientX: 180, clientY: 100 }] });
      fireEvent.touchMove(target, { touches: [{ clientX: x, clientY: y }] });
      fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: x, clientY: y }] });
    };
    const details = screen.getByRole('tabpanel', { name: '详情' });
    swipe(details, 90, 105);
    expect(screen.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true');
    const comments = screen.getByRole('tabpanel', { name: '评论' });
    swipe(comments, 265, 102);
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    swipe(details, 95, 220);
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    const rail = document.createElement('div');
    rail.dataset.horizontalScroll = '';
    details.append(rail);
    swipe(rail, 90, 100);
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.touchStart(details, { touches: [{ clientX: 180, clientY: 100 }] });
    fireEvent.touchMove(details, { touches: [{ clientX: 90, clientY: 100 }] });
    fireEvent.touchCancel(details);
    fireEvent.touchEnd(details, { touches: [], changedTouches: [{ clientX: 90, clientY: 100 }] });
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: '详情' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '评论' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true');
    expect(details).toHaveAttribute('inert');
    fireEvent.keyDown(screen.getByRole('tab', { name: '评论' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: '详情' })).toHaveFocus();
    expect(details).not.toHaveAttribute('inert');
  });
  it('slides both panels across one stage while the swipe is still under the finger', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 0 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('heading', { name: metadata.title });
    const details = screen.getByRole('tabpanel', { name: '详情' });
    const stage = details.parentElement!;
    // 藏起来的那块没有可访问名（display: none 下算不出），按 DOM 直接取。
    const comments = stage.querySelector<HTMLElement>('[role="tabpanel"][aria-label="评论"]')!;
    expect(stage.className).toBe('archive-detail-panels');
    expect(comments).toHaveAttribute('hidden');

    fireEvent.touchStart(details, { touches: [{ clientX: 240, clientY: 100 }] });
    fireEvent.touchMove(details, { touches: [{ clientX: 180, clientY: 104 }] });

    // 手指还没松：两块面板并排铺在同一个舞台上，位移跟着手指走 —— 滑出去的那半
    // 和滑进来的那半同时看得见，这就是「翻页」而不是「切换」。
    expect(stage.className).toContain('is-sliding');
    expect(stage.className).toContain('is-dragging');
    expect(comments).not.toHaveAttribute('hidden');
    expect(details.getAttribute('style')).toContain('translate3d(-60px, 0, 0)');
    expect(comments.getAttribute('style')).toContain('translate3d(calc(100% + 16px - 60px), 0, 0)');
    // 标签页要等松手那一刻才算换过。
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.touchEnd(details, { touches: [], changedTouches: [{ clientX: 180, clientY: 104 }] });
    expect(screen.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true');
    // 收势结束，舞台收起来：位移清零，另一块重新藏起来，容器回到单块占位。
    expect(stage.className).toBe('archive-detail-panels');
    expect(details).toHaveAttribute('hidden');
    expect(details.getAttribute('style') ?? '').toBe('');
    expect(comments.getAttribute('style') ?? '').toBe('');
  });
  it('snaps back to the same panel when the drag is too short to turn', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 0 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('heading', { name: metadata.title });
    const details = screen.getByRole('tabpanel', { name: '详情' });
    const stage = details.parentElement!;
    const comments = stage.querySelector<HTMLElement>('[role="tabpanel"][aria-label="评论"]')!;

    fireEvent.touchStart(details, { touches: [{ clientX: 240, clientY: 100 }] });
    fireEvent.touchMove(details, { touches: [{ clientX: 220, clientY: 102 }] });
    // 20px 已经越过起手阈值，所以舞台上两块都在，位移也跟手。
    expect(stage.className).toContain('is-sliding');
    expect(details.getAttribute('style')).toContain('translate3d(-20px, 0, 0)');

    fireEvent.touchEnd(details, { touches: [], changedTouches: [{ clientX: 220, clientY: 102 }] });
    // 拖得不够长也不够快：回弹到原来那块，标签页不换。
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    expect(comments).toHaveAttribute('hidden');
    expect(stage.className).toBe('archive-detail-panels');
    expect(details.getAttribute('style') ?? '').toBe('');
  });
  it('stretches a little and holds when there is no panel on that side', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 0 } };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('heading', { name: metadata.title });
    fireEvent.click(screen.getByRole('tab', { name: '评论' }));
    expect(screen.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true');
    const comments = screen.getByRole('tabpanel', { name: '评论' });
    const stage = comments.parentElement!;

    fireEvent.touchStart(comments, { touches: [{ clientX: 240, clientY: 100 }] });
    fireEvent.touchMove(comments, { touches: [{ clientX: 120, clientY: 100 }] });
    const offset = Number(/translate3d\((-?[\d.]+)px/.exec(comments.getAttribute('style') ?? '')?.[1]);
    // 手指拖了 120px，但右边没有面板了：只按阻力挪出一小段，绝不跟着走出整幅空白。
    expect(offset).toBeLessThan(-10);
    expect(offset).toBeGreaterThan(-64);

    fireEvent.touchEnd(comments, { touches: [], changedTouches: [{ clientX: 120, clientY: 100 }] });
    expect(screen.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true');
    expect(stage.className).toBe('archive-detail-panels');
    expect(comments.getAttribute('style') ?? '').toBe('');
  });
  it('labels the final saved page as completed', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: server.scopeId, archiveId: metadata.archiveId, pageIndex: 11, pageCount: 12, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: false } };
      if (command === 'read_favorites_category') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    expect(await screen.findByRole('link', { name: '已读完' })).toBeInTheDocument();
  });

  it('refreshes retained progress, reading-list membership and metadata after synchronization', async () => {
    let pulled = false;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, title: pulled ? 'Updated detail' : metadata.title, pageCount: 0 } };
      if (command === 'list_reading_list') return { ok: true, value: pulled ? [{ scopeId: server.scopeId, archiveId: metadata.archiveId, addedAt: 'now', updatedAt: 'now', deviceId: 'device', revision: 1, deleted: false }] : [] };
      if (command === 'load_reading_progress') return { ok: true, value: pulled ? { scopeId: server.scopeId, archiveId: metadata.archiveId, pageIndex: 0, pageCount: 259, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } : null };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: pulled, favorites: false } };
      if (command === 'read_favorites_category') return { ok: true, value: null };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('heading', { name: metadata.title });
    expect(screen.getByRole('button', { name: '加入待看' })).toBeInTheDocument();
    pulled = true;
    act(() => invalidateRouteCache());
    await screen.findByRole('heading', { name: 'Updated detail' });
    await screen.findByRole('button', { name: '移出待看' });
    fireEvent.click(screen.getByRole('button', { name: '档案菜单' }));
    expect(await screen.findByRole('menuitem', { name: '清除阅读进度' })).toBeInTheDocument();
  });
  it.each([false, true])('places reset in the configured surface and removes duplicated menu actions (toolbar=%s)', async toolbar => {
    let hasProgress = true;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, detailActions: ['read', 'readingList', 'favorites', 'download', 'edit', 'delete', ...(toolbar ? ['clearProgress'] : [])] } };
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, pageCount: 0 } };
      if (command === 'load_reading_progress') return { ok: true, value: hasProgress ? { scopeId: server.scopeId, archiveId: metadata.archiveId, pageIndex: 0, pageCount: 259, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } : null };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: false } };
      if (command === 'read_favorites_category') return { ok: true, value: null };
      if (command === 'clear_reading_progress') { hasProgress = false; return { ok: true, value: null }; }
      if (command === 'list_reading_list' || command === 'list_eh_accounts' || command === 'list_reading_history') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><ToastProvider><PreferencesProvider><ArchiveDetailRoute archiveId={metadata.archiveId} /></PreferencesProvider></ToastProvider></MemoryRouter>);
    await screen.findByRole('heading', { name: metadata.title });
    if (toolbar) await screen.findByRole('button', { name: '清除阅读进度' });
    fireEvent.click(screen.getByRole('button', { name: '档案菜单' }));
    await screen.findByRole('menuitem', { name: '无痕阅读' });
    for (const name of ['阅读', '加入待看', '加入收藏夹', '下载档案', '编辑元数据', '删除档案']) {
      expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument();
    }
    if (toolbar) {
      expect(screen.queryByRole('menuitem', { name: '清除阅读进度' })).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: '清除阅读进度' }));
    } else {
      fireEvent.click(await screen.findByRole('menuitem', { name: '清除阅读进度' }));
    }
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('clear_reading_progress', { scopeId: server.scopeId, archiveId: metadata.archiveId }));
    await screen.findByText('已清除阅读进度和历史记录');
    expect(screen.queryByRole('button', { name: '清除阅读进度' })).not.toBeInTheDocument();
  });
  it.each([false, true])('retires an incognito press or prompt when its page hides (open=%s)', async open => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const content = <MemoryRouter><ArchiveDetailRoute archiveId="archive-a" /></MemoryRouter>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    await screen.findByRole('heading', { name: metadata.title });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(screen.getByRole('link', { name: '阅读' }));
      if (open) act(() => vi.advanceTimersByTime(600));
      view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole('dialog', { name: '无痕阅读', hidden: true })).not.toBeInTheDocument();
      view.rerender(<RetainedPage active>{content}</RetainedPage>);
      act(() => vi.advanceTimersByTime(600));
      expect(screen.queryByRole('dialog', { name: '无痕阅读' })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('rebuilds malformed recommendations from the server', async () => {
    writeRouteCache('recommendations:server-a:archive-a', { similarPool: {}, sameCreator: [], complete: true });
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_reading_history' || command === 'find_missing_archives' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page') return { ok: true, value: { items: [{ serverId: 'server-a', archiveId: 'recommendation', title: 'Recovered recommendation', pageCount: 1, updatedAt: 'now', tags: ['female:big breasts', 'artist:sample artist'] }], total: 1, hasMore: false } };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await screen.findByRole('link', { name: /Recovered recommendation/ });
  });

  it('ignores malformed cached metadata and loads the archive normally', async () => {
    writeRouteCache('archive-detail:last:archive-a', { ...metadata, title: { stale: true } });
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    expect(() => renderDetail()).not.toThrow();
    await screen.findByRole('heading', { name: metadata.title });
  });

  it('serializes downloads per detail and does not keep B busy or unlock it after A completes', async () => {
    const finishes = new Map<string, (value: unknown) => void>();
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, archiveId: args?.archiveId, title: args?.archiveId } };
      if (command === 'download_archive') return new Promise(resolve => { finishes.set(String(args?.archiveId), resolve); });
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    setInvokeAdapterForTests(adapter);
    const view = render(<MemoryRouter><ArchiveDetailRoute archiveId="archive-a" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-a' });
    const download = screen.getByRole('button', { name: '下载档案' });
    act(() => { fireEvent.click(download); fireEvent.click(download); });
    expect(adapter.mock.calls.filter(([command]) => command === 'download_archive')).toHaveLength(1);
    view.rerender(<MemoryRouter><ArchiveDetailRoute archiveId="archive-b" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-b' });
    expect(screen.getByRole('button', { name: '下载档案' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '下载档案' }));
    await act(async () => finishes.get('archive-a')!({ ok: true, value: { status: 'completed', path: 'a.zip', taskId: 'a' } }));
    expect(screen.getByRole('button', { name: '下载档案' })).toBeDisabled();
    await act(async () => finishes.get('archive-b')!({ ok: true, value: { status: 'completed', path: 'b.zip', taskId: 'b' } }));
    expect(screen.getByRole('button', { name: '下载档案' })).toBeEnabled();
  });

  it.each([false, true])('does not carry an incognito press or dialog into the next archive (open=%s)', async open => {
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, archiveId: args?.archiveId, title: args?.archiveId } };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const view = render(<MemoryRouter><ArchiveDetailRoute archiveId="archive-a" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-a' });
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(screen.getByRole('link', { name: '阅读' }));
      if (open) act(() => vi.advanceTimersByTime(600));
      view.rerender(<MemoryRouter><ArchiveDetailRoute archiveId="archive-b" /></MemoryRouter>);
      act(() => vi.advanceTimersByTime(600));
    } finally { vi.useRealTimers(); }
    await screen.findByRole('heading', { name: 'archive-b', hidden: true });
    expect(screen.queryByRole('dialog', { name: '无痕阅读' })).not.toBeInTheDocument();
  });

  it('retries a failed metadata load without leaving the detail route', async () => {
    let reads = 0;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return ++reads === 1
        ? { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '详情读取暂时失败', retryable: true } }
        : { ok: true, value: metadata };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('详情读取暂时失败');
    fireEvent.click(screen.getByRole('button', { name: '重试加载详情' }));
    expect(await screen.findByRole('heading', { name: 'Archive detail' })).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it('does not apply a pending reading-list mutation to another archive', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, archiveId: args?.archiveId, title: args?.archiveId } };
      if (command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'set_reading_list') return new Promise(resolve => { finish = resolve; });
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const view = render(<MemoryRouter><ArchiveDetailRoute archiveId="archive-a" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-a' });
    fireEvent.click(screen.getByRole('button', { name: '加入待看' }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<MemoryRouter><ArchiveDetailRoute archiveId="archive-b" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-b' });
    await act(async () => finish({ ok: true, value: { scopeId: 'scope-a', archiveId: 'archive-a', addedAt: '2026-10-15', updatedAt: '2026-10-15', deviceId: 'device-a', revision: 1, deleted: false } }));
    expect(screen.getByRole('button', { name: '加入待看' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('ignores an A favorite completion after B membership has loaded', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, archiveId: args?.archiveId, title: args?.archiveId } };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'fav', archives: [] } };
      if (command === 'add_archive_to_category') return pending;
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    const view = render(<MemoryRouter><ArchiveDetailRoute archiveId="archive-a" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '收藏' }));
    view.rerender(<MemoryRouter><ArchiveDetailRoute archiveId="archive-b" /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'archive-b' });
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).not.toBeDisabled());
    await act(async () => finish({ ok: true, value: { operation: 'add_to_category', success: 1 } }));
    expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('refreshes its heart after a favorite write on another surface', async () => {
    let favorite = false;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'read_favorites_category') return { ok: true, value: { id: 'fav', archives: favorite ? ['archive-a'] : [] } };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).not.toBeDisabled());
    favorite = true;
    act(() => invalidateRouteCache('favorites:'));
    expect(await screen.findByRole('button', { name: '取消收藏' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('paints the last detail snapshot before server lookup completes', async () => {
    const cached = { ...metadata, title: 'Cached detail' };
    writeRouteCache('archive-detail:last:archive-a', cached);
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return new Promise(() => undefined);
      if (command === 'list_watchlist' || command === 'list_categories') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: [] };
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
      if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
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
      if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive detail封面大图' })).not.toBeInTheDocument());
  });

  it('links translated detail tags to an exact library search', async () => {
    installTagTranslations({ female: { 'big breasts': '巨乳' } });
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: metadata };
      if (command === 'list_watchlist' || command === 'list_categories' || command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: true, value: [] };
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
          ? { ok: true, value: [0x89, 0x50, 0x4e, 0x47] }
          : { ok: true, value: [] };
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
      if (command === 'cache_read_image') return { ok: true, value: [] };
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

  it('keeps the cached detail on screen while the server is unreachable', async () => {
    // 之前访问过这一份档案（两份快照都在），然后服务器离线：这就是用户报的
    // 「点开缓存里的档案，整个页面变成一块纯色」。
    writeRouteCache('archive-detail:last:archive-a', { ...metadata, title: '离线缓存' });
    writeRouteCache('archive-detail:last:server-a:archive-a', { ...metadata, title: '离线缓存' });
    writeRouteCache('archive-detail:server-a:archive-a', { ...metadata, title: '离线缓存' });
    const offline = { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '服务器连不上', retryable: true } };
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      // 本地那几条（账户、书架记录）照常回答，远端的一律失败。
      if (command === 'list_categories') return { ok: true, value: [] };
      return offline;
    });

    renderDetail();

    expect(await screen.findByRole('heading', { name: '离线缓存' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: '档案操作' })).toBeInTheDocument();
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
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'search_archives_page' || command === 'list_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
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
      if (command === 'search_archives_page' || command === 'list_archives_page') {
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
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    const similar = await screen.findByRole('region', { name: '推荐' });
    expect(await within(similar).findByRole('link', { name: /Strong match/ })).toBeInTheDocument();
    // Sharing only a zero-weight namespace is not a recommendation.
    expect(within(similar).queryByRole('link', { name: /Weak match/ })).not.toBeInTheDocument();

    // Same-creator results live behind a tab in the same rail, so the section
    // costs one card row instead of two.
    const creatorTab = await screen.findByRole('tab', { name: '同作者' });
    fireEvent.click(creatorTab);
    expect(await within(similar).findByRole('link', { name: /By same artist/ })).toBeInTheDocument();
    expect(within(similar).queryByRole('link', { name: /Strong match/ })).not.toBeInTheDocument();

    expect(await screen.findByRole('region', { name: '页面缩略图' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '推荐' })).toBeInTheDocument();
  });

  it('reads 推荐 before the searches land, and grows the creator tab out of it', async () => {
    // The heading used to be 猜你喜欢 until the results arrived, and only then
    // turned into tabs — so the same section announced two different names.
    const releases: Array<() => void> = [];
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
      if (command === 'search_archives_page' || command === 'list_archives_page') {
        const query = String((args?.input as { query?: string } | undefined)?.query ?? '');
        await new Promise<void>((resolve) => { releases.push(resolve); });
        const rows = query.startsWith('artist:')
          ? [{ serverId: 'scope-a', archiveId: 'by-same-artist', title: 'By same artist', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['artist:someone'] }]
          : [{ serverId: 'scope-a', archiveId: 'strong', title: 'Strong match', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'female:futanari', 'category:manga'] }];
        return { ok: true, value: { items: rows, total: rows.length, hasMore: false } };
      }
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_tasks') return { ok: true, value: [] };
      throw new Error(`Unexpected command: ${command}`);
    });

    renderDetail();

    // While the searches are in flight the strip is already there, reading 推荐,
    // with the creator segment collapsed out of the tab order.
    const rail = await screen.findByRole('region', { name: '推荐' });
    expect(within(rail).getByRole('tab', { name: '推荐' })).toHaveAttribute('aria-selected', 'true');
    // Out of the accessibility tree as well as out of the tab order, so the name
    // is not even computable — assert the DOM state directly.
    const creatorTab = rail.querySelector('.archive-recommendations-tab-creator');
    const initialTabs = rail.querySelector('[role="tablist"]');
    const initialGrid = rail.querySelector('.archive-rail-grid');
    const initialRefresh = within(rail).getByRole('button', { name: '刷新推荐' });
    expect(initialRefresh).toBeDisabled();
    expect(creatorTab).toBeDisabled();
    expect(creatorTab).toHaveAttribute('aria-hidden', 'true');
    expect(creatorTab).toHaveAttribute('tabindex', '-1');

    act(() => releases.forEach((release) => release()));
    await vi.waitFor(() => expect(within(rail).getByRole('tab', { name: '同作者' })).toBeEnabled());
    // The strip carries the class the width animation keys off.
    expect(document.querySelector('.archive-recommendations-tabs.has-creator')).not.toBeNull();
    expect(screen.getByRole('region', { name: '推荐' })).toBe(rail);
    expect(rail.querySelector('[role="tablist"]')).toBe(initialTabs);
    expect(rail.querySelector('.archive-rail-grid')).toBe(initialGrid);
    expect(within(rail).getByRole('button', { name: '刷新推荐' })).toBe(initialRefresh);
    expect(initialRefresh).toBeEnabled();
    // tablist 的直接子节点只能是自己就是 tab 的、或者标了 presentation/none 的纯包装：
    // 中间夹一个没有角色的通用节点，读屏就可能不再把创建者那个 tab 算作这条 tablist 的
    // 页签（testing-library 不看归属，所以光靠 getByRole 发现不了）。宽度动画那个 span
    // 就是这种包装，它必须自己声明没有语义。
    const tablist = rail.querySelector('.archive-recommendations-tabs');
    expect(tablist).not.toBeNull();
    for (const child of Array.from(tablist!.children)) {
      expect(
        ['tab', 'presentation', 'none'],
        `tablist 的子节点 ${child.className || child.tagName} 缺少角色：包装节点要写 role="presentation"`,
      ).toContain(child.getAttribute('role'));
    }
    expect(tablist!.querySelector('.archive-recommendations-tab-creator')).not.toBeNull();
  });

  it('requests page thumbnails only when they approach the viewport', async () => {
    const OriginalObserver = window.IntersectionObserver;
    const observed: Array<() => void> = [];
    // 共享观察器（全页面一个实例）的语义：observe 一个节点产生一次可触发的
    // 回调注册，而不是构造实例时触发一次。
    window.IntersectionObserver = class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(node: Element) {
        observed.push(() => this.callback([{ isIntersecting: true, target: node } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
      }
      disconnect() {}
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
      if (command === 'cache_read_image') return { ok: true, value: [] };
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
      if (command === 'get_eh_comments') return { ok: true, value: [{ id: 'comment-link', author: 'Reader', body: 'https://exhentai.org/g/4256859/531b16d2ae/', score: 1, postedAt: '', isUploader: false, isEditable: false, myVote: 0 }] };
      if (command === 'cache_read_image') return { ok: true, value: [] };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'No cover', retryable: true } };
      if (command === 'search_archives_page' || command === 'list_archives_page') return { ok: true, value: { items: [{ serverId: server.id, archiveId: 'matched', title: 'Matched archive', pageCount: 1, updatedAt: 'now' }], total: 1, hasMore: false } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    function Target() {
      const location = useLocation();
      return <p>{`Linked archive ${location.pathname}${location.search}`}</p>;
    }
    render(<MemoryRouter initialEntries={['/home/archive-a?server=server-a']}><Routes>
      <Route path="/home/archive-a" element={<ArchiveDetailRoute archiveId="archive-a" detailBasePath="/home" />} />
      <Route path="/home/matched" element={<Target />} />
    </Routes></MemoryRouter>);
    await vi.waitFor(() => expect(adapter.mock.calls.some(([command]) => command === 'get_eh_comments')).toBe(true));
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('search_archives_page', { input: expect.objectContaining({ serverId: server.id, query: '/g/4256859/531b16d2ae' }) }));
    expect(screen.getByRole('tab', { name: '详情' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(await screen.findByRole('tab', { name: '评论' }));
    expect(await screen.findByRole('region', { name: 'E-Hentai 评论' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '页面缩略图' })).not.toBeInTheDocument();
    const comments = screen.getByRole('region', { name: 'E-Hentai 评论' });
    fireEvent.click(screen.getByRole('tab', { name: '详情' }));
    fireEvent.click(screen.getByRole('tab', { name: '评论' }));
    expect(screen.getByRole('region', { name: 'E-Hentai 评论' })).toBe(comments);
    expect(adapter.mock.calls.filter(([command]) => command === 'get_eh_comments')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: 'https://exhentai.org/g/4256859/531b16d2ae/' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '打开档案详情' }));
    expect(await screen.findByText('Linked archive /home/matched?server=server-a')).toBeInTheDocument();
  });

  it('keeps both detail tabs available when the E-Hentai account is not verified', async () => {
    setInvokeAdapterForTests(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'source:https://e-hentai.org/g/12345/abc/' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'list_eh_accounts') return { ok: true, value: [{ id: 'eh-a', label: 'EH', host: 'e-hentai.org', cookieRef: 'ref', isActive: true, status: 'error', createdAt: '', updatedAt: '' }] };
      if (command === 'cache_read_image') return { ok: true, value: [] };
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
      if (command === 'search_archives_page' || command === 'list_archives_page') return { ok: true, value: { items: [
        { serverId: server.id, archiveId: 'gone', title: 'Gone recommendation', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] },
        { serverId: server.id, archiveId: 'kept', title: 'Kept recommendation', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] },
      ], total: 2, hasMore: false } };
      if (command === 'verify_archives_exist') return { ok: true, value: ['gone'] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command} ${(args as any)?.input ?? ''}`);
    });
    renderDetail();
    const rail = await screen.findByRole('region', { name: '推荐' });
    expect(within(rail).getByRole('link', { name: /Kept recommendation/ })).toBeInTheDocument();
    expect(within(rail).queryByRole('link', { name: /Gone recommendation/ })).not.toBeInTheDocument();
  });

  it('keeps recommendation cards inside the page that owns the detail', async () => {
    // 推荐条里的卡片从前一律指向 `/library/:id`：首页或书架的详情栏点一条推荐，
    // 左边那一栏会跟着换成档案库——与「谁的详情谁来持有」正好相反。
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page' || command === 'list_archives_page') return { ok: true, value: { items: [
        { serverId: server.id, archiveId: 'kept', title: 'Kept recommendation', pageCount: 2, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] },
      ], total: 1, hasMore: false } };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    renderDetail('/home');
    const rail = await screen.findByRole('region', { name: '推荐' });
    expect(await within(rail).findByRole('link', { name: /Kept recommendation/ })).toHaveAttribute('href', '/home/kept?server=server-a');
  });

  it('reuses the recommendations it already searched for on a second visit', async () => {
    // The rail costs up to a dozen searches on the server, and the answer for one
    // archive does not change minute to minute.
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'artist:someone, female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page' || command === 'list_archives_page') {
        const query = String((args?.input as { query?: string } | undefined)?.query ?? '');
        return { ok: true, value: {
          items: [{ serverId: server.id, archiveId: `for-${query}`, title: `命中 ${query}`, pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: [query] }],
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
    await screen.findByRole('region', { name: '推荐' });
    const searchesSoFar = () => adapter.mock.calls.filter(([command]) => command === 'search_archives_page').length;
    await vi.waitFor(() => expect(searchesSoFar()).toBeGreaterThan(0));
    const searches = searchesSoFar();
    first.unmount();

    const second = renderDetail();
    const rail = await screen.findByRole('region', { name: '推荐' });
    // A cached rail arrives with its cards already in it; one that had to search
    // again would still be a skeleton at this point.
    expect(within(rail).getByRole('link', { name: /命中/ })).toBeInTheDocument();
    expect(searchesSoFar()).toBe(searches);
    second.unmount();
  });

  it('pages a seed on the server instead of trusting one page of the local mirror', async () => {
    // 同作者栏从前问的是本地镜像的第一页，而镜像只有同步过的那部分：「有时获取同作者
    // 档案不全」就是这两条叠出来的。现在一个种子在服务端按 `has_more` 往后翻，第二页
    // 里的档案照样进候选池。
    const pageOf = (start: number) => [
      { serverId: server.id, archiveId: `page-${start}-a`, title: `次要 ${start}`, pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'artist:someone'] },
      { serverId: server.id, archiveId: `page-${start}-b`, title: `重点 ${start}`, pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'female:futanari'] },
    ];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        const start = Number((args?.input as { start?: number } | undefined)?.start ?? 0);
        return { ok: true, value: { items: pageOf(start), total: 6, hasMore: start === 0 } };
      }
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderDetail('/home');
    const rail = await screen.findByRole('region', { name: '推荐' });
    // 第二页那条只可能来自第二次请求：只读第一页的话它根本不在候选里。
    expect(await within(rail).findByRole('link', { name: /重点 2/ })).toBeInTheDocument();
    expect(within(rail).getByRole('link', { name: /次要 0/ })).toBeInTheDocument();
    // 第二页是靠条目偏移翻出来的（第一页两条 → 下一页 start=2），不是把第一页又读一遍。
    expect(adapter.mock.calls.filter(([command, callArgs]) => command === 'search_archives_page'
      && (callArgs?.input as { start?: number }).start === 2)).toHaveLength(1);
  });

  it('searches again when the cached answer came back short', async () => {
    // 取数被截断（页数用满、半途失败或整段走了镜像）时写下的缓存只是先把上一次的答案
    // 画出来：它不能把短答案在这里钉一天，下一次进详情页要在后台补齐。
    let round = 0;
    const gates: Array<() => void> = [];
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page') {
        const start = Number((args?.input as { start?: number } | undefined)?.start ?? 0);
        if (start === 0) round += 1;
        // 把补齐那次搜索的第一页闸住：不闸的话它在同一串微任务里就换完答案了，
        // 「缓存先画、后台再补」这一段根本观察不到。
        if (round > 1 && start === 0) await new Promise<void>((resolve) => gates.push(resolve));
        return { ok: true, value: {
          items: [{ serverId: server.id, archiveId: `r${round}-${start}`, title: `第 ${round} 轮 ${start}`, pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses'] }],
          total: 60,
          hasMore: true,
        } };
      }
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const first = renderDetail('/home');
    const rail = await screen.findByRole('region', { name: '推荐' });
    expect(await within(rail).findByRole('link', { name: /第 1 轮 0/ })).toBeInTheDocument();
    // 这一轮被页数上限截断了，写下的快照必须自己承认「这份答案可能是短的」。
    expect(readRouteCache<{ complete?: boolean }>('recommendations:server-a:archive-a')?.complete).toBe(false);
    first.unmount();

    const second = renderDetail('/home');
    const secondRail = await screen.findByRole('region', { name: '推荐' });
    // 缓存先把上一轮那几张摆出来（补齐的搜索还卡在网线上）。
    await waitFor(() => expect(round).toBe(2));
    expect(within(secondRail).getByRole('link', { name: /第 1 轮 0/ })).toBeInTheDocument();
    // ……松手之后，后台那次搜索换上补齐的答案。
    await act(async () => { gates.splice(0).forEach((release) => release()); });
    expect(await within(secondRail).findByRole('link', { name: /第 2 轮 0/ })).toBeInTheDocument();
    second.unmount();
  });

  it('re-ranks the cached pool for this visit instead of replaying one frozen order', async () => {
    // 池子留在快照里是为了省掉重复搜索；面板那十几张每次进详情页都按本次的种子重排。
    // 少了这一层，24 小时快照会把推荐栏钉成同一份，用户看到的就是「每次进来都一样」。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') {
        return { ok: true, value: { ...metadata, tags: 'female:glasses, female:tie-a, female:tie-b' } };
      }
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page') return { ok: true, value: { items: [
        { serverId: server.id, archiveId: 'tie-a', title: '并列 A', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'female:tie-a'] },
        { serverId: server.id, archiveId: 'tie-b', title: '并列 B', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['female:glasses', 'female:tie-b'] },
      ], total: 2, hasMore: false } };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const orderIn = (rail: HTMLElement) => within(rail).getAllByRole('link')
      .map((node) => /并列 [AB]/.exec(node.textContent ?? '')?.[0] ?? '')
      .filter(Boolean)
      .join(',');

    vi.spyOn(Math, 'random').mockReturnValue(0.13);
    const first = renderDetail('/home');
    const firstRail = await screen.findByRole('region', { name: '推荐' });
    await within(firstRail).findByRole('link', { name: /并列 A/ });
    const firstOrder = orderIn(firstRail);
    const searches = adapter.mock.calls.filter(([command]) => command === 'search_archives_page').length;
    await act(async () => { first.unmount(); });

    vi.spyOn(Math, 'random').mockReturnValue(0.79);
    renderDetail('/home');
    const secondRail = await screen.findByRole('region', { name: '推荐' });
    await within(secondRail).findByRole('link', { name: /并列 A/ });
    expect(orderIn(secondRail)).not.toEqual(firstOrder);
    // 换的是面板次序，不是取数：快照完整时一次搜索都不该再打。
    expect(adapter.mock.calls.filter(([command]) => command === 'search_archives_page').length).toBe(searches);
  });

  it('asks the local mirror with the search term when the server cannot answer', async () => {
    // 服务端答不上时回退问镜像，但条件要跟着走：从前这条回退把 query 丢了，答的是「库里
    // 最新的一百条」，调用方按精确标签一筛就什么都不剩——同作者栏会突然空掉。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [server] };
      if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'artist:someone, female:glasses' } };
      if (command === 'list_watchlist' || command === 'list_reading_list') return { ok: true, value: [] };
      if (command === 'search_archives_page') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '对面没答上', retryable: true } };
      if (command === 'list_archives_page') return { ok: true, value: { items: [
        { serverId: server.id, archiveId: 'mirrored', title: '镜像里的同作者', pageCount: 4, updatedAt: '2026-08-28T00:00:00Z', tags: ['artist:someone'] },
      ], total: 1, hasMore: false } };
      if (command === 'verify_archives_exist') return { ok: true, value: [] };
      if (command === 'cache_read_image') return { ok: false, error: { code: 'LRR_NOT_FOUND', message: 'no cover', retryable: false } };
      if (command === 'load_archive_thumbnail') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'no cover', retryable: true } };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    renderDetail('/home');
    const rail = await screen.findByRole('region', { name: '推荐' });
    fireEvent.click(await screen.findByRole('tab', { name: '同作者' }));
    expect(await within(rail).findByRole('link', { name: /镜像里的同作者/ })).toBeInTheDocument();
  });
});

it('retains detail DOM and thumbnail requests across repeated tab switches', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'load_archive_metadata') return { ok: true, value: { ...metadata, tags: 'category:manga, uploader:sample, female:example', pageCount: 1 } };
    if (command === 'cache_read_image') return { ok: true, value: [255, 216, 255, 224] };
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
    if (command === 'cache_read_image') return { ok: true, value: [] };
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
