import { z } from 'zod';
import { invokeCommand } from '../bridge/invoke';
import type { CommandResult } from '../domain/result';

export class NativeLegacyRepository {
  importExport(scopeId: string, serialized: string): Promise<CommandResult<number>> {
    return invokeCommand('import_legacy_export', { input: { scopeId, serialized } }, z.number().int().nonnegative());
  }
}
