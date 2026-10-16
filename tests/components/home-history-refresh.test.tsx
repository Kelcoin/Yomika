import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceRoutes } from '../../src/app/routes';
import { PreferencesProvider } from '../../src/app/preferences';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { writeRouteCache } from '../../src/lib/routeCache';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';

afterEach(resetInvokeAdapterForTests);
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
  expect(screen.queryByText('History new')).not.toBeInTheDocument();
});
