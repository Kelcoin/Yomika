import { z } from 'zod';

import { invokeBinaryCommand, invokeCommand } from '../bridge/invoke';
import {
  ArchiveRecordSchema,
  ArchivePageSchema,
  ReadingProgressSchema,
  ServerRecordSchema,
  type ArchiveRecord,
  type ArchivePage,
  type ReadingProgress,
  type ServerRecord,
  TaskRecordSchema,
  type TaskRecord,
  SyncJournalRecordSchema,
  type SyncJournalInput,
  type SyncJournalRecord,
  type SyncJournalStatusSchema,
  WatchlistRecordSchema,
  type WatchlistRecord,
  ReadingHistoryRecordSchema,
  type ReadingHistoryRecord,
} from '../domain/library';
import type { CommandResult } from '../domain/result';
import { invalidateRouteCache } from '../lib/routeCache';

function invalidateShelves<T>(result: CommandResult<T>): CommandResult<T> {
  if (result.ok) {
    invalidateRouteCache('home:');
    invalidateRouteCache('state:');
  }
  return result;
}
import type { ServerIdentity } from '../domain/server';

type NewProgress = Omit<ReadingProgress, 'updatedAt' | 'revision'>;
const ReaderManifestSchema = z.object({
  archiveId: z.string().min(1),
  title: z.string(),
  pages: z.array(z.string().min(1)),
});
export const ArchiveMetadataSchema = z.object({
  archiveId: z.string().min(1),
  title: z.string(),
  filename: z.string(),
  tags: z.string(),
  summary: z.string().nullable().optional(),
  extension: z.string(),
  progress: z.number().int(),
  pageCount: z.number().int().nonnegative(),
  lastReadTime: z.number().int(),
  size: z.number().int().nonnegative(),
});
export type ArchiveMetadata = z.infer<typeof ArchiveMetadataSchema>;
const UploadArchiveResultSchema = z.object({
  operation: z.literal('upload'),
  success: z.literal(1),
  id: z.string().min(1),
});
const DownloadUrlResultSchema = z.object({
  job: z.number().int().positive(),
  url: z.string().min(1),
});
const CategorySchema = z.object({
  id: z.string().length(14),
  name: z.string(),
  pinned: z.boolean(),
  search: z.string().nullable().optional(),
  archives: z.array(z.string()),
});
export type Category = z.infer<typeof CategorySchema>;
const ServerStatusSchema = z.object({
  serverId: z.string().min(1),
  online: z.boolean(),
  name: z.string().optional().nullable(),
  error: z.string().optional().nullable(),
});
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
const OperationResultSchema = z.object({
  operation: z.string().min(1),
  success: z.literal(1),
});

export const SearchPresetSchema = z.object({
  scopeId: z.string().min(1),
  presetId: z.string().min(1),
  name: z.string().min(1),
  query: z.string(),
  sortBy: z.enum(['title', 'added']),
  sortOrder: z.enum(['asc', 'desc']),
  categoryId: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deviceId: z.string().min(1),
  revision: z.number().int().positive(),
  deleted: z.boolean(),
});
export type SearchPreset = z.infer<typeof SearchPresetSchema>;
export interface SearchPresetInput {
  scopeId: string;
  presetId: string;
  name: string;
  query: string;
  sortBy: 'title' | 'added';
  sortOrder: 'asc' | 'desc';
  categoryId: string | null;
}

