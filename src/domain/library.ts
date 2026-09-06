import { z } from 'zod';

export const ServerRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  baseUrl: z.string().url(),
  scopeId: z.string().min(1),
});

export type ServerRecord = z.infer<typeof ServerRecordSchema>;

export const ArchiveRecordSchema = z.object({
  serverId: z.string().min(1),
  archiveId: z.string().min(1),
  title: z.string(),
  pageCount: z.number().int().nonnegative(),
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
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const SyncJournalOperationSchema = z.enum(['upsert', 'delete']);
export const SyncJournalStatusSchema = z.enum(['pending', 'retryable', 'processing', 'completed', 'failed']);
export const SyncJournalRecordSchema = z.object({
  sequence: z.number().int().positive(),
  scopeId: z.string().min(1),
  objectId: z.string().min(1),
  objectType: z.string().min(1),
  operation: SyncJournalOperationSchema,
  deviceId: z.string().min(1),
  logicalClock: z.number().int().nonnegative(),
  wallClock: z.string().min(1),
  baseHash: z.string().nullable().optional(),
  payloadHash: z.string().min(1),
  payloadJson: z.string().min(1),
  status: SyncJournalStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
});
export type SyncJournalRecord = z.infer<typeof SyncJournalRecordSchema>;
export type SyncJournalInput = Omit<SyncJournalRecord, 'sequence' | 'wallClock' | 'status' | 'attemptCount' | 'lastError'> & {
  baseHash?: string;
};
