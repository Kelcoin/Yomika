/** Readoshi server-scope compatibility.
 *
 * The worker export stamps `serverScope` as md5(normalized server URL)
 * (Readoshi's `createServerScopeId`), while Yomika mints scope ids from
 * SHA-256(origin + name). Matching an export back to a configured server
 * therefore requires recomputing the Readoshi formula over every server's
 * base URL. The md5 implementation below is a direct port of Readoshi's
 * `configScope.js` so both sides stay in lockstep.
 */

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const TABLE = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0);

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function wordHex(value: number): string {
  let output = '';
  for (let index = 0; index < 4; index += 1) output += ((value >>> (index * 8)) & 0xff).toString(16).padStart(2, '0');
  return output;
}

export function md5(value: string): string {
  const input = new TextEncoder().encode(String(value ?? ''));
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  for (let index = 0; index < 8; index += 1) bytes[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Int32Array(16);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((bytes[start] ?? 0) | ((bytes[start + 1] ?? 0) << 8) | ((bytes[start + 2] ?? 0) << 16) | ((bytes[start + 3] ?? 0) << 24)) | 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      const round = index >> 4;
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? index : round === 1 ? (5 * index + 1) % 16 : round === 2 ? (3 * index + 5) % 16 : (7 * index) % 16;
      const sum = (a + f + (TABLE[index] ?? 0) + (words[g] ?? 0)) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, SHIFT[index] ?? 0)) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return `${wordHex(a0)}${wordHex(b0)}${wordHex(c0)}${wordHex(d0)}`;
}

/** The URL normalization the Readoshi worker's header scope is derived from:
 * origin plus path with any trailing slashes stripped (compare configScope.js
 * normalizeServerUrl). Unlike Yomika's stricter server normalize, malformed
 * input degrades to a lowercase, trailing-slash-trimmed string. */
export function normalizeReadoshiServerUrl(value: string): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.hash = '';
    url.search = '';
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return text.replace(/\/+$/, '').toLowerCase();
  }
}

/** Recompute the Readoshi worker's `serverScope` for one of Yomika's servers. */
export function readoshiServerScope(baseUrl: string): string {
  const normalized = normalizeReadoshiServerUrl(baseUrl);
  return normalized ? md5(normalized) : '';
}
