import { z } from 'zod';

export const ServerRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  baseUrl: z.string().url(),
  scopeId: z.string().min(1),
  /** The one server the home shelves, the library and every default-server
   * fallback read from. `.default(true)` keeps older invocations and test
   * fixtures valid; the database always writes the flag. */
  enabled: z.boolean().default(true),
});

export type ServerRecord = z.infer<typeof ServerRecordSchema>;

export const ArchiveRecordSchema = z.object({
  serverId: z.string().min(1),
  archiveId: z.string().min(1),
  title: z.string(),
  pageCount: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative().optional(),
  summary: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  coverPage: z.number().int().nonnegative().nullable().optional(),
  isDeleted: z.boolean().optional(),
  updatedAt: z.string().min(1),
  addedAt: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export type ArchiveRecord = z.infer<typeof ArchiveRecordSchema>;

/** 查重页只取身份、卡片展示和比较所需字段，避免整库传输无关元数据。 */
export const ArchiveIdentitySchema = z.object({
  archiveId: z.string().min(1),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  pageCount: z.number().int().nullable().optional(),
  fileSize: z.number().int().nullable().optional(),
  addedAt: z.number().int().nonnegative().nullable().optional(),
});
export type ArchiveIdentity = z.infer<typeof ArchiveIdentitySchema>;

export const ArchivePageSchema = z.object({
  items: z.array(ArchiveRecordSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type ArchivePage = z.infer<typeof ArchivePageSchema>;

export const ReadingProgressSchema = z.object({
  scopeId: z.string().min(1),
  archiveId: z.string().min(1),
  pageIndex: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  layout: z.enum(['paged', 'continuous']),
  direction: z.enum(['ltr', 'rtl']),
  /** Whether page 0 opens alone in double-page mode. Null means undecided, which
   * reads as the default; a row written by an older build has no value at all. */
  coverAlone: z.boolean().nullable().optional(),
  updatedAt: z.string().min(1),
  revision: z.number().int().positive(),
});

export type ReadingProgress = z.infer<typeof ReadingProgressSchema>;

export const WatchlistRecordSchema = z.object({
  scopeId: z.string().min(1),
  archiveId: z.string().min(1),
  addedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  deviceId: z.string().min(1),
  deletedAt: z.string().nullable().optional(),
  revision: z.number().int().positive(),
  deleted: z.boolean(),
});
export type WatchlistRecord = z.infer<typeof WatchlistRecordSchema>;

export const ReadingHistoryRecordSchema = z.object({
  scopeId: z.string().min(1),
  archiveId: z.string().min(1),
  pageIndex: z.number().int().nonnegative(),
  visitedAt: z.string().min(1),
  deviceId: z.string().min(1),
  revision: z.number().int().positive(),
});
export type ReadingHistoryRecord = z.infer<typeof ReadingHistoryRecordSchema>;

export const TaskStatusSchema = z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['download', 'sync', 'inference', 'maintenance']),
  label: z.string(),
  status: TaskStatusSchema,
  progress: z.number().min(0).max(1),
  cancelable: z.boolean(),
  retryable: z.boolean(),
  // 原生那侧是 Option<String>，serde 一直发出这个字段，没有错误时是 null。
  error: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  // 下载任务才有：对应哪一份档案、文件落在哪、一共多少、收了多少、多快。
  archiveId: z.string().nullable().optional(),
  serverId: z.string().nullable().optional(),
  localPath: z.string().nullable().optional(),
  totalBytes: z.number().int().nonnegative().nullable().optional(),
  receivedBytes: z.number().int().nonnegative().default(0),
  bytesPerSecond: z.number().int().nonnegative().nullable().optional(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const DownloadResultSchema = z.object({
  status: z.enum(['completed', 'paused', 'cancelled', 'failed', 'existing']),
  /** 落盘路径；暂停时是半份文件，中止时是空串。 */
  path: z.string(),
  taskId: z.string().min(1),
});
export type DownloadResult = z.infer<typeof DownloadResultSchema>;

/** 下载目录里的一份档案。磁盘才是主语：路径是它的身份，镜像只用来补标题、标签
 * 和封面。 */
export const LocalArchiveRecordSchema = z.object({
  path: z.string().min(1),
  archiveId: z.string().nullable().optional(),
  serverId: z.string().nullable().optional(),
  scopeId: z.string().nullable().optional(),
  title: z.string(),
  fileSize: z.number().int().nonnegative(),
  addedAt: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string()).default([]),
});

export type LocalArchiveRecord = z.infer<typeof LocalArchiveRecordSchema>;
