import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { invokeCommand, resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../src/bridge/invoke';
import * as errorLog from '../src/lib/errorLog';

afterEach(() => { resetInvokeAdapterForTests(); vi.restoreAllMocks(); });
it('keeps expected native authentication failures out of diagnostic logs', async () => {
  const logged = vi.spyOn(errorLog, 'logError');
  setInvokeAdapterForTests(async () => ({ ok: false, error: { code: 'APP_SECURITY_AUTH', message: '密码不正确', retryable: true } }));
  const result = await invokeCommand('app_security_unlock_password', { password: 'secret' }, z.unknown());
  expect(result.ok).toBe(false);
  expect(logged).not.toHaveBeenCalled();
});
it.each(['domain', 'throw', 'schema', 'envelope'])('does not log credentials from security %s failures', async (failure) => {
  const secret = 'private-passphrase-981';
  const logged = vi.spyOn(errorLog, 'logError');
  setInvokeAdapterForTests(async () => {
    if (failure === 'throw') throw new Error(secret);
    if (failure === 'domain') return { ok: false, error: { code: 'INVALID_INPUT', message: secret, retryable: false } };
    return failure === 'schema' ? { ok: true, value: secret } : { unexpected: secret };
  });
  await invokeCommand('app_security_configure', { config: { currentPassword: secret, password: secret } }, z.object({ locked: z.boolean() }));
  expect(logged).toHaveBeenCalled();
  expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
});
