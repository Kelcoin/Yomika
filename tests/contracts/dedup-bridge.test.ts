import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeDedupRepository } from '../../src/repositories/nativeDedupRepository';

afterEach(resetInvokeAdapterForTests);

describe('native dedup bridge', () => {
  it('checks file hash through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { hash: 'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f', size: 1234 } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const result = await repository.checkFile('/path/to/file.zip');
    expect(result).toEqual({ ok: true, value: { hash: 'ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f', size: 1234 } });
    expect(adapter).toHaveBeenCalledWith('dedup_check_file', { path: '/path/to/file.zip' });
  });

  it('returns error when checkFile fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'File not found', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.checkFile('/missing')).toEqual({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'File not found', retryable: true } });
  });

  it('saves dedup feature through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const input = { scopeId: 'scope-a', path: '/path/to/file.zip', exactHash: 'a'.repeat(64), dhash: 'ff'.repeat(8), algorithmVersion: '1', size: 1024 };
    expect(await repository.saveFeature(input)).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('dedup_save_feature', { input });
  });

  it('bridges scan chunks, cancellation, and resume with typed sessions', async () => {
    const session = { sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v1', status: 'running', checkpoint: 1, archiveCount: 2 };
    const adapter = vi.fn(async () => ({ ok: true, value: session }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const chunk = { sessionId: 'scan-1', algorithmVersion: 'v1', checkpoint: 1, archives: [], pairs: [], selectedArchiveIds: [] };
    await repository.scanChunk(chunk);
    await repository.cancelScan('scan-1');
    await repository.resumeScan('scan-1');
    expect(adapter.mock.calls).toEqual([
      ['dedup_scan_chunk', { input: chunk }],
      ['dedup_cancel_scan', { sessionId: 'scan-1' }],
      ['dedup_resume_scan', { sessionId: 'scan-1' }],
    ]);
  });

  it('returns error when saveFeature fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid dedup feature', retryable: false } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.saveFeature({ scopeId: '', path: '', exactHash: '', algorithmVersion: '1', size: 0 })).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid dedup feature', retryable: false } });
  });

  it('finds exact hash matches through the native bridge', async () => {
    const records = [{ scopeId: 'scope-a', path: '/a.zip', exactHash: 'a'.repeat(64), dhash: null, algorithmVersion: '1', size: 100 }];
    const adapter = vi.fn(async () => ({ ok: true, value: records }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.findExact('scope-a', 'a'.repeat(64))).toEqual({ ok: true, value: records });
    expect(adapter).toHaveBeenCalledWith('dedup_find_exact', { scopeId: 'scope-a', exactHash: 'a'.repeat(64) });
  });

  it('returns empty array when findExact has no matches', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [] }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    expect(await repository.findExact('scope-a', 'f'.repeat(64))).toEqual({ ok: true, value: [] });
  });

  it('bridges durable scan lifecycle and validates the loaded graph', async () => {
    const session = { sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v1', status: 'running', checkpoint: 0, archiveCount: 2 };
    const loaded = {
      session: { ...session, status: 'completed', checkpoint: 2 },
      archives: [{ archiveId: 'a', path: 'cover:a', title: 'A', pageCount: 10, size: 100, featureVersion: 'v1' }],
      pairs: [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'image', diagnostics: { distance: 2 } }],
      selectedArchiveIds: ['a'], outcomes: [],
    };
    const adapter = vi.fn(async (command: string) => ({ ok: true, value: command === 'dedup_load_result' ? loaded : session }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const input = { sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v1', archiveCount: 2 };
    expect(await repository.startScan(input)).toEqual({ ok: true, value: session });
    expect(await repository.loadResult('scan-1')).toEqual({ ok: true, value: loaded });
    expect(adapter).toHaveBeenNthCalledWith(1, 'dedup_start_scan', { input });
    expect(adapter).toHaveBeenNthCalledWith(2, 'dedup_load_result', { sessionId: 'scan-1' });
  });

  it('bridges exclusions, imports, and partial deletion outcomes', async () => {
    const adapter = vi.fn(async (command: string) => command === 'dedup_delete_selected'
      ? { ok: true, value: { rejectedArchiveIds: [], outcomes: [{ archiveId: 'a', deleted: false, message: 'offline' }] } }
      : { ok: true, value: undefined });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeDedupRepository();
    const relation = { scopeId: 'scope-a', leftArchiveId: 'b', rightArchiveId: 'a' };
    await repository.saveNonDuplicate(relation);
    await repository.removeNonDuplicate(relation);
    await repository.importReadoshi({ scopeId: 'scope-a', pairs: [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'import', diagnostics: null }] });
    expect(await repository.deleteSelected({ sessionId: 'scan-1', outcomes: [{ archiveId: 'a', deleted: false, message: 'offline' }] })).toEqual({
      ok: true, value: { rejectedArchiveIds: [], outcomes: [{ archiveId: 'a', deleted: false, message: 'offline' }] },
    });
    expect(adapter.mock.calls.map(([command]) => command)).toEqual([
      'dedup_save_non_duplicate', 'dedup_remove_non_duplicate', 'dedup_import_readoshi', 'dedup_delete_selected',
    ]);
  });

  it('defaults deletion to native execution without injected outcomes', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { rejectedArchiveIds: [], outcomes: [] } }));
    setInvokeAdapterForTests(adapter);
    await new NativeDedupRepository().deleteSelected({ sessionId: 'scan-1' });
    expect(adapter).toHaveBeenCalledWith('dedup_delete_selected', { input: { sessionId: 'scan-1', outcomes: [] } });
  });

  it('rejects malformed native scan results', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: { sessionId: 'scan-1', checkpoint: -1 } }));
    const result = await new NativeDedupRepository().resumeScan('scan-1');
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Native command returned an invalid response', retryable: false } });
  });

  it('starts a cache-first bounded scan and validates typed progress', async () => {
    const progress = {
      sessionId: 'scan-1', scopeId: 'scope-a', status: 'completed', stage: 'completed',
      processed: 2, total: 2, cacheHits: 2, downloads: 0, missingCovers: 0,
      invalidCovers: 0, pairCount: 1, degraded: false, checkpoint: 2,
      diagnostics: [], pairs: [{ leftArchiveId: 'a', rightArchiveId: 'b', source: 'image', diagnostics: null }],
    };
    const adapter = vi.fn(async (command: string) => command === 'dedup_scan'
      ? { ok: true, value: progress } : { ok: true, value: undefined });
    setInvokeAdapterForTests(adapter);
    const result = await new NativeDedupRepository().scan({
      sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v2',
      startDate: '2026-01-01', endDate: '2026-12-31', chunkSize: 2,
    });
    expect(result).toEqual({ ok: true, value: progress });
    expect(adapter).toHaveBeenCalledWith('dedup_scan', { input: {
      sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v2',
      startDate: '2026-01-01', endDate: '2026-12-31', chunkSize: 2,
    }});
  });

  it('maps a cancelled scan checkpoint and degraded diagnostics', async () => {
    const progress = {
      sessionId: 'scan-1', scopeId: 'scope-a', status: 'cancelled', stage: 'cancelled',
      processed: 2, total: 4, cacheHits: 1, downloads: 1, missingCovers: 1,
      invalidCovers: 1, pairCount: 0, degraded: true, checkpoint: 2,
      diagnostics: ['archive-b: cover missing'], pairs: [],
    };
    setInvokeAdapterForTests(async () => ({ ok: true, value: progress }));
    expect(await new NativeDedupRepository().scan({
      sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v2', chunkSize: 2,
    })).toEqual({ ok: true, value: progress });
  });

  it('maps malformed scan progress to INVALID_RESPONSE', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: {
      sessionId: 'scan-1', scopeId: 'scope-a', status: 'completed', processed: -1,
    }}));
    expect(await new NativeDedupRepository().scan({
      sessionId: 'scan-1', scopeId: 'scope-a', algorithmVersion: 'v2', chunkSize: 2,
    })).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'Native command returned an invalid response', retryable: false } });
  });
});
