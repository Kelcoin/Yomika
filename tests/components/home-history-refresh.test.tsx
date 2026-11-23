import { setInvokeAdapterForTests } from '../localReadingDataAdapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { invalidateRouteCache, writeRouteCache } from '../../src/lib/routeCache';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);
it('refreshes each home shelf independently and brings a new history head into view', async () => {
  const server = { id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com', enabled: true };
  let ids = ['old'];
  let historyCalls = 0;
  let readingCalls = 0;
  let release: (() => void) | undefined;
  let hold: 'history' | 'reading' | undefined;
  setInvokeAdapterForTests(async (command, args) => {
    if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_reading_history') {
      historyCalls++;
      if (hold === 'history') await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, value: ids.map(archiveId => ({ scopeId: 's', archiveId, pageIndex: 1, visitedAt: '2026-10-16', deviceId: 'd', revision: 1 })) };
    }
    if (command === 'list_reading_list') {
      readingCalls++;
      if (hold === 'reading') await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, value: [{ scopeId: 's', archiveId: 'pending', addedAt: 'now', updatedAt: 'now', deviceId: 'd', revision: 1, deleted: false }] };
    }
    if (command === 'list_archives_by_ids') return { ok: true, value: (args?.archiveIds as string[]).map(archiveId => ({ serverId: 's', archiveId, title: archiveId, pageCount: 20, updatedAt: 'now' })) };
    return { ok: true, value: [] };
  });
  render(<MemoryRouter><PreferencesProvider><ToastProvider><WorkspaceRoutes /></ToastProvider></PreferencesProvider></MemoryRouter>);
  await screen.findByText('old');
  const historyButton = screen.getByRole('button', { name: '刷新继续阅读' });
  const readingButton = screen.getByRole('button', { name: '刷新待看档案' });
  await waitFor(() => expect(readingButton).toBeEnabled());
  const beforeReading = readingCalls;
  hold = 'history';
  fireEvent.click(historyButton);
  await waitFor(() => expect(historyButton).toBeDisabled());
  expect(readingButton).toBeEnabled();
  expect(readingCalls).toBe(beforeReading);
  await waitFor(() => expect(release).toBeDefined());
  hold = undefined;
  await act(async () => release?.());
  await waitFor(() => expect(historyButton).toBeEnabled());
  const beforeHistory = historyCalls;
  release = undefined;
  hold = 'reading';
  fireEvent.click(readingButton);
  await waitFor(() => expect(readingButton).toBeDisabled());
  expect(historyButton).toBeEnabled();
  expect(historyCalls).toBe(beforeHistory);
  await waitFor(() => expect(release).toBeDefined());
  hold = undefined;
  await act(async () => release?.());
  await waitFor(() => expect(readingButton).toBeEnabled());
  const rail = screen.getByRole('region', { name: '继续阅读' });
  const grid = rail.querySelector<HTMLElement>('.archive-rail-grid')!;
  grid.scrollLeft = 250;
  ids = ['new', 'old'];
  act(() => invalidateRouteCache('home:'));
  await within(rail).findByText('new');
  expect(grid.scrollLeft).toBe(0);
  grid.scrollLeft = 150;
  act(() => invalidateRouteCache('home:'));
  await waitFor(() => expect(historyButton).toBeEnabled());
  expect(grid.scrollLeft).toBe(150);
});
it('revalidates warm history on mount and when returning to a retained home', async () => {
  const server = { id: 's', scopeId: 's', name: 'Server', baseUrl: 'https://example.com', enabled: true };
  let id = 'new';
  let reads = 0;
  writeRouteCache('home:shelves', { servers: { ok: true, value: [server] }, history: [], readingList: [], archives: [], randomArchives: [] });
  setInvokeAdapterForTests(async (command) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
    if (command === 'list_reading_history') {
      reads++;
      return { ok: true, value: [{ scopeId: 's', archiveId: id, pageIndex: 1, visitedAt: '2026-10-16T00:00:00Z', deviceId: 'd', revision: 1 }] };
    }
    if (command === 'list_archives_by_ids') return { ok: true, value: [{ serverId: 's', archiveId: id, title: `History ${id}`, pageCount: 20, updatedAt: '2026-10-16' }] };
    return { ok: true, value: [] };
  });
  render(<MemoryRouter><PreferencesProvider><ToastProvider>
    <Link to="/settings">Leave home</Link><Link to="/">Return home</Link><WorkspaceRoutes />
  </ToastProvider></PreferencesProvider></MemoryRouter>);
  expect(await screen.findByText('History new')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Leave home'));
  id = 'newer';
  const before = reads;
  fireEvent.click(screen.getByText('Return home'));
  await waitFor(() => expect(reads).toBeGreaterThan(before));
  expect(await screen.findByText('History newer')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('History new')).not.toBeInTheDocument());
});

it('adds home cards as their metadata resolves while the other shelf is pending', async () => {
  const server = { id: 'progressive', scopeId: 'progressive', name: 'Server', baseUrl: 'https://example.com', enabled: true };
  let finishReading!: () => void;
  const reading = new Promise<void>(resolve => { finishReading = resolve; });
  let finishSlow!: () => void;
  const slow = new Promise<void>(resolve => { finishSlow = resolve; });
  const indexed = new Set(['cached']);
  setInvokeAdapterForTests(async (command, args) => {
    if (command === 'list_servers') return { ok: true, value: [server] };
    if (command === 'list_reading_history') return { ok: true, value: ['cached', 'fast', 'slow'].map(archiveId => ({ scopeId: server.scopeId, archiveId, pageIndex: 1, visitedAt: '2026-10-16', deviceId: 'd', revision: 1 })) };
    if (command === 'list_reading_list') { await reading; return { ok: true, value: [] }; }
    if (command === 'list_archives_by_ids') return { ok: true, value: (args?.archiveIds as string[]).filter(id => indexed.has(id)).map(archiveId => ({ serverId: server.id, archiveId, title: `Card ${archiveId}`, pageCount: 20, updatedAt: 'now' })) };
    if (command === 'load_archive_metadata') {
      const archiveId = args?.archiveId as string;
      if (archiveId === 'slow') await slow;
      indexed.add(archiveId);
      return { ok: true, value: { archiveId, title: archiveId, filename: 'archive.cbz', tags: '', extension: 'cbz', progress: 0, pageCount: 20, lastReadTime: 0, size: 1024 } };
    }
    return { ok: true, value: [] };
  });
  render(<MemoryRouter><PreferencesProvider><ToastProvider><WorkspaceRoutes /></ToastProvider></PreferencesProvider></MemoryRouter>);
  try {
    const cached = await screen.findByRole('link', { name: /Card cached/ });
    const fast = await screen.findByRole('link', { name: /Card fast/ });
    expect(fast.closest('.archive-rail-item')).toHaveClass('is-entering');
    expect(screen.queryByRole('link', { name: /Card slow/ })).toBeNull();
    await act(async () => finishSlow());
    expect(await screen.findByRole('link', { name: /Card slow/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Card cached/ })).toBe(cached);
  } finally { await act(async () => { finishSlow(); finishReading(); }); }
});
