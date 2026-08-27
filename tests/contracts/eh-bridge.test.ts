import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { NativeEhRepository } from '../../src/repositories/nativeEhRepository';

afterEach(resetInvokeAdapterForTests);

describe('native EH account bridge', () => {
  it('saves and lists account metadata without exposing cookies', async () => {
    const account = { id: 'eh-a', label: 'EH', host: 'e-hentai.org', usernameHint: 'reader', cookieRef: 'eh-a-ref', isActive: true, status: 'unverified', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    const adapter = vi.fn(async (command: string) => command === 'save_eh_account' ? { ok: true, value: account } : { ok: true, value: [account] });
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.saveAccount({ id: 'eh-a', label: 'EH', host: 'e-hentai.org', usernameHint: 'reader', cookie: 'secret' })).toEqual({ ok: true, value: account });
    expect(await repository.listAccounts()).toEqual({ ok: true, value: [account] });
    expect(adapter).toHaveBeenNthCalledWith(1, 'save_eh_account', { input: { id: 'eh-a', label: 'EH', host: 'e-hentai.org', usernameHint: 'reader', cookie: 'secret' } });
    expect(JSON.stringify(account)).not.toContain('secret');
  });
});

describe('native EH search bridge', () => {
  it('searches galleries through the native bridge with typed params', async () => {
    const searchResponse = { galleries: [{ galleryKey: '12345', url: '/g/12345/abc/', title: 'Test Gallery', category: 'Doujinshi', uploader: 'author', pageCount: 10, tags: ['tag1'] }] };
    const adapter = vi.fn(async () => ({ ok: true, value: searchResponse }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.searchGalleries('eh-a', 'test query', { category: 2, page: 1 })).toEqual({ ok: true, value: searchResponse });
    expect(adapter).toHaveBeenCalledWith('search_eh_galleries', { accountId: 'eh-a', query: 'test query', params: { category: 2, page: 1 } });
  });

  it('returns error result when bridge returns error', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'Rate limit', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.searchGalleries('eh-a', 'query')).toEqual({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'Rate limit', retryable: true } });
  });
});

describe('native EH removeFavorite bridge', () => {
  it('removes a favorite through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: undefined }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.removeFavorite('eh-a', '12345', 'abcdef')).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('remove_eh_favorite', { accountId: 'eh-a', galleryId: '12345', token: 'abcdef' });
  });

  it('returns error result when removeFavorite bridge fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'EH_REAUTH_REQUIRED', message: 'Login required', retryable: false } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.removeFavorite('eh-a', '12345', 'abcdef')).toEqual({ ok: false, error: { code: 'EH_REAUTH_REQUIRED', message: 'Login required', retryable: false } });
  });
});

describe('native EH voteComment bridge', () => {
  it('votes on a comment through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: undefined }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.voteComment('eh-a', '12345', 'abcdef', '777', 1)).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('vote_eh_comment', { accountId: 'eh-a', galleryId: '12345', token: 'abcdef', commentId: '777', vote: 1 });
  });

  it('returns error result when voteComment bridge fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'Rate limit', retryable: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.voteComment('eh-a', '12345', 'abcdef', '777', -1)).toEqual({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'Rate limit', retryable: true } });
  });
});

describe('native EH login health check bridge', () => {
  it('checks login status through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: { loggedIn: true } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.checkLoginHealth('eh-a')).toEqual({ ok: true, value: { loggedIn: true } });
    expect(adapter).toHaveBeenCalledWith('check_eh_login_health', { accountId: 'eh-a' });
  });

  it('returns error result when login health check bridge fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'EH_CLOUDFLARE', message: 'Cloudflare blocked', retryable: false } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.checkLoginHealth('eh-a')).toEqual({ ok: false, error: { code: 'EH_CLOUDFLARE', message: 'Cloudflare blocked', retryable: false } });
  });
});

describe('native EH account switching bridge', () => {
  it('sets an account as active through the native bridge', async () => {
    const adapter = vi.fn(async () => ({ ok: true, value: undefined }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.setActiveAccount('eh-b')).toEqual({ ok: true, value: undefined });
    expect(adapter).toHaveBeenCalledWith('set_active_eh_account', { accountId: 'eh-b' });
  });

  it('returns error result when account switching fails', async () => {
    const adapter = vi.fn(async () => ({ ok: false, error: { code: 'UNKNOWN', message: 'Account not found', retryable: false } }));
    setInvokeAdapterForTests(adapter);
    const repository = new NativeEhRepository();
    expect(await repository.setActiveAccount('nonexistent')).toEqual({ ok: false, error: { code: 'UNKNOWN', message: 'Account not found', retryable: false } });
  });
});
