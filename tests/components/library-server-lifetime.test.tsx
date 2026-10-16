import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryRouteWorkspace } from '../../src/components/LibraryRouteWorkspace';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetRouteCacheForTests } from '../../src/lib/routeCache';
import { PreferencesProvider } from '../../src/app/preferences';
import { App } from '../../src/app/App';

afterEach(() => { resetInvokeAdapterForTests(); resetRouteCacheForTests(); });

const servers = ['A', 'B'].map(id => ({ id, scopeId: id, name: id, baseUrl: `https://${id.toLowerCase()}.example.com` }));
const preset = (scopeId: string) => ({ scopeId, presetId: 'shared-id', name: `${scopeId} preset`, query: '', sortBy: 'added', sortOrder: 'desc', categoryId: null, createdAt: '2026-10-15', updatedAt: '2026-10-15', deviceId: 'test', revision: 1, deleted: false });

describe('library server request lifetimes', () => {
  it('ignores a late A page while B server lookup is still pending', async () => {
    let reads = 0;
    let finishServers!: (value: unknown) => void;
    let finishPage!: (value: unknown) => void;
    const page = (serverId: string) => ({ ok: true, value: { items: [{ serverId, archiveId: 'shared', title: `${serverId} pending page`, pageCount: 1, updatedAt: 'now' }], total: 1, hasMore: false } });
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return ++reads === 1 ? { ok: true, value: servers } : new Promise(resolve => { finishServers = resolve; });
      if (command === 'search_archives_page') return (args?.input as { serverId: string }).serverId === 'A' ? new Promise(resolve => { finishPage = resolve; }) : page('B');
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/library?server=A']}><PreferencesProvider><Link to="/library?server=B">Switch server</Link><LibraryRouteWorkspace showDetail={false} /></PreferencesProvider></MemoryRouter>);
    await waitFor(() => expect(finishPage).toBeDefined());
    fireEvent.click(screen.getByText('Switch server'));
    await waitFor(() => expect(finishServers).toBeDefined());
    await act(async () => finishPage(page('A')));
    expect(screen.queryByRole('button', { name: /^A pending page\b/ })).not.toBeInTheDocument();
    await act(async () => finishServers({ ok: true, value: servers }));
    await screen.findByRole('button', { name: /^B pending page\b/ });
  });

  it.each(['reading', 'category'])('does not apply a late A %s write to B membership', async kind => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: servers };
      if (command === 'search_archives_page') {
        const serverId = (args?.input as { serverId: string }).serverId;
        return { ok: true, value: { items: [{ serverId, archiveId: 'shared', title: `${serverId} archive`, pageCount: 1, updatedAt: 'now' }], total: 1, hasMore: false } };
      }
      if (command === 'list_categories') return { ok: true, value: [{ id: 'SET_1613080290', name: 'Static shelf', pinned: false, search: null, archives: [] }] };
      if (command === 'set_reading_list' || command === 'add_archive_to_category') return new Promise(resolve => { finish = resolve; });
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/library?server=A']}><PreferencesProvider><Link to="/library?server=B">Switch server</Link><LibraryRouteWorkspace showDetail={false} /></PreferencesProvider></MemoryRouter>);
    const label = kind === 'reading' ? '加入待看' : 'Static shelf';
    fireEvent.contextMenu(await screen.findByRole('button', { name: /^A archive\b/ }), { clientX: 100, clientY: 100 });
    fireEvent.click(await screen.findByRole('menuitem', { name: label }));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByText('Switch server'));
    await screen.findByRole('button', { name: /^B archive\b/ });
    await act(async () => finish({ ok: true, value: kind === 'reading'
      ? { scopeId: 'A', archiveId: 'shared', addedAt: 'now', updatedAt: 'now', deviceId: 'test', revision: 1, deleted: false }
      : { operation: 'add_to_category', success: 1 } }));
    fireEvent.contextMenu(screen.getByRole('button', { name: /^B archive\b/ }), { clientX: 100, clientY: 100 });
    expect(await screen.findByRole('menuitem', { name: label })).toBeEnabled();
  });

  it('does not replace B details after an A metadata save finishes', async () => {
    let finish!: (value: unknown) => void;
    const records = ['a', 'b'].map(archiveId => ({ serverId: 'A', archiveId, title: `Archive ${archiveId}`, pageCount: 1, updatedAt: 'now' }));
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: servers };
      if (command === 'search_archives_page') return { ok: true, value: { items: records, total: 2, hasMore: false } };
      if (command === 'load_archive_metadata') return { ok: true, value: { archiveId: args?.archiveId, title: `Title ${args?.archiveId}`, filename: `${args?.archiveId}.zip`, tags: '', summary: '', extension: 'zip', progress: 0, pageCount: 1, lastReadTime: 0, size: 1 } };
      if (command === 'update_archive_metadata') return new Promise(resolve => { finish = resolve; });
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/library?server=A']}><PreferencesProvider><LibraryRouteWorkspace /></PreferencesProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '编辑元数据' }));
    fireEvent.submit(document.querySelector('form.metadata-form')!);
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /^Archive b\b/ }));
    await screen.findByText('b.zip');
    await act(async () => finish({ ok: true, value: { operation: 'update_metadata', success: 1 } }));
    expect(screen.getByText('b.zip')).toBeInTheDocument();
  });

  it('does not replace B categories with a late A category read', async () => {
    let finish!: (value: unknown) => void;
    const category = (name: string) => ({ id: 'SET_1613080290', name, pinned: false, search: null, archives: [] });
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: servers };
      if (command === 'list_categories') return args?.serverId === 'A'
        ? new Promise(resolve => { finish = resolve; }) : { ok: true, value: [category('B category')] };
      if (command === 'search_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/library?server=A']}><PreferencesProvider><Link to="/library?server=B">Switch server</Link><LibraryRouteWorkspace showDetail={false} /></PreferencesProvider></MemoryRouter>);
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByText('Switch server'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '分类筛选' })).toHaveTextContent('B category'));
    await act(async () => finish({ ok: true, value: [category('A category')] }));
    expect(screen.getByRole('combobox', { name: '分类筛选' })).toHaveTextContent('B category');
    expect(screen.getByRole('combobox', { name: '分类筛选' })).not.toHaveTextContent('A category');
  });

  it.each(['/library', '/to-read'])('does not insert a saved A preset into B after switching servers on %s', async path => {
    let finish!: (value: unknown) => void;
    let input: Record<string, unknown> = {};
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: servers };
      if (command === 'list_search_presets') return { ok: true, value: [preset(String(args?.scopeId))] };
      if (command === 'save_search_preset') { input = args?.input as Record<string, unknown>; return new Promise(resolve => { finish = resolve; }); }
      if (command === 'search_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      if (command.startsWith('list_') || command === 'find_missing_archives') return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={[`${path}?server=A`]}><Link to={`${path}?server=B`}>Switch server</Link><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '检索预设' }));
    await screen.findByRole('menuitem', { name: 'A preset' });
    fireEvent.click(screen.getByRole('menuitem', { name: '新增预设' }));
    fireEvent.change(screen.getByRole('textbox', { name: '预设名称' }), { target: { value: 'New A preset' } });
    fireEvent.click(screen.getByRole('button', { name: '保存预设' }));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByText('Switch server'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '检索预设' }));
    await screen.findByRole('menuitem', { name: 'B preset' });
    await act(async () => finish({ ok: true, value: { ...preset('A'), ...input } }));
    expect(screen.queryByRole('menuitem', { name: 'New A preset' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'B preset' })).toBeInTheDocument();
  });

  it('does not replace B presets with a late A preset read', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'load_preferences') return { ok: true, value: { theme: 'system', defaultLayout: 'auto', defaultDirection: 'ltr', cacheMaxBytes: 2147483648 } };
      if (command === 'list_servers') return { ok: true, value: servers };
      if (command === 'list_search_presets') return args?.scopeId === 'A'
        ? new Promise(resolve => { finish = resolve; }) : { ok: true, value: [preset('B')] };
      if (command === 'search_archives_page') return { ok: true, value: { items: [], total: 0, hasMore: false } };
      if (command.startsWith('list_')) return { ok: true, value: [] };
      return { ok: false, error: { code: 'UNKNOWN', message: 'unused', retryable: false } };
    });
    render(<MemoryRouter initialEntries={['/library?server=A']}><PreferencesProvider><Link to="/library?server=B">Switch server</Link><LibraryRouteWorkspace showDetail={false} /></PreferencesProvider></MemoryRouter>);
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByText('Switch server'));
    fireEvent.click(await screen.findByRole('button', { name: '检索预设' }));
    await screen.findByRole('menuitem', { name: 'B preset' });
    await act(async () => finish({ ok: true, value: [preset('A')] }));
    expect(screen.getByRole('menuitem', { name: 'B preset' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'A preset' })).not.toBeInTheDocument();
  });
});
