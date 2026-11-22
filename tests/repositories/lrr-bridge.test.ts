import { simulateRouteCacheRestartForTests } from '../../src/lib/routeCache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeDedupRepository } from '../../src/repositories/nativeDedupRepository';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';
import { NativeLrrBridgeRepository, invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';
const metadata = { protocol: 1, serverId: 'server', epoch: 'epoch', version: 4 };
const state = { archiveId: 'a', version: 4, generation: 0, watchlistAt: 'now', historyAt: 'now',
  progress: { pageIndex: 3, pageCount: 10, layout: 'paged', direction: 'rtl', coverAlone: null, updatedAt: 'now' } };
afterEach(() => { invalidateLrrBridgeConfig(); resetInvokeAdapterForTests(); vi.restoreAllMocks(); });
describe('optional LANraragi reading data', () => {
  it('keeps default mode local and caches only successful local configuration', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async command => {
      commands.push(command);
      return { ok: true, value: command === 'lrr_bridge_config' ? { enabled: false, pending: 0, conflicts: 0 } : null };
    });
    const repo = new NativeLibraryRepository();
    await repo.loadProgress('s', 'a'); await repo.loadProgress('s', 'b');
    expect(commands).toEqual(['lrr_bridge_config', 'load_reading_progress', 'load_reading_progress']);
  });
  it('shares a pending hosted state lookup between progress and membership', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
      if (command === 'get_archive_membership') return { ok: true, value: { reading: false, favorites: true } };
      if (args?.action === 'states') return pending;
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);
    const repo = new NativeLibraryRepository();
    const progress = repo.loadProgress('s', 'a');
    const membership = repo.archiveMembership('s', 'a');
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledWith('get_archive_membership', { scopeId: 's', archiveId: 'a' }));
    expect(adapter.mock.calls.filter(([, args]) => args?.action === 'states')).toHaveLength(1);
    finish({ ok: true, value: { ...metadata, states: [state] } });
    expect(await progress).toMatchObject({ ok: true, value: { pageIndex: 3 } });
    expect(await membership).toEqual({ ok: true, value: { reading: true, favorites: true } });
  });
  it('maps hosted progress/history/watchlist through hosted commands', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command, args) => {
      commands.push(command);
      if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 1, conflicts: 0 } };
      if (args?.action === 'apply') return { ok: true, value: { state, queued: true } };
      return { ok: true, value: { ...metadata, states: [state], total: 1 } };
    });
    const repo = new NativeLibraryRepository();
    expect(await repo.loadProgress('s', 'a')).toEqual({ ok: true, value: { ...state.progress, scopeId: 's', archiveId: 'a', revision: 4 } });
    expect((await repo.listHistory('s')).ok).toBe(true);
    expect((await repo.listWatchlist('s')).ok).toBe(true);
    expect((await repo.clearReadingProgress('s', 'a')).ok).toBe(true);
    expect(commands.every(command => command.startsWith('lrr_bridge_'))).toBe(true);
  });
  it('refreshes history with additions and tombstones since the last complete snapshot', async () => {
    const recent = { ...state, archiveId: 'b', historyAt: '2026-11-21T12:00:00Z' };
    const removed = { ...state, version: 5, historyAt: null };
    const adapter = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      if (args?.action === 'list') return { ok: true, value: { ...metadata, historyDelta: true, states: [state], total: 1 } };
      if (args?.action === 'history_changes') {
        const since = (args.input as { since: number }).since;
        return { ok: true, value: { ...metadata, version: 6, states: since < 6 ? [removed, recent] : [], total: since < 6 ? 2 : 0 } };
      }
      throw new Error(`Unexpected action: ${args?.action}`);
    });
    setInvokeAdapterForTests(adapter);
    const repo = new NativeLrrBridgeRepository();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state] });
    simulateRouteCacheRestartForTests();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [recent] });
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [recent] });
    expect(adapter.mock.calls.map(([, args]) => [args?.action, (args?.input as { since?: number }).since])).toEqual([
      ['list', undefined], ['history_changes', 4], ['history_changes', 6],
    ]);
  });

  it('retries the delta from the last complete cursor when a write shifts the next page', async () => {
    const partial = { ...state, archiveId: 'partial', historyAt: '2026-11-20T12:00:00Z' };
    const newest = { ...state, archiveId: 'newest', historyAt: '2026-11-21T12:00:00Z' };
    const actions: string[] = [];
    const offsets: number[] = [];
    setInvokeAdapterForTests(async (_command, args) => {
      actions.push(String(args?.action));
      if (args?.action === 'list') return { ok: true, value: { ...metadata, historyDelta: true, states: [state], total: 1 } };
      if (args?.action !== 'history_changes') throw new Error(`Unexpected action: ${args?.action}`);
      const { since, offset } = args.input as { since: number; offset: number };
      expect(since).toBe(4);
      offsets.push(offset);
      if (offsets.length === 1) return { ok: true, value: { ...metadata, version: 5, states: [partial], total: 2 } };
      return { ok: true, value: { ...metadata, version: 6, states: [newest], total: 1 } };
    });
    const repo = new NativeLrrBridgeRepository();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state] });
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state, newest] });
    expect(offsets).toEqual([0, 1, 0]);
    expect(actions.filter(action => action === 'list')).toHaveLength(1);
  });

  it('shows queued history removals without persisting them as remote tombstones', async () => {
    let pendingStates = [{ ...state, historyAt: null }];
    setInvokeAdapterForTests(async (_command, args) => ({ ok: true, value: args?.action === 'history_changes'
      ? { ...metadata, states: [], total: 0, pendingStates }
      : { ...metadata, states: [state], total: 1, historyDelta: true } }));
    const repo = new NativeLrrBridgeRepository();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state] });
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [] });
    pendingStates = [];
    simulateRouteCacheRestartForTests();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state] });
  });

  it('uses the last complete history and queued writes if a later delta page is offline', async () => {
    const partial = { ...state, archiveId: 'partial', version: 6 };
    const queued = { ...state, archiveId: 'queued' };
    const adapter = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      if (args?.action === 'list') return { ok: true, value: { ...metadata, states: [state], total: 1, historyDelta: true } };
      const { offset } = args?.input as { offset: number };
      return { ok: true, value: offset === 0
        ? { ...metadata, states: [partial], total: 2, version: 6 }
        : { ...metadata, states: [], total: 0, offline: true, pendingStates: [queued] } };
    });
    setInvokeAdapterForTests(adapter);
    const repo = new NativeLrrBridgeRepository();
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state] });
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [state, queued] });
    expect(adapter.mock.calls.map(([, args]) => args?.action)).toEqual(['list', 'history_changes', 'history_changes']);
  });

  it('does not publish a history snapshot after its scope was invalidated', async () => {
    let release!: () => void;
    const firstResponse = new Promise<void>(resolve => { release = resolve; });
    const fresh = { ...state, archiveId: 'fresh' };
    const adapter = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      expect(args?.action).toBe('list');
      const first = adapter.mock.calls.length === 1;
      if (first) await firstResponse;
      return { ok: true, value: { ...metadata, historyDelta: true, states: [first ? state : fresh], total: 1 } };
    });
    setInvokeAdapterForTests(adapter);
    const repo = new NativeLrrBridgeRepository();
    const stale = repo.list('s', 'history');
    invalidateLrrBridgeConfig('s');
    expect(await repo.list('s', 'history')).toEqual({ ok: true, value: [fresh] });
    release();
    expect((await stale).ok).toBe(false);
  });

  it('keeps external history pages and accepts removed history states', async () => {
    const imported = { ...state, historyPageIndex: 7 };
    const removed = { ...state, archiveId: 'b', historyAt: null, historyRemovedAt: '2026-11-19T09:00:00.000Z' };
    setInvokeAdapterForTests(async (command) => ({ ok: true, value: command === 'lrr_bridge_config'
      ? { enabled: true, pending: 0, conflicts: 0 }
      : { ...metadata, states: [imported, removed], total: 2 } }));
    expect(await new NativeLibraryRepository().listHistory('s')).toMatchObject({ ok: true, value: [{ archiveId: 'a', pageIndex: 7 }] });
  });
  it('paginates lists and rejects continuously changing snapshots', async () => {
    let version = 0;
    const inputs: unknown[] = [];
    setInvokeAdapterForTests(async (_command, args) => {
      inputs.push(args?.input); version++;
      return { ok: true, value: { ...metadata, version, states: [state], total: 101 } };
    });
    expect((await new NativeLrrBridgeRepository().list('s', 'history')).ok).toBe(false);
    expect(inputs).toHaveLength(4);
  });
  it('invalidates cached mode across all repository instances after configuration', async () => {
    let enabled = false;
    setInvokeAdapterForTests(async (command, args) => {
      if (command === 'lrr_bridge_configure') enabled = args?.enabled as boolean;
      return { ok: true, value: { enabled, pending: 0, conflicts: 0 } };
    });
    const first = new NativeLrrBridgeRepository(); const second = new NativeLrrBridgeRepository();
    expect((await first.config('s')).ok).toBe(true);
    await second.configure('s', true);
    expect(await first.config('s')).toEqual({ ok: true, value: { enabled: true, pending: 0, conflicts: 0 } });
  });
  it('submits explicit regression preference and treats workspace conflicts as failures', async () => {
    const calls: Record<string, unknown>[] = [];
    setInvokeAdapterForTests(async (_command, args) => {
      calls.push(args!);
      if (args?.action === 'apply') return { ok: true, value: { state, queued: true } };
      return { ok: true, value: { ...metadata, errorCode: 'BRIDGE_CONFLICT', workspace: { key: 'dedup:manifest', version: 2, value: [] } } };
    });
    const repo = new NativeLrrBridgeRepository();
    expect((await repo.apply('s', 'a', 'progress', { ...state.progress, layout: 'paged', direction: 'ltr', allowProgressRegression: true })).ok).toBe(true);
    expect(calls[0]).toMatchObject({ input: { operation: { progress: { allowProgressRegression: true } } } });
    expect(await repo.workspacePut('s', 'dedup:manifest', 1, [], 'fixed-retry-id')).toMatchObject({ ok: false, error: { code: 'REMOTE_CONFLICT' } });
    expect(calls[1]).toMatchObject({ input: { operationId: 'fixed-retry-id', expectedVersion: 1 } });
    const before = calls.length;
    expect((await repo.workspacePut('s', 'dedup:manifest', 1, '字'.repeat(700))).ok).toBe(false);
    expect(calls).toHaveLength(before);
  });
});


