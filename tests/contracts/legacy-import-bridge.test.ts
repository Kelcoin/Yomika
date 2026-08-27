import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeLegacyRepository } from '../../src/repositories/nativeLegacyRepository';

afterEach(resetInvokeAdapterForTests);

describe('legacy import bridge', () => {
  it('passes scope and raw export to atomic native importer', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: 3 }));
    setInvokeAdapterForTests(adapter);
    expect(await new NativeLegacyRepository().importExport('scope-a', '{}')).toEqual({ ok: true, value: 3 });
    expect(adapter).toHaveBeenCalledWith('import_legacy_export', { input: { scopeId: 'scope-a', serialized: '{}' } });
  });
});
