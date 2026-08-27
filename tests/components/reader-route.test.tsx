import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

describe('reader route', () => {
  it('loads native manifest and page bytes, then persists progress on navigation', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    setInvokeAdapterForTests(async (command: string) => {
      calls.push(command);
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') {
        return { ok: true, value: [{ id: 'scope-real', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-real' }] };
      }
      if (command === 'load_reader_manifest') {
        return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['00.jpg', '01.jpg'] } };
      }
      if (command === 'load_reader_page') return { ok: true, value: [1, 2, 3] };
      if (command === 'load_reading_progress') return { ok: true, value: null };
      if (command === 'save_reading_progress') {
        return {
          ok: true,
          value: { scopeId: 'scope-real', archiveId: 'a1', pageIndex: 1, pageCount: 2, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 },
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 1 页' })).toBeInTheDocument();
    await user.click(screen.getByRole('main', { name: '漫画阅读器' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('img', { name: '第 2 页' })).toBeInTheDocument();
    expect(calls).toEqual(['list_servers', 'load_preferences', 'load_reader_manifest', 'load_reading_progress', 'load_reader_page', 'load_reader_page', 'save_reading_progress']);
  });

  it('loads the restored page first and limits initial preloading to adjacent pages', async () => {
    const loadedPaths: string[] = [];
    setInvokeAdapterForTests(async (command: string, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2_147_483_648 } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }] };
      if (command === 'load_reader_manifest') return { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg'] } };
      if (command === 'load_reading_progress') return { ok: true, value: { scopeId: 'scope-a', archiveId: 'a1', pageIndex: 3, pageCount: 5, layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 1 } };
      if (command === 'load_reader_page') {
        loadedPaths.push(String(args?.path));
        return { ok: true, value: [1] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<MemoryRouter initialEntries={['/reader/a1']}><App /></MemoryRouter>);

    expect(await screen.findByRole('img', { name: '第 4 页' })).toBeInTheDocument();
    expect(loadedPaths[0]).toBe('3.jpg');
    expect(new Set(loadedPaths)).toEqual(new Set(['2.jpg', '3.jpg', '4.jpg']));
  });
});