describe('hosted preset and non-duplicate collections', () => {
  const preset = { scopeId: 's', presetId: 'p', name: 'Saved', query: 'artist:a', sortBy: 'added' as const, sortOrder: 'desc' as const, categoryId: null };
  const record = { collection: 'search_presets', key: 'p', version: 3, value: preset, createdAt: '2026-01-01', updatedAt: '2026-01-02' };
  const pair = { scopeId: 's', leftArchiveId: 'a', rightArchiveId: 'b' };
  const failure = { ok: false as const, error: { code: 'NETWORK', message: 'offline', retryable: true } };

  it('lists hosted presets, filters tombstones and routes saves and deletes through the collection', async () => {
    const adapter = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
      if (command === 'list_search_presets') return { ok: true, value: [] };
      if (args?.action === 'collection_list') return { ok: true, value: { records: [record, { ...record, key: 'gone', value: null }] } };
      const operation = (args?.input as { operation: { value: unknown } }).operation;
      return { ok: true, value: { queued: true, record: { ...record, value: operation.value } } };
    });
    setInvokeAdapterForTests(adapter);
    const repo = new NativeLibraryRepository();
    expect(await repo.listSearchPresets('s')).toMatchObject({ ok: true, value: [{ presetId: 'p', name: 'Saved', revision: 3 }] });
    expect(await repo.saveSearchPreset(preset)).toMatchObject({ ok: true, value: { presetId: 'p', deleted: false } });
    expect(await repo.deleteSearchPreset('s', 'p')).toMatchObject({ ok: true, value: { presetId: 'p', deleted: true } });
    expect(adapter).toHaveBeenCalledWith('lrr_bridge_request', { scopeId: 's', action: 'collection_apply', input: { operation: { collection: 'search_presets', key: 'p', value: null } } });
    expect(adapter.mock.calls.some(([command]) => command === 'save_search_preset' || command === 'delete_search_preset')).toBe(false);
  });

  it('refreshes hosted marks before both scan paths and relation listing', async () => {
    const commands: string[] = [];
    setInvokeAdapterForTests(async (command, args) => {
      commands.push(command === 'lrr_bridge_request' ? String(args?.action) : command);
      if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
      if (args?.action === 'collection_list') return { ok: true, value: { records: [] } };
      if (command === 'dedup_list_non_duplicates') return { ok: true, value: [] };
      return failure;
    });
    const repo = new NativeDedupRepository();
    await repo.startScan({ sessionId: 'one', scopeId: 's', algorithmVersion: 'v1', archiveCount: 2 });
    await repo.scan({ sessionId: 'two', scopeId: 's', algorithmVersion: 'v1' });
    await repo.listNonDuplicates('s');
    expect(commands).toEqual(['lrr_bridge_config', 'collection_list', 'dedup_start_scan', 'collection_list', 'dedup_scan', 'collection_list', 'dedup_list_non_duplicates']);
  });

  it('stops a hosted scan when refreshing exclusions fails', async () => {
    const adapter = vi.fn(async (command: string) => command === 'lrr_bridge_config'
      ? { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } } : failure);
    setInvokeAdapterForTests(adapter);
    expect(await new NativeDedupRepository().scan({ sessionId: 'scan', scopeId: 's', algorithmVersion: 'v1' })).toEqual(failure);
    expect(adapter.mock.calls.some(([command]) => command === 'dedup_scan')).toBe(false);
  });

  it('notifies hosted lifecycle after saves, removals and imported relations', async () => {
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('yomika:lrr-bridge-write', listener);
    setInvokeAdapterForTests(async command => ({ ok: true, value: command === 'lrr_bridge_config'
      ? { enabled: true, pending: 0, conflicts: 0 } : command === 'dedup_save_non_duplicates' ? [true, false] : null }));
    try {
      const repo = new NativeDedupRepository();
      expect((await repo.saveNonDuplicate(pair)).ok).toBe(true);
      expect((await repo.saveNonDuplicates([pair, pair])).ok).toBe(true);
      expect((await repo.removeNonDuplicate(pair)).ok).toBe(true);
      expect((await repo.importReadoshi({ scopeId: 's', pairs: [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'readoshi' }] })).ok).toBe(true);
      expect(events).toEqual(Array.from({ length: 4 }, () => ({ scopeId: 's', kind: 'non_duplicates' })));
    } finally { window.removeEventListener('yomika:lrr-bridge-write', listener); }
  });

  it('keeps disabled collections local and avoids hosted requests', async () => {
    const adapter = vi.fn(async (command: string) => ({ ok: true, value: command === 'lrr_bridge_config'
      ? { enabled: false, pending: 0, conflicts: 0 } : [] }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeLibraryRepository().listSearchPresets('s')).toEqual({ ok: true, value: [] });
    expect(await new NativeDedupRepository().listNonDuplicates('s')).toEqual({ ok: true, value: [] });
    expect(adapter.mock.calls.map(([command]) => command)).toEqual(['lrr_bridge_config', 'list_search_presets', 'dedup_list_non_duplicates']);
  });
});


