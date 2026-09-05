import { describe, expect, it, afterEach } from 'vitest';

import { invokeCommand, resetInvokeAdapterForTests, setInvokeAdapterForTests, VoidResponseSchema } from '../../src/bridge/invoke';

afterEach(resetInvokeAdapterForTests);

describe('void command responses', () => {
  it('accepts the JSON null a Rust CommandResult<()> actually sends', async () => {
    // `serde` writes `()` as `null`, so validating a void command with
    // `z.undefined()` rejected every real reply as INVALID_RESPONSE — while the
    // test adapters, which answer with a literal `undefined`, passed. That is why
    // opening the E-Hentai sign-in window failed with "Native command returned an
    // invalid response" and nothing ever closed the window.
    setInvokeAdapterForTests(async () => ({ ok: true, value: null }));
    await expect(invokeCommand('open_eh_login_window', {}, VoidResponseSchema))
      .resolves.toEqual({ ok: true, value: undefined });
  });

  it('still accepts an absent value', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: undefined }));
    await expect(invokeCommand('close_eh_login_window', {}, VoidResponseSchema))
      .resolves.toEqual({ ok: true, value: undefined });
  });

  it('does not swallow a value that should have been checked', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: { unexpected: true } }));
    const result = await invokeCommand('close_eh_login_window', {}, VoidResponseSchema);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  });
});
