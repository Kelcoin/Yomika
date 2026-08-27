import { z } from 'zod';

import { DomainErrorSchema } from '../domain/errors';
import { err, ok, type CommandResult } from '../domain/result';

type InvokeAdapter = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let testAdapter: InvokeAdapter | undefined;

export function setInvokeAdapterForTests(adapter: InvokeAdapter): void {
  testAdapter = adapter;
}

export function resetInvokeAdapterForTests(): void {
  testAdapter = undefined;
}

export async function invokeCommand<TRequest extends Record<string, unknown>, TResponse>(
  name: string,
  request: TRequest,
  schema: z.ZodType<TResponse>,
): Promise<CommandResult<TResponse>> {
  try {
    const adapter = testAdapter ?? await loadNativeAdapter();
    const payload = await adapter(name, request);
    const resultSchema = z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({ ok: z.literal(false), error: DomainErrorSchema }),
    ]);
    const parsed = resultSchema.safeParse(payload);

    if (!parsed.success) {
      return err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
    }

    if (!parsed.data.ok) {
      return err(parsed.data.error.code, parsed.data.error.message, parsed.data.error.retryable);
    }

    const value = schema.safeParse(parsed.data.value);
    return value.success
      ? ok(value.data)
      : err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
  } catch {
    return err('UNKNOWN', 'Native command failed', true);
  }
}

async function loadNativeAdapter(): Promise<InvokeAdapter> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Native runtime unavailable');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return (command, args) => invoke(command, args);
}
