/**
 * E-Hentai 的报错文案层。
 *
 * 抓取、HTML 解析与 Cookie 管理都已经搬到原生侧（`src-tauri/src/commands/eh.rs`），
 * 所以这里只剩 presentation：把原生侧发出的 `DomainErrorCode` 翻成用户看得懂的一句话。
 * 通用码表讲的是「会话出了什么事」，登录表单另有自己的 presenter——理由见文件末尾。
 *
 * `EhComment` 只因为评论组件（`src/components/EhComments.tsx`）从这里取它的形状而留在这里，
 * 它不参与文案，也不再有抓取侧的实现。
 */

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
