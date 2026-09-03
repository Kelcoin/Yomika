/** E-Hentai authentication is carried by two cookies. Users paste them in many
 * shapes (a whole `Cookie:` header, a DevTools copy, or just the two values),
 * so parse permissively and derive everything else — the site, the account id
 * and the label — instead of asking for it.
 */
export interface EhCookieCredentials {
  memberId: string;
  passHash: string;
  igneous?: string;
}

const COOKIE_PAIR = /([a-z_]+)\s*=\s*([^;,\s]+)/gi;

export function parseEhCookie(input: string): EhCookieCredentials | undefined {
  const values = new Map<string, string>();
  for (const match of input.matchAll(COOKIE_PAIR)) {
    const [, name, value] = match;
    if (!name || !value) continue;
    values.set(name.toLowerCase(), value.trim());
  }
  const memberId = values.get('ipb_member_id');
  const passHash = values.get('ipb_pass_hash');
  if (!memberId || !passHash || !/^\d+$/.test(memberId) || !/^[0-9a-f]{32}$/i.test(passHash)) return undefined;
  const igneous = values.get('igneous');
  return { memberId, passHash, ...(igneous && igneous !== 'mystery' ? { igneous } : {}) };
}

export function formatEhCookie(credentials: EhCookieCredentials): string {
  const parts = [`ipb_member_id=${credentials.memberId}`, `ipb_pass_hash=${credentials.passHash}`];
  if (credentials.igneous) parts.push(`igneous=${credentials.igneous}`);
  return parts.join('; ');
}

/** An `igneous` cookie is what unlocks ExHentai; without it only e-hentai works. */
export function ehHostFor(credentials: EhCookieCredentials): 'e-hentai.org' | 'exhentai.org' {
  return credentials.igneous ? 'exhentai.org' : 'e-hentai.org';
}

export function ehAccountIdFor(credentials: EhCookieCredentials): string {
  return `eh-${credentials.memberId}`;
}
