import { QUIET_ERROR_CODES } from '../domain/errors';
import { redactSensitive } from './redaction';

/** 一次运行里的错误记录。
 *
 * 记录从这里写进后端的日志文件（启动时清空），设置页的「错误日志」读的就是
 * 那份文件。日志是给人看的现场：消息经过 redaction，不会带上 API key 之类的
 * 敏感值。 */
export interface ErrorLogRecord {
  /** ISO-8601；后端 panic 写的是 `epoch:<毫秒>`。 */
  at: string;
  level: 'error' | 'warn';
  /** 出错的位置，例如 `bridge/list_archives`、`window`、`reader`。 */
  source: string;
  message: string;
  detail?: string;
}

type ErrorLogSink = (records: readonly ErrorLogRecord[]) => Promise<boolean>;

/** 缓冲这么多条之后，最旧的先丢：日志不该把自己变成内存问题。 */
const MAX_BUFFERED = 500;
/** 落盘节奏：一次离线会连着失败十几次，一条一次 IPC 不值当。 */
const FLUSH_DELAY_MS = 400;
/** 单次 flush 最多写这么多条，剩下的下一拍继续。 */
const FLUSH_BATCH = 60;
const MAX_MESSAGE_CHARS = 1200;
const MAX_DETAIL_CHARS = 2000;

const buffered: ErrorLogRecord[] = [];
let sink: ErrorLogSink = nativeSink;
let timer: number | undefined;
/** 没有后端可写（浏览器里跑、测试环境）时连缓冲都不做：记日志这件事本身不该
 * 在别处留下计时器或内存。 */
let sinkAvailable = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 后端不可用（测试、浏览器里跑）时静默丢弃：记日志这件事本身不该制造错误。 */
async function nativeSink(records: readonly ErrorLogRecord[]): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // 一批一次 IPC：错误风暴时 60 条就是 60 次串行往返，桥上全是它。
    await invoke('error_log_append_batch', { inputs: records });
    return true;
  } catch {
    return false;
  }
}

export function setErrorLogSinkForTests(next?: ErrorLogSink): void {
  sink = next ?? nativeSink;
  sinkAvailable = next !== undefined;
  buffered.length = 0;
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
}

function schedule(): void {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => { void flushErrorLog(); }, FLUSH_DELAY_MS);
}

/** 把缓冲区交给 sink。导出前也调它：导出的文件里应该有刚刚发生的那几条。 */
export async function flushErrorLog(): Promise<void> {
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
  while (buffered.length) {
    const batch = buffered.splice(0, FLUSH_BATCH);
    const written = await sink(batch);
    // 后端写不进去就不再重试：留着只会让缓冲区在下一次失败时被挤爆。
    if (!written) break;
  }
}

function flat(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function describe(context: unknown): string | undefined {
  if (context === undefined) return undefined;
  try {
    const redacted = redactSensitive(context);
    const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    return text ? flat(text, MAX_DETAIL_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

/** Keep transport failures precise: a decoder mentioning a network is still a bug. */
export function isExpectedError(value: unknown, depth = 0): boolean {
  if (depth > 3 || value == null) return false;
  if (typeof value === 'string') {
    const code = value.match(/^([A-Z][A-Z0-9_]+)(?=[:：\s]|$)/)?.[1];
    return code !== undefined && QUIET_ERROR_CODES.has(code);
  }
  if (typeof value !== 'object') return false;
  const error = value as { code?: unknown; name?: unknown; message?: unknown; error?: unknown; cause?: unknown };
  if (typeof error.code === 'string' && QUIET_ERROR_CODES.has(error.code)) return true;
  if (error.name === 'AbortError' || error.name === 'NetworkError' || error.name === 'TimeoutError') return true;
  if (error.name === 'TypeError' && typeof error.message === 'string' && /^(Failed to fetch|Load failed|Network request failed|Failed to execute 'fetch' on 'Window': Failed to fetch)\.?$/.test(error.message)) return true;
  return isExpectedError(error.error, depth + 1) || isExpectedError(error.cause, depth + 1);
}

export function logError(source: string, message: unknown, context?: unknown, level: ErrorLogRecord['level'] = 'error'): void {
  if (!sinkAvailable || isExpectedError(message) || isExpectedError(context)) return;
  const structured = message && typeof message === 'object' ? message as { code?: unknown; message?: unknown } : undefined;
  const text = structured && 'message' in structured ? `${structured.code ? `${structured.code}: ` : ''}${String(structured.message)}` : String(message ?? '');
  const safeMessage = flat(text, MAX_MESSAGE_CHARS);
  if (!safeMessage) return;
  const detail = describe(context);
  const record: ErrorLogRecord = {
    at: new Date().toISOString(),
    level,
    source: flat(source || 'app', 80),
    message: flat(String(redactSensitive(safeMessage)), MAX_MESSAGE_CHARS),
    ...(detail === undefined ? {} : { detail }),
  };
  buffered.push(record);
  if (buffered.length > MAX_BUFFERED) buffered.splice(0, buffered.length - MAX_BUFFERED);
  schedule();
}

export function logWarn(source: string, message: unknown, context?: unknown): void {
  logError(source, message, context, 'warn');
}

/** 没人接住的错误也要留下现场：抛到 window 上的异常和没 catch 的 promise。 */
export function installErrorLogging(): () => void {
  const onError = (event: ErrorEvent): void => {
    if (isExpectedError(event.error)) return;
    logError('window', event.message || 'Uncaught error', {
      file: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as { message?: unknown; stack?: unknown } | undefined;
    const message = reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : String(reason ?? 'Unhandled rejection');
    logError('promise', message, { error: event.reason, stack: reason && typeof reason === 'object' ? reason.stack : undefined });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
