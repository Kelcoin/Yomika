import { describe, expect, it, vi } from 'vitest';
import { LrrHttpClient } from '../../src/services/lrrClient';

describe('LANraragi client contract', () => {
  it('gets archive metadata from the non-deprecated metadata endpoint', async () => {
    const id = 'a'.repeat(40);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      arcid: id, title: 'Archive', filename: 'a.zip', tags: 'artist:test', isnew: false,
      extension: 'zip', progress: 0, pagecount: 3, lastreadtime: 0, size: 10,
    }), { status: 200 }));
    const client = new LrrHttpClient({ baseUrl: 'https://library.test/', fetcher });

    const result = await client.getArchiveMetadata(id);

    expect(result).toMatchObject({ ok: true, value: { archiveId: id, pageCount: 3, title: 'Archive' } });
    expect(fetcher).toHaveBeenCalledWith(`https://library.test/api/archives/${id}/metadata`, expect.any(Object));
  });

  it('requests page bytes with required path query and preserves binary response', async () => {
    const id = 'a'.repeat(40);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetcher = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const client = new LrrHttpClient({ baseUrl: 'https://library.test/', fetcher });

    const result = await client.getArchivePage(id, '00.jpg');

    expect(result).toMatchObject({ ok: true, value: bytes.buffer });
    expect(fetcher).toHaveBeenCalledWith(`https://library.test/api/archives/${id}/page?path=00.jpg`, expect.any(Object));
  });

  it('gets archive file paths for reader page requests', async () => {
    const id = 'a'.repeat(40);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ pages: ['00.jpg', '01.jpg'], job: null }), { status: 200 }));
    const client = new LrrHttpClient({ baseUrl: 'https://library.test/', fetcher });

    const result = await client.getArchiveFiles(id);

    expect(result).toEqual({ ok: true, value: ['00.jpg', '01.jpg'] });
    expect(fetcher).toHaveBeenCalledWith(`https://library.test/api/archives/${id}/files`, expect.any(Object));
  });

  it('normalizes the base URL and sends API authentication', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: 'LANraragi', version: '0.9.40' }), { status: 200 }));
    const client = new LrrHttpClient({ baseUrl: 'https://library.test/', apiKey: 'secret', fetcher });

    const result = await client.getServerInfo();

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://library.test/api/info', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer c2VjcmV0' }),
    }));
  });

  it('sends search parameters in the query and validates archive metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ arcid: 'a'.repeat(40), title: 'Archive', filename: 'a.zip', tags: '', isnew: false, extension: 'zip', progress: 0, pagecount: 12, lastreadtime: 0, size: 10 }],
      recordsFiltered: 1,
      recordsTotal: 2,
    }), { status: 200 }));
    const client = new LrrHttpClient({ baseUrl: 'https://library.test', apiKey: 'secret', fetcher });

    const result = await client.searchArchives({ filter: 'artist:test', start: 20, sortBy: 'title', order: 'desc', newOnly: true });

    expect(result).toMatchObject({ ok: true, value: { recordsFiltered: 1, data: [{ archiveId: 'a'.repeat(40), pageCount: 12 }] } });
    expect(fetcher).toHaveBeenCalledWith(
      'https://library.test/api/search?filter=artist%3Atest&start=20&sortby=title&order=desc&newonly=true',
      expect.any(Object),
    );
  });

  it('treats an uninitialized search engine as retryable', async () => {
    const client = new LrrHttpClient({ baseUrl: 'https://library.test', fetcher: async () => new Response(null, { status: 204 }) });
    expect(await client.searchArchives({})).toMatchObject({ ok: false, error: { code: 'REMOTE_UNAVAILABLE', retryable: true } });
  });

  it.each([
    [401, 'LRR_UNAUTHORIZED', false],
    [404, 'LRR_NOT_FOUND', false],
    [429, 'REMOTE_RATE_LIMIT', true],
    [503, 'REMOTE_UNAVAILABLE', true],
  ] as const)('maps HTTP %s to %s', async (status, code, retryable) => {
    const client = new LrrHttpClient({ baseUrl: 'https://library.test', fetcher: async () => new Response('', { status }) });
    const result = await client.getServerInfo();
    expect(result).toMatchObject({ ok: false, error: { code, retryable } });
  });

  it('rejects malformed successful responses', async () => {
    const client = new LrrHttpClient({ baseUrl: 'https://library.test', fetcher: async () => new Response('{}', { status: 200 }) });
    expect(await client.getServerInfo()).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  });
});
