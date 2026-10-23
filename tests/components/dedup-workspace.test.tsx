import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeduplicationWorkspace } from '../../src/components/DeduplicationWorkspace';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { translateRawTag } from '../../src/lib/tags';
import { RetainedPage } from '../../src/app/RetainedPage';

afterEach(() => { resetInvokeAdapterForTests(); vi.unstubAllGlobals(); });
describe('duplicate deletion confirmation', () => {
  it('bounds mounted cards even when every pair belongs to one large chain', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const records = Array.from({ length: 301 }, (_, index) => ({ id: String(index), title: 'Archive ' + index, tags: [], fileSize: 1, pageCount: 24 }));
    const base = scanFixture(records);
    const pairs = records.slice(1).map((record, index) => ({ leftArchiveId: String(index), rightArchiveId: record.id, source: 'image' }));
    setInvokeAdapterForTests(async (command, payload) => {
      const response = await base(command, payload) as { ok: boolean; value: unknown };
      if (command === 'dedup_load_result') return { ok: true, value: { ...(response.value as object), pairs } };
      return response;
    });
    const content = <ToastProvider><DeduplicationWorkspace /></ToastProvider>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await screen.findByRole('checkbox', { name: '选择 Archive 0' });
    const count = view.container.querySelectorAll('.dedup-member').length;
    const start = performance.now();
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    console.info('dedup retained reentry:', Math.round(performance.now() - start), 'ms; mounted cards:', count);
    expect(count).toBe(48);
    expect(view.container.querySelectorAll('.dedup-member')).toHaveLength(48);
    fireEvent.click(screen.getByRole('button', { name: '关联重复链 1' }));
    await waitFor(() => expect(screen.getByText('Archive 0').closest('.dedup-group')).toHaveClass('is-selected'));
    fireEvent.click(screen.getByRole('button', { name: '执行所选' }));
    await screen.findByRole('dialog', { name: '确认删除' });
    expect(screen.getByText(/将标记 300 组为不重复/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '确认删除' })).toHaveClass('dialog-title');
  });

  it('reports smart selection page gaps only as a completion toast', async () => {
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 2, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 60 },
    ]));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await screen.findByRole('checkbox', { name: '选择 Archive A' });
    fireEvent.click(screen.getByRole('button', { name: '智能选择' }));
    const toast = await screen.findByText('智能选择完成，1 组页数差超过 10 页，请人工确认后再执行。');
    expect(toast.closest('.toast-card')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '关闭页数差警告' })).not.toBeInTheDocument();
  });

  it.each([
    ['a', 'b', 'c'],
    ['b', 'c', 'a'],
    ['a', 'c', 'b'],
    ['b', 'a', 'c'],
  ])('keeps chain candidates %s and %s selected while protecting %s', async (first, second, survivor) => {
    const base = scanFixture(['a', 'b', 'c'].map((id) => ({ id, title: id.toUpperCase(), tags: [], fileSize: 1, pageCount: 24 })));
    const pairs = [
      { leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' },
      { leftArchiveId: 'b', rightArchiveId: 'c', source: 'filename' },
    ];
    const adapter = vi.fn(async (command: string, args?: Parameters<typeof base>[1]) => {
      const response = await base(command, args) as { ok: boolean; value: unknown };
      return command === 'dedup_load_result' ? { ok: true, value: { ...(response.value as object), pairs } } : response;
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await screen.findByRole('checkbox', { name: '选择 A' });
    const cards = (id: string) => screen.getAllByRole('checkbox', { name: '选择 ' + id.toUpperCase() });
    fireEvent.click(cards(first)[0]!);
    fireEvent.click(cards(second)[0]!);
    cards(first).forEach((card) => expect(card).toHaveAttribute('aria-checked', 'true'));
    cards(second).forEach((card) => expect(card).toHaveAttribute('aria-checked', 'true'));
    cards(survivor).forEach((card) => expect(card).toBeDisabled());
    await waitFor(() => expect(adapter).toHaveBeenLastCalledWith('dedup_save_selection', { sessionId: expect.any(String), selectedArchiveIds: [first, second] }));
    // Filtering out an edge must not change the connected-component invariant.
    fireEvent.change(screen.getByRole('combobox', { name: '来源' }), { target: { value: 'image' } });
    if (survivor !== 'c') cards(survivor).forEach((card) => expect(card).toBeDisabled());
    fireEvent.change(screen.getByRole('combobox', { name: '来源' }), { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('combobox', { name: '视图' }), { target: { value: 'chains' } });
    cards(first).forEach((card) => expect(card).toHaveAttribute('aria-checked', 'true'));
    cards(survivor).forEach((card) => expect(card).toBeDisabled());
    fireEvent.click(cards(second)[0]!);
    cards(survivor).forEach((card) => expect(card).toBeEnabled());
    fireEvent.click(cards(survivor)[0]!);
    await waitFor(() => expect(adapter).toHaveBeenLastCalledWith('dedup_save_selection', { sessionId: expect.any(String), selectedArchiveIds: [first, survivor] }));
  });

  it('switches a pair candidate directly and clears both member and group selections', async () => {
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 2, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 60 },
    ]));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    const a = await screen.findByRole('checkbox', { name: '选择 Archive A' });
    const b = screen.getByRole('checkbox', { name: '选择 Archive B' });
    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(b);
    expect(a).toHaveAttribute('aria-checked', 'false');
    expect(b).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: '清除选择' }));
    expect(b).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: '全选分组' }));
    fireEvent.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.getByRole('button', { name: '执行所选' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '智能选择' }));
    await waitFor(() => expect(b).toHaveAttribute('aria-checked', 'true'));
  });

  it('filters the page-gap view strictly above ten pages', async () => {
    const records = [
      { id: 'a', title: 'Wide A', tags: [], fileSize: 1, pageCount: 24 },
      { id: 'b', title: 'Wide B', tags: [], fileSize: 1, pageCount: 35 },
      { id: 'c', title: 'Close C', tags: [], fileSize: 1, pageCount: 24 },
      { id: 'd', title: 'Close D', tags: [], fileSize: 1, pageCount: 34 },
    ];
    const base = scanFixture(records);
    setInvokeAdapterForTests(async (command, payload) => {
      const response = await base(command, payload) as { ok: boolean; value: unknown };
      if (command === 'dedup_load_result') return { ok: true, value: { ...(response.value as object), pairs: [
        { leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' },
        { leftArchiveId: 'c', rightArchiveId: 'd', source: 'image' },
      ] } };
      return response;
    });
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
    await screen.findByRole('checkbox', { name: '选择 Close C' });
    fireEvent.change(screen.getByRole('combobox', { name: '视图' }), { target: { value: 'page-gap' } });
    expect(screen.getByRole('checkbox', { name: '选择 Wide A' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 Close C' })).not.toBeInTheDocument();
  });

  it('keeps the scan controls mounted while the server is loading', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async command => command === 'list_servers'
      ? new Promise(resolve => { finish = resolve; }) : { ok: true, value: [] });
    const view = render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    const start = screen.getByRole('button', { name: '开始扫描' });
    const date = screen.getByRole('button', { name: /起始日期/ });
    expect(start).toBeDisabled();
    expect(screen.getByLabelText('正在读取服务器')).toBeInTheDocument();
    await act(async () => finish({ ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] }));
    await waitFor(() => expect(start).toBeEnabled());
    expect(screen.getByRole('button', { name: '开始扫描' })).toBe(start);
    expect(screen.getByRole('button', { name: /起始日期/ })).toBe(date);
    view.unmount();
  });
  it('does not reopen an old overview lookup after leaving and returning', async () => {
    const record = { serverId: 's', archiveId: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' };
    let finish: ((value: unknown) => void) | undefined;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: [record] };
      if (command === 'dedup_list_non_duplicates') return { ok: true, value: [{ pairKey: 'a|b', leftArchiveId: 'a', rightArchiveId: 'b', tombstoned: false }] };
      if (command === 'list_archives_by_ids') return new Promise((resolve) => { finish = resolve; });
      return { ok: true, value: [] };
    });
    const content = <MemoryRouter><ToastProvider><DeduplicationWorkspace /></ToastProvider></MemoryRouter>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '不重复关系' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive A' }));
    await waitFor(() => expect(finish).toBeDefined());
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    await act(async () => { finish!({ ok: true, value: [record] }); });
    expect(screen.queryByRole('dialog', { name: 'Archive A' })).not.toBeInTheDocument();
  });

  it.each(['history', 'relations', 'smart', 'delete'] as const)('retires the %s dialog when its retained page hides', async (kind) => {
    const base = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 2 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 2 },
    ], 'filename');
    setInvokeAdapterForTests(async (command, payload) => {
      if (command === 'dedup_list_sessions' || command === 'dedup_list_non_duplicates') return { ok: true, value: [] };
      return base(command, payload);
    });
    const content = <ToastProvider><DeduplicationWorkspace /></ToastProvider>;
    const view = render(<RetainedPage active>{content}</RetainedPage>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    if (kind === 'smart' || kind === 'delete') {
      fireEvent.click(screen.getByRole('button', { name: '开始扫描' }));
      const card = await screen.findByRole('checkbox', { name: '选择 Archive A' });
      if (kind === 'delete') fireEvent.click(card);
    }
    fireEvent.click(screen.getByRole('button', { name: { history: '扫描结果', relations: '不重复关系', smart: '智能选择', delete: '执行所选' }[kind] }));
    await screen.findByRole('dialog');
    view.rerender(<RetainedPage active={false}>{content}</RetainedPage>);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    view.rerender(<RetainedPage active>{content}</RetainedPage>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('loads a resumed scan result even after its completed progress stops polling', async () => {
    const session = { sessionId: 'resumed', scopeId: 'scope', algorithmVersion: 'v1', status: 'running', checkpoint: 0, archiveCount: 2 };
    const pairs = [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' }];
    let polls = 0;
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(async (command) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, tagTranslationEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: ['a','b'].map((id) => ({ id, archiveId: id, title: id, tags: [], pageCount: 1, fileSize: 1 })) };
      if (command === 'dedup_list_non_duplicates') return { ok: true, value: [] };
      if (command === 'dedup_list_sessions') return { ok: true, value: [{ ...session, pairCount: 1, createdAt: 'now', updatedAt: 'now' }] };
      if (command === 'dedup_scan_progress') return { ok: true, value: { ...session, status: ++polls > 1 ? 'completed' : 'running', stage: polls > 1 ? 'completed' : 'covers', processed: 2, total: 2, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 1, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_load_result') return new Promise((resolve) => { finish = resolve; });
      throw new Error(command);
    });
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(finish).toBeDefined());
    // Let React process the completed progress before the result IPC returns.
    await act(async () => {});
    await act(async () => { finish({ ok: true, value: { session: { ...session, status: 'completed' }, archives: [], pairs, selectedArchiveIds: [], outcomes: [] } }); });
    expect(await screen.findByRole('checkbox', { name: '选择 a' })).toBeInTheDocument();
  });

  it('lets a second tap undo a selection while its save is still pending', async () => {
    const user = userEvent.setup();
    const fixture = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 2 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 2 },
    ]);
    const saves: Array<{ ids: string[]; finish: (value: unknown) => void }> = [];
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'dedup_save_selection') return new Promise((finish) => {
        saves.push({ ids: args?.selectedArchiveIds as string[], finish });
      });
      return fixture(command, args);
    });
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));
    const card = await screen.findByRole('checkbox', { name: '选择 Archive A' });
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => { saves[0]!.finish({ ok: true, value: null }); });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]!.ids).toEqual([]);
    await act(async () => { saves[1]!.finish({ ok: true, value: null }); });
    expect(card).toHaveAttribute('aria-checked', 'false');
  });

  it('confirms favorite synchronization and reports failed archive outcomes', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId:'a',rightArchiveId:'b',source:'filename' };
    const session = {sessionId:'scan',scopeId:'scope',algorithmVersion:'v1',status:'completed',checkpoint:2,archiveCount:2};
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return {ok:true,value:{...DEFAULT_PREFERENCES,ehFavoriteDeleteSync:true}};
      if (command === 'list_servers') return {ok:true,value:[{id:'s',scopeId:'scope',name:'Server',baseUrl:'https://lrr.test'}]};
      if (command === 'list_archive_identities') return {ok:true,value:[]};
      if (command === 'dedup_scan') return {ok:true,value:{...session,stage:'completed',processed:2,total:2,cacheHits:0,downloads:0,missingCovers:0,invalidCovers:0,pairCount:1,degraded:false,diagnostics:[],pairs:[pair]}};
      if (command === 'dedup_load_result') return {ok:true,value:{session,archives:[],pairs:[pair],selectedArchiveIds:['a'],outcomes:[]}};
      if (command === 'dedup_delete_selected') return {ok:true,value:{rejectedArchiveIds:[],outcomes:[{archiveId:'a',deleted:false,message:'收藏同步失败'}]}};
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button',{name:'开始扫描'})).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));
    await user.click(await screen.findByRole('button', { name: '执行所选' }));
    expect(screen.getByRole('dialog', { name: '确认删除' })).toHaveClass('dialog-content');
    expect(await screen.findByRole('switch', { name: '本次同步删除 E-Hentai 收藏' })).toHaveAttribute('aria-checked', 'true');
    expect(adapter.mock.calls.some(([command]) => command === 'dedup_delete_selected')).toBe(false);
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_delete_selected', { input: { sessionId: 'scan', outcomes: [] }, syncFavorite: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 个档案未删除：收藏同步失败');
  });

  it('leaves the favorite row out entirely when no E-Hentai account is signed in', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId: 'a', rightArchiveId: 'b', source: 'filename' };
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 2, archiveCount: 2 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: true } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: [] };
      // 没有已登录的 E-Hentai 账户：收藏同步这次做不了。
      if (command === 'list_eh_accounts') return { ok: true, value: [] };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 2, total: 2, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 1, degraded: false, diagnostics: [], pairs: [pair] } };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs: [pair], selectedArchiveIds: ['a'], outcomes: [] } };
      if (command === 'dedup_delete_selected') return { ok: true, value: { rejectedArchiveIds: [], outcomes: [{ archiveId: 'a', deleted: true }] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));
    await user.click(await screen.findByRole('button', { name: '执行所选' }));

    const dialog = await screen.findByRole('dialog', { name: '确认删除' });
    // 等确认按钮可用 = 偏好与账户都读完了，再断言那一行不存在。
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeEnabled());
    expect(within(dialog).queryByRole('switch', { name: '本次同步删除 E-Hentai 收藏' })).not.toBeInTheDocument();

    // 删除本身照旧：这次只是不同步收藏。
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_delete_selected', { input: { sessionId: 'scan', outcomes: [] }, syncFavorite: false }));
  });

  it('marks every pair of a selected group as non-duplicate on execute', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId: 'a', rightArchiveId: 'b', source: 'filename' };
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 2, archiveCount: 2 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: ['a','b'].map((id) => ({ id, archiveId: id, title: id, tags: [], pageCount: 1, fileSize: 1 })) };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 2, total: 2, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 1, degraded: false, diagnostics: [], pairs: [pair] } };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs: [pair], selectedArchiveIds: [], outcomes: [] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 点击组头 = 整组选择；执行时把组内全部两两组合标记为不重复。
    await user.click(await screen.findByRole('button', { name: /疑似重复/ }));
    await user.click(screen.getByRole('button', { name: '执行所选' }));
    expect(await screen.findByRole('dialog', { name: '确认删除' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    // 整组标记走批命令：一把锁内落库，返回成功条数。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_save_non_duplicates', { input: { entries: [{ scopeId: 'scope', leftArchiveId: 'a', rightArchiveId: 'b' }] } }));
  });

  it('removes deleted archives from the view after execute', async () => {
    const user = userEvent.setup();
    const adapter = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 1 },
    ], 'image', [
      { archiveId: 'a', deleted: true },
      { archiveId: 'b', deleted: false, message: 'LANraragi 删除失败' },
    ]);
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 勾选 a 并执行：a 真删、b 删除失败；组只剩一个成员时整组离开视图
    // （与 Readoshi 的 filterGroupsByProcessedState 一致），失败信息照常播报。
    await user.click(await screen.findByRole('checkbox', { name: /Archive A/ }));
    await user.click(screen.getByRole('button', { name: '执行所选' }));
    await user.click(await screen.findByRole('button', { name: '确认删除' }));
    // 失败的那一个照常播报（执行结果不再挂在列表下方那行小字里）。
    expect(await screen.findByRole('alert')).toHaveTextContent('1 个档案未删除：LANraragi 删除失败');
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Archive A/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: /Archive B/ })).not.toBeInTheDocument();
  });

  function scanFixture(
    archives: { id: string; title: string; tags: string[]; fileSize: number; pageCount: number }[],
    source = 'image',
    deleteOutcomes?: { archiveId: string; deleted: boolean; message?: string }[],
  ) {
    const pairs = [{ leftArchiveId: archives[0]!.id, rightArchiveId: archives[1]!.id, source }];
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 2, archiveCount: 2 };
    const records = archives.map((archive) => ({ serverId: 's', archiveId: archive.id, title: archive.title, tags: archive.tags, fileSize: archive.fileSize, pageCount: archive.pageCount, updatedAt: '2026-01-01' }));
    // loadResult 与真实后端一样回放持久化的选择：scanChunk 写什么就回什么。
    let selectedArchiveIds: string[] = [];
    const adapter = vi.fn(async (command: string, payload?: { input?: { selectedArchiveIds?: string[] }; selectedArchiveIds?: string[] }) => {
      // 这里没有 PreferencesProvider；卡片标签按当前词典显示，断言用同一份显示名。
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: false, tagTranslationEnabled: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: records };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 2, total: 2, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 1, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_save_selection') {
        selectedArchiveIds = [...(payload?.selectedArchiveIds ?? [])];
        return { ok: true, value: null };
      }
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs, selectedArchiveIds, outcomes: [] } };
      if (command === 'dedup_delete_selected') {
        return { ok: true, value: { rejectedArchiveIds: [], outcomes: deleteOutcomes ?? [{ archiveId: records[0]!.archiveId, deleted: true }] } };
      }
      throw new Error(command);
    });
    return adapter;
  }

  it('shows smart signals and the size row on each card', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: ['other:uncensored', 'language:chinese'], fileSize: 2_500_000, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: ['other:rough translation', 'other:extraneous ads'], fileSize: 1_200_000, pageCount: 24 },
    ]));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 判定胶囊和标签同处一个瀑布流：比对可见行（测量行是 aria-hidden 的副本）。
    const visible = (name: string) => {
      const card = screen.getByRole('checkbox', { name });
      return [...card.querySelectorAll('.archive-row-tag-line')].map((line) => line.textContent).join('|');
    };
    expect(visible('选择 Archive A')).toContain('无修正');
    expect(visible('选择 Archive B')).toContain('渣翻');
    expect(visible('选择 Archive B')).toContain('外部广告');
    expect(visible('选择 Archive B')).toContain('无汉语');
    // 体积与页数分列两端、各自成元素（钉在卡片底部，不随标签行数移动）。
    const meta = (name: string) => screen.getByRole('checkbox', { name }).querySelector('.dedup-member-meta')!.textContent;
    expect(meta('选择 Archive A')).toBe('2.5 MB24页');
    expect(meta('选择 Archive B')).toBe('1.2 MB24页');
  });

  it('draws every duplicate member as a card with a cover, tag chips and accessible selection states', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: ['other:mosaic censorship', 'language:chinese'], fileSize: 2_500_000, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: ['other:uncensored'], fileSize: 1_200_000, pageCount: 24 },
    ]));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 整张卡就是勾选框，通过底色表示状态，不再遮挡封面。
    const card = await screen.findByRole('checkbox', { name: '选择 Archive A' });
    expect(card).toHaveClass('dedup-member');
    expect(card).toHaveAttribute('aria-checked', 'false');
    expect(card.querySelector('.archive-card-check')).toBeNull();
    // 封面槽与档案信息（标签胶囊、判定徽标、体积页数）都在卡里。
    expect(card.querySelector('.archive-thumb-card-media')).not.toBeNull();
    // 胶囊读取的是可见行（测量行是 aria-hidden 的副本，按文本查会重复命中）。
    const visibleChips = [...card.querySelectorAll('.dedup-member-tags .archive-row-tag-line')].map((line) => line.textContent).join('|');
    expect(visibleChips).toContain(translateRawTag('other:mosaic censorship'));
    expect(visibleChips).toContain(translateRawTag('language:chinese'));
    expect(visibleChips).toContain('有码');
    expect(card.querySelector('.dedup-member-meta')?.textContent).toBe('2.5 MB24页');
    const otherCard = screen.getByRole('checkbox', { name: '选择 Archive B' });
    expect([...otherCard.querySelectorAll('.archive-row-tag-line')].map((line) => line.textContent).join('|')).toContain('无修正');
    // 裸 checkbox 会被全局 input 样式拉成整行宽的方块，正是布局崩坏的原因。
    expect(document.querySelectorAll('.dedup-members input[type="checkbox"]')).toHaveLength(0);

    await user.click(card);
    expect(screen.getByRole('checkbox', { name: '选择 Archive A' })).toHaveAttribute('aria-checked', 'true');
  });

  it('labels each group with its source and number, and draws its actions as icons', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 1 },
    ], 'filename'));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    // 服务器不再让用户选：按钮行里没有服务器下拉框。
    expect(screen.queryByRole('combobox', { name: '服务器' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 组标题：序号居中，来源缩成紧随其后的一个图标（不再占左边一格）。
    const heading = await screen.findByRole('button', { name: /疑似重复 1/ });
    expect(within(heading).getByRole('img', { name: '来源：文件名' })).toBeInTheDocument();
    // 「页数差大」这类提醒不再写在组标题上。
    expect(within(heading).queryByText(/页数差/) ).toBeNull();
    // 与阅读器工具栏同一种语言：除「开始扫描」外一律纯图标，词只留在可访问名和
    // 提示里，一排动作看起来就是一排符号。
    for (const name of ['重置', '扫描结果', '不重复关系']) {
      const button = screen.getByRole('button', { name });
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.querySelector('.action-label')?.textContent?.trim()).toBe(name);
      expect(button).toHaveAttribute('title', name);
    }
    // 「开始扫描」是这一页的主动作，保留文字。
    const start = screen.getByRole('button', { name: '开始扫描' });
    expect(start.querySelector('svg')).not.toBeNull();
    expect(start).toHaveTextContent('开始扫描');
  });

  it('keeps manually touched groups when smart select runs', async () => {
    const user = userEvent.setup();
    const adapter = scanFixture([
      { id: 'a', title: 'Archive A', tags: ['language:chinese'], fileSize: 2_500_000, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: ['other:rough translation'], fileSize: 1_200_000, pageCount: 24 },
    ]);
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 手动勾选 a（该组变为"手动触碰"），随后智能选择必须保留这个手动选择。
    await user.click(await screen.findByRole('checkbox', { name: /Archive A/ }));
    const persisted = await screen.findByRole('checkbox', { name: /Archive A/ });
    expect(persisted).toBeChecked();
    await user.click(screen.getByRole('button', { name: '智能选择' }));

    // 智能选择不覆盖手动选择：a 仍是删除候选。
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Archive A/ })).toBeChecked());
  });

  it('asks before folding filename-only groups into smart selection', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      const fixture = scanFixture([
        { id: 'a', title: 'Archive A', tags: [], fileSize: 2_500_000, pageCount: 24 },
        { id: 'b', title: 'Archive B', tags: [], fileSize: 1_200_000, pageCount: 24 },
      ]);
      const inner = await fixture(command) as { ok: boolean; value?: unknown };
      if (command === 'dedup_load_result') return { ok: true, value: { session: { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 2, archiveCount: 2 }, archives: [], pairs: [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'filename' }], selectedArchiveIds: [], outcomes: [] } };
      return inner;
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 文件名来源的组存在 → 智能选择先弹确认，不直接执行。
    await screen.findByText(/Archive A/);
    await user.click(screen.getByRole('button', { name: '智能选择' }));
    expect(await screen.findByRole('dialog', { name: '智能选择确认' })).toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'dedup_save_selection').length).toBe(0);
    const dialog = screen.getByRole('dialog', { name: '智能选择确认' });
    expect(dialog.closest('.dedup-confirm')).toBeNull();
    expect(within(dialog).queryByText(/自动保留每组中更合适的档案/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading')).toHaveClass('dialog-title');
    expect(within(dialog).getByRole('switch').closest('.settings-row')).toHaveClass('is-iconless');
    await user.click(within(dialog).getByRole('switch', { name: '包含仅文件名匹配的组' }));
    await user.click(within(dialog).getByRole('button', { name: '执行智能选择' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_save_selection', expect.objectContaining({ selectedArchiveIds: expect.any(Array) })));
    expect(screen.getByRole('checkbox', { name: '选择 Archive B' })).toHaveAttribute('aria-checked', 'true');
    expect(await screen.findByText('智能选择完成，请复核后执行。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭页数差警告' })).not.toBeInTheDocument();
  });

  it('folds linked groups into a chain block and counts the excluded relations', async () => {
    const user = userEvent.setup();
    const pairs = [
      { leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' },
      { leftArchiveId: 'b', rightArchiveId: 'c', source: 'image' },
    ];
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 3, archiveCount: 3 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return {
        ok: true,
        value: ['a', 'b', 'c'].map((id) => ({ serverId: 's', archiveId: id, title: id.toUpperCase(), tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' })),
      };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 3, total: 3, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 2, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs, selectedArchiveIds: [], outcomes: [] } };
      // 一条有效关系 + 一条已移除的墓碑：统计只算有效的那条。
      if (command === 'dedup_list_non_duplicates') return {
        ok: true,
        value: [
          { pairKey: 'a|z', leftArchiveId: 'a', rightArchiveId: 'z', tombstoned: false },
          { pairKey: 'b|z', leftArchiveId: 'b', rightArchiveId: 'z', tombstoned: true },
        ],
      };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 默认视图就把 a-b、b-c 这条链圈进同一个区块（Readoshi 的 renderChain），
    // 标头只写「关联重复链」加序号，后面不再跟一行解释。
    const chainButton = await screen.findByRole('button', { name: '关联重复链 1' });
    expect(chainButton.closest('.dedup-chain')).not.toBeNull();
    expect(chainButton.closest('.dedup-chain')!.querySelectorAll('.dedup-group')).toHaveLength(2);
    // 图标加链号：号是数据不是标签，所以它留在按钮上。
    expect(chainButton.closest('.dedup-chain-heading')!.textContent).toBe('1');
    // 一组永远是两两成对，标题里不再重复「N 项」。
    expect(screen.queryByText(/\d+ 项/)).not.toBeInTheDocument();
    // 「已排除」显示的是标记为不重复的条数，墓碑不算。
    const stat = (await screen.findByText('已排除')).closest('.dedup-stat')!;
    await waitFor(() => expect(stat).toHaveTextContent('1'));
  });

  it('packs standalone groups into rows and leaves the partial row centered', async () => {
    const user = userEvent.setup();
    // 四条互不相连的重复对 → 三个一行、最后一个单独一行；链各自占整行。
    const pairs = [
      { leftArchiveId: 'a1', rightArchiveId: 'a2', source: 'image' },
      { leftArchiveId: 'b1', rightArchiveId: 'b2', source: 'image' },
      { leftArchiveId: 'c1', rightArchiveId: 'c2', source: 'image' },
      { leftArchiveId: 'd1', rightArchiveId: 'd2', source: 'image' },
    ];
    const ids = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2'];
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 8, archiveCount: 8 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: ids.map((id) => ({ serverId: 's', archiveId: id, title: id.toUpperCase(), tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' })) };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 8, total: 8, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 4, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs, selectedArchiveIds: [], outcomes: [] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    await screen.findByRole('button', { name: /疑似重复 1/ });
    const rows = [...document.querySelectorAll('.dedup-group-row')];
    // jsdom 量不到宽度 → 按默认三列分行：3 + 1。
    expect(rows.map((row) => row.querySelectorAll('.dedup-group').length)).toEqual([3, 1]);
    // 每行都按「满行三列」的列数留给卡片（jsdom 不做 calc 解析，只看变量）：
    // 不满的行因此是两边留白，而不是把卡片撑胖。
    for (const row of rows) expect((row as HTMLElement).style.getPropertyValue('--group-columns')).toBe('3');
  });

  it('toggles every group of a chain from the chain label', async () => {
    const user = userEvent.setup();
    const pairs = [
      { leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' },
      { leftArchiveId: 'b', rightArchiveId: 'c', source: 'image' },
    ];
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 3, archiveCount: 3 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return {
        ok: true,
        value: ['a', 'b', 'c'].map((id) => ({ serverId: 's', archiveId: id, title: id.toUpperCase(), tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' })),
      };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 3, total: 3, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 2, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs, selectedArchiveIds: [], outcomes: [] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 切到重复链视图，链标头一次选中链内全部组（按钮自己的按下状态就是凭据）。
    await screen.findByRole('button', { name: /疑似重复 1/ });
    await user.selectOptions(screen.getByRole('combobox', { name: '视图' }), 'chains');
    const chainButton = await screen.findByRole('button', { name: '关联重复链 1' });
    await user.click(chainButton);
    await waitFor(() => expect(chainButton).toHaveAttribute('aria-pressed', 'true'));
  });
  it('selects every group at once from the summary actions', async () => {
    const user = userEvent.setup();
    const adapter = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 1 },
      { id: 'c', title: 'Archive C', tags: [], fileSize: 1, pageCount: 1 },
    ], 'image');
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 一次把重复组全部标记为待标记，再点一次回到未选：按钮在这两个状态之间换名。
    await user.click(await screen.findByRole('button', { name: '全选分组' }));
    expect(await screen.findByRole('button', { name: '取消全选' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消全选' }));
    expect(await screen.findByRole('button', { name: '全选分组' })).toBeInTheDocument();
  });

  it('marks the page count of archives whose page counts disagree', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 24 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 180 },
    ]));
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 页数对不上的档案，页数自己带标记；组标题上不再有那行提醒。
    const flagged = (await screen.findByRole('checkbox', { name: /Archive B/ })).querySelector('.dedup-member-pages');
    expect(flagged).toHaveClass('is-flagged');
    expect(flagged).toHaveTextContent('180页');
    expect((screen.getByRole('checkbox', { name: /Archive A/ }).querySelector('.dedup-member-pages'))).toHaveClass('is-flagged');
    expect(screen.queryByText(/页数差大/)).not.toBeInTheDocument();
  });

  it('filters the result list by whether a group has a selection yet', async () => {
    const user = userEvent.setup();
    const pairs = [
      { leftArchiveId: 'a1', rightArchiveId: 'a2', source: 'image' },
      { leftArchiveId: 'b1', rightArchiveId: 'b2', source: 'image' },
    ];
    const ids = ['a1', 'a2', 'b1', 'b2'];
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 4, archiveCount: 4 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: ids.map((id) => ({ serverId: 's', archiveId: id, title: id.toUpperCase(), tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' })) };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 4, total: 4, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 2, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_save_selection') return { ok: true, value: null };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs, selectedArchiveIds: [], outcomes: [] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 勾选第一组的 a1，第二组不动。
    await user.click(await screen.findByRole('checkbox', { name: '选择 A1' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: '选择 A1' })).toHaveAttribute('aria-checked', 'true'));

    // 「选择」和另外两个筛选一样是下拉框。
    const selection = screen.getByRole('combobox', { name: '选择' });
    await user.selectOptions(selection, 'selected');
    expect(screen.getByRole('checkbox', { name: '选择 A1' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择 B1' })).not.toBeInTheDocument();

    await user.selectOptions(selection, 'pending');
    expect(screen.queryByRole('checkbox', { name: '选择 A1' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 B1' })).toBeInTheDocument();

    await user.selectOptions(selection, 'all');
    expect(screen.getByRole('checkbox', { name: '选择 A1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 B1' })).toBeInTheDocument();
  });

  it('makes a loaded saved result editable and preserves edits made during a save', async () => {
    const user = userEvent.setup();
    const base = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 2, pageCount: 2 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 2 },
    ]);
    let completeSave: (() => void) | undefined;
    const adapter = vi.fn(async (command: string, args?: Parameters<typeof base>[1]) => {
      if (command === 'dedup_list_sessions') return { ok: true, value: [{ sessionId: 'scan', scopeId: 'scope', status: 'completed', archiveCount: 2, pairCount: 1, createdAt: '2026-10-23', updatedAt: '2026-10-23', saved: true }] };
      if (command === 'dedup_save_session') {
        await new Promise<void>((resolve) => { completeSave = resolve; });
        return { ok: true, value: null };
      }
      return base(command, args);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /^载入 / }));
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择 Archive A' }));
    await user.click(screen.getByRole('button', { name: '保存扫描结果' }));
    await waitFor(() => expect(completeSave).toBeDefined());
    await user.click(screen.getByRole('checkbox', { name: '选择 Archive B' }));
    await act(async () => { completeSave!(); });
    expect(await screen.findByRole('button', { name: '保存扫描结果' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存扫描结果' }));
    await act(async () => { completeSave!(); });
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
  });

  it('deletes the only saved result after its pending selection checkpoint', async () => {
    const user = userEvent.setup();
    const base = scanFixture([
      { id: 'a', title: 'Archive A', tags: [], fileSize: 2, pageCount: 2 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 2 },
    ]);
    let completeSelection: (() => void) | undefined;
    let deleted = false;
    const adapter = vi.fn(async (command: string, args?: Parameters<typeof base>[1]) => {
      if (command === 'dedup_list_sessions') return { ok: true, value: deleted ? [] : [{ sessionId: 'scan', scopeId: 'scope', status: 'completed', archiveCount: 2, pairCount: 1, createdAt: '2026-10-23', updatedAt: '2026-10-23', saved: true }] };
      if (command === 'dedup_save_selection') await new Promise<void>((resolve) => { completeSelection = resolve; });
      if (command === 'dedup_delete_session') { deleted = true; return { ok: true, value: null }; }
      return base(command, args);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /^载入 / }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 Archive A' }));
    await waitFor(() => expect(completeSelection).toBeDefined());
    await user.click(screen.getByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /^删除 / }));
    expect(deleted).toBe(false);
    await act(async () => { completeSelection!(); });
    expect(await screen.findByText('还没有保存的扫描结果')).toBeInTheDocument();
    expect(deleted).toBe(true);
    expect(screen.queryByRole('region', { name: '本次扫描' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '扫描结果' }));
    expect(await screen.findByText('还没有保存的扫描结果')).toBeInTheDocument();
  });

  it('does not save after scanning, and saves explicitly on request', async () => {
    const user = userEvent.setup();
    const base = scanFixture([
      { id: 'a', title: 'Archive A', tags: ['language:chinese'], fileSize: 2, pageCount: 2 },
      { id: 'b', title: 'Archive B', tags: [], fileSize: 1, pageCount: 2 },
    ]);
    const adapter = vi.fn(async (command: string, args?: Parameters<typeof base>[1]) => command === 'dedup_save_session'
      ? { ok: true, value: null } : base(command, args));
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));
    const save = await screen.findByRole('button', { name: '保存扫描结果' });
    expect(adapter.mock.calls.some(([command]) => command === 'dedup_save_session')).toBe(false);
    await user.click(save);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_save_session', expect.objectContaining({ sessionId: expect.any(String) })));
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择 Archive A' }));
    expect(await screen.findByRole('button', { name: '保存扫描结果' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '保存扫描结果' }));
    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
    expect(adapter.mock.calls.filter(([command]) => command === 'dedup_save_session')).toHaveLength(2);
  });
});

describe('dedup scan progress and saved results', () => {
  const scanProgress = {
    sessionId: 'scan', scopeId: 'scope', status: 'running', stage: 'covers',
    processed: 3, total: 10, cacheHits: 1, downloads: 2, missingCovers: 0, invalidCovers: 0,
    pairCount: 0, degraded: false, checkpoint: 3, diagnostics: [], pairs: [],
  };

  it('paints a progress bar as soon as the scan starts and follows the polled progress', async () => {
    const user = userEvent.setup();
    let resolveScan: ((value: unknown) => void) | undefined;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: Array.from({ length: 10 }, (_, index) => ({ serverId: 's', archiveId: `a${index}`, title: `A${index}`, tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' })) };
      if (command === 'dedup_scan') return new Promise((resolve) => { resolveScan = resolve; });
      if (command === 'dedup_scan_progress') return { ok: true, value: scanProgress };
      if (command === 'dedup_load_result') return { ok: true, value: { session: { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 10, archiveCount: 10 }, archives: [], pairs: [], selectedArchiveIds: [], outcomes: [] } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '开始扫描' }));

    // 点击后立刻出现进度卡：不等到第一个分块下载完才有反应。
    const bar = await screen.findByRole('progressbar', { name: '扫描进度' });
    expect(await screen.findByText('正在枚举档案')).toBeInTheDocument();
    // 轮询拿到后端进度后，条与百分比跟着走（3/10）。
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '30'), { timeout: 3000 });
    expect(screen.getByText(/3 \/ 10/)).toBeInTheDocument();
    // 让扫描收尾：busy 落下后轮询停止，测试结束前不再有定时器回调。
    await act(async () => {
      resolveScan?.({ ok: true, value: { ...scanProgress, status: 'completed', stage: 'completed', processed: 10, checkpoint: 10 } });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '开始扫描' })).toBeEnabled());
  });

  it('opens the non-duplicate relations in a dialog with archive titles', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return {
        ok: true,
        value: [{ serverId: 's', archiveId: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' }],
      };
      if (command === 'dedup_list_non_duplicates') return {
        ok: true,
        value: [
          { pairKey: 'a|z', leftArchiveId: 'a', rightArchiveId: 'z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k3j2i1h0g9', tombstoned: false },
        ],
      };
      // 身份列表里没有概览弹窗要的全字段：打开标题时按 id 现取整条记录。
      if (command === 'list_archives_by_ids') return {
        ok: true,
        value: [{ serverId: 's', archiveId: 'a', title: 'Archive A', tags: [], fileSize: 1, pageCount: 1, updatedAt: '2026-01-01' }],
      };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<MemoryRouter><ToastProvider><DeduplicationWorkspace /></ToastProvider></MemoryRouter>);

    // 入口固定在检测范围卡的动作行里，打开的是对话框而不是页面中间的面板。
    const entry = await screen.findByRole('button', { name: '不重复关系' });
    expect(entry.closest('.dedup-section')).not.toBeNull();
    await user.click(entry);
    const dialog = await screen.findByRole('dialog', { name: '不重复关系' });
    expect(within(dialog).getByRole('textbox')).not.toHaveFocus();
    expect(dialog).toHaveFocus();
    expect(within(dialog).queryByRole('button', { name: '关闭' })).not.toBeInTheDocument();
    // 「已移除」的含义写在说明里：不再参与比对，但仍可恢复标记。
    expect(within(dialog).getByPlaceholderText('在 1 条不重复关系中搜索')).toBeInTheDocument();
    expect(within(dialog).queryByText(/不再参与比对/)).not.toBeInTheDocument();
    // 行内显示的是档案标题（按 ID 解析），解析不到才退回 ID 前缀。
    // 库里还有的档案，标题就是打开档案概览的入口（就地看，不跳阅读器），
    // 已删除的只显示文字。
    const titleButton = within(dialog).getByRole('button', { name: 'Archive A' });
    expect(within(dialog).getByText('未知档案 z8y7x6w5')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.dedup-relation-title')).toHaveLength(1);
    // 行内不再显示档案 ID。
    expect(dialog.querySelector('code')).toBeNull();

    await user.click(titleButton);
    const overview = await screen.findByRole('dialog', { name: 'Archive A' });
    expect(screen.queryByRole('dialog', { name: '不重复关系' })).not.toBeInTheDocument();
    expect(within(overview).getByLabelText('档案概览')).toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: '第 1 页' })).toBeInTheDocument();
    await user.click(within(overview).getByRole('button', { name: '关闭概览' }));
    expect(await screen.findByRole('dialog', { name: '不重复关系' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜索不重复关系' })).not.toHaveFocus();
  });

  it('renders saved results only after refreshed identities and never invents missing archive cards', async () => {
    const user = userEvent.setup();
    const session = { sessionId: 'saved-live', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 3, archiveCount: 3 };
    let validated = false;
    let finish!: (value: unknown) => void;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'dedup_list_non_duplicates') return { ok: true, value: [] };
      if (command === 'list_archive_identities') return { ok: true, value: (validated ? ['a','b'] : ['ghost','a']).map((id) => ({ id, archiveId: id, title: validated ? 'Current ' + id : 'Old ' + id, tags: [], pageCount: 1, fileSize: 1 })) };
      if (command === 'dedup_list_sessions') return { ok: true, value: [{ ...session, pairCount: 2, createdAt: 'now', updatedAt: 'now' }] };
      if (command === 'dedup_load_result') return new Promise((resolve) => { finish = resolve; });
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /^载入 / }));
    expect(adapter).toHaveBeenCalledWith('dedup_load_result', { sessionId: 'saved-live', refreshIndex: true });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await act(async () => {
      validated = true;
      finish({ ok: true, value: { session, archives: [], pairs: [
        { leftArchiveId: 'a', rightArchiveId: 'b', source: 'image' },
        { leftArchiveId: 'ghost', rightArchiveId: 'b', source: 'image' },
      ], selectedArchiveIds: [], outcomes: [] } });
    });
    expect(await screen.findByRole('checkbox', { name: '选择 Current b' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 Current a' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /ghost/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Old a')).not.toBeInTheDocument();
  });

  it('keeps saved history open when current directory validation fails', async () => {
    const user = userEvent.setup();
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities' || command === 'dedup_list_non_duplicates') return { ok: true, value: [] };
      if (command === 'dedup_list_sessions') return { ok: true, value: [{ sessionId: 'saved', scopeId: 'scope', status: 'completed', archiveCount: 2, pairCount: 1, createdAt: 'now', updatedAt: 'now' }] };
      if (command === 'dedup_load_result') return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '目录验证失败，请重试', retryable: true } };
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await user.click(await screen.findByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /^载入 / }));
    expect(await screen.findByText('目录验证失败，请重试')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '扫描结果' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(adapter.mock.calls.filter(([command]) => command === 'list_archive_identities')).toHaveLength(1);
  });

  it('lists saved scan results, loads one and deletes one', async () => {
    const user = userEvent.setup();
    const session = { sessionId: 'saved-1', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 15226, archiveCount: 15226 };
    // 删除真的把这一行从列表里去掉，与落库后的行为一致。
    let saved = [
      { sessionId: 'saved-1', scopeId: 'scope', status: 'completed', archiveCount: 15226, pairCount: 37, createdAt: '2026-09-14 04:20:00', updatedAt: '2026-09-14 04:33:00' },
    ];
    const adapter = vi.fn(async (command: string, payload?: { scopeId?: string; sessionId?: string }) => {
      if (command === 'load_preferences') return { ok: true, value: DEFAULT_PREFERENCES };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archive_identities') return { ok: true, value: [] };
      if (command === 'dedup_list_sessions') return { ok: true, value: saved };
      if (command === 'dedup_load_result') return { ok: true, value: { session, archives: [], pairs: [], selectedArchiveIds: [], outcomes: [] } };
      if (command === 'dedup_delete_session') { saved = saved.filter((item) => item.sessionId !== payload?.sessionId); return { ok: true, value: null }; }
      throw new Error(command);
    });
    setInvokeAdapterForTests(adapter);
    render(<ToastProvider><DeduplicationWorkspace /></ToastProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '扫描结果' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '扫描结果' }));

    const dialog = await screen.findByRole('dialog', { name: '扫描结果' });
    expect(await screen.findByText(/15,226 档案 · 37 组疑似重复/)).toBeInTheDocument();
    // 纯图标按钮：可访问名带上这是哪一次结果，免得一排「载入」分不出谁是谁。
    await user.click(screen.getByRole('button', { name: /^载入 / }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_load_result', { sessionId: 'saved-1', refreshIndex: true }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(await screen.findByText('已载入扫描结果：0 组疑似重复')).toBeInTheDocument();

    // 同一个结果再删一次：命令带会话 id，删除后列表刷新。
    await user.click(screen.getByRole('button', { name: '扫描结果' }));
    await user.click(await screen.findByRole('button', { name: /删除/ }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_delete_session', { sessionId: 'saved-1' }));
    // 空态是「这里什么都没有」，不再是一条套着记录外框的列表项。
    expect(await screen.findByText('还没有保存的扫描结果')).toBeInTheDocument();
    expect(document.querySelector('.dedup-history-list')).toBeNull();
  });


});
