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

const COOKIE_PAIR = /([a-z_][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;,\s\r\n]*))/gi;
const COOKIE_ATTRIBUTES = new Set([
  'domain', 'path', 'expires', 'max-age', 'samesite', 'secure', 'httponly',
  'priority', 'partitioned', 'hostonly', 'session',
]);

function addCookiePair(values: Map<string, [string, string]>, rawName: unknown, rawValue: unknown) {
  if (typeof rawName !== 'string' || typeof rawValue !== 'string') return;
  const name = rawName.trim();
  const value = rawValue.trim();
  const key = name.toLowerCase();
  if (!name || COOKIE_ATTRIBUTES.has(key)) return;
  if (key === 'cookie' || key === 'set-cookie') {
    // Browser script exports use `document.cookie = "name=value"`. The
    // enclosing assignment is not a cookie; its quoted value is.
    for (const match of value.matchAll(COOKIE_PAIR)) {
      const [, nestedName, doubleQuoted, singleQuoted, bareValue] = match;
      addCookiePair(values, nestedName, doubleQuoted ?? singleQuoted ?? bareValue ?? '');
    }
    return;
  }
  // Cookie names are deliberately narrower than arbitrary JSON property names.
  if (!/^[a-z_][a-z0-9_-]*$/i.test(name)) return;
  values.set(key, [name, value]);
}

function collectJsonCookies(value: unknown, values: Map<string, [string, string]>) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonCookies(item, values);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.value === 'string') {
    addCookiePair(values, record.name, record.value);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'name' || key === 'value') continue;
    if (typeof child === 'string') addCookiePair(values, key, child);
    else collectJsonCookies(child, values);
  }
}

export function parseEhCookiePairs(input: string): Array<[string, string]> {
  const values = new Map<string, [string, string]>();
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      collectJsonCookies(parsed, values);
    } catch {
      // Some clipboard formats look JSON-adjacent; fall through to key/value parsing.
    }
  }
  // Browser extensions can export the Netscape cookie-file format. Its last
  // two tab-separated columns are the cookie name and value.
  for (const line of trimmed.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || (value.startsWith('#') && !value.startsWith('#HttpOnly_'))) continue;
    const columns = value.replace(/^#HttpOnly_/i, '').split(/\t+/);
    if (columns.length >= 7) addCookiePair(values, columns[5], columns.slice(6).join('\t'));
  }
  for (const match of trimmed.matchAll(COOKIE_PAIR)) {
    const [, rawName, doubleQuoted, singleQuoted, bareValue] = match;
    addCookiePair(values, rawName, doubleQuoted ?? singleQuoted ?? bareValue ?? '');
  }
  return [...values.values()];
}

export function parseEhCookie(input: string): EhCookieCredentials | undefined {
  const values = new Map<string, string>();
  for (const [name, value] of parseEhCookiePairs(input)) values.set(name.toLowerCase(), value);
  const memberId = values.get('ipb_member_id');
  const passHash = values.get('ipb_pass_hash');
  if (!memberId || !passHash || !/^\d+$/.test(memberId) || !/^[0-9a-f]{32}$/i.test(passHash)) return undefined;
  const igneous = values.get('igneous');
  return { memberId, passHash, ...(igneous && igneous !== 'mystery' ? { igneous } : {}) };
}

/** Keeps every pasted cookie for export while authentication still derives from the two required fields. */
export function formatEhCookieHeader(input: string): string {
  return parseEhCookiePairs(input).map(([name, value]) => `${name}=${value}`).join('; ');
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
