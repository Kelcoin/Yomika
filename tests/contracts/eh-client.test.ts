import { describe, expect, it, vi } from 'vitest';

import { EhCookieJar, EhHttpClient, classifyEhResponse, parseEhComments, parseEhGallery, parseEhSearchResults } from '../../src/services/ehClient';

describe('EH HTTP boundary', () => {
  it('classifies login, rate limit, Cloudflare and deleted gallery responses', () => {
    expect(classifyEhResponse(200, 'You are logged in')).toEqual({ kind: 'ok' });
    expect(classifyEhResponse(403, 'cf-chl-captcha')).toEqual({ kind: 'cloudflare', retryable: false, reauthRequired: false });
    expect(classifyEhResponse(429, 'too many requests')).toEqual({ kind: 'rate_limit', retryable: true, reauthRequired: false });
    expect(classifyEhResponse(404, 'gallery does not exist')).toEqual({ kind: 'gallery_deleted', retryable: false, reauthRequired: false });
  });

  it('prioritizes copyright removal over the generic 404 classification', () => {
    const body = '<title>Gallery Not Available</title><p>This gallery is unavailable due to a copyright claim by FAKKU.</p>';
    expect(classifyEhResponse(404, body)).toEqual({ kind: 'gallery_copyright_removed', retryable: false, reauthRequired: false });
    expect(classifyEhResponse(200, body)).toEqual({ kind: 'gallery_copyright_removed', retryable: false, reauthRequired: false });
    expect(classifyEhResponse(404, 'This gallery was removed at the request of the copyright holder.')).toEqual({ kind: 'gallery_copyright_removed', retryable: false, reauthRequired: false });
  });

  it('recognizes Worker non-gallery pages regardless of their HTTP status', () => {
    expect(classifyEhResponse(200, '<title>Just a moment...</title>')).toEqual({ kind: 'cloudflare', retryable: false, reauthRequired: false });
    expect(classifyEhResponse(200, '<title>Login</title><p>Please login</p>')).toEqual({ kind: 'unauthorized', retryable: false, reauthRequired: true });
    expect(classifyEhResponse(200, '<h1>Content Warning</h1><p>You are seeing this page because this gallery contains content that may be objectionable.</p>')).toEqual({ kind: 'content_warning', retryable: false, reauthRequired: true });
    expect(classifyEhResponse(403, 'Access Denied')).toEqual({ kind: 'access_blocked', retryable: false, reauthRequired: false });
    expect(classifyEhResponse(200, '<title>Gallery Not Found</title>')).toEqual({ kind: 'gallery_deleted', retryable: false, reauthRequired: false });
  });

  it('injects cookies only for matching EH host and filters temporary values', () => {
    const jar = new EhCookieJar();
    jar.setFromHeader('e-hentai.org', 'igneous=mystery; Path=/');
    jar.setFromHeader('e-hentai.org', 'ipb_member_id=42; Path=/');
    jar.setFromHeader('exhentai.org', 'igneous=abc; Path=/');
    expect(jar.headerFor('e-hentai.org')).toBe('ipb_member_id=42');
    expect(jar.headerFor('other.example')).toBe('');
  });

  it('returns stable domain errors and updates scoped cookies', async () => {
    const jar = new EhCookieJar();
    const calls: RequestInit[] = [];
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org',
      cookieJar: jar,
      fetcher: async (_url, init) => {
        calls.push(init ?? {});
        return new Response('<html>gallery does not exist</html>', {
          status: 404,
          headers: { 'set-cookie': 'ipb_session_id=session-1; Path=/' },
        });
      },
    });
    const result = await client.loginProbe();
    expect(result).toEqual({ ok: false, error: { code: 'EH_GALLERY_DELETED', message: 'E-Hentai gallery was deleted or not found', retryable: false } });
    expect(calls[0]?.headers).toEqual({});
    expect(jar.headerFor('e-hentai.org')).toBe('ipb_session_id=session-1');
  });

  it('detects logged-in state from logout link in response', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('<html><a href="?showlogout=1">Logout</a></html>', { status: 200 }),
    });
    const result = await client.loginProbe();
    expect(result).toEqual({ ok: true, value: { loggedIn: true } });
  });

  it('detects logged-out state when no login indicator present', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('<html><a href="login.php">Login</a></html>', { status: 200 }),
    });
    const result = await client.loginProbe();
    expect(result).toEqual({ ok: true, value: { loggedIn: false } });
  });

  it('returns domain errors for failed login probe requests', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('rate limit', { status: 429 }),
    });
    const result = await client.loginProbe();
    expect(result).toEqual({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'E-Hentai rate limit reached', retryable: true } });
  });

  it('parses gallery detail into a safe domain model without returning HTML', () => {
    const result = parseEhGallery(`
      <html><h1 id="gn">English title</h1><h1 id="gj">日本語タイトル</h1>
      <div id="gdn">Uploader</div><div id="gdc">Manga</div>
      <div id="gdd">Length: 24 pages</div><div id="taglist"><a>artist:foo</a><a>language:english</a></div>
      <script>alert('x')</script></html>`, 'https://e-hentai.org/g/123/abcdef/');
    expect(result).toEqual({
      galleryKey: '123', url: 'https://e-hentai.org/g/123/abcdef/', title: 'English title',
      japaneseTitle: '日本語タイトル', uploader: 'Uploader', category: 'Manga', pageCount: 24,
      tags: ['artist:foo', 'language:english'],
    });
    expect(JSON.stringify(result)).not.toContain('<script>');
  });

  it('fetches and parses gallery details through the scoped client', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('<h1 id="gn">Title</h1><h1 id="gj"></h1><div id="gdd">Length: 2 pages</div>', { status: 200 }),
    });
    const result = await client.getGallery('https://e-hentai.org/g/123/abcdef/');
    expect(result.ok && result.value.pageCount).toBe(2);
  });

  it('fetches comments through the scoped gallery request', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('<div class="c1" id="c7"><div class="c3"><a>Bob</a></div><div class="c6">Hello</div></div>', { status: 200 }),
    });
    await expect(client.getComments('https://e-hentai.org/g/123/abcdef/')).resolves.toEqual({
      ok: true, value: [{ id: '7', author: 'Bob', body: 'Hello', score: 0, postedAt: '', isUploader: false, isEditable: false, myVote: 0 }],
    });
  });

  it('returns a specific error for a copyright-removal comments page', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('<p>This gallery is unavailable due to a copyright claim by FAKKU.</p>', { status: 404 }),
    });
    await expect(client.getComments('https://e-hentai.org/g/2793202/0b248815aa/')).resolves.toEqual({
      ok: false,
      error: { code: 'EH_GALLERY_COPYRIGHT_REMOVED', message: 'E-Hentai gallery was removed due to a copyright claim', retryable: false },
    });
  });

  it('distinguishes an empty page response from a valid empty POST response', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('', { status: 200 }),
    });
    await expect(client.getGallery('https://e-hentai.org/g/123/abcdef/')).resolves.toEqual({
      ok: false,
      error: { code: 'EH_EMPTY_RESPONSE', message: 'E-Hentai returned an empty response', retryable: true },
    });
  });

  it('parses comments into safe text models with scores', () => {
    const comments = parseEhComments(`<div class="c1" id="c100"><div class="c3"><a>Alice</a></div><div class="c5"><b>+12</b></div><div class="c6">Hello <script>alert(1)</script><a href="javascript:bad">link</a></div></div>`);
    expect(comments).toEqual([{ id: '100', author: 'Alice', body: 'Hello alert(1)link', score: 12, postedAt: '', isUploader: false, isEditable: false, myVote: 0 }]);
    expect(JSON.stringify(comments)).not.toContain('<script>');
  });

  it('posts favorite changes only to scoped EH host', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher: async (url, init) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return new Response('OK', { status: 200 }); } });
    expect(await client.setFavorite('123', 'abcdef', 2, 'note')).toEqual({ ok: true, value: undefined });
    expect(calls[0]?.url).toBe('https://e-hentai.org/gallerypopups.php');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(String(calls[0]?.init?.body)).toContain('favcat=2');
  });

  it('posts a comment form only to a caller-provided scoped EH action URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher: async (url, init) => { calls.push({ url: String(url), ...(init ? { init } : {}) }); return new Response('OK', { status: 200 }); } });
    expect(await client.postComment('https://e-hentai.org/comment', { gid: '123', comment: 'hello' })).toEqual({ ok: true, value: undefined });
    expect(calls[0]?.url).toBe('https://e-hentai.org/comment');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded', Cookie: '' });
    expect(String(calls[0]?.init?.body)).toContain('comment=hello');
  });

  it('rejects comment actions on another host before network access', async () => {
    const fetcher = vi.fn(async () => new Response('OK', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.postComment('https://exhentai.org/comment', { comment: 'hello' })).toEqual({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'E-Hentai URL host mismatch', retryable: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('parses search results from EH search page HTML into safe gallery list', () => {
    const html = `
      <html><body>
        <table id="gdt">
          <div class="glg">
            <div class="glc"><div class="gl3"><a href="https://e-hentai.org/g/1111/aaa/">Title One</a></div>
            <div class="gl4"><span class="gl5">Manga</span><div class="gl6">Uploader A</div><div class="gl7">24 pages</div></div>
            <div class="gltags"><a>artist:foo</a><a>language:english</a></div>
            </div>
          </div>
          <div class="glg">
            <div class="glc"><div class="gl3"><a href="https://e-hentai.org/g/2222/bbb/">Title Two</a></div>
            <div class="gl4"><span class="gl5">Doujinshi</span><div class="gl6">Uploader B</div><div class="gl7">12 pages</div></div>
            <div class="gltags"><a>parody:fate</a></div>
            </div>
          </div>
        </table>
        <div id="lastlink">Next</div>
      </body></html>`;
    const results = parseEhSearchResults(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      galleryKey: '1111', url: 'https://e-hentai.org/g/1111/aaa/', title: 'Title One',
      category: 'Manga', uploader: 'Uploader A', pageCount: 24,
      tags: ['artist:foo', 'language:english'],
    });
    expect(results[1]!.galleryKey).toBe('2222');
    expect(JSON.stringify(results)).not.toContain('<script>');
  });

  it('extracts total result count and current page from search results', () => {
    const html = `<html><body>
      <table id="gdt"><div class="glg"><div class="glc"><div class="gl3"><a href="https://e-hentai.org/g/1/x/">X</a></div>
      <div class="gl4"><span class="gl5">Manga</span><div class="gl6">U</div><div class="gl7">1 pages</div></div></div></div></table>
      <div id="dms">Search took 0.1 seconds (1 results found)</div>
    </body></html>`;
    const parsed = parseEhSearchResults(html);
    expect(parsed).toHaveLength(1);
  });

  it('searches galleries through the scoped client with correct query params', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(`<table id="gdt"><div class="glg"><div class="glc"><div class="gl3"><a href="https://e-hentai.org/g/1/x/">Found</a></div>
          <div class="gl4"><span class="gl5">Manga</span><div class="gl6">U</div><div class="gl7">5 pages</div></div></div></div></table>`, { status: 200 });
      },
    });
    const result = await client.searchGalleries('fate grand order', { category: 2, page: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.galleries).toHaveLength(1);
      expect(result.value.galleries[0]!.title).toBe('Found');
    }
    expect(calls[0]?.url).toContain('f_search=fate+grand+order');
    expect(calls[0]?.url).toContain('f_cat=2');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('rejects search on mismatched host before network access', async () => {
    const fetcher = vi.fn(async () => new Response('OK', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://exhentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.searchGalleries('https://e-hentai.org/g/1234/abc/')).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'E-Hentai search requires the same host as the client', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects search with empty query before network access', async () => {
    const fetcher = vi.fn(async () => new Response('OK', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.searchGalleries('')).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'E-Hentai search query must not be empty', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns domain errors for failed search requests', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('not logged in', { status: 401 }),
    });
    const result = await client.searchGalleries('test');
    expect(result).toEqual({ ok: false, error: { code: 'EH_REAUTH_REQUIRED', message: 'E-Hentai login is required', retryable: false } });
  });

  it('removes a favorite via POST with deletefav action', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    const result = await client.removeFavorite('12345', 'abcdef');
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('gallerypopups.php');
    const body = new URLSearchParams(calls[0]?.init?.body as string);
    expect(body.get('act')).toBe('deletefav');
    expect(body.get('gid')).toBe('12345');
    expect(body.get('t')).toBe('abcdef');
  });

  it('rejects removeFavorite with invalid galleryId before network access', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.removeFavorite('not-a-number', 'abc')).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid E-Hentai favorite input', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects removeFavorite with invalid token before network access', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.removeFavorite('12345', 'zzz!')).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid E-Hentai favorite input', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns domain errors for failed removeFavorite requests', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('rate limit', { status: 429 }),
    });
    const result = await client.removeFavorite('12345', 'abc');
    expect(result).toEqual({ ok: false, error: { code: 'EH_RATE_LIMIT', message: 'E-Hentai rate limit reached', retryable: true } });
  });

  it('votes on a comment via POST with votecomment action', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    const result = await client.voteComment('12345', 'abcdef', '777', 1);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('gallerypopups.php');
    const body = new URLSearchParams(calls[0]?.init?.body as string);
    expect(body.get('act')).toBe('votecomment');
    expect(body.get('gid')).toBe('12345');
    expect(body.get('t')).toBe('abcdef');
    expect(body.get('comment_id')).toBe('777');
    expect(body.get('comment_vote')).toBe('1');
    expect(body.get('ac')).toBeNull();
    expect(body.get('vote')).toBeNull();
  });

  it('rejects voteComment with invalid galleryId before network access', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.voteComment('not-a-number', 'abc', '777', 1)).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid E-Hentai vote input', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects voteComment with invalid vote value before network access', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const client = new EhHttpClient({ baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(), fetcher });
    expect(await client.voteComment('12345', 'abc', '777', 5)).toEqual({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'Invalid E-Hentai vote input', retryable: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns domain errors for failed voteComment requests', async () => {
    const client = new EhHttpClient({
      baseUrl: 'https://e-hentai.org', cookieJar: new EhCookieJar(),
      fetcher: async () => new Response('not logged in', { status: 401 }),
    });
    const result = await client.voteComment('12345', 'abc', '777', 1);
    expect(result).toEqual({ ok: false, error: { code: 'EH_REAUTH_REQUIRED', message: 'E-Hentai login is required', retryable: false } });
  });
});
