import { z } from 'zod';
import { ComputedImageLeaseSchema } from '../domain/compute';

import { invokeBinaryCommand, invokeCommand, VoidResponseSchema } from '../bridge/invoke';
import {
  ArchiveIdentitySchema,
  ArchiveRecordSchema,
  ArchivePageSchema,
  ReadingProgressSchema,
  ServerRecordSchema,
  type ArchiveIdentity,
  type ArchiveRecord,
  type ArchivePage,
  type ReadingProgress,
  type ServerRecord,
  TaskRecordSchema,
  type TaskRecord,
  DownloadResultSchema,
  type DownloadResult,
  LocalArchiveRecordSchema,
  type LocalArchiveRecord,
  WatchlistRecordSchema,
  type WatchlistRecord,
  ReadingHistoryRecordSchema,
  type ReadingHistoryRecord,
} from '../domain/library';
import type { CommandResult } from '../domain/result';
import { invalidateRouteCache, readRouteCache, writeRouteCache } from '../lib/routeCache';
import { rememberServerPresence } from '../lib/serverPresence';
import { NativeLrrBridgeRepository, bridgeProgress, bridgeWatchlist, bridgeHistory, invalidateLrrBridgeConfig, type BridgeCollectionRecord } from './nativeLrrBridgeRepository';
import { ok, err } from '../domain/result';
import type { ServerIdentity } from '../domain/server';
const lrrBridge = new NativeLrrBridgeRepository();
const pendingArchiveDownloads = new Map<string, number>();
const archiveDownloadKey = (serverId: string, archiveId: string) => `${serverId}\0${archiveId}`;

export function isArchiveDownloadPending(serverId: string, archiveId: string) {
  return pendingArchiveDownloads.has(archiveDownloadKey(serverId, archiveId));
}

function invalidateShelves<T>(result: CommandResult<T>): CommandResult<T> {
  if (result.ok) {
    invalidateRouteCache('home:');
    invalidateRouteCache('state:');
  }
  return result;
}
function invalidateFavorites<T>(result: CommandResult<T>): CommandResult<T> {
  if (result.ok) invalidateRouteCache('favorites:');
  return invalidateShelves(result);
}

type NewProgress = Omit<ReadingProgress, 'updatedAt' | 'revision'> & { allowProgressRegression?: boolean };
/** 同一个键上的写入串成一条链：**后一次派发**等前一次落定再发。
 *
 * 这几条命令体都改成了 `#[tauri::command(async)]`，也就是在 tokio 线程池上跑——「先发
 * 的先落库」不再由 UI 线程保证。写入绝对值的那几个（收藏、待看、阅读进度）必须自己排
 * 好序，否则同一张卡连点两次会倒着落库：界面上是取消收藏，库里还留着。
 *
 * 传 `run` 而不是已经发出去的 promise，是因为第二个参数接的是**拒绝**路径：前一次写入
 * 失败（桥断了、响应读不出来）不该把后一次一起吞掉。
 */
function sharePendingRead<T>(reads: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = reads.get(key);
  if (existing) return existing;
  const read = load().finally(() => { if (reads.get(key) === read) reads.delete(key); });
  reads.set(key, read);
  return read;
}

const pendingStates = new Map<string, ReturnType<typeof lrrBridge.states>>();
const pendingFavorites = new Map<string, Promise<CommandResult<{ id: string; archives: string[] } | null>>>();
const pendingCategories = new Map<string, Promise<CommandResult<Category[]>>>();
const membershipKey = (scopeId: string, archiveId: string) => `${scopeId}\0${archiveId}`;
const readArchiveState = (scopeId: string, archiveId: string) =>
  sharePendingRead(pendingStates, membershipKey(scopeId, archiveId), () => lrrBridge.states(scopeId, [archiveId]));

const categorySnapshotKey = (serverId: string) => `categories:${encodeURIComponent(serverId)}:`;

export function readCategorySnapshot(serverId: string): Category[] | undefined {
  const parsed = CategorySchema.array().safeParse(readRouteCache(categorySnapshotKey(serverId), Infinity));
  return parsed.success ? parsed.data : undefined;
}

