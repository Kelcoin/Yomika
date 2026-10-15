import { afterEach, describe, expect, it } from 'vitest';

import { flushErrorLog, installErrorLogging, logError, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';

function collect() {
  const written: ErrorLogRecord[] = [];
  setErrorLogSinkForTests(async (records) => { written.push(...records); return true; });
  return written;
}

afterEach(() => setErrorLogSinkForTests());

describe('error log', () => {
  it('batches records instead of one IPC per error, and redacts secrets', async () => {
    const written = collect();

    logError('bridge/list_archives', '请求失败', { apiKey: 'super-secret', url: 'https://lrr.test/api?apikey=alsosecret' });
    logError('reader/page', '页面加载失败');
    // 排队等下一拍，不是每条一次 IPC。
    expect(written).toHaveLength(0);

    await flushErrorLog();
    expect(written.map((record) => record.source)).toEqual(['bridge/list_archives', 'reader/page']);
    expect(written[0]!.message).toBe('请求失败');
    expect(written[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const detail = written[0]!.detail ?? '';
    expect(detail).not.toContain('super-secret');
    expect(detail).not.toContain('alsosecret');
    expect(detail).toContain('[REDACTED]');
    // 没有上下文的记录不带 detail，而不是带一个空字符串。
    expect(written[1]!.detail).toBeUndefined();
  });

  it('drops records instead of growing without bound', async () => {
    const written = collect();
    for (let index = 0; index < 600; index += 1) logError('app', `failure ${index}`);
    await flushErrorLog();
    expect(written.length).toBeLessThanOrEqual(500);
    // 留下的是最近的：被挤掉的是最早的几条。
    expect(written[written.length - 1]!.message).toBe('failure 599');
    expect(written[0]!.message).not.toBe('failure 0');
  });

  it('records uncaught errors and unhandled rejections, and stops when asked', async () => {
    const written = collect();
    const stop = installErrorLogging();

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'index.js', lineno: 12 }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('nothing caught this');
    window.dispatchEvent(rejection);
    await flushErrorLog();

    expect(written.map((record) => record.message)).toEqual(['boom', 'nothing caught this']);
    expect(written[0]!.source).toBe('window');
    expect(written[0]!.detail).toContain('index.js');
    expect(written[1]!.source).toBe('promise');

    stop();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after stop' }));
    await flushErrorLog();
    expect(written.map((record) => record.message)).not.toContain('after stop');
  });
});

it('drops expected outcomes but preserves unknown network-related bugs', async () => {
  const written = collect();
  for (const code of ['COMPUTE_QUEUE_FULL', 'CANCELLED', 'ABORTED', 'NETWORK', 'REMOTE_TIMEOUT']) {
    logError('reader', 'operation failed', { error: { code, message: 'try again' } });
    logError('reader', { code, message: 'try again' });
  }
  logError('image', new DOMException('stopped', 'AbortError'));
  logError('promise', new TypeError('Failed to fetch'));
  logError('reader', 'network decoder invariant failed');
  logError('reader', { code: 'GPU_OUTPUT_INVALID', message: 'bad output' });
  await flushErrorLog();
  expect(written).toHaveLength(2);
});
it('preserves rejection codes and names for filtering', async () => {
  const written = collect();
  const uninstall = installErrorLogging();
  for (const reason of [{ code: 'COMPUTE_QUEUE_FULL', message: 'busy' }, new DOMException('stop', 'AbortError'), new TypeError('Failed to fetch')]) {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);
  }
  uninstall();
  await flushErrorLog();
  expect(written).toHaveLength(0);
});
