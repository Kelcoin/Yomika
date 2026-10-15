import { z } from 'zod';

import {
  invokeCommand,
  invokeBinaryCommand,
  resetInvokeAdapterForTests,
  setInvokeAdapterForTests,
} from '../../src/bridge/invoke';
import { getPlatformCapabilities } from '../../src/bridge/platform';
import { flushErrorLog, setErrorLogSinkForTests, type ErrorLogRecord } from '../../src/lib/errorLog';

afterEach(() => {
  resetInvokeAdapterForTests();
  setErrorLogSinkForTests();
});

describe('typed invoke bridge', () => {
  it('returns a schema-validated native value', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: { ready: true } }));

    await expect(invokeCommand('probe', {}, z.object({ ready: z.boolean() }))).resolves.toEqual({
      ok: true,
      value: { ready: true },
    });
  });

  it('maps malformed native payloads to INVALID_RESPONSE', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: { ready: 'yes' } }));

    await expect(invokeCommand('probe', {}, z.object({ ready: z.boolean() }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE', retryable: false },
    });
  });

  it('rejects unwrapped native values', async () => {
    setInvokeAdapterForTests(async () => ({ ready: true }));

    await expect(invokeCommand('probe', {}, z.object({ ready: z.boolean() }))).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    });
  });

  it('maps thrown adapter errors without parsing their text', async () => {
    setInvokeAdapterForTests(async () => {
      throw new Error('native details');
    });

    await expect(invokeCommand('probe', {}, z.object({ ready: z.boolean() }))).resolves.toEqual({
      ok: false,
      error: { code: 'UNKNOWN', message: 'Native command failed', retryable: true },
    });
  });

  it('keeps a state that is not a failure out of the error log, while still failing the call', async () => {
    const written: ErrorLogRecord[] = [];
    setErrorLogSinkForTests(async (records) => { written.push(...records); return true; });
    setInvokeAdapterForTests(async (command: string) => command === 'load_archive_metadata'
      ? { ok: false, error: { code: 'LRR_NOT_FOUND', message: '该档案已从 LANraragi 移除', retryable: false } }
      : { ok: false, error: { code: 'LRR_UNAUTHORIZED', message: '钥匙不对', retryable: false } });

    await expect(invokeCommand('load_archive_metadata', {}, z.object({}))).resolves.toMatchObject({
      ok: false,
      error: { code: 'LRR_NOT_FOUND' },
    });
    await expect(invokeCommand('list_archives', {}, z.object({}))).resolves.toMatchObject({
      ok: false,
      error: { code: 'LRR_UNAUTHORIZED' },
    });
    await flushErrorLog();

    // 「档案已经不在 LANraragi 上了」是**眼下的事实**，不是哪里坏了：档案详情页本来就会
    // 告诉用户「该档案已从 LANraragi 移除，本地索引已清理」。它照样按失败返回（调用方
    // 照旧分支），只是不往设置页那份错误日志里塞——日志是给人查现场的。
    expect(written.map((record) => record.source)).toEqual(['bridge/list_archives']);
    expect(written[0]!.message).toContain('LRR_UNAUTHORIZED');
  });

  it('reports explicit browser capabilities without user-agent detection', async () => {
    await expect(getPlatformCapabilities()).resolves.toMatchObject({
      ok: true,
      value: {
        platform: 'browser',
        native: false,
        secureStorage: false,
        fileSystem: false,
        backgroundTasks: false,
        nativeInference: false,
      },
    });
  });
});

it('returns network failures unchanged and writes them, including binary commands', async () => {
  const written: ErrorLogRecord[] = [];
  setErrorLogSinkForTests(async (records) => { written.push(...records); return true; });
  const failure = { ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } };
  setInvokeAdapterForTests(async () => failure);
  expect(await invokeCommand('probe', {}, z.string())).toEqual(failure);
  expect(await invokeBinaryCommand('image', {})).toEqual(failure);
  setInvokeAdapterForTests(async () => { throw new TypeError('Failed to fetch'); });
  expect(await invokeCommand('probe', {}, z.string())).toMatchObject({ ok: false });
  expect(await invokeBinaryCommand('image', {})).toMatchObject({ ok: false });
  await flushErrorLog();
  // 「连不上服务器」要留下现场（2026-10-15 复核）：两条 NETWORK 各写一条，界面照旧拿到
  // 原样的失败。静音名单只收「设计上会自己过去」的退让，不收传输故障。抛出来的 TypeError
  // 没有码，桥不替它编一个，所以不写。
  expect(written.map((record) => record.message)).toEqual(['NETWORK: offline', 'NETWORK: offline']);
});

it('retains remote protocol and engine diagnostics carried by REMOTE_UNAVAILABLE', async () => {
  const written: ErrorLogRecord[] = [];
  setErrorLogSinkForTests(async (records) => { written.push(...records); return true; });
  for (const message of ['capabilities JSON malformed', 'pairing JSON malformed', 'processing response was not an image', 'remote engine failed: GPU_OUTPUT_INVALID']) {
    const failure = { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message, retryable: true } };
    setInvokeAdapterForTests(async () => failure);
    expect(await invokeCommand('remote', {}, z.string())).toEqual(failure);
    expect(await invokeBinaryCommand('remote_image', {})).toEqual(failure);
  }
  await flushErrorLog();
  expect(written).toHaveLength(8);
  expect(written.every((record) => record.message.startsWith('REMOTE_UNAVAILABLE:'))).toBe(true);
});
