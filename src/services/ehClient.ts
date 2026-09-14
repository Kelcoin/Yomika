import { err, ok, type CommandResult } from '../domain/result';
import type { DomainErrorCode } from '../domain/errors';

export type EhResponseClassification =
  | { kind: 'ok' }
  | { kind: 'cloudflare'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'access_blocked'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'rate_limit'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'unauthorized'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'content_warning'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'gallery_deleted'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'gallery_copyright_removed'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'empty_response'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'unexpected_page'; retryable: boolean; reauthRequired: boolean }
  | { kind: 'unavailable'; retryable: boolean; reauthRequired: boolean };

export type EhResponseContext = 'generic' | 'page';

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

export interface EhComment {
  id: string;
  author: string;
  body: string;
  score: number;
  postedAt: string;
  isUploader: boolean;
  isEditable: boolean;
  myVote: number;
}

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

const EH_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "07 September 2026, 10:30" (`dd MMMM yyyy, HH:mm`, en_US) →
 * "2026-09-07 10:30". Relative or unparseable lines keep their raw text. */
export function normalizeEhPostedDate(raw: string): string {
  const parsed = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})$/);
  const [day, monthName, year, hour, minute] = parsed?.slice(1) ?? [];
  if (!day || !monthName || !year || !hour || !minute) return raw;
  const month = EH_MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!month) return raw;
  const hours = Number(hour);
  const minutes = Number(minute);
  const days = Number(day);
  if (days === 0 || days > 31 || hours > 23 || minutes > 59) return raw;
  return `${year}-${String(month).padStart(2, '0')}-${String(days).padStart(2, '0')} ${hour.padStart(2, '0')}:${minute}`;
}

