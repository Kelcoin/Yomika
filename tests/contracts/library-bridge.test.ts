import { NativeLrrBridgeRepository, invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { flushErrorLog, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';
import { readRouteCache, resetRouteCacheForTests, writeRouteCache } from '../../src/lib/routeCache';
import { NativeLibraryRepository } from '../../src/repositories/nativeLibraryRepository';

beforeEach(async () => {
  invalidateLrrBridgeConfig();
  setInvokeAdapterForTests(async () => ({ ok: true, value: { enabled: false, pending: 0, conflicts: 0 } }));
  for (const scopeId of ['s', 'scope-a']) await new NativeLrrBridgeRepository().configure(scopeId, false);
  resetInvokeAdapterForTests();
});

afterEach(() => {
  resetInvokeAdapterForTests();
  // 这些用例会写路由快照：残留会让后面的用例按「有快照就不重读」跳过装载。
  resetRouteCacheForTests();
});

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

  it('accepts archive metadata without a LANraragi summary', async () => {
    const value = {
      archiveId: 'a1', title: 'Archive', filename: 'archive.cbz', tags: 'artist:test',
      summary: null, extension: 'cbz', progress: 0, pageCount: 10, lastReadTime: 0, size: 123,
    };
    setInvokeAdapterForTests(async () => ({ ok: true, value }));

    const result = await new NativeLibraryRepository().loadArchiveMetadata('scope-a', 'a1');

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
      progress: 0, cancelable: true, retryable: true, receivedBytes: 0, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
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
      progress: 0, cancelable: true, retryable: true, receivedBytes: 0, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
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
      progress: 0.5, cancelable: true, retryable: true, receivedBytes: 0, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:01:00Z',
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
      progress: 0.5, cancelable: true, retryable: true, receivedBytes: 0, createdAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:02:00Z',
    };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeLibraryRepository().retryTask('task-1')).toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('retry_task', { id: 'task-1' });
  });

  // 原生 TaskRecord 的 error 是 Option<String>，serde 会一直把这个字段发出来，
  // 没有错误时是 null；上面这些用例的假数据都把它整段省掉了，所以「没有报错」
  // 的那一行——也就是每一行成功完成的任务——从来没有被这份 schema 收过。
  it('accepts task rows the native side really serializes', async () => {
    // 这一份是照原生那侧真正发出的 JSON 抄的：error 是 null、几个下载列也在。
    const value = [{
      id: 'task-1789696533845538100', kind: 'download', label: '下载 [ie] archive.zip',
      status: 'completed', progress: 1, error: null, cancelable: false, retryable: false,
      createdAt: '2026-09-18 01:55:33', updatedAt: '2026-09-18 01:55:36',
      archiveId: 'a'.repeat(40), serverId: 'scope-a', localPath: 'E:\\Downloads\\a-archive.zip',
      totalBytes: 200, receivedBytes: 200, bytesPerSecond: null,
    }];
    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value })));

    expect(await new NativeLibraryRepository().listTasks()).toEqual({ ok: true, value });
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

  it('keeps the reading list separate from the watchlist', async () => {
    const record = { scopeId: 'scope-a', archiveId: 'a1', addedAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z', deviceId: 'device-a', revision: 1, deleted: false };
    const adapter = vi.fn(async () => ({ ok: true, value: record }));
    setInvokeAdapterForTests(adapter);

    // "I plan to read this" and "I liked this" are different lists, and both
    // sync, so they are different commands against different tables.
    await new NativeLibraryRepository().setReadingList('scope-a', 'a1', true);
    expect(adapter).toHaveBeenCalledWith('set_reading_list', { scopeId: 'scope-a', archiveId: 'a1', added: true });

    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value: [record] })));
    expect(await new NativeLibraryRepository().listReadingList('scope-a')).toEqual({ ok: true, value: [record] });
  });

  it('lists LANraragi categories through the native command', async () => {
    const value = [{ id: 'SET_1613080290', name: 'Favorites', pinned: false, search: null, archives: ['a1'] }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    const result = await repository.listCategories('scope-a');

    // Navigation must not re-resolve dynamic categories on the server.
    expect(adapter).toHaveBeenNthCalledWith(1, 'list_categories', { serverId: 'scope-a', force: false });
    expect(result).toEqual({ ok: true, value });

    await repository.listCategories('scope-a', true);
    expect(adapter).toHaveBeenNthCalledWith(2, 'list_categories', { serverId: 'scope-a', force: true });
  });

  it('reads the Favorites category on its own fast path', async () => {
    const value = { id: 'SET_1785040778', archives: ['a1'] };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    // 书架、详情页的心、右键菜单与多选只问这一条分类：它有自己的命令，不走
    // list_categories 那条会把每条动态分类都解析一遍的路。
    expect(await new NativeLibraryRepository().readFavoritesCategory('server-a')).toEqual({ ok: true, value });
    expect(adapter).toHaveBeenCalledWith('read_favorites_category', { serverId: 'server-a' });

    // 服务器上没有这条分类时就是 null，调用方据此退回本机那份收藏。
    setInvokeAdapterForTests(vi.fn(async () => ({ ok: true, value: null })));
    expect(await new NativeLibraryRepository().readFavoritesCategory('server-a')).toEqual({ ok: true, value: null });
  });

  it('clears specific reading-history records through the native command', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: 2 }));
    setInvokeAdapterForTests(adapter);

    // 清理的是记录（每条写同步墓碑），不是档案。
    expect(await new NativeLibraryRepository().deleteHistoryRecords('scope-a', ['a1', 'a2'])).toEqual({ ok: true, value: 2 });
    expect(adapter).toHaveBeenCalledWith('delete_history_records', { scopeId: 'scope-a', archiveIds: ['a1', 'a2'] });
  });

  it('clears progress with its own command, leaving history-only deletion independent', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: null }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeLibraryRepository().clearReadingProgress('scope-a', 'a1')).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('clear_reading_progress', { scopeId: 'scope-a', archiveId: 'a1' });
  });

  it('adds an archive to a category through the native command', async () => {
    const value = { operation: 'add_to_category', success: 1 };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    // 这条镜像写要连着作废书架快照：本机收藏那一下触发的重读发生在 PUT 之前，会把
    // 「加收藏之前」的服务器名单写进快照（见 shelf-cache 那条行为用例）。
    writeRouteCache('home:shelves', { watchlist: [] });
    writeRouteCache('state:watchlist:default', { watchlist: [] });

    const result = await new NativeLibraryRepository().addArchiveToCategory('scope-a', 'SET_1613080290', 'a1');

    expect(adapter).toHaveBeenCalledWith('add_archive_to_category', {
      serverId: 'scope-a', categoryId: 'SET_1613080290', archiveId: 'a1',
    });
    expect(result).toEqual({ ok: true, value });
    expect(readRouteCache('home:shelves')).toBeUndefined();
    expect(readRouteCache('state:watchlist:default')).toBeUndefined();
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

  it('accepts a binary IPC body for image commands without a JSON envelope', async () => {
    const adapter = vi.fn(async (command: string) => (command === 'load_reader_page'
      ? new Uint8Array([255, 216, 255, 224]).buffer
      : new Uint8Array([137, 80, 78, 71])));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    expect(await repository.loadReaderPage('scope-a', 'a1', 0, '00.jpg')).toEqual({
      ok: true, value: new Uint8Array([255, 216, 255, 224]).buffer,
    });
    expect(await repository.loadArchivePageThumbnail('scope-a', 'a1', 3)).toEqual({
      ok: true, value: new Uint8Array([137, 80, 78, 71]).buffer,
    });
  });

  it('keeps the JSON error envelope for failed image commands', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '页面暂时不可用', retryable: true } }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeLibraryRepository().loadReaderPage('scope-a', 'a1', 0, '00.jpg')).toEqual({
      ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '页面暂时不可用', retryable: true },
    });
  });

  it('asks LANraragi for the random selection instead of shuffling locally', async () => {
    const value = [{ serverId: 'scope-a', archiveId: 'a1', title: 'Random', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z' }];
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().searchRandomArchives('scope-a', 8);

    expect(adapter).toHaveBeenCalledWith('search_random_archives', { input: { serverId: 'scope-a', count: 8 } });
    expect(result).toEqual({ ok: true, value });
  });

  it('lists schema-validated server records', async () => {
    const value = [{ id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a', enabled: true }];
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

  it('loads archives in bounded pages for large libraries', async () => {
    const value = { items: [], total: 14447, hasMore: true };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listArchivesPage('s1', 100, 100);

    expect(adapter).toHaveBeenCalledWith('list_archives_page', {
      input: { serverId: 's1', query: '', sortBy: 'added', order: 'desc', categoryId: null, untaggedOnly: false, offset: 100, limit: 100 },
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('keeps the search term when an older host answers with the whole library', async () => {
    // 老主机只有整份列表，回退时把 query 丢了就等于拿「库里最新的一百条」去答「这个
    // 标签下的档案」，调用方按精确标签一筛就什么都不剩。
    const adapter = vi.fn(async (command: string) => {
      if (command === 'list_archives_page') return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'unknown command', retryable: false } };
      if (command === 'list_archives') return { ok: true, value: [
        { serverId: 's1', archiveId: 'farmer', title: 'Something else', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z', tags: ['female:glasses'] },
        { serverId: 's1', archiveId: 'prefix', title: 'Same prefix', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z', tags: ['artist:someoneelse'] },
        { serverId: 's1', archiveId: 'wanted', title: 'Wanted', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z', tags: ['artist:someone'] },
      ] };
      throw new Error(`Unexpected command: ${command}`);
    });
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listArchivesPage('s1', 0, 100, { query: 'artist:someone' });

    // 镜像那条 SQL 是子串匹配，所以 `artist:someoneelse` 也答——精确到标签那一步是
    // 调用方的事。这里要证的是「不相关的行不再混进来」，顺序照旧。
    expect(result).toMatchObject({ ok: true, value: { total: 2, hasMore: false } });
    expect(result.ok && result.value.items.map((archive) => archive.archiveId)).toEqual(['prefix', 'wanted']);
  });

  it('reads the library list from the server by item offset', async () => {
    const value = { items: [], total: 14447, hasMore: true };
    const adapter = vi.fn(async () => ({ ok: true, value }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().searchArchivesPage('s1', 240, {
      query: 'artist:someone$', sortBy: 'title', order: 'asc', categoryId: 'SET_1613080290',
    });

    // `start` is an item offset, and the query and category go to LANraragi:
    // resolving them locally is what made an archive added on the server
    // invisible until a whole-library pull happened to succeed.
    expect(adapter).toHaveBeenCalledWith('search_archives_page', {
      input: { serverId: 's1', query: 'artist:someone$', sortBy: 'title', order: 'asc', categoryId: 'SET_1613080290', untaggedOnly: false, start: 240 },
    });
    expect(result).toEqual({ ok: true, value });
  });

  it('resolves shelf ids without reading the whole library', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [{
      serverId: 's1', archiveId: 'a2', title: 'Second', pageCount: 8, updatedAt: '2026-08-26T00:00:00Z',
    }] }));
    setInvokeAdapterForTests(adapter);

    const result = await new NativeLibraryRepository().listArchivesByIds('s1', ['a2', 'a1']);

    expect(adapter).toHaveBeenCalledWith('list_archives_by_ids', { serverId: 's1', archiveIds: ['a2', 'a1'] });
    expect(result).toMatchObject({ ok: true, value: [{ archiveId: 'a2' }] });
  });

  it('answers an empty shelf without crossing the bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: [] }));
    setInvokeAdapterForTests(adapter);

    expect(await new NativeLibraryRepository().listArchivesByIds('s1', [])).toEqual({ ok: true, value: [] });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('accepts nullable archive fields returned from sqlite native rows', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: [{
      serverId: 's1', archiveId: 'a1', title: 'Archive', pageCount: 8,
      summary: null, category: null, language: null, coverPage: null,
      isDeleted: false, updatedAt: '2026-08-26 00:00:00',
    }] }));

    const result = await new NativeLibraryRepository().listArchives('s1');

    expect(result).toMatchObject({ ok: true, value: [{ archiveId: 'a1' }] });
  });

  it('rejects malformed archive rows from native code', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: [{ archiveId: 'a1' }] }));
    expect(await new NativeLibraryRepository().listArchives('s1')).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  });

  // 日志要说出是哪个字段。只写一句「没匹配上」，一个 null 撞上非 nullable 的
  // schema 就得从猜字段开始查——任务表的那个 error 就是这么查出来的。
  it('names the field that failed validation in the error log', async () => {
    const written: ErrorLogRecord[] = [];
    setErrorLogSinkForTests(async (records) => { written.push(...records); return true; });
    try {
      setInvokeAdapterForTests(async () => ({ ok: true, value: [{ archiveId: 'a1', fileSize: 'huge' }] }));

      await new NativeLibraryRepository().listArchives('s1');
      await flushErrorLog();

      expect(written.at(-1)?.detail).toContain('fileSize');
    } finally {
      setErrorLogSinkForTests();
    }
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

  it('waits for queued page writes before reading history or resume progress', async () => {
    const completed: Array<() => void> = [];
    const calls: string[] = [];
    setInvokeAdapterForTests((command, payload) => {
      calls.push(command);
      if (command === 'save_reading_progress') return new Promise((resolve) => {
        completed.push(() => resolve({ ok: true, value: {
          ...(payload as { progress: object }).progress,
          updatedAt: '2026-08-26T00:00:00Z', revision: 1,
        } }));
      });
      if (command === 'list_reading_history') return Promise.resolve({ ok: true, value: [] });
      return Promise.resolve({ ok: true, value: null });
    });
    const repo = new NativeLibraryRepository();
    const base = { scopeId: 'scope-a', archiveId: 'a1', pageCount: 10, layout: 'paged' as const, direction: 'ltr' as const };
    const first = repo.saveProgress({ ...base, pageIndex: 1 });
    const second = repo.saveProgress({ ...base, pageIndex: 2 });
    const history = repo.listHistory('scope-a');
    const resume = repo.loadProgress('scope-a', 'a1');
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(calls).toEqual(['save_reading_progress']);
    completed.shift()?.();
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(calls).toEqual(['save_reading_progress', 'save_reading_progress']);
    completed.shift()?.();
    await Promise.all([first, second, history, resume]);
    expect(calls.slice(2)).toEqual(['list_reading_history', 'load_reading_progress']);
  });

  it('adds, removes, and lists scoped watchlist records', async () => {
    const value = {
      scopeId: 'scope-a', archiveId: 'a1',
      addedAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z',
      deviceId: 'device-a', revision: 1, deleted: false,
    };
    const adapter = vi.fn(async (command: string) => ({
      ok: true,
      value: command === 'list_reading_list' ? [value] : value,
    }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeLibraryRepository();

    expect(await repository.setWatchlist('scope-a', 'a1', true)).toEqual({ ok: true, value });
    expect(await repository.setWatchlist('scope-a', 'a1', false)).toEqual({ ok: true, value });
    expect(await repository.listWatchlist('scope-a')).toEqual({ ok: true, value: [value] });
    expect(adapter).toHaveBeenNthCalledWith(1, 'set_reading_list', { scopeId: 'scope-a', archiveId: 'a1', added: true });
    expect(adapter).toHaveBeenNthCalledWith(2, 'set_reading_list', { scopeId: 'scope-a', archiveId: 'a1', added: false });
    expect(adapter).toHaveBeenNthCalledWith(3, 'list_reading_list', { scopeId: 'scope-a' });
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
    const value = { id: 'scope-a', name: 'Home', baseUrl: 'https://example.com', scopeId: 'scope-a', enabled: true };
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


it('preserves archive added timestamps in the lightweight dedup identity response', async () => {
  const identities = [{ archiveId:'a',title:'Archive',tags:[],pageCount:24,fileSize:2500000,addedAt:1700000000 }];
  setInvokeAdapterForTests(async () => ({ok:true,value:identities}));
  const result = await new NativeLibraryRepository().listArchiveIdentities('server-a');
  expect(result).toEqual({ok:true,value:identities});
});
