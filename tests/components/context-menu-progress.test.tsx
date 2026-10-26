import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useArchiveContextMenu } from '../../src/components/useArchiveContextMenu';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

function Harness() {
  const menu = useArchiveContextMenu();
  return <><button onClick={() => menu.open({ serverId: 'server', archiveId: 'archive', title: 'Test', pageCount: 10, updatedAt: '' }, { x: 20, y: 20 })}>Open</button>{menu.menu}</>;
}
afterEach(() => vi.restoreAllMocks());
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
  vi.spyOn(NativeLibraryRepository.prototype, 'loadProgress').mockResolvedValue({ ok: true, value: null });
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
  let resolve!: (value: Awaited<ReturnType<NativeLibraryRepository['loadProgress']>>) => void;
  vi.spyOn(NativeLibraryRepository.prototype, 'loadProgress').mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<MemoryRouter><Harness /></MemoryRouter>);
  await act(async () => { fireEvent.click(screen.getByText('Open')); });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await act(async () => { resolve({ ok: true, value: { scopeId: 'scope', archiveId: 'archive', pageIndex: 1, pageCount: 10, updatedAt: '', layout: 'paged', direction: 'ltr', revision: 1 } }); });
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: /清除阅读进度/ })).toBeInTheDocument();
});
