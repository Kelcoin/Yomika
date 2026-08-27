import type { DomainError, DomainErrorCode } from './errors';

export type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DomainError };

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function err(
  code: DomainErrorCode,
  message: string,
  retryable: boolean,
): CommandResult<never> {
  return { ok: false, error: { code, message, retryable } };
}

export function isOk<T>(result: CommandResult<T>): result is { ok: true; value: T } {
  return result.ok;
}