export function parseEhComments(html: string): EhComment[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return [...document.querySelectorAll<HTMLElement>('.c6[id^="comment_"], .c1[id^="c"]')].map((candidate) => {
    const bodyNode = candidate.matches('.c6') ? candidate : candidate.querySelector<HTMLElement>('.c6');
    const node = candidate.matches('.c1') ? candidate : candidate.closest('.c1') ?? candidate.parentElement;
    const id = candidate.matches('.c6') ? candidate.id.replace(/^comment_/, '') : candidate.id.replace(/^c/, '');
    const metadata = node?.querySelector('.c3')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    // The real header line ends in `by:` (colon), and the score block is
    // `class="c5 nosel"` with its number prefixed by the word "Score" —
    // `.c5` matches the class token, so only the line split needs care here.
    const postedRaw = metadata.match(/^(?:Posted on|发表于)\s+(.+?)(?:\s+by:|\s+by\s+|$)/i)?.[1]?.trim() ?? '';
    const up = document.getElementById(`comment_vote_up_${id}`);
    const down = document.getElementById(`comment_vote_down_${id}`);
    return {
      id,
      // The name anchor comes first; a PM link with an image follows it.
      author: node?.querySelector('.c3 a')?.textContent?.trim() ?? '',
      body: bodyNode?.textContent?.trim() ?? '',
      score: Number((node?.querySelector('.c5')?.textContent ?? '0').match(/[+-]?\d+/)?.[0] ?? 0),
      postedAt: normalizeEhPostedDate(postedRaw),
      isUploader: Boolean(node?.querySelector('[name="ulcomment"]')),
      isEditable: Boolean(node?.querySelector('[onclick*="edit_comment"]')),
      myVote: up?.hasAttribute('style') ? 1 : down?.hasAttribute('style') ? -1 : 0,
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

export function classifyEhResponse(status: number, body: string, context: EhResponseContext = 'generic'): EhResponseClassification {
  const normalized = body.toLowerCase();
  // EH sometimes returns these pages with HTTP 200 (and the copyright page
  // currently returns 404), so inspect the body before relying on status.
  if (normalized.includes('copyright claim')
    || normalized.includes('copyright infringement')
    || normalized.includes('copyright complaint')
    || normalized.includes('copyright holder')
    || normalized.includes('dmca')
    || normalized.includes('removed due to copyright')
    || normalized.includes('unavailable due to a copyright')) {
    return { kind: 'gallery_copyright_removed', retryable: false, reauthRequired: false };
  }
  if (normalized.includes('cf-browser-verification')
    || normalized.includes('_cf_chl_opt')
    || normalized.includes('cf-challenge')
    || normalized.includes('just a moment')
    || normalized.includes('checking your browser')) {
    return { kind: 'cloudflare', retryable: false, reauthRequired: false };
  }
  if (status === 429 || normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return { kind: 'rate_limit', retryable: true, reauthRequired: false };
  }
  if (status === 403 && (normalized.includes('cloudflare') || normalized.includes('cf-chl') || normalized.includes('captcha'))) {
    return { kind: 'cloudflare', retryable: false, reauthRequired: false };
  }
  if (status === 401 || normalized.includes('<title>login</title>') || normalized.includes('please login') || normalized.includes('you must be logged in') || normalized.includes('not logged in') || normalized.includes('login required') || normalized.includes('your ip address has been temporarily banned')) {
    return { kind: 'unauthorized', retryable: false, reauthRequired: true };
  }
  if (normalized.includes('you are seeing this page because') || /<h1\b[^>]*>[\s\S]*content warning[\s\S]*<\/h1>/i.test(body)) {
    return { kind: 'content_warning', retryable: false, reauthRequired: true };
  }
  if (status === 403) return { kind: 'access_blocked', retryable: false, reauthRequired: false };
  if (status === 404 || normalized.includes('gallery not found') || normalized.includes('gallery does not exist') || normalized.includes('gallery has been removed')) {
    return { kind: 'gallery_deleted', retryable: false, reauthRequired: false };
  }
  if (context === 'page' && status >= 200 && status < 300 && body.trim().length === 0) {
    return { kind: 'empty_response', retryable: true, reauthRequired: false };
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
      const classification = classifyEhResponse(response.status, body, 'page');
      if (classification.kind !== 'ok') return err(this.errorCode(classification.kind), this.errorMessage(classification.kind), classification.retryable);
      const gallery = parseEhGallery(body, target.toString());
      return gallery.galleryKey ? ok(gallery) : err('EH_UNEXPECTED_PAGE', 'E-Hentai returned an unrecognized gallery page', false);
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
      const classification = classifyEhResponse(response.status, body, 'page');
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
      const body = new URLSearchParams({
        gid: galleryId,
        t: token,
        act: 'votecomment',
        comment_id: commentId,
        comment_vote: String(vote),
      });
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
      const classification = classifyEhResponse(response.status, body, 'page');
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
    if (kind === 'gallery_copyright_removed') return 'EH_GALLERY_COPYRIGHT_REMOVED';
    if (kind === 'gallery_deleted') return 'EH_GALLERY_DELETED';
    if (kind === 'unauthorized') return 'EH_REAUTH_REQUIRED';
    if (kind === 'rate_limit') return 'EH_RATE_LIMIT';
    if (kind === 'cloudflare') return 'EH_CLOUDFLARE';
    if (kind === 'access_blocked') return 'EH_ACCESS_BLOCKED';
    if (kind === 'content_warning') return 'EH_CONTENT_WARNING';
    if (kind === 'empty_response') return 'EH_EMPTY_RESPONSE';
    if (kind === 'unexpected_page') return 'EH_UNEXPECTED_PAGE';
    return 'EH_UNAVAILABLE';
  }

  private errorMessage(kind: Exclude<EhResponseClassification, { kind: 'ok' }>['kind']): string {
    if (kind === 'gallery_copyright_removed') return 'E-Hentai gallery was removed due to a copyright claim';
    if (kind === 'gallery_deleted') return 'E-Hentai gallery was deleted or not found';
    if (kind === 'unauthorized') return 'E-Hentai login is required';
    if (kind === 'rate_limit') return 'E-Hentai rate limit reached';
    if (kind === 'cloudflare') return 'E-Hentai Cloudflare challenge blocked request';
    if (kind === 'access_blocked') return 'E-Hentai access was blocked';
    if (kind === 'content_warning') return 'E-Hentai content warning requires confirmation or login';
    if (kind === 'empty_response') return 'E-Hentai returned an empty response';
    if (kind === 'unexpected_page') return 'E-Hentai returned an unrecognized page';
    return 'E-Hentai is unavailable';
  }
}

export function presentEhError(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    EH_GALLERY_COPYRIGHT_REMOVED: '画廊因版权要求被移除，评论不可用。',
    EH_GALLERY_DELETED: '画廊不存在或已被删除。',
    EH_CONTENT_WARNING: 'E-Hentai 内容警告页面需要登录或确认。',
    EH_ACCESS_BLOCKED: 'E-Hentai 拒绝了当前请求，可能是 Cookie、IP 或访问权限问题。',
    EH_CLOUDFLARE: 'E-Hentai 的 Cloudflare 验证拦截了请求。',
    // A rejected sign-in is not an expired session: it used to share
    // EH_REAUTH_REQUIRED, so a first login attempt told the user their login had
    // expired and to reconfigure a cookie they had never set.
    EH_LOGIN_REJECTED: 'E-Hentai 拒绝了这次登录，请检查用户名与密码。',
    EH_REAUTH_REQUIRED: 'E-Hentai 登录已失效，请重新配置 Cookie。',
    EH_RATE_LIMIT: 'E-Hentai 请求过于频繁，请稍后重试。',
    EH_EMPTY_RESPONSE: 'E-Hentai 返回了空响应。',
    EH_UNEXPECTED_PAGE: 'E-Hentai 返回了无法识别的页面。',
  };
  return messages[code] ?? fallback;
}

/** The sign-in form's own presenter.
 *
 * A sign-in answers with a reason the user can act on — a rejected password, a
 * Cloudflare challenge, a temporary IP ban — so that reason is shown as-is. The
 * generic map must not get a say here: it would turn any of them into "your
 * login has expired, reconfigure the cookie", which is what a first sign-in
 * attempt used to report.
 */
export function presentEhLoginError(code: string, message: string): string {
  return message.trim() || presentEhError(code, 'E-Hentai 登录失败。');
}
