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

export class NativeLibraryRepository {
  setWatchlist(scopeId: string, archiveId: string, added: boolean): Promise<CommandResult<WatchlistRecord>> {
    return invokeCommand('set_watchlist', { scopeId, archiveId, added }, WatchlistRecordSchema);
  }
  listWatchlist(scopeId: string): Promise<CommandResult<WatchlistRecord[]>> {
    return invokeCommand('list_watchlist', { scopeId }, z.array(WatchlistRecordSchema));
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
    return invokeCommand('delete_archive', { serverId, archiveId }, z.null());
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
  listCategories(serverId: string): Promise<CommandResult<Category[]>> {
    return invokeCommand('list_categories', { serverId }, z.array(CategorySchema));
  }
  addArchiveToCategory(serverId: string, categoryId: string, archiveId: string): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('add_archive_to_category', { serverId, categoryId, archiveId }, OperationResultSchema);
  }
  updateArchiveMetadata(serverId: string, archiveId: string, metadata: { title?: string; tags?: string; summary?: string }): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('update_archive_metadata', { serverId, archiveId, metadata }, OperationResultSchema);
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

  listArchives(serverId: string): Promise<CommandResult<ArchiveRecord[]>> {
    return invokeCommand('list_archives', { serverId }, z.array(ArchiveRecordSchema));
  }
  async listArchivesPage(
    serverId: string,
    offset = 0,
    limit = 100,
    query: { query?: string; sortBy?: 'title' | 'added'; order?: 'asc' | 'desc'; categoryId?: string | null } = {},
  ): Promise<CommandResult<ArchivePage>> {
    const result = await invokeCommand('list_archives_page', {
      input: {
        serverId,
        query: query.query ?? '',
        sortBy: query.sortBy ?? 'added',
        order: query.order ?? 'desc',
        categoryId: query.categoryId ?? null,
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
    return invokeCommand('save_reading_progress', { progress }, ReadingProgressSchema);
  }

  loadProgress(scopeId: string, archiveId: string): Promise<CommandResult<ReadingProgress | null>> {
    return invokeCommand('load_reading_progress', { scopeId, archiveId }, ReadingProgressSchema.nullable());
  }
}
