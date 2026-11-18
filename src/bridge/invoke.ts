import { z } from 'zod';

import { DomainErrorSchema, QUIET_ERROR_CODES } from '../domain/errors';
import { err, ok, type CommandResult } from '../domain/result';
import { logError } from '../lib/errorLog';

type InvokeAdapter = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

let testAdapter: InvokeAdapter | undefined;

export function setInvokeAdapterForTests(adapter: InvokeAdapter): void {
  testAdapter = adapter;
}

export function resetInvokeAdapterForTests(): void {
  testAdapter = undefined;
}

const ResultEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: DomainErrorSchema }),
]);

/** The response schema for a command that answers with nothing.
 *
 * Rust's `CommandResult<()>` serialises its value as JSON `null`, so validating
 * it with `z.undefined()` rejected every real reply as
 * "Native command returned an invalid response" — while the test adapters, which
 * answer with a literal `undefined`, passed. Every void command needs the pair,
 * so it lives here once instead of being remembered per call site. */
export const VoidResponseSchema = z.union([z.null(), z.undefined()]).transform(() => undefined) as unknown as z.ZodType<void>;

export async function invokeCommand<TRequest extends Record<string, unknown>, TResponse>(
  name: string,
  request: TRequest,
  schema: z.ZodType<TResponse, z.ZodTypeDef, unknown>,
): Promise<CommandResult<TResponse>> {
  // Reading and workspace payloads are private; diagnostics need only the action.
  const securityCommand = name.startsWith('app_security_');
  const loggedRequest = securityCommand || name === 'write_clipboard_text' || name === 'show_system_toast' ? {} : name.startsWith('lrr_bridge_') ? { scopeId: request.scopeId, action: request.action } : request;
  try {
    const adapter = testAdapter ?? await loadNativeAdapter();
    const payload = await adapter(name, request);
    const parsed = ResultEnvelopeSchema.safeParse(payload);

    if (!parsed.success) {
      logError(`bridge/${name}`, 'Native command returned an invalid response', { request: loggedRequest });
      return err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
    }

    if (!parsed.data.ok) {
      // 失败的命令都要留下现场：这是设置页那份错误日志的主要来源。例外是那几个
      // 「现在就是这样」的码（档案已经不在服务器上、这一页的推理被取消）——它们照样
      // 按失败返回，但不进日志，免得把真正的现场埋掉。
      if (!QUIET_ERROR_CODES.has(parsed.data.error.code)) {
        logError(`bridge/${name}`, securityCommand ? `${parsed.data.error.code}: Security command failed` : `${parsed.data.error.code}: ${parsed.data.error.message}`, securityCommand ? {} : { request: loggedRequest, error: parsed.data.error });
      }
      return err(parsed.data.error.code, parsed.data.error.message, parsed.data.error.retryable);
    }

    const value = schema.safeParse(parsed.data.value);
    if (value.success) return ok(value.data);
    // 哪个字段没对上才是能查的东西。只写「不匹配」等于把现场丢掉：一个
    // `null` 撞上非 nullable 的 schema，排查要从猜字段开始。
    logError(`bridge/${name}`, 'Native command answer did not match its schema', {
      request: loggedRequest,
      issues: securityCommand ? [] : value.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    });
    return err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
  } catch (error) {
    logError(`bridge/${name}`, 'Native command failed', securityCommand ? {} : { request: loggedRequest, error, errorMessage: error instanceof Error ? error.message : String(error) });
    return err('UNKNOWN', 'Native command failed', true);
  }
}

/** Image commands answer with a binary IPC body on success and keep the JSON
 * `{ ok: false, error }` envelope for failures, so success is recognised by the
 * payload type. The JSON array of byte numbers is still accepted: it is what the
 * test adapters produce, and what an older native build would send. */
export async function invokeBinaryCommand<TRequest extends Record<string, unknown>>(
  name: string,
  request: TRequest,
): Promise<CommandResult<ArrayBuffer>> {
  try {
    const adapter = testAdapter ?? await loadNativeAdapter();
    const payload = await adapter(name, request);
    const direct = toArrayBuffer(payload);
    if (direct) return ok(direct);

    const parsed = ResultEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      logError(`bridge/${name}`, 'Native command returned an invalid response', { request });
      return err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
    }
    if (!parsed.data.ok) {
      if (!QUIET_ERROR_CODES.has(parsed.data.error.code)) {
        logError(`bridge/${name}`, `${parsed.data.error.code}: ${parsed.data.error.message}`, { request, error: parsed.data.error });
      }
      return err(parsed.data.error.code, parsed.data.error.message, parsed.data.error.retryable);
    }

    const bytes = toArrayBuffer(parsed.data.value);
    if (bytes) return ok(bytes);
    logError(`bridge/${name}`, 'Native command answer did not match its schema', { request });
    return err('INVALID_RESPONSE', 'Native command returned an invalid response', false);
  } catch (error) {
    logError(`bridge/${name}`, 'Native command failed', { request, error, errorMessage: error instanceof Error ? error.message : String(error) });
    return err('UNKNOWN', 'Native command failed', true);
  }
}

function toArrayBuffer(payload: unknown): ArrayBuffer | undefined {
  if (payload instanceof ArrayBuffer) return payload;
  if (payload instanceof Uint8Array) {
    return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(payload) && payload.every((entry) => typeof entry === 'number')) {
    return new Uint8Array(payload as number[]).buffer;
  }
  return undefined;
}

async function loadNativeAdapter(): Promise<InvokeAdapter> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Native runtime unavailable');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return (command, args) => invoke(command, args);
}
