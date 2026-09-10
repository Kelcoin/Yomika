import { z } from 'zod';
import { invokeCommand, VoidResponseSchema } from './invoke';
import type { CommandResult } from '../domain/result';

export function openExternalUrl(url: string): Promise<CommandResult<void>> {
  return invokeCommand('open_external_url', { url: z.string().url().parse(url) }, VoidResponseSchema);
}
