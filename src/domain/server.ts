export interface ServerIdentityInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export interface ServerIdentity {
  name: string;
  baseUrl: string;
  scopeId: string;
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('Server URL must not contain credentials');
  if (url.search || url.hash) throw new Error('Server URL must not contain query or fragment');
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export async function createServerIdentity(input: ServerIdentityInput): Promise<ServerIdentity> {
  const name = input.name.trim();
  const baseUrl = normalizeServerUrl(input.baseUrl);
  const origin = new URL(baseUrl).origin;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${origin}\n${name.toLocaleLowerCase()}`));
  const scopeId = `scope_${[...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { name, baseUrl, scopeId };
}
