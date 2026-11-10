import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useArchiveContextMenu } from '../../src/components/useArchiveContextMenu';
import { ArchiveDeleteDialog } from '../../src/components/ArchiveDeleteDialog';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { RetainedPage } from '../../src/app/RetainedPage';
import { invalidateRouteCache } from '../../src/lib/routeCache';

afterEach(resetInvokeAdapterForTests);
const archive = { archiveId: 'a', serverId: 's', title: 'Archive', pageCount: 10, updatedAt: 'now' };
function Menu() {
  const { open, menu } = useArchiveContextMenu();
  return <><button onClick={() => open(archive, { x: 100, y: 100 })}>打开菜单</button>{menu}</>;
}

describe('archive actions', () => {
  it('refreshes an already open menu when synchronization changes membership', async () => {
    let reading = false;
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      if (command === 'get_archive_membership') return { ok: true, value: { reading, favorites: false } };
      return { ok: true, value: null };
    });
    render(<MemoryRouter><Menu /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '加入待看' })).not.toHaveAttribute('aria-disabled'));
    reading = true;
    act(() => invalidateRouteCache());
    expect(await screen.findByRole('menuitem', { name: '移出待看' })).toBeInTheDocument();
  });
  it('offers local progress reset while the remote favorites service is still pending', async () => {
    setInvokeAdapterForTests(async command => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      if (command === 'read_favorites_category') return new Promise(() => {});
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope', archiveId: 'a', pageIndex: 0, pageCount: 259, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } };
      return { ok: true, value: { reading: false, favorites: false } };
    });
    render(<MemoryRouter><Menu /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(await screen.findByRole('menuitem', { name: '清除阅读进度' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '加入收藏夹' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('clears progress and history together only for a previously read archive', async () => {
    let read = true;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: false } };
      if (command === 'load_reading_progress') return { ok: true, value: read ? { scopeId: 'scope', archiveId: 'a', pageIndex: 0, pageCount: 259, layout: 'paged', direction: 'ltr', updatedAt: 'now', revision: 1 } : null };
      if (command === 'clear_reading_progress') { read = false; return { ok: true, value: null }; }
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><ToastProvider><Menu /></ToastProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '清除阅读进度' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('clear_reading_progress', { scopeId: 'scope', archiveId: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    await waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'load_reading_progress').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('menuitem', { name: '清除阅读进度' })).not.toBeInTheDocument();
  });
  it('closes a context menu when its retained page hides without a local route change', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: [] }));
    const content = <MemoryRouter><Menu /></MemoryRouter>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    fireEvent.click(screen.getByRole('button', { name: '打开菜单' }));
    await screen.findByRole('menu');
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument();
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes retained menus and pending deletion when navigating to another scope', async () => {
    let navigate!: ReturnType<typeof useNavigate>;
    let finish!: (value: unknown) => void;
    const deleted = vi.fn();
    setInvokeAdapterForTests(async command => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'delete_archive') return new Promise(resolve => { finish = resolve; });
      return { ok: true, value: [] };
    });
    function RetainedMenu() {
      navigate = useNavigate();
      const { open, menu, requestDelete } = useArchiveContextMenu({ onDeleted: deleted });
      return <><button onClick={() => open(archive, { x: 100, y: 100 })}>Open</button><button onClick={() => requestDelete(archive)}>Delete</button>{menu}</>;
    }
    render(<MemoryRouter initialEntries={['/library?server=A']}><RetainedMenu /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('menu');
    act(() => navigate('/library?server=B'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => navigate('/to-read?server=B'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => finish({ ok: true, value: null }));
    expect(deleted).not.toHaveBeenCalled();
  });

  it('starts a new deletion confirmation for B and ignores the old A completion', async () => {
    let finish!: (value: unknown) => void;
    const deletedA = vi.fn();
    const closeA = vi.fn();
    const closeB = vi.fn();
    setInvokeAdapterForTests(async command => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'delete_archive') return new Promise(resolve => { finish = resolve; });
      throw new Error(command);
    });
    const view = render(<ArchiveDeleteDialog archive={archive} onClose={closeA} onDeleted={deletedA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<ArchiveDeleteDialog archive={{ ...archive, archiveId: 'b', title: 'B' }} onClose={closeB} onDeleted={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
    await act(async () => finish({ ok: true, value: null }));
    expect(deletedA).not.toHaveBeenCalled();
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('「B」');
  });

  it('allows retrying failed deletion preferences without closing the confirmation', async () => {
    let reads = 0;
    const deleted = vi.fn();
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return ++reads === 1
        ? { ok: false, error: { code: 'LOCAL_DATABASE', message: '设置暂不可用', retryable: true } }
        : { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      return { ok: true, value: null };
    });
    const user = userEvent.setup();
    render(<ToastProvider><ArchiveDeleteDialog archive={archive} onClose={vi.fn()} onDeleted={deleted} /></ToastProvider>);
    expect(await screen.findByRole('button', { name: '重新加载设置' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重新加载设置' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
  });

  it('does not put a completed mutation for one archive into the next open menu', async () => {
    const user = userEvent.setup();
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: false } };
      if (command === 'read_favorites_category') return { ok: true, value: null };
      if (command === 'set_reading_list') return new Promise((resolve) => { finish = resolve; });
      throw new Error(command);
    });
    function Menus() {
      const { open, menu } = useArchiveContextMenu();
      return <><button onClick={() => open(archive, { x: 100, y: 100 })}>First</button><button onClick={() => open({ ...archive, archiveId: 'b', title: 'Second' }, { x: 100, y: 100 })}>Second</button>{menu}</>;
    }
    render(<MemoryRouter><Menus /></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: 'First' }));
    await user.click(await screen.findByRole('menuitem', { name: '加入待看' }));
    await waitFor(() => expect(finish).toBeDefined());
    await user.click(screen.getByRole('button', { name: 'Second' }));
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '加入待看' })).toBeEnabled());
    await act(async () => { finish({ ok: true, value: { scopeId: 'scope', archiveId: 'a', addedAt: 'now', updatedAt: 'now', deviceId: 'device', revision: 1, deleted: false } }); });
    expect(screen.getByRole('menuitem', { name: '加入待看' })).toBeEnabled();
  });

  it('shows independent list memberships and sends the archive download command', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      // 右键菜单现在用单点 membership 探针，不再拉全量列表。
      if (command === 'get_archive_membership') return { ok: true, value: { reading: true, favorites: false } };
      if (command === 'download_archive') return { ok: true, value: { status: 'completed', path: 'E:\\Comics\\a.zip', taskId: 'task-1' } };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><ToastProvider><Menu /></ToastProvider></MemoryRouter>);
    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    expect(await screen.findByRole('menuitem', { name: '移出待看' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '加入收藏夹' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '删除档案' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '下载档案' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('download_archive', { serverId: 's', archiveId: 'a' }));
    expect(await screen.findByText('下载完成：E:\\Comics\\a.zip')).toBeInTheDocument();
  });

  it('requires the drawn confirmation and permits opting out of favorite sync', async () => {
    const deleted = vi.fn();
    const closed = vi.fn();
    const adapter = vi.fn(async (command: string) => command === 'load_preferences'
      ? { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: true } }
      : { ok: true, value: null });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><ArchiveDeleteDialog archive={archive} onClose={closed} onDeleted={deleted} /></ToastProvider>);
    const toggle = await screen.findByRole('switch', { name: '本次同步删除 E-Hentai 收藏' });
    expect(screen.getByRole('dialog')).toHaveClass('dialog-content');
    expect(adapter.mock.calls.some(([command]) => command === 'delete_archive')).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
    expect(closed).toHaveBeenCalledTimes(1);
    // 打开时顺带读一次 E-Hentai 账户：这次关了开关，所以只有删除命令。
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['load_preferences', 'list_eh_accounts', 'delete_archive']);
  });
});
