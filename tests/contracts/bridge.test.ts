import { z } from 'zod';

import {
  invokeCommand,
  resetInvokeAdapterForTests,
  setInvokeAdapterForTests,
} from '../../src/bridge/invoke';
import { getPlatformCapabilities } from '../../src/bridge/platform';

afterEach(() => {
  resetInvokeAdapterForTests();
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