export class NativeLibraryRepository {
  setWatchlist(scopeId: string, archiveId: string, added: boolean): Promise<CommandResult<WatchlistRecord>> {
    return invokeCommand('set_watchlist', { scopeId, archiveId, added }, WatchlistRecordSchema).then(invalidateShelves);
  }
  listWatchlist(scopeId: string): Promise<CommandResult<WatchlistRecord[]>> {
    return invokeCommand('list_watchlist', { scopeId }, z.array(WatchlistRecordSchema));
  }
  /** Reading list ("待看") is a second list beside the watchlist ("收藏夹"):
   * intent to read versus having liked something. */
  setReadingList(scopeId: string, archiveId: string, added: boolean): Promise<CommandResult<WatchlistRecord>> {
    return invokeCommand('set_reading_list', { scopeId, archiveId, added }, WatchlistRecordSchema).then(invalidateShelves);
  }
  listReadingList(scopeId: string): Promise<CommandResult<WatchlistRecord[]>> {
    return invokeCommand('list_reading_list', { scopeId }, z.array(WatchlistRecordSchema));
  }
  /** Saved searches sync with everything else, so they live in the database
   * rather than local settings. */
  listSearchPresets(scopeId: string): Promise<CommandResult<SearchPreset[]>> {
    return invokeCommand('list_search_presets', { scopeId }, z.array(SearchPresetSchema));
  }
  saveSearchPreset(input: SearchPresetInput): Promise<CommandResult<SearchPreset>> {
    return invokeCommand('save_search_preset', { input }, SearchPresetSchema);
  }
  deleteSearchPreset(scopeId: string, presetId: string): Promise<CommandResult<SearchPreset>> {
    return invokeCommand('delete_search_preset', { scopeId, presetId }, SearchPresetSchema);
  }
  listHistory(scopeId: string): Promise<CommandResult<ReadingHistoryRecord[]>> {
    return invokeCommand('list_reading_history', { scopeId }, z.array(ReadingHistoryRecordSchema));
  }
  appendSyncJournal(entry: SyncJournalInput): Promise<CommandResult<SyncJournalRecord>> {
    return invokeCommand('append_sync_journal', { entry }, SyncJournalRecordSchema);
  }
  listSyncJournal(scopeId: string, status?: z.infer<typeof SyncJournalStatusSchema>): Promise<CommandResult<SyncJournalRecord[]>> {
    return invokeCommand('list_sync_journal', { scopeId, ...(status ? { status } : {}) }, z.array(SyncJournalRecordSchema));
  }
  setSyncJournalState(
    scopeId: string,
    sequence: number,
    status: z.infer<typeof SyncJournalStatusSchema>,
    error?: string,
  ): Promise<CommandResult<SyncJournalRecord>> {
    return invokeCommand('set_sync_journal_state', {
      input: { scopeId, sequence, status, ...(error ? { error } : {}) },
    }, SyncJournalRecordSchema);
  }
  loadArchiveMetadata(serverId: string, archiveId: string): Promise<CommandResult<z.infer<typeof ArchiveMetadataSchema>>> {
    return invokeCommand('load_archive_metadata', { serverId, archiveId }, ArchiveMetadataSchema);
  }
  deleteArchive(serverId: string, archiveId: string): Promise<CommandResult<null>> {
    return invokeCommand('delete_archive', { serverId, archiveId }, z.null()).then(invalidateShelves);
  }
  downloadArchive(serverId: string, archiveId: string): Promise<CommandResult<string>> {
    return invokeCommand('download_archive', { serverId, archiveId }, z.string().min(1));
  }
  createTask(input: { kind: 'download' | 'sync' | 'inference' | 'maintenance'; label: string }): Promise<CommandResult<TaskRecord>> {
    return invokeCommand('create_task', { task: input }, TaskRecordSchema);
  }
  listTasks(): Promise<CommandResult<TaskRecord[]>> {
    return invokeCommand('list_tasks', {}, z.array(TaskRecordSchema));
  }
  updateTask(
    id: string,
    update: { status?: import('../domain/library').TaskStatus; progress?: number; error?: string },
  ): Promise<CommandResult<TaskRecord>> {
    return invokeCommand('update_task', { id, update }, TaskRecordSchema);
  }
  retryTask(id: string): Promise<CommandResult<TaskRecord>> {
    return invokeCommand('retry_task', { id }, TaskRecordSchema);
  }
  uploadArchive(input: { serverId: string; taskId: string; filePath: string }): Promise<CommandResult<z.infer<typeof UploadArchiveResultSchema>>> {
    return invokeCommand('upload_archive', input, UploadArchiveResultSchema);
  }
  /** Confirms the ids a shelf is about to show still exist on the server, and
   * answers with the ones that are gone (now tombstoned locally). */
  verifyArchivesExist(serverId: string, archiveIds: readonly string[]): Promise<CommandResult<string[]>> {
    return invokeCommand('verify_archives_exist', { serverId, archiveIds }, z.array(z.string()));
  }
  /** Hands a URL to LANraragi's own downloader, which picks the plugin. Answers
   * with the Minion job it queued — the download runs on the server. */
  downloadUrl(serverId: string, url: string, categoryId?: string): Promise<CommandResult<z.infer<typeof DownloadUrlResultSchema>>> {
    return invokeCommand('download_url', { serverId, url, categoryId: categoryId ?? null }, DownloadUrlResultSchema);
  }
  /** `force` re-resolves dynamic categories on the server (one unpaged
   * `/api/search` each). Leave it off for navigation: the native side serves a
   * persisted snapshot instead. */
  listCategories(serverId: string, force = false): Promise<CommandResult<Category[]>> {
    return invokeCommand('list_categories', { serverId, force }, z.array(CategorySchema));
  }
  addArchiveToCategory(serverId: string, categoryId: string, archiveId: string): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('add_archive_to_category', { serverId, categoryId, archiveId }, OperationResultSchema);
  }
  removeArchiveFromCategory(serverId: string, categoryId: string, archiveId: string): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('remove_archive_from_category', { serverId, categoryId, archiveId }, OperationResultSchema).then(invalidateShelves);
  }
  updateArchiveMetadata(serverId: string, archiveId: string, metadata: { title?: string; tags?: string; summary?: string }): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('update_archive_metadata', { serverId, archiveId, metadata }, OperationResultSchema).then(invalidateShelves);
  }
  listMetadataPlugins(serverId: string): Promise<CommandResult<unknown>> {
    return invokeCommand('list_metadata_plugins', { serverId }, z.unknown());
  }
  useMetadataPlugin(serverId: string, archiveId: string, plugin: string, arg = ''): Promise<CommandResult<Record<string, unknown>>> {
    return invokeCommand('use_metadata_plugin', { serverId, archiveId, plugin, arg }, z.record(z.unknown()));
  }
  async loadArchiveThumbnail(serverId: string, archiveId: string): Promise<CommandResult<ArrayBuffer>> {
    const result = await invokeBinaryCommand('load_archive_thumbnail', { serverId, archiveId });
    if (result.ok) window.dispatchEvent(new Event('yomika:cache-changed'));
    return result;
  }
  loadArchivePageThumbnail(serverId: string, archiveId: string, page: number): Promise<CommandResult<ArrayBuffer>> {
    return invokeBinaryCommand('load_archive_page_thumbnail', { serverId, archiveId, page });
  }
  loadReaderManifest(serverId: string, archiveId: string): Promise<CommandResult<z.infer<typeof ReaderManifestSchema>>> {
    return invokeCommand('load_reader_manifest', { serverId, archiveId }, ReaderManifestSchema);
  }

  async loadReaderPage(serverId: string, archiveId: string, pageIndex: number, path: string): Promise<CommandResult<ArrayBuffer>> {
    const result = await invokeBinaryCommand('load_reader_page', { serverId, archiveId, pageIndex, path });
    if (result.ok) window.dispatchEvent(new Event('yomika:cache-changed'));
    return result;
  }

  replaceArchives(serverId: string, searchResponseJson: string): Promise<CommandResult<ArchiveRecord[]>> {
    return invokeCommand('replace_archives', { input: { serverId, searchResponseJson } }, z.array(ArchiveRecordSchema));
  }

  refreshArchives(
    serverId: string,
    params: {
      filter?: string;
      start?: number;
      sortby?: string;
      order?: string;
      newonly?: boolean;
      untaggedonly?: boolean;
      hidecompleted?: boolean;
      category?: string;
      groupbyTanks?: boolean;
    },
  ): Promise<CommandResult<ArchiveRecord[]>> {
    return invokeCommand('refresh_archives', { input: { serverId, params } }, z.array(ArchiveRecordSchema));
  }

  /** LANraragi picks the archives; no need to hold the whole index locally. */
  searchRandomArchives(serverId: string, count = 8, query: { filter?: string; categoryId?: string | null } = {}): Promise<CommandResult<ArchiveRecord[]>> {
    return invokeCommand('search_random_archives', {
      input: {
        serverId,
        count,
        ...(query.filter ? { filter: query.filter } : {}),
        ...(query.categoryId ? { category: query.categoryId } : {}),
      },
    }, z.array(ArchiveRecordSchema));
  }

  /** True when LANraragi's newest page holds archives the local index misses.
   * One page instead of the whole library, so it is cheap enough to run on
   * entering the library. */
  probeNewArchives(serverId: string): Promise<CommandResult<boolean>> {
    return invokeCommand('probe_new_archives', { serverId }, z.boolean());
  }

  listServers(): Promise<CommandResult<ServerRecord[]>> {
    return invokeCommand('list_servers', {}, z.array(ServerRecordSchema));
  }

  checkServerStatus(): Promise<CommandResult<ServerStatus[]>> {
    return invokeCommand('check_server_status', {}, z.array(ServerStatusSchema));
  }

  saveServer(input: { identity: ServerIdentity; apiKey: string }): Promise<CommandResult<ServerRecord>> {
    return invokeCommand('save_server', {
      server: input.identity,
      apiKey: input.apiKey,
    }, ServerRecordSchema);
  }

  /** 切换当前启用的服务器：启用一台即停用其余，书架与首页随之改读它。
   * 切换是罕见且全局的动作，直接全量失效——所有按服务器缓存的快照
   * （首页/书架/档案库/详情）都不该在切换后闪现旧服务器的数据。 */
  setServerEnabled(serverId: string): Promise<CommandResult<ServerRecord>> {
    return invokeCommand('set_server_enabled', { serverId, enabled: true }, ServerRecordSchema).then((result) => {
      if (result.ok) invalidateRouteCache();
      return result;
    });
  }

  /** 编辑已配置服务器时读回系统安全存储中的 API Key，供弹窗展示与预填。 */
  readServerApiKey(scopeId: string): Promise<CommandResult<string>> {
    return invokeCommand('read_server_api_key', { scopeId }, z.string());
  }

  listArchives(serverId: string): Promise<CommandResult<ArchiveRecord[]>> {
    return invokeCommand('list_archives', { serverId }, z.array(ArchiveRecordSchema));
  }
  /** For the shelves, which know their archive ids and only need the records
   * behind them — reading the whole library to resolve a dozen titles scaled
   * with the library instead of with the shelf. Answers in the requested id
   * order and silently drops ids the local index has not seen. */
  async listArchivesByIds(serverId: string, archiveIds: string[]): Promise<CommandResult<ArchiveRecord[]>> {
    if (archiveIds.length === 0) return { ok: true, value: [] };
    return invokeCommand('list_archives_by_ids', { serverId, archiveIds }, z.array(ArchiveRecordSchema));
  }
  /** The library list, straight from LANraragi.
   *
   * `start` is an item offset, not a page number, and the page size is a
   * server-side preference we cannot set — callers read it off the length of
   * page zero. The local index is a cache behind this call, not its source:
   * asking it for the list meant an archive added on the server stayed invisible
   * until a whole-library pull happened to succeed. Search and category are
   * resolved by LANraragi too, so its own syntax works and a dynamic category
   * costs us nothing. */
  searchArchivesPage(
    serverId: string,
    start = 0,
    query: { query?: string; sortBy?: 'title' | 'added'; order?: 'asc' | 'desc'; categoryId?: string | null; untaggedOnly?: boolean } = {},
  ): Promise<CommandResult<ArchivePage>> {
    return invokeCommand('search_archives_page', {
      input: {
        serverId,
        query: query.query ?? '',
        sortBy: query.sortBy ?? 'added',
        order: query.order ?? 'desc',
        categoryId: query.categoryId ?? null,
        untaggedOnly: query.untaggedOnly ?? false,
        start,
      },
    }, ArchivePageSchema);
  }

  async listArchivesPage(
    serverId: string,
    offset = 0,
    limit = 100,
    query: { query?: string; sortBy?: 'title' | 'added'; order?: 'asc' | 'desc'; categoryId?: string | null; untaggedOnly?: boolean } = {},
  ): Promise<CommandResult<ArchivePage>> {
    const result = await invokeCommand('list_archives_page', {
      input: {
        serverId,
        query: query.query ?? '',
        sortBy: query.sortBy ?? 'added',
        order: query.order ?? 'desc',
        categoryId: query.categoryId ?? null,
        untaggedOnly: query.untaggedOnly ?? false,
        offset,
        limit,
      },
    }, ArchivePageSchema);
    if (result.ok || !['INVALID_RESPONSE', 'UNKNOWN'].includes(result.error.code) || offset !== 0) return result;
    const legacy = await this.listArchives(serverId);
    return legacy.ok
      ? { ok: true, value: { items: legacy.value.slice(0, limit), total: legacy.value.length, hasMore: legacy.value.length > limit } }
      : legacy;
  }

  saveProgress(progress: NewProgress): Promise<CommandResult<ReadingProgress>> {
    return invokeCommand('save_reading_progress', { progress }, ReadingProgressSchema).then(invalidateShelves);
  }

  loadProgress(scopeId: string, archiveId: string): Promise<CommandResult<ReadingProgress | null>> {
    return invokeCommand('load_reading_progress', { scopeId, archiveId }, ReadingProgressSchema.nullable());
  }
}
