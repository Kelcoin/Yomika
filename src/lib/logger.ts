import { redactSensitive } from './redaction';

export interface LogRecord {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  message: string;
  context?: unknown;
}

export type LogSink = (record: LogRecord) => void;

export function createLogger(sink: LogSink) {
  const write = (level: LogRecord['level'], message: string, context?: unknown): void => {
    const record: LogRecord = { level, message: String(redactSensitive(message)) };
    if (context !== undefined) {
      record.context = redactSensitive(context);
    }
    sink(record);
  };

  return {
    error: (message: string, context?: unknown) => write('error', message, context),
    warn: (message: string, context?: unknown) => write('warn', message, context),
    info: (message: string, context?: unknown) => write('info', message, context),
    debug: (message: string, context?: unknown) => write('debug', message, context),
    trace: (message: string, context?: unknown) => write('trace', message, context),
  };
}