function invalidateCategoryReads(serverId: string) {
  pendingFavorites.delete(serverId);
  pendingCategories.delete(serverId);
  invalidateRouteCache(categorySnapshotKey(serverId));
}

const pendingWrites = new Map<string, Promise<unknown>>();
function queuedWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (key.startsWith('progress\0') || key.startsWith('reading-list\0')) pendingStates.delete(key.slice(key.indexOf('\0') + 1));
  const prior = pendingWrites.get(key);
  const write = (prior ?? Promise.resolve()).then(run, run);
  pendingWrites.set(key, write);
  void write.finally(() => { if (pendingWrites.get(key) === write) pendingWrites.delete(key); }).catch(() => undefined);
  return write;
}

const progressKey = (scopeId: string, archiveId: string) => `progress\0${scopeId}\0${archiveId}`;

async function waitForProgress(scopeId: string, archiveId?: string) {
  const writes = [...pendingWrites].filter(([key]) => archiveId === undefined
    ? key.startsWith(`progress\0${scopeId}\0`)
    : key === progressKey(scopeId, archiveId)).map(([, write]) => write);
  await Promise.all(writes);
}
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
export const CategorySchema = z.object({
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

function mapPreset(scopeId: string, record: BridgeCollectionRecord): SearchPreset {
  const value = record.value as Partial<SearchPreset> | null;
  return { scopeId, presetId: record.key, name: value?.name ?? '已删除预设', query: value?.query ?? '',
    sortBy: value?.sortBy ?? 'added', sortOrder: value?.sortOrder ?? 'desc', categoryId: value?.categoryId ?? null,
    createdAt: record.createdAt ?? new Date().toISOString(), updatedAt: record.updatedAt ?? new Date().toISOString(),
    deviceId: 'lrr-bridge', revision: Math.max(1, record.version), deleted: record.value === null };
}

/** `query_archive_page` 切词的那一套：逗号分隔、去掉首尾空白、末尾的 `$` 只对服务端
 * 的精确搜索有意义、比较时按小写。空词丢掉。 */
function archiveSearchTokens(query: string): string[] {
  return query
    .split(',')
    .map((token) => token.trim().replace(/\$+$/, '').toLowerCase())
    .filter((token) => token.length > 0);
}

/** 镜像那条 SQL 的匹配规则搬到 JS 里：带命名空间的词只看标签，裸词看标题或标签。
 *
 * 老主机没有分页搜索，回退只能拿整份列表，所以查询条件必须在这里自己补上——从前
 * 它直接 `slice(0, limit)` 交出去，等于把「这个标签下的档案」答成了「库里最新的一百
 * 条」，再被调用方的精确标签过滤一筛就什么都不剩。 */
function archiveMatchesSearch(archive: ArchiveRecord, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const title = archive.title.toLowerCase();
  const tags = (archive.tags ?? []).join(',').toLowerCase();
  return tokens.every((token) => (token.includes(':') ? tags.includes(token) : title.includes(token) || tags.includes(token)));
}

export class NativeLibraryRepository {
  /** Public watchlist means local 待看. Uses the existing reading_list local mirror. */
  setWatchlist(scopeId: string, archiveId: string, added: boolean): Promise<CommandResult<WatchlistRecord>> {
    return this.setReadingList(scopeId, archiveId, added);
  }
  listWatchlist(scopeId: string): Promise<CommandResult<WatchlistRecord[]>> {
    return this.listReadingList(scopeId);
  }
  /** Compatibility name for the established local pending-reading store. */
  setReadingList(scopeId: string, archiveId: string, added: boolean): Promise<CommandResult<WatchlistRecord>> {
    return queuedWrite(`reading-list\0${scopeId}\0${archiveId}`, async () => {
      const config = await lrrBridge.config(scopeId);
      if (!config.ok) return config;
      if (!config.value.enabled) return invokeCommand('set_reading_list', { scopeId, archiveId, added }, WatchlistRecordSchema).then(invalidateShelves);
      const result = await lrrBridge.apply(scopeId, archiveId, added ? 'watchlist_add' : 'watchlist_remove');
      return invalidateShelves(result.ok ? ok(bridgeWatchlist(scopeId, result.value)) : result);
    });
  }
  async listReadingList(scopeId: string): Promise<CommandResult<WatchlistRecord[]>> {
    // Progress may remove a finished archive; pending additions/removals must
    // also land before a refresh reads the shelf.
    await Promise.all([...pendingWrites].filter(([key]) =>
      key.startsWith(`reading-list\0${scopeId}\0`) || key.startsWith(`progress\0${scopeId}\0`))
      .map(([, write]) => write));
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (!config.value.enabled) return invokeCommand('list_reading_list', { scopeId }, z.array(WatchlistRecordSchema));
    const result = await lrrBridge.list(scopeId, 'watchlist');
    return result.ok ? ok(result.value.filter(state => state.watchlistAt !== null).map(state => bridgeWatchlist(scopeId, state))) : result;
  }
  /** 右键菜单要的两个布尔：两个 PK 点查就够，犯不着拉全量列表。 */
  async archiveMembership(scopeId: string, archiveId: string): Promise<CommandResult<{ reading: boolean; favorites: boolean }>> {
    await Promise.all([...pendingWrites].filter(([key]) => key.endsWith(`\0${scopeId}\0${archiveId}`)).map(([, write]) => write));
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (config.value.enabled) {
      const [states, local] = await Promise.all([
        readArchiveState(scopeId, archiveId),
        invokeCommand('get_archive_membership', { scopeId, archiveId }, z.object({ reading: z.boolean(), favorites: z.boolean() })),
      ]);
      if (!states.ok) return states;
      return local.ok ? ok({ ...local.value, reading: states.value[0]?.watchlistAt != null }) : local;
    }
    return invokeCommand('get_archive_membership', { scopeId, archiveId }, z.object({ reading: z.boolean(), favorites: z.boolean() }));
  }
  /** Saved searches follow the same per-server ownership as reading records. */
  async listSearchPresets(scopeId: string): Promise<CommandResult<SearchPreset[]>> {
    await Promise.all([...pendingWrites].filter(([key]) => key.startsWith(`preset\0${scopeId}\0`)).map(([, write]) => write));
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (!config.value.enabled) return invokeCommand('list_search_presets', { scopeId }, z.array(SearchPresetSchema));
    const result = await lrrBridge.collectionList(scopeId, 'search_presets');
    if (!result.ok) return result;
    const records = result.value.filter(record => record.value !== null).map(record => mapPreset(scopeId, record));
    const parsed = z.array(SearchPresetSchema).safeParse(records);
    return parsed.success ? ok(parsed.data.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))) : err('INVALID_RESPONSE', '服务器搜索预设数据无效', false);
  }
  saveSearchPreset(input: SearchPresetInput): Promise<CommandResult<SearchPreset>> {
    return queuedWrite(`preset\0${input.scopeId}\0${input.presetId}`, async () => {
      const config = await lrrBridge.config(input.scopeId);
      if (!config.ok) return config;
      if (!config.value.enabled) return invokeCommand('save_search_preset', { input }, SearchPresetSchema);
      const { scopeId, presetId, ...value } = input;
      const result = await lrrBridge.collectionApply(scopeId, 'search_presets', presetId, value);
      return result.ok ? ok(mapPreset(scopeId, result.value)) : result;
    });
  }
  deleteSearchPreset(scopeId: string, presetId: string): Promise<CommandResult<SearchPreset>> {
    return queuedWrite(`preset\0${scopeId}\0${presetId}`, async () => {
      const config = await lrrBridge.config(scopeId);
      if (!config.ok) return config;
      if (!config.value.enabled) return invokeCommand('delete_search_preset', { scopeId, presetId }, SearchPresetSchema);
      const current = await invokeCommand('list_search_presets', { scopeId }, z.array(SearchPresetSchema));
      if (!current.ok) return current;
      const old = current.value.find(preset => preset.presetId === presetId);
      const result = await lrrBridge.collectionApply(scopeId, 'search_presets', presetId, null);
      return result.ok ? ok({ ...mapPreset(scopeId, result.value), ...(old ? { name: old.name, query: old.query, sortBy: old.sortBy, sortOrder: old.sortOrder, categoryId: old.categoryId } : {}) }) : result;
    });
  }
  /** Optional shelf decorations can use the mirror already populated by progress sync. */
  listCachedHistory(scopeId: string): Promise<CommandResult<ReadingHistoryRecord[]>> {
    return invokeCommand('list_reading_history', { scopeId }, z.array(ReadingHistoryRecordSchema));
  }
  async listHistory(scopeId: string): Promise<CommandResult<ReadingHistoryRecord[]>> {
    await waitForProgress(scopeId);
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (!config.value.enabled) return this.listCachedHistory(scopeId);
    const result = await lrrBridge.list(scopeId, 'history');
    return result.ok ? ok(result.value.filter(state => state.historyAt !== null).map(state => bridgeHistory(scopeId, state))) : result;
  }
  /** 历史自动清理：读完的留 90 天，没读完的留 365 天；返回清掉的条数。
   *
   * 真清掉了才算一次「书架上的历史变了」：首页那一排与历史/书架的快照都要作废，否则
   * 清掉的记录还留在首页上——用户报的「历史里已经不显示已读完的档案，首页还在显示」
   * 就是这条：写入后也需要让界面上的快照失效。 */
  pruneHistory(): Promise<CommandResult<number>> {
    return invokeCommand('prune_history', {}, z.number().int().nonnegative()).then((result) => {
      if (result.ok && result.value > 0) invalidateShelves(result);
      return result;
    });
  }
  /** 清理选中的历史记录（不是档案），并让书架快照失效。 */
  async deleteHistoryRecords(scopeId: string, archiveIds: string[]): Promise<CommandResult<number>> {
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (config.value.enabled) {
      let count = 0;
      for (const archiveId of [...new Set(archiveIds)]) {
        const result = await queuedWrite(progressKey(scopeId, archiveId), () => lrrBridge.apply(scopeId, archiveId, 'history_delete'));
        if (!result.ok) return result;
        count++;
      }
      return invalidateShelves(ok(count));
    }
    return invokeCommand('delete_history_records', { scopeId, archiveIds }, z.number().int().nonnegative()).then((result) => {
      if (result.ok && result.value > 0) invalidateShelves(result);
      return result;
    });
  }
  /** Explicitly reset reading; deleting history alone deliberately keeps progress. */
  clearReadingProgress(scopeId: string, archiveId: string): Promise<CommandResult<void>> {
    return queuedWrite(progressKey(scopeId, archiveId), async () => {
      const config = await lrrBridge.config(scopeId);
      if (!config.ok) return config;
      if (!config.value.enabled) return invokeCommand('clear_reading_progress', { scopeId, archiveId }, VoidResponseSchema).then(invalidateShelves);
      const result = await lrrBridge.apply(scopeId, archiveId, 'progress_clear');
      return invalidateShelves(result.ok ? ok(undefined) : result);
    });
  }
  /** LANraragi 的 🔖 Favorites 这一条分类（`null` = 服务器上没有这条）。
   *
   * 书架、详情页的心、右键菜单与多选都只问它，所以它有一条自己的快路：只读
   * `/api/categories` 的回包里那条**静态**分类，不解析任何动态分类。走
   * `listCategories` 的话，缓存一过期就要为每条动态分类各跑一次不分页的全库搜索
   * （见 `read_favorites_category`）。 */
  readFavoritesCategory(serverId: string): Promise<CommandResult<{ id: string; archives: string[] } | null>> {
    return sharePendingRead(pendingFavorites, serverId, () =>
      invokeCommand('read_favorites_category', { serverId }, z.object({ id: z.string(), archives: z.array(z.string()) }).nullable()));
  }

  loadArchiveMetadata(serverId: string, archiveId: string): Promise<CommandResult<z.infer<typeof ArchiveMetadataSchema>>> {
    return invokeCommand('load_archive_metadata', { serverId, archiveId }, ArchiveMetadataSchema);
  }
  deleteArchive(serverId: string, archiveId: string): Promise<CommandResult<null>> {
    return invokeCommand('delete_archive', { serverId, archiveId }, z.null()).then(invalidateShelves);
  }
  /** 一次性把这份档案收下来。暂停和中止不是失败：结果里带着最终状态。 */
  archiveDownloadStatus(serverId: string, archiveId: string) {
    return invokeCommand('archive_download_status', { serverId, archiveId }, z.object({
      downloaded: z.boolean(), downloading: z.boolean(),
      receivedBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative().nullable(),
    }));
  }
  async downloadArchive(serverId: string, archiveId: string): Promise<CommandResult<DownloadResult>> {
    const key = archiveDownloadKey(serverId, archiveId);
    pendingArchiveDownloads.set(key, (pendingArchiveDownloads.get(key) ?? 0) + 1);
    invalidateRouteCache('downloads:');
    try {
      return await invokeCommand('download_archive', { serverId, archiveId }, DownloadResultSchema);
    } finally {
      const remaining = (pendingArchiveDownloads.get(key) ?? 1) - 1;
      if (remaining) pendingArchiveDownloads.set(key, remaining);
      else pendingArchiveDownloads.delete(key);
      invalidateRouteCache('downloads:');
    }
  }
  /** 接着收：从 `.part` 已有的字节往后要。失败过的任务也走这里。 */
  resumeDownload(taskId: string): Promise<CommandResult<DownloadResult>> {
    return invokeCommand('resume_download', { taskId }, DownloadResultSchema);
  }
  pauseDownload(taskId: string): Promise<CommandResult<void>> {
    return invokeCommand('pause_download', { taskId }, VoidResponseSchema);
  }
  cancelDownload(taskId: string): Promise<CommandResult<void>> {
    return invokeCommand('cancel_download', { taskId }, VoidResponseSchema);
  }
  /** 下载目录里现存的档案；顺便跟磁盘对齐一次（新增的记进来、没了的收掉）。 */
  listLocalArchives(): Promise<CommandResult<LocalArchiveRecord[]>> {
    return invokeCommand('list_local_archives', {}, z.array(LocalArchiveRecordSchema));
  }
  loadLocalArchiveCover(path: string): Promise<CommandResult<string>> {
    return invokeCommand('load_local_archive_cover', { path }, z.string());
  }
  /** 删除本地文件，服务器上的那份档案不动。 */
  deleteLocalArchives(paths: string[]): Promise<CommandResult<number>> {
    return invokeCommand('delete_local_archives', { paths }, z.number().int().nonnegative()).then(result => {
      if (result.ok) invalidateRouteCache('downloads:');
      return result;
    });
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
    if (force) pendingCategories.delete(serverId);
    const pending = sharePendingRead(pendingCategories, serverId, () => {
      const request = invokeCommand('list_categories', { serverId, force }, CategorySchema.array());
      return request.then(result => {
        if (result.ok && pendingCategories.get(serverId) === pending) {
          writeRouteCache(categorySnapshotKey(serverId), result.value, { persist: true });
        }
        return result;
      });
    });
    return pending;
  }
  /** 镜像写：本机那张收藏表由 `setWatchlist` 先写，服务器上这条静态分类随后才落地。
   *
   * 这里必须和 `removeArchiveFromCategory` 一样作废书架快照。本机写那一下会广播一次
   * `state:` 作废，书架于是**立刻重读一次**——而那一刻 PUT 还没发出去，Rust 那边的
   * 分类快照还在，读回来的是**加收藏之前**的名单，并且被写进 localStorage 快照自己
   * 续命下去。所以症状是单向的：移出收藏夹立刻正确（那条有作废），加进去却不出现。 */
  addArchiveToCategory(serverId: string, categoryId: string, archiveId: string): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('add_archive_to_category', { serverId, categoryId, archiveId }, OperationResultSchema).then(result => {
      if (result.ok) invalidateCategoryReads(serverId);
      return invalidateFavorites(result);
    });
  }
  removeArchiveFromCategory(serverId: string, categoryId: string, archiveId: string): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('remove_archive_from_category', { serverId, categoryId, archiveId }, OperationResultSchema).then(result => {
      if (result.ok) invalidateCategoryReads(serverId);
      return invalidateFavorites(result);
    });
  }
  updateArchiveMetadata(serverId: string, archiveId: string, metadata: { title?: string; tags?: string; summary?: string }): Promise<CommandResult<z.infer<typeof OperationResultSchema>>> {
    return invokeCommand('update_archive_metadata', { serverId, archiveId, metadata }, OperationResultSchema).then(result => {
      if (result.ok) invalidateCategoryReads(serverId);
      return result;
    }).then(invalidateShelves);
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

  openReaderPageFile(serverId: string, archiveId: string, pageIndex: number, path: string, taskId: string, readerSession: number) {
    return invokeCommand('reader_open_page_file', { serverId, archiveId, pageIndex, path, taskId, readerSession }, z.object({
      lease: ComputedImageLeaseSchema,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).nullable());
  }

  async loadReaderPage(serverId: string, archiveId: string, pageIndex: number, path: string, taskId?: string): Promise<CommandResult<ArrayBuffer>> {
    const result = await invokeBinaryCommand('load_reader_page', { serverId, archiveId, pageIndex, path, ...(taskId ? { taskId } : {}) });
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
    return invokeCommand('list_servers', {}, z.array(ServerRecordSchema)).then((result) => {
      // 这一问同时也答了「有没有服务器」：页面拿它决定第一帧画骨架还是画引导
      // （见 src/lib/serverPresence.ts）。读失败什么也没说，上一次的答案保持原样。
      if (result.ok) rememberServerPresence(result.value.length > 0);
      return result;
    });
  }

  checkServerStatus(): Promise<CommandResult<ServerStatus[]>> {
    return invokeCommand('check_server_status', {}, z.array(ServerStatusSchema));
  }

  saveServer(input: { identity: ServerIdentity; apiKey: string }): Promise<CommandResult<ServerRecord>> {
    return invokeCommand('save_server', {
      server: input.identity,
      apiKey: input.apiKey,
    }, ServerRecordSchema).then((result) => {
      // 存下一台（新的或改的）之后「没有服务器」这个答案就过期了。
      if (result.ok) { invalidateLrrBridgeConfig(input.identity.scopeId); rememberServerPresence(true); }
      return result;
    });
  }

  /** 切换当前启用的服务器：启用一台即停用其余，书架与首页随之改读它。
   * 切换是罕见且全局的动作，直接全量失效——所有按服务器缓存的快照
   * （首页/书架/档案库/详情）都不该在切换后闪现旧服务器的数据。 */
  setServerEnabled(serverId: string): Promise<CommandResult<ServerRecord>> {
    return invokeCommand('set_server_enabled', { serverId, enabled: true }, ServerRecordSchema).then((result) => {
      if (result.ok) {
        invalidateRouteCache();
        // 启用的前提是这台服务器还在，答案只能是「有」。
        rememberServerPresence(true);
      }
      return result;
    });
  }

  /** 删除一台服务器的配置（连接信息与凭据）。档案馆藏、阅读进度与阅读记录按
   * scope id 留在本机，重新添加同一地址即可接回；这里仍然全量失效，因为服务器
   * 列表、当前数据源与所有按服务器缓存的快照都可能变。 */
  deleteServer(serverId: string): Promise<CommandResult<ServerRecord[]>> {
    return invokeCommand('delete_server', { serverId }, z.array(ServerRecordSchema)).then((result) => {
      if (result.ok) {
        invalidateLrrBridgeConfig();
        invalidateRouteCache();
        // 回的是删完剩下的那份列表，随手把答案改对：删掉最后一台时下一个页面
        // 的第一帧就该是引导，而不是先给一次骨架。
        rememberServerPresence(result.value.length > 0);
      }
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
  /** 去重页专用：只回 id/标题/标签/页数/体积，整库校验不再为全字段付费。 */
  listArchiveIdentities(serverId: string): Promise<CommandResult<ArchiveIdentity[]>> {
    return invokeCommand('list_archive_identities', { serverId }, z.array(ArchiveIdentitySchema));
  }
  /** For the shelves, which know their archive ids and only need the records
   * behind them — reading the whole library to resolve a dozen titles scaled
   * with the library instead of with the shelf. Answers in the requested id
   * order. Resolve missing metadata without pulling the entire index. */
  async listArchivesByIds(serverId: string, archiveIds: string[], options: { resolveMissing?: boolean; onAvailable?: (archives: ArchiveRecord[]) => void; signal?: AbortSignal } = {}): Promise<CommandResult<ArchiveRecord[]>> {
    if (archiveIds.length === 0) return { ok: true, value: [] };
    const cached = await invokeCommand('list_archives_by_ids', { serverId, archiveIds }, z.array(ArchiveRecordSchema));
    if (!cached.ok || options.resolveMissing === false) return cached;
    if (!options.signal?.aborted && cached.value.length) options.onAvailable?.(cached.value);
    const found = new Set(cached.value.map(archive => archive.archiveId));
    const missing = [...new Set(archiveIds)].filter(id => !found.has(id)).slice(0, 64);
    if (missing.length === 0) return cached;
    let cursor = 0;
    let resolved = false;
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (!options.signal?.aborted && cursor < missing.length) {
        const id = missing[cursor++]!;
        // Native metadata loading persists the record. Offline failures leave
        // the existing shelf usable; a later refresh can try missing ids again.
        const result = await this.loadArchiveMetadata(serverId, id);
        if (!result.ok || options.signal?.aborted) continue;
        resolved = true;
        if (options.onAvailable) {
          const indexed = await this.listArchivesByIds(serverId, [id], { resolveMissing: false });
          if (indexed.ok && indexed.value.length && !options.signal?.aborted) options.onAvailable(indexed.value);
        }
      }
    }));
    return resolved && !options.signal?.aborted
      ? invokeCommand('list_archives_by_ids', { serverId, archiveIds }, z.array(ArchiveRecordSchema))
      : cached;
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
    if (!legacy.ok) return legacy;
    const matched = legacy.value.filter((archive) => archiveMatchesSearch(archive, archiveSearchTokens(query.query ?? '')));
    return {
      ok: true,
      value: {
        items: matched.slice(offset, offset + limit),
        total: matched.length,
        hasMore: matched.length > offset + limit,
      },
    };
  }

  saveProgress(progress: NewProgress): Promise<CommandResult<ReadingProgress>> {
    return queuedWrite(
      progressKey(progress.scopeId, progress.archiveId),
      async () => {
        const config = await lrrBridge.config(progress.scopeId);
        if (!config.ok) return config;
        if (!config.value.enabled) return invokeCommand('save_reading_progress', { progress }, ReadingProgressSchema).then(invalidateShelves);
        const result = await lrrBridge.apply(progress.scopeId, progress.archiveId, 'progress', {
          pageIndex: progress.pageIndex, pageCount: progress.pageCount, layout: progress.layout, direction: progress.direction,
          ...(progress.coverAlone !== undefined ? { coverAlone: progress.coverAlone } : {}),
          allowProgressRegression: progress.allowProgressRegression ?? true, updatedAt: new Date().toISOString(),
        });
        if (!result.ok) return result;
        const value = bridgeProgress(progress.scopeId, result.value);
        return invalidateShelves(value ? ok(value) : err('INVALID_RESPONSE', '托管进度响应无效', false));
      },
    );
  }

  async loadProgress(scopeId: string, archiveId: string): Promise<CommandResult<ReadingProgress | null>> {
    const result = await this.loadReadingStatus(scopeId, archiveId);
    return result.ok ? ok(result.value.progress) : result;
  }

  async loadReadingStatus(scopeId: string, archiveId: string): Promise<CommandResult<{ progress: ReadingProgress | null; hasHistory: boolean }>> {
    await waitForProgress(scopeId, archiveId);
    const config = await lrrBridge.config(scopeId);
    if (!config.ok) return config;
    if (!config.value.enabled) {
      const result = await invokeCommand('load_reading_progress', { scopeId, archiveId }, ReadingProgressSchema.nullable());
      return result.ok ? ok({ progress: result.value, hasHistory: false }) : result;
    }
    const result = await readArchiveState(scopeId, archiveId);
    if (!result.ok) return result;
    const state = result.value[0];
    return ok({ progress: state ? bridgeProgress(scopeId, state) : null, hasHistory: state?.historyAt != null });
  }
}
