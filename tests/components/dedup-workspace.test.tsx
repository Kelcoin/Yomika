import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeduplicationWorkspace } from '../../src/components/DeduplicationWorkspace';
import { ToastProvider } from '../../src/components/Toast';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);
describe('duplicate deletion confirmation', () => {
  it('confirms favorite synchronization and reports failed archive outcomes', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId:'a',rightArchiveId:'b',source:'filename' };
    const session = {sessionId:'scan',scopeId:'scope',algorithmVersion:'v1',status:'completed',checkpoint:2,archiveCount:2};
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return {ok:true,value:{...DEFAULT_PREFERENCES,ehFavoriteDeleteSync:true}};
      if (command === 'list_servers') return {ok:true,value:[{id:'s',scopeId:'scope',name:'Server',baseUrl:'https://lrr.test'}]};
      if (command === 'list_archives') return {ok:true,value:[]};
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

  it('marks every pair of a selected group as non-duplicate on execute', async () => {
    const user = userEvent.setup();
    const pair = { leftArchiveId: 'a', rightArchiveId: 'b', source: 'filename' };
    const session = { sessionId: 'scan', scopeId: 'scope', algorithmVersion: 'v1', status: 'completed', checkpoint: 2, archiveCount: 2 };
    const adapter = vi.fn(async (command: string) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archives') return { ok: true, value: [] };
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
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dedup_save_non_duplicate', { input: { scopeId: 'scope', leftArchiveId: 'a', rightArchiveId: 'b' } }));
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
    await waitFor(() => expect(screen.getByText(/执行完成：标记 0 组，删除 1 个/)).toBeInTheDocument());
    expect(screen.queryByRole('checkbox', { name: /Archive A/ })).not.toBeInTheDocument();
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
    const adapter = vi.fn(async (command: string, payload?: { input?: { selectedArchiveIds?: string[] } }) => {
      if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES, ehFavoriteDeleteSync: false } };
      if (command === 'list_servers') return { ok: true, value: [{ id: 's', scopeId: 'scope', name: 'Server', baseUrl: 'https://lrr.test' }] };
      if (command === 'list_archives') return { ok: true, value: records };
      if (command === 'dedup_scan') return { ok: true, value: { ...session, stage: 'completed', processed: 2, total: 2, cacheHits: 0, downloads: 0, missingCovers: 0, invalidCovers: 0, pairCount: 1, degraded: false, diagnostics: [], pairs } };
      if (command === 'dedup_scan_chunk') {
        selectedArchiveIds = [...(payload?.input?.selectedArchiveIds ?? [])];
        return { ok: true, value: session };
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

    expect(await screen.findByText('无修正')).toBeInTheDocument();
    expect(screen.getByText('渣翻')).toBeInTheDocument();
    expect(screen.getByText('外部广告')).toBeInTheDocument();
    expect(screen.getByText('无汉语')).toBeInTheDocument();
    expect(screen.getByText('2.5 MB · 24页')).toBeInTheDocument();
    expect(screen.getByText('1.2 MB · 24页')).toBeInTheDocument();
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
    expect(adapter.mock.calls.filter(([command]) => command === 'dedup_scan_chunk').length).toBe(0);
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
      if (command === 'list_archives') return {
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

    // 切到重复链视图，链标头一次选中链内全部组。
    await screen.findByText(/已标记跳过/);
    await user.selectOptions(screen.getByRole('combobox', { name: '视图' }), 'chains');
    await user.click(await screen.findByRole('button', { name: '关联重复链' }));
    expect(await screen.findByText(/待标记组 2 组/)).toBeInTheDocument();
  });
});
