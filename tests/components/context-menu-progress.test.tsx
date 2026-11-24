import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useArchiveContextMenu } from '../../src/components/useArchiveContextMenu';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

function Harness() {
  const menu = useArchiveContextMenu();
  return <><button onClick={() => menu.open({ serverId: 'server', archiveId: 'archive', title: 'Test', pageCount: 10, updatedAt: '' }, { x: 20, y: 20 })}>Open</button>{menu.menu}</>;
}
afterEach(() => {
  resetInvokeAdapterForTests();
  invalidateLrrBridgeConfig();
  vi.restoreAllMocks();
});
it.each(['servers', 'favorites'] as const)('keeps the original lookup alive when a native contextmenu repeats the hold during %s', async (pendingStage) => {
  const serverResult = { ok: true as const, value: [{ id: 'server', scopeId: 'scope', name: 'Test', baseUrl: 'https://example.com', enabled: true }] };
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(NativeLibraryRepository.prototype, 'listServers').mockImplementation(async () => {
    if (pendingStage === 'servers') await gate;
    return serverResult;
  });
  vi.spyOn(NativeLibraryRepository.prototype, 'archiveMembership').mockResolvedValue({ ok: true, value: { reading: false, favorites: false } });
  vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockImplementation(async () => {
    if (pendingStage === 'favorites') await gate;
    return { ok: true, value: null };
  });
  vi.spyOn(NativeLibraryRepository.prototype, 'loadReadingStatus').mockResolvedValue({ ok: true, value: { progress: null, hasHistory: false } });
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getByRole('menuitem', { name: '加入收藏夹' })).not.toHaveAttribute('data-disabled'));
  expect(screen.getByRole('menu')).toBeInTheDocument();
});
it('prepares the progress action before mounting the menu', async () => {
  vi.spyOn(NativeLibraryRepository.prototype, 'listServers').mockResolvedValue({ ok: true, value: [{ id: 'server', scopeId: 'scope', name: 'Test', baseUrl: 'https://example.com', enabled: true }] });
  vi.spyOn(NativeLibraryRepository.prototype, 'archiveMembership').mockResolvedValue({ ok: true, value: { reading: false, favorites: false } });
  vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockResolvedValue({ ok: true, value: null });
  let resolve!: (value: Awaited<ReturnType<NativeLibraryRepository['loadReadingStatus']>>) => void;
  vi.spyOn(NativeLibraryRepository.prototype, 'loadReadingStatus').mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await act(async () => { resolve({ ok: true, value: { progress: { scopeId: 'scope', archiveId: 'archive', pageIndex: 1, pageCount: 10, updatedAt: '', layout: 'paged', direction: 'ltr', revision: 1 }, hasHistory: true } }); });
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /清除阅读进度/ })).toBeInTheDocument();
});


it('can clear a first-page visit imported from LANraragi history alone', async () => {
  vi.spyOn(NativeLibraryRepository.prototype, 'listServers').mockResolvedValue({ ok: true, value: [{ id: 'server', scopeId: 'scope', name: 'Test', baseUrl: 'https://example.com', enabled: true }] });
  vi.spyOn(NativeLibraryRepository.prototype, 'readFavoritesCategory').mockResolvedValue({ ok: true, value: null });
  let state = { archiveId: 'archive', version: 1, generation: 0, progress: null, historyAt: 'now' as string | null, watchlistAt: null, historyPageIndex: 0 as number | undefined };
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
    if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: false } };
    if (args?.action === 'states') return { ok: true, value: { protocol: 1, serverId: 'server', epoch: 'epoch', version: state.version, states: [state] } };
    if (args?.action === 'apply') {
      expect(args.input).toEqual({ operation: { archiveId: 'archive', kind: 'progress_clear' } });
      state = { ...state, version: 2, generation: 1, historyAt: null, historyPageIndex: undefined };
      return { ok: true, value: { state, queued: true } };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter><Harness /></MemoryRouter>);
  fireEvent.click(screen.getByText('Open'));
  fireEvent.click(await screen.findByRole('menuitem', { name: '清除阅读进度' }));
  await waitFor(() => expect(state.historyAt).toBeNull());
  fireEvent.click(screen.getByText('Open'));
  await screen.findByRole('menuitem', { name: '无痕阅读' });
  expect(screen.queryByRole('menuitem', { name: '清除阅读进度' })).not.toBeInTheDocument();
});
