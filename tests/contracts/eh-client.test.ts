import { describe, expect, it } from 'vitest';

import { DomainErrorCodeSchema } from '../../src/domain/errors';
import { presentEhError, presentEhLoginError } from '../../src/services/ehClient';

/**
 * 这一份只盯 `src/services/ehClient.ts` 里活着的那半边。
 *
 * HTTP 客户端与解析器（`EhHttpClient` / `EhCookieJar` / `parseEhGallery` /
 * `parseEhComments` / `parseEhSearchResults` / `classifyEhResponse`）在 `src/` 里
 * 一个调用者都没有：抓取已经在原生侧完成（`src-tauri/src/commands/eh.rs`），
 * 所以那几个导出连同 32 个用例一起删掉了——它们能测的只是没人走的那条路。
 * 组件真正用到的是这两个 presenter（`src/components/EhComments.tsx:5`、
 * `src/components/EhRouteWorkspace.tsx:9`），在此之前零覆盖。
 */

/** 原生侧会发出的码 → 用户看到的那句话。 */
const MESSAGES: Array<[string, string]> = [
  ['EH_GALLERY_COPYRIGHT_REMOVED', '画廊因版权要求被移除，评论不可用。'],
  ['EH_GALLERY_DELETED', '画廊不存在或已被删除。'],
  ['EH_CONTENT_WARNING', 'E-Hentai 内容警告页面需要登录或确认。'],
  ['EH_ACCESS_BLOCKED', 'E-Hentai 拒绝了当前请求，可能是 Cookie、IP 或访问权限问题。'],
  ['EH_CLOUDFLARE', 'E-Hentai 的 Cloudflare 验证拦截了请求。'],
  ['EH_LOGIN_REJECTED', 'E-Hentai 拒绝了这次登录，请检查用户名与密码。'],
  ['EH_REAUTH_REQUIRED', 'E-Hentai 登录已失效，请重新配置 Cookie。'],
  ['EH_RATE_LIMIT', 'E-Hentai 请求过于频繁，请稍后重试。'],
  ['EH_EMPTY_RESPONSE', 'E-Hentai 返回了空响应。'],
  ['EH_UNEXPECTED_PAGE', 'E-Hentai 返回了无法识别的页面。'],
];

/** 刻意不在这张表里的码：调用点各有更具体的话要说。 */
const INTENTIONALLY_UNMAPPED = [
  // 「没登录」由登录流程自己讲；「服务不可用」本来就是说不清哪里不对的兜底。
  'EH_UNAVAILABLE',
  'EH_UNAUTHORIZED',
  // 用户关掉了登录窗口，调用点多半什么都不显示。
  'EH_LOGIN_WINDOW_CLOSED',
];

describe('EH error presentation', () => {
  it.each(MESSAGES)('shows the reason for %s instead of the caller fallback', (code, message) => {
    expect(presentEhError(code, '兜底')).toBe(message);
  });

  it('falls back for codes it does not know', () => {
    expect(presentEhError('EH_UNAVAILABLE', '兜底')).toBe('兜底');
    expect(presentEhError('LRR_UNAUTHORIZED', '兜底')).toBe('兜底');
  });

  // 挡的是「原生侧加了新码，前端悄悄显示兜底」：新增一个 EH_ 码却忘了写话，
  // 这条会红，而不是让用户对着「E-Hentai 不可用」猜。
  it('leaves no EH code of the domain schema without a message, except the documented ones', () => {
    const ehCodes = DomainErrorCodeSchema.options.filter((code) => code.startsWith('EH_'));
    const mapped = new Set(MESSAGES.map(([code]) => code));

    expect(ehCodes.filter((code) => !mapped.has(code) && !INTENTIONALLY_UNMAPPED.includes(code))).toEqual([]);
    // 允许清单本身也得是准的：搬进表里的码要从这里删掉。
    expect(INTENTIONALLY_UNMAPPED.filter((code) => mapped.has(code))).toEqual([]);
  });

  it('never lets the generic map talk over a sign-in answer', () => {
    // 曾经两者共用 EH_REAUTH_REQUIRED：第一次登录失败会说「登录已失效，请重新配置
    // Cookie」——让用户去重配一个他从来没设过的 Cookie。
    expect(presentEhLoginError('EH_LOGIN_REJECTED', '用户名或密码不正确')).toBe('用户名或密码不正确');

    // 原生侧给了话就照说，哪怕那句话是英文。
    expect(presentEhLoginError('EH_CLOUDFLARE', 'Cloudflare challenge')).toBe('Cloudflare challenge');

    // 原生侧没给话时才回到这张表，最后才是登录自己的兜底。
    expect(presentEhLoginError('EH_CLOUDFLARE', '   ')).toBe('E-Hentai 的 Cloudflare 验证拦截了请求。');
    expect(presentEhLoginError('EH_SOMETHING_NEW', '')).toBe('E-Hentai 登录失败。');
  });
});
