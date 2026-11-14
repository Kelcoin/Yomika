import { afterEach, describe, expect, it } from 'vitest';

import { findMissingArchives, resetArchiveExistenceForTests } from '../../src/lib/archiveExistence';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';

/** One native call, as the verifier makes it. */
function adapter(answer: (archiveIds: string[]) => { missing?: string[]; fail?: boolean }) {
  const calls: string[][] = [];
  setInvokeAdapterForTests(async (command, args) => {
    if (command !== 'verify_archives_exist') return { ok: true, value: null };
    const archiveIds = (args?.archiveIds ?? []) as string[];
    calls.push(archiveIds);
    const reply = answer(archiveIds);
    if (reply.fail) return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: 'offline', retryable: true } };
    return { ok: true, value: reply.missing ?? [] };
  });
  return calls;
}

describe('archive existence', () => {
  afterEach(() => {
    resetInvokeAdapterForTests();
    resetArchiveExistenceForTests();
  });

  it('checks a shelf in bounded batches instead of only its first page', async () => {
    // Every id costs one request, so the budget is real — but a shelf longer than
    // one batch has to keep going, or the ids past the cap are never looked at and
    // the card that fails is always one of those.
    const calls = adapter(() => ({ missing: ['gone-64', 'gone-200'] }));
    const ids = Array.from({ length: 200 }, (_, index) => `arch-${index}`);

    const missing = await findMissingArchives('server-a', ids);

    expect(calls.map((batch) => batch.length)).toEqual([64, 64, 64]);
    expect(calls[0]?.[0]).toBe('arch-0');
    expect(calls[2]?.[0]).toBe('arch-128');
    expect(missing).toEqual(new Set(['gone-64', 'gone-200']));
  });

  it('remembers the answers for the session so a second visit finishes the shelf', async () => {
    const calls = adapter(() => ({ missing: [] }));
    const ids = Array.from({ length: 200 }, (_, index) => `arch-${index}`);

    await findMissingArchives('server-a', ids);
    expect(calls).toHaveLength(3);

    // The same visit again asks about the eight it did not reach, not the 192 it did.
    calls.length = 0;
    await findMissingArchives('server-a', ids);
    expect(calls.map((batch) => batch.length)).toEqual([8]);
    expect(calls[0]?.[0]).toBe('arch-192');
  });

  it('counts a batch as checked only when the server answered', async () => {
    // An unreachable server is not a deletion, and it is not an answer either: the
    // ids have to be asked about again rather than remembered as verified.
    let attempt = 0;
    const calls = adapter(() => {
      attempt += 1;
      return attempt === 1 ? { fail: true } : { missing: ['arch-1'] };
    });

    expect(await findMissingArchives('server-a', ['arch-0', 'arch-1'])).toEqual(new Set());
    expect(calls).toHaveLength(1);

    expect(await findMissingArchives('server-a', ['arch-0', 'arch-1'])).toEqual(new Set(['arch-1']));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['arch-0', 'arch-1']);
  });

  it('does nothing without a server', async () => {
    const calls = adapter(() => ({ missing: [] }));
    expect(await findMissingArchives('', ['arch-0'])).toEqual(new Set());
    expect(calls).toHaveLength(0);
  });
});
