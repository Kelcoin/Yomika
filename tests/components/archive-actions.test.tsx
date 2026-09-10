import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useArchiveContextMenu } from '../../src/components/useArchiveContextMenu';
import { ArchiveDeleteDialog } from '../../src/components/ArchiveDeleteDialog';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);
const archive = { archiveId: 'a', serverId: 's', title: 'Archive', pageCount: 10, updatedAt: 'now' };
function Menu() {
  const { open, menu } = useArchiveContextMenu();
  return <><button onClick={() => open(archive, { x: 100, y: 100 })}>打开菜单</button>{menu}</>;
}

describe('archive actions', () => {
  it('shows independent list memberships and sends the archive download command', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'S', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_reading_list') return { ok: true, value: [{ scopeId: 'scope', archiveId: 'a', addedAt: 'now', updatedAt: 'now', deviceId: 'd', revision: 1, deleted: false }] };
      if (command === 'list_watchlist') return { ok: true, value: [] };
      if (command === 'download_archive') return { ok: true, value: 'E:\\Comics\\a.zip' };
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
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['load_preferences', 'delete_archive']);
  });
});
