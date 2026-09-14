import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';
import type { WorkerV3Payload } from '../lib/dataMigration';

export const WorkerImportReportSchema = z.object({
  history: z.number().int().nonnegative(),
  historyRemoved: z.number().int().nonnegative(),
  watchlist: z.number().int().nonnegative(),
  watchlistRemoved: z.number().int().nonnegative(),
});

export type WorkerImportReport = z.infer<typeof WorkerImportReportSchema>;

export class NativeLegacyRepository {
  importExport(scopeId: string, serialized: string): Promise<CommandResult<number>> {
    return invokeCommand('import_legacy_export', { input: { scopeId, serialized } }, z.number().int().nonnegative());
  }
  importWorkerExport(scopeId: string, payload: WorkerV3Payload): Promise<CommandResult<WorkerImportReport>> {
    return invokeCommand('import_worker_export', {
      input: {
        scopeId,
        history: { entries: payload.history.entries, deletedIds: payload.history.deletedIds },
        watchlist: { entries: payload.watchlist.entries, tombstones: payload.watchlist.tombstones },
      },
    }, WorkerImportReportSchema);
  }
}
