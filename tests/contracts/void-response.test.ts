import { describe, expect, it, afterEach } from 'vitest';

import { invokeCommand, resetInvokeAdapterForTests, setInvokeAdapterForTests, VoidResponseSchema } from '../../src/bridge/invoke';
import { NativeInferenceRepository } from '../../src/repositories/nativeInferenceRepository';

afterEach(resetInvokeAdapterForTests);

describe('void command responses', () => {
  it.each([
    'MODEL_MANIFEST_FETCH_FAILED', 'INVALID_MANIFEST', 'INVALID_INPUT',
    'MODEL_ALREADY_EXISTS', 'MODEL_DOWNLOAD_FAILED', 'INVALID_MODEL_IMPORT', 'MODEL_ACTIVATION_FAILED',
  ])('preserves model failure details for %s', async (code) => {
    const error = { code, message: 'Model operation failed', retryable: true };
    setInvokeAdapterForTests(async () => ({ ok: false, error }));
    await expect(new NativeInferenceRepository().validateReleaseManifest({}))
      .resolves.toEqual({ ok: false, error });
  });

  it('accepts real Rust null responses for model release operations', async () => {
    setInvokeAdapterForTests(async () => ({ ok: true, value: null }));
    const repository = new NativeInferenceRepository();
    const operations = [
      repository.validateReleaseManifest({}),
      repository.downloadReleaseAsset({ url: 'https://example.com/model', asset: {}, destination: 'models' }),
      repository.downloadModelBundle({ prefix: '', ownerRepo: 'Kelcoin/Yomika', manifest: {}, destination: 'models' }),
      repository.validateModelImport('models', {}),
      repository.cancelReleaseDownload('models'),
      repository.validateModelArchive([], {}),
      repository.activateModelDirectory('staging', 'models'),
      repository.validateLocalModel('models', {}),
    ];
    for (const operation of operations) {
      await expect(operation).resolves.toEqual({ ok: true, value: undefined });
    }
  });

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
