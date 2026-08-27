import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

afterEach(resetInvokeAdapterForTests);

describe('native library repository bridge', () => {
  it('replaces archives from a validated LANraragi search response', async () => {
    const value = [{ serverId: 'scope-a', archiveId: 'a1', title: 'Archive', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z' }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().replaceArchives('scope-a', '{"data":[]}');

    expect(adapter).toHaveBeenCalledWith('replace_archives', { input: { serverId: 'scope-a', searchResponseJson: '{"data":[]}' } });
    expect(result).toEqual({ ok: true, value });
  });

  it('loads reader manifest and page bytes through native commands', async () => {
    const adapter = vi.fn(async (command: string) => command === 'load_reader_manifest'
      ? { ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['00.jpg'] } }
      : { ok: true, value: [1, 2, 3] });
    setInvokeAdapterForTests(adapter);

    const repository = new NativeLibraryRepository();
    expect(await repository.loadReaderManifest('scope-a', 'a1')).toEqual({
      ok: true, value: { archiveId: 'a1', title: 'Reader', pages: ['00.jpg'] },
    });
    expect(await repository.loadReaderPage('scope-a', 'a1', 0, '00.jpg')).toEqual({
      ok: true, value: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(adapter).toHaveBeenNthCalledWith(1, 'load_reader_manifest', { serverId: 'scope-a', archiveId: 'a1' });
    expect(adapter).toHaveBeenNthCalledWith(2, 'load_reader_page', { serverId: 'scope-a', archiveId: 'a1', pageIndex: 0, path: '00.jpg' });
  });

  it('loads archive metadata through the native detail command', async () => {
    const value = {
      archiveId: 'a1', title: 'Archive', filename: 'archive.cbz', tags: 'artist:test',
      summary: 'Summary', extension: 'cbz', progress: 2, pageCount: 10, lastReadTime: 0, size: 123,
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().loadArchiveMetadata('scope-a', 'a1');

    expect(adapter).toHaveBeenCalledWith('load_archive_metadata', { serverId: 'scope-a', archiveId: 'a1' });
    expect(result).toEqual({ ok: true, value });
  });

  it('deletes an archive through a scoped native command', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().deleteArchive('scope-a', 'a1');

    expect(adapter).toHaveBeenCalledWith('delete_archive', { serverId: 'scope-a', archiveId: 'a1' });
    expect(result).toEqual({ ok: true, value: null });
  });

  it('creates a persistent upload task through the native task command', async () => {
    const value = {
      id: 'task-1', kind: 'download', label: '上传 archive.cbz', status: 'queued',
      progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().createTask({ kind: 'download', label: '上传 archive.cbz' });

    expect(adapter).toHaveBeenCalledWith('create_task', { task: { kind: 'download', label: '上传 archive.cbz' } });
    expect(result).toEqual({ ok: true, value });
  });

  it('lists persisted tasks through the native task command', async () => {
    const value = [{
      id: 'task-1', kind: 'download', label: '下载 archive.cbz', status: 'queued',
      progress: 0, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
    }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listTasks();

    expect(adapter).toHaveBeenCalledWith('list_tasks', {});
    expect(result).toEqual({ ok: true, value });
  });

  it('updates a task status and progress through the native task command', async () => {
    const value = {
      id: 'task-1', kind: 'download', label: '下载 archive.cbz', status: 'running',
      progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:01:00Z',
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().updateTask('task-1', { status: 'running', progress: 0.5 });

    expect(adapter).toHaveBeenCalledWith('update_task', { id: 'task-1', update: { status: 'running', progress: 0.5 } });
    expect(result).toEqual({ ok: true, value });
  });

  it('retries a failed recoverable task explicitly', async () => {
    const value = {
      id: 'task-1', kind: 'download', label: '下载 archive.cbz', status: 'queued',
      progress: 0.5, cancelable: true, retryable: true, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:02:00Z',
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeLibraryRepository().retryTask('task-1')).toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('retry_task', { id: 'task-1' });
  });

  it('uploads a local archive through a task-scoped native command', async () => {
    const value = { operation: 'upload', success: 1, id: 'archive-1' };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().uploadArchive({
      serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/demo.cbz',
    });

    expect(adapter).toHaveBeenCalledWith('upload_archive', {
      serverId: 'scope-a', taskId: 'task-1', filePath: 'C:/library/demo.cbz',
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('lists LANraragi categories through the native command', async () => {
    const value = [{ id: 'SET_1613080290', name: 'Favorites', pinned: false, search: null, archives: ['a1'] }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listCategories('scope-a');

    expect(adapter).toHaveBeenCalledWith('list_categories', { serverId: 'scope-a' });
    expect(result).toEqual({ ok: true, value });
  });

  it('adds an archive to a category through the native command', async () => {
    const value = { operation: 'add_to_category', success: 1 };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().addArchiveToCategory('scope-a', 'SET_1613080290', 'a1');

    expect(adapter).toHaveBeenCalledWith('add_archive_to_category', {
      serverId: 'scope-a', categoryId: 'SET_1613080290', archiveId: 'a1',
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('updates archive metadata through the native command', async () => {
    const value = { operation: 'update_metadata', success: 1 };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().updateArchiveMetadata('scope-a', 'a1', {
      title: 'New title', tags: 'artist:test', summary: 'New summary',
    });

    expect(adapter).toHaveBeenCalledWith('update_archive_metadata', {
      serverId: 'scope-a', archiveId: 'a1', metadata: { title: 'New title', tags: 'artist:test', summary: 'New summary' },
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('loads thumbnail bytes through the native command', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [255, 216, 255] }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().loadArchiveThumbnail('scope-a', 'a1');

    expect(adapter).toHaveBeenCalledWith('load_archive_thumbnail', { serverId: 'scope-a', archiveId: 'a1' });
    expect(result).toEqual({ ok: true, value: new Uint8Array([255, 216, 255]).buffer });
  });

  it('lists schema-validated server records', async () => {
    const value = [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listServers();

    expect(adapter).toHaveBeenCalledWith('list_servers', {});
    expect(result).toEqual({ ok: true, value });
  });

  it('lists schema-validated archives for one server', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [{
      serverId: 's1', archiveId: 'a1', title: 'Archive', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z',
    }] }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listArchives('s1');

    expect(adapter).toHaveBeenCalledWith('list_archives', { serverId: 's1' });
    expect(result).toMatchObject({ ok: true, value: [{ archiveId: 'a1' }] });
  });

  it('rejects malformed archive rows from native code', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: [{ archiveId: 'a1' }] }));
    expect(await new NativeLibraryRepository().listArchives('s1')).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  });

  it('saves scoped progress through one typed command', async () => {
    const value = {
      scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, pageCount: 10,
      layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 2,
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().saveProgress({
      scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, pageCount: 10, layout: 'paged', direction: 'ltr',
    });

    expect(adapter).toHaveBeenCalledWith('save_reading_progress', { progress: expect.objectContaining({ scopeId: 'scope-a', pageIndex: 4 }) });
    expect(result).toEqual({ ok: true, value });
  });

  it('loads scoped progress through one typed command', async () => {
    const value = {
      scopeId: 'scope-a', archiveId: 'a1', pageIndex: 4, pageCount: 10,
      layout: 'paged', direction: 'ltr', updatedAt: '2026-08-26T00:00:00Z', revision: 2,
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().loadProgress('scope-a', 'a1');

    expect(adapter).toHaveBeenCalledWith('load_reading_progress', { scopeId: 'scope-a', archiveId: 'a1' });
    expect(result).toEqual({ ok: true, value });
  });

  it('appends, lists, and retries scoped sync journal entries', async () => {
    const value = {
      sequence: 7, scopeId: 'scope-a', objectId: 'scope-a/a1', objectType: 'reading_progress',
      operation: 'upsert', deviceId: 'device-a', logicalClock: 2,
      wallClock: '2026-08-26T00:00:00Z', payloadHash: 'hash-a',
      payloadJson: '{"page":4}', status: 'pending', attemptCount: 0,
    };
    const adapter = vi.fn(async (command: string) => ({
      ok: true,
      value: command === 'list_sync_journal' ? [value] : value,
    }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();
    const entry = {
      scopeId: 'scope-a', objectId: 'scope-a/a1', objectType: 'reading_progress',
      operation: 'upsert' as const, deviceId: 'device-a', logicalClock: 2,
      payloadHash: 'hash-a', payloadJson: '{"page":4}',
    };

    expect(await repository.appendSyncJournal(entry)).toEqual({ ok: true, value });
    expect(await repository.listSyncJournal('scope-a', 'pending')).toEqual({ ok: true, value: [value] });
    expect(await repository.setSyncJournalState('scope-a', 7, 'retryable', 'offline')).toEqual({ ok: true, value });

    expect(adapter).toHaveBeenNthCalledWith(1, 'append_sync_journal', { entry });
    expect(adapter).toHaveBeenNthCalledWith(2, 'list_sync_journal', { scopeId: 'scope-a', status: 'pending' });
    expect(adapter).toHaveBeenNthCalledWith(3, 'set_sync_journal_state', {
      input: { scopeId: 'scope-a', sequence: 7, status: 'retryable', error: 'offline' },
    });
  });

  it('adds, removes, and lists scoped watchlist records', async () => {
    const value = {
      scopeId: 'scope-a', archiveId: 'a1',
      addedAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
      deviceId: 'device-a', revision: 1, deleted: false,
    };
    const adapter = vi.fn(async (command: string) => ({
      ok: true,
      value: command === 'list_watchlist' ? [value] : value,
    }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    expect(await repository.setWatchlist('scope-a', 'a1', true)).toEqual({ ok: true, value });
    expect(await repository.setWatchlist('scope-a', 'a1', false)).toEqual({ ok: true, value });
    expect(await repository.listWatchlist('scope-a')).toEqual({ ok: true, value: [value] });
    expect(adapter).toHaveBeenNthCalledWith(1, 'set_watchlist', { scopeId: 'scope-a', archiveId: 'a1', added: true });
    expect(adapter).toHaveBeenNthCalledWith(2, 'set_watchlist', { scopeId: 'scope-a', archiveId: 'a1', added: false });
    expect(adapter).toHaveBeenNthCalledWith(3, 'list_watchlist', { scopeId: 'scope-a' });
  });

  it('lists scoped reading history records', async () => {
    const value = [{
      scopeId: 'scope-a', archiveId: 'a1', pageIndex: 8,
      visitedAt: '2026-08-26T00:00:00Z', deviceId: 'device-a', revision: 2,
    }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeLibraryRepository().listHistory('scope-a')).toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('list_reading_history', { scopeId: 'scope-a' });
  });

  it('saves server identity and passes the key only to the native command', async () => {
    const value = { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().saveServer({
      identity: { name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' },
      apiKey: 'secret',
    });

    expect(adapter).toHaveBeenCalledWith('save_server', {
      server: { name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a' },
      apiKey: 'secret',
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('refreshes archives through native search with typed parameters', async () => {
    const value = [
      { serverId: 'scope-a', archiveId: 'a1', title: 'Archive', pageCount: 8, updatedAt: '2026-08-27T00:00:00Z' },
    ];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().refreshArchives('scope-a', { filter: 'test$' });

    expect(adapter).toHaveBeenCalledWith('refresh_archives', {
      input: { serverId: 'scope-a', params: { filter: 'test$' } },
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('refreshes archives with all optional search parameters', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [] }));
    setInvokeAdapterForTests(adapter);

    await new NativeLibraryRepository().refreshArchives('scope-b', {
      filter: 'fate',
      start: 0,
      sortby: 'title',
      order: 'asc',
      newonly: true,
      untaggedonly: false,
      hidecompleted: true,
      category: 'a1b2c3d4e5f6g7',
      groupbyTanks: false,
    });

    expect(adapter).toHaveBeenCalledWith('refresh_archives', {
      input: {
        serverId: 'scope-b',
        params: {
          filter: 'fate',
          start: 0,
          sortby: 'title',
          order: 'asc',
          newonly: true,
          untaggedonly: false,
          hidecompleted: true,
          category: 'a1b2c3d4e5f6g7',
          groupbyTanks: false,
        },
      },
    });
  });
});
