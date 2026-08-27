import { err, ok, type CommandResult } from '../domain/result';
import type { DomainErrorCode } from '../domain/errors';

export type EhResponseClassification =
  | { kind: 'ok' }
  | { kind: 'cloudflare'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'rate_limit'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'unauthorized'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'gallery_deleted'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'unavailable'; retryable: boolean; reauthRequired: boolean };

const TEMPORARY_COOKIES = new Set(['__utmp', 'igneous']);

export interface EhGallery {
  galleryKey: string;
  url: string;
  title: string;
  japaneseTitle: string;
  uploader: string;
  category: string;
  pageCount: number;
  tags: string[];
}

export interface EhComment { id: string; author: string; body: string; score: number; }

export interface EhSearchResult {
  galleryKey: string;
  url: string;
  title: string;
  category: string;
  uploader: string;
  pageCount: number;
  tags: string[];
}

export interface EhSearchParams {
  category?: number;
  page?: number;
}

export interface EhSearchResponse {
  galleries: EhSearchResult[];
}

export function parseEhComments(html: string): EhComment[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return [...document.querySelectorAll('.c1[id]')].map((node) => {
    const rawId = node.id;
    const scoreText = node.querySelector('.c5')?.textContent?.trim() ?? '0';
    return {
      id: rawId.replace(/^c/, ''),
      author: node.querySelector('.c3 a')?.textContent?.trim() ?? '',
      body: node.querySelector('.c6')?.textContent?.trim() ?? '',
      score: Number(scoreText.match(/[+-]?\d+/)?.[0] ?? 0),
    };
  }).filter((comment) => comment.id.length > 0);
}

export function parseEhSearchResults(html: string): EhSearchResult[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const entries = [...document.querySelectorAll('.glg')];
  return entries.map((entry) => {
    const link = entry.querySelector('.gl3 a');
    const href = link?.getAttribute('href') ?? '';
    const title = link?.textContent?.trim() ?? '';
    const category = entry.querySelector('.gl5')?.textContent?.trim() ?? '';
    const uploader = entry.querySelector('.gl6')?.textContent?.trim() ?? '';
    const pageText = entry.querySelector('.gl7')?.textContent?.trim() ?? '';
    const pageCount = Number(pageText.match(/(\d[\d,]*)\s*pages?/i)?.[1]?.replaceAll(',', '') ?? 0);
    const tags = [...(entry.querySelectorAll('.gltags a'))]
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean);
    const match = href.match(/\/g\/(\d+)\//);
    return {
      galleryKey: match?.[1] ?? '',
      url: href,
      title,
      category,
      uploader,
      pageCount,
      tags,
    };
  }).filter((result) => result.galleryKey.length > 0 && result.title.length > 0);
}

export function parseEhGallery(html: string, url: string): EhGallery {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? '';
  const match = new URL(url).pathname.match(/\/g\/([^/]+)\//);
  const pageText = text('#gdd');
  const pageCount = Number(pageText.match(/(\d[\d,]*)\s*pages?/i)?.[1]?.replaceAll(',', '') ?? 0);
  const tags = [...document.querySelectorAll('#taglist a')]
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean);
  return {
    galleryKey: match?.[1] ?? '',
    url,
    title: text('#gn'),
    japaneseTitle: text('#gj'),
    uploader: text('#gdn'),
    category: text('#gdc'),
    pageCount,
    tags,
  };
}

export class EhCookieJar {
  private readonly cookies = new Map<string, Map<string, string>>();

