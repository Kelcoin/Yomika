import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter } from 'react-router-dom';
import { PreferencesProvider } from '../../src/app/preferences';
import { LibraryRouteWorkspace } from '../../src/components/LibraryRouteWorkspace';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetRouteCacheForTests } from '../../src/lib/routeCache';
vi.mock('../../src/components/LibraryWorkspace', () => ({ LibraryWorkspace: (props: { isFavorite: boolean; onToggleFavorite?: () => void; archives: { serverId: string }[] }) => <><span>{props.archives[0]?.serverId}</span><button disabled={!props.onToggleFavorite} onClick={props.onToggleFavorite} aria-pressed={props.isFavorite}>toggle</button></> }));
afterEach(() => { resetInvokeAdapterForTests(); resetRouteCacheForTests(); });
it('ignores a library favorite write from the previous server after new membership resolves', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_servers') return { ok: true, value: ['A', 'B'].map(id => ({ id, scopeId: id, name: id, baseUrl: 'https://example.com' })) };
    if (command === 'search_archives_page') return { ok: true, value: { items: [{ archiveId: 'shared', serverId: (args?.input as { serverId: string }).serverId, title: 'Shared', pageCount: 3, updatedAt: '2026-01-01' }], total: 1, hasMore: false } };
    if (command === 'read_favorites_category') return { ok: true, value: { id: 'fav', archives: [] } };
    if (command === 'add_archive_to_category') return pending;
    if (command.startsWith('list_')) return { ok: true, value: [] };
    return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
  });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter initialEntries={['/library?server=A']}><Link to="/library?server=B">B-nav</Link><PreferencesProvider><LibraryRouteWorkspace /></PreferencesProvider></MemoryRouter>);
  await screen.findByText('A');
  await act(async () => {});
  fireEvent.click(screen.getByText('toggle'));
  await waitFor(() => expect(adapter).toHaveBeenCalledWith('add_archive_to_category', { serverId: 'A', categoryId: 'fav', archiveId: 'shared' }));
  fireEvent.click(screen.getByText('B-nav'));
  await screen.findByText('B');
  await waitFor(() => expect(screen.getByText('toggle')).toHaveAttribute('aria-pressed', 'false'));
  await act(async () => finish({ ok: true, value: { operation: 'add_to_category', success: 1 } }));
  expect(screen.getByText('toggle')).toHaveAttribute('aria-pressed', 'false');
});

it('does not expose A membership while B membership is deferred or failed', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'list_servers') return { ok: true, value: ['A', 'B'].map(id => ({ id, scopeId: id, name: id, baseUrl: 'https://example.com' })) };
    if (command === 'search_archives_page') return { ok: true, value: { items: [{ archiveId: 'shared', serverId: (args?.input as { serverId: string }).serverId, title: 'Shared', pageCount: 3, updatedAt: '2026-01-01' }], total: 1, hasMore: false } };
    if (command === 'read_favorites_category') return args?.serverId === 'B' ? pending : { ok: true, value: { id: 'fav', archives: ['shared'] } };
    if (command.startsWith('list_')) return { ok: true, value: [] };
    return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
  });
  setInvokeAdapterForTests(adapter);
  render(<MemoryRouter initialEntries={['/library?server=A']}><Link to="/library?server=B">B-nav</Link><PreferencesProvider><LibraryRouteWorkspace /></PreferencesProvider></MemoryRouter>);
  await screen.findByText('A');
  await waitFor(() => expect(screen.getByText('toggle')).toHaveAttribute('aria-pressed', 'true'));
  fireEvent.click(screen.getByText('B-nav'));
  await screen.findByText('B');
  expect(screen.getByText('toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('toggle')).toBeDisabled();
  fireEvent.click(screen.getByText('toggle'));
  await act(async () => finish({ ok: false, error: { code: 'NETWORK', message: 'B offline', retryable: true } }));
  expect(screen.getByText('toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('toggle')).toBeDisabled();
  fireEvent.click(screen.getByText('toggle'));
  expect(adapter.mock.calls.some(([command]) => ['add_archive_to_category', 'remove_archive_from_category'].includes(command))).toBe(false);
});