it('advances hosted pagination by the returned rows after server deletions shorten a page', async () => {
  const offsets: number[] = [];
  setInvokeAdapterForTests(async (_command, args) => {
    const offset = (args?.input as { offset: number }).offset;
    offsets.push(offset);
    return { ok: true, value: { ...metadata, total: 3, states: offset === 0 ? [{ ...state, archiveId: 'a' }, { ...state, archiveId: 'b' }] : [{ ...state, archiveId: 'c' }] } };
  });
  expect(await new NativeLrrBridgeRepository().list('s', 'history')).toMatchObject({ ok: true, value: [{ archiveId: 'a' }, { archiveId: 'b' }, { archiveId: 'c' }] });
  expect(offsets).toEqual([0, 2]);
});

it('restarts an empty hosted page once and bounds retries when deletions keep invalidating it', async () => {
  const offsets: number[] = [];
  setInvokeAdapterForTests(async (_command, args) => {
    offsets.push((args?.input as { offset: number }).offset);
    return { ok: true, value: { ...metadata, total: 2, states: [] } };
  });
  expect(await new NativeLrrBridgeRepository().list('s', 'watchlist')).toMatchObject({ ok: false, error: { code: 'REMOTE_CONFLICT', retryable: true } });
  expect(offsets).toEqual([0, 0]);
});