  setFromHeader(host: string, header: string): void {
    const first = header.split(';', 1)[0] ?? '';
    const separator = first.indexOf('=');
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!name || TEMPORARY_COOKIES.has(name)) return;
    const hostCookies = this.cookies.get(host) ?? new Map<string, string>();
    if (!value) hostCookies.delete(name);
    else hostCookies.set(name, value);
    this.cookies.set(host, hostCookies);
  }

  headerFor(host: string): string {
    return [...(this.cookies.get(host)?.entries() ?? [])]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

export function classifyEhResponse(status: number, body: string): EhResponseClassification {
  const normalized = body.toLowerCase();
  if (status === 429 || normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return { kind: 'rate_limit', retryable: true, reauthRequired: false };
  }
  if (status === 403 && (normalized.includes('cloudflare') || normalized.includes('cf-chl') || normalized.includes('captcha'))) {
    return { kind: 'cloudflare', retryable: false, reauthRequired: false };
  }
  if (status === 401 || normalized.includes('not logged in') || normalized.includes('login required')) {
    return { kind: 'unauthorized', retryable: false, reauthRequired: true };
  }
  if (status === 404 || normalized.includes('gallery does not exist') || normalized.includes('gallery has been removed')) {
    return { kind: 'gallery_deleted', retryable: false, reauthRequired: false };
  }
  if (status >= 500 || status < 200) return { kind: 'unavailable', retryable: true, reauthRequired: false };
  return { kind: 'ok' };
}

interface EhHttpClientOptions {
  baseUrl: string;
  cookieJar: EhCookieJar;
  fetcher?: typeof fetch;
}

export class EhHttpClient {
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly cookieJar: EhCookieJar;
  private readonly fetcher: typeof fetch;

  constructor(options: EhHttpClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid EH URL');
    this.baseUrl = url.origin;
    this.host = url.hostname;
    this.cookieJar = options.cookieJar;
    this.fetcher = options.fetcher ?? fetch;
  }

  async loginProbe(signal?: AbortSignal): Promise<CommandResult<{ loggedIn: boolean }>> {
    try {
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = cookie ? { Cookie: cookie } : {};
      const response = await this.fetcher(`${this.baseUrl}/`, { headers, ...(signal ? { signal } : {}) });
      const body = await response.text();
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookieJar.setFromHeader(this.host, setCookie);
      const classification = classifyEhResponse(response.status, body);
      if (classification.kind === 'ok') return ok({ loggedIn: /logged\s+in|logout/i.test(body) });
      return err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async getGallery(url: string, signal?: AbortSignal): Promise<CommandResult<EhGallery>> {
    try {
      const target = new URL(url);
      if (target.hostname !== this.host) return err('INVALID_RESPONSE', 'E-Hentai URL host mismatch', false);
      const cookie = this.cookieJar.headerFor(this.host);
      const response = await this.fetcher(target.toString(), { headers: cookie ? { Cookie: cookie } : {}, ...(signal ? { signal } : {}) });
      const body = await response.text();
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookieJar.setFromHeader(this.host, setCookie);
      const classification = classifyEhResponse(response.status, body);
      if (classification.kind !== 'ok') return err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
      const gallery = parseEhGallery(body, target.toString());
      return gallery.galleryKey ? ok(gallery) : err('INVALID_RESPONSE', 'Invalid E-Hentai gallery page', false);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async getComments(url: string, signal?: AbortSignal): Promise<CommandResult<EhComment[]>> {
    try {
      const target = new URL(url);
      if (target.hostname !== this.host) return err('INVALID_RESPONSE', 'E-Hentai URL host mismatch', false);
      const cookie = this.cookieJar.headerFor(this.host);
      const response = await this.fetcher(target.toString(), { headers: cookie ? { Cookie: cookie } : {}, ...(signal ? { signal } : {}) });
      const body = await response.text();
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookieJar.setFromHeader(this.host, setCookie);
      const classification = classifyEhResponse(response.status, body);
      if (classification.kind !== 'ok') return err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
      return ok(parseEhComments(body));
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async postComment(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<CommandResult<void>> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return err('INVALID_RESPONSE', 'Invalid E-Hentai comment action URL', false);
    }
    if (target.hostname !== this.host) return err('INVALID_RESPONSE', 'E-Hentai URL host mismatch', false);
    const entries = Object.entries(fields).filter(([name, value]) => name.trim().length > 0 && typeof value === 'string');
    if (entries.length === 0 || entries.some(([name]) => name.trim().length === 0)) {
      return err('INVALID_RESPONSE', 'E-Hentai comment form is empty', false);
    }
    try {
      const body = new URLSearchParams(entries);
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie };
      const response = await this.fetcher(target.toString(), { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
      const responseBody = await response.text();
      const classification = classifyEhResponse(response.status, responseBody);
      return classification.kind === 'ok' ? ok(undefined) : err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async voteComment(galleryId: string, token: string, commentId: string, vote: number, signal?: AbortSignal): Promise<CommandResult<void>> {
    if (!/^\d+$/.test(galleryId) || !/^[a-f0-9]+$/i.test(token) || !/^\d+$/.test(commentId) || (vote !== 1 && vote !== -1)) {
      return err('INVALID_RESPONSE', 'Invalid E-Hentai vote input', false);
    }
    try {
      const body = new URLSearchParams({ gid: galleryId, t: token, ac: commentId, act: 'votecomment', vote: String(vote) });
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) };
      const response = await this.fetcher(`${this.baseUrl}/gallerypopups.php`, { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
      const text = await response.text();
      const classification = classifyEhResponse(response.status, text);
      return classification.kind === 'ok' ? ok(undefined) : err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async searchGalleries(query: string, params?: EhSearchParams, signal?: AbortSignal): Promise<CommandResult<EhSearchResponse>> {
    if (!query.trim()) return err('INVALID_RESPONSE', 'E-Hentai search query must not be empty', false);
    const trimmed = query.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        if (new URL(trimmed).hostname !== this.host) {
          return err('INVALID_RESPONSE', 'E-Hentai search requires the same host as the client', false);
        }
      } catch { return err('INVALID_RESPONSE', 'E-Hentai search query contains an invalid URL', false); }
    }
    try {
      const searchUrl = new URL(this.baseUrl);
      searchUrl.searchParams.set('f_search', query.trim());
      if (params?.category !== undefined) searchUrl.searchParams.set('f_cat', String(params.category));
      if (params?.page !== undefined) searchUrl.searchParams.set('page', String(params.page));
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = cookie ? { Cookie: cookie } : {};
      const response = await this.fetcher(searchUrl.toString(), { headers, ...(signal ? { signal } : {}) });
      const body = await response.text();
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookieJar.setFromHeader(this.host, setCookie);
      const classification = classifyEhResponse(response.status, body);
      if (classification.kind !== 'ok') return err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
      return ok({ galleries: parseEhSearchResults(body) });
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async setFavorite(galleryId: string, token: string, category: number, note: string, signal?: AbortSignal): Promise<CommandResult<void>> {
    if (!/^\d+$/.test(galleryId) || !/^[a-f0-9]+$/i.test(token) || !Number.isInteger(category) || category < 0 || category > 9) {
      return err('INVALID_RESPONSE', 'Invalid E-Hentai favorite input', false);
    }
    try {
      const body = new URLSearchParams({ gid: galleryId, t: token, act: 'addfav', favcat: String(category), favnote: note, apply: 'Apply Changes' });
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) };
      const response = await this.fetcher(`${this.baseUrl}/gallerypopups.php`, { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
      const text = await response.text();
      const classification = classifyEhResponse(response.status, text);
      return classification.kind === 'ok' ? ok(undefined) : err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  async removeFavorite(galleryId: string, token: string, signal?: AbortSignal): Promise<CommandResult<void>> {
    if (!/^\d+$/.test(galleryId) || !/^[a-f0-9]+$/i.test(token)) {
      return err('INVALID_RESPONSE', 'Invalid E-Hentai favorite input', false);
    }
    try {
      const body = new URLSearchParams({ gid: galleryId, t: token, act: 'deletefav' });
      const cookie = this.cookieJar.headerFor(this.host);
      const headers: HeadersInit = { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) };
      const response = await this.fetcher(`${this.baseUrl}/gallerypopups.php`, { method: 'POST', headers, body, ...(signal ? { signal } : {}) });
      const text = await response.text();
      const classification = classifyEhResponse(response.status, text);
      return classification.kind === 'ok' ? ok(undefined) : err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
    } catch (cause) {
      return err('EH_UNAVAILABLE', cause instanceof Error ? cause.message : 'E-Hentai request failed', true);
    }
  }

  private errorCode(kind: Exclude<EhResponseClassification, { kind: 'ok' }>['kind']): DomainErrorCode {
    if (kind === 'gallery_deleted') return 'EH_GALLERY_DELETED';
    if (kind === 'unauthorized') return 'EH_REAUTH_REQUIRED';
    if (kind === 'rate_limit') return 'EH_RATE_LIMIT';
    if (kind === 'cloudflare') return 'EH_CLOUDFLARE';
    return 'EH_UNAVAILABLE';
  }

  private errorMessage(kind: Exclude<EhResponseClassification, { kind: 'ok' }>['kind']): string {
    if (kind === 'gallery_deleted') return 'E-Hentai gallery was deleted or not found';
    if (kind === 'unauthorized') return 'E-Hentai login is required';
    if (kind === 'rate_limit') return 'E-Hentai rate limit reached';
    if (kind === 'cloudflare') return 'E-Hentai Cloudflare challenge blocked request';
    return 'E-Hentai is unavailable';
  }
}
