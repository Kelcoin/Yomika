import { describe, expect, it } from 'vitest';

import { ehAccountIdFor, ehHostFor, formatEhCookie, formatEhCookieHeader, parseEhCookie, parseEhCookiePairs } from '../../src/lib/ehCookie';

const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('e-hentai cookie parsing', () => {
  it('accepts a full cookie header, a DevTools copy, and bare values', () => {
    expect(parseEhCookie(`Cookie: ipb_member_id=1234; ipb_pass_hash=${hash}; sl=dm_2`))
      .toEqual({ memberId: '1234', passHash: hash });
    expect(parseEhCookie(`ipb_member_id\t=\t1234 , ipb_pass_hash = ${hash}`))
      .toEqual({ memberId: '1234', passHash: hash });
    expect(parseEhCookie(`IPB_MEMBER_ID=1234; IPB_PASS_HASH=${hash.toUpperCase()}`))
      .toEqual({ memberId: '1234', passHash: hash.toUpperCase() });
  });

  it('keeps igneous when present and treats it as the ExHentai unlock', () => {
    const credentials = parseEhCookie(`ipb_member_id=99; ipb_pass_hash=${hash}; igneous=abcdef1234`);
    expect(credentials).toEqual({ memberId: '99', passHash: hash, igneous: 'abcdef1234' });
    expect(ehHostFor(credentials!)).toBe('exhentai.org');
    expect(formatEhCookie(credentials!)).toBe(`ipb_member_id=99; ipb_pass_hash=${hash}; igneous=abcdef1234`);
  });

  it('keeps every cookie field when normalizing an imported header', () => {
    expect(formatEhCookieHeader(`Cookie: ipb_member_id=99; ipb_pass_hash=${hash}; sl=dm_2; sk=abc-123; yay=louder`))
      .toBe(`ipb_member_id=99; ipb_pass_hash=${hash}; sl=dm_2; sk=abc-123; yay=louder`);
  });

  it('imports quoted, multiline and JSON cookie exports while filtering attributes', () => {
    const multiline = `Cookie: ipb_member_id="99"\nipb_pass_hash=${hash}\nsl=dm_2\nPath=/`;
    expect(parseEhCookie(multiline)).toEqual({ memberId: '99', passHash: hash });
    expect(formatEhCookieHeader(multiline)).toBe(`ipb_member_id=99; ipb_pass_hash=${hash}; sl=dm_2`);

    const json = JSON.stringify([
      { name: 'ipb_member_id', value: '99' },
      { name: 'ipb_pass_hash', value: hash },
      { name: 'igneous', value: 'fresh' },
      { name: 'path', value: '/' },
    ]);
    expect(parseEhCookie(json)).toEqual({ memberId: '99', passHash: hash, igneous: 'fresh' });
    expect(parseEhCookiePairs(json)).toEqual([
      ['ipb_member_id', '99'],
      ['ipb_pass_hash', hash],
      ['igneous', 'fresh'],
    ]);
  });

  it('imports browser script assignments whose Cookie value contains the actual pairs', () => {
    const script = `document.cookie = "ipb_member_id=99"; document.cookie = "ipb_pass_hash=${hash}";`;
    expect(parseEhCookie(script)).toEqual({ memberId: '99', passHash: hash });
    expect(formatEhCookieHeader(script)).toBe(`ipb_member_id=99; ipb_pass_hash=${hash}`);
  });

  it('imports a JSON object keyed by cookie name', () => {
    const json = JSON.stringify({ ipb_member_id: '99', ipb_pass_hash: hash, igneous: 'fresh', path: '/' });
    expect(parseEhCookie(json)).toEqual({ memberId: '99', passHash: hash, igneous: 'fresh' });
  });

  it('imports Netscape cookie-file exports', () => {
    const netscape = [
      '# Netscape HTTP Cookie File',
      'e-hentai.org\tTRUE\t/\tFALSE\t0\tipb_member_id\t99',
      `e-hentai.org\tTRUE\t/\tFALSE\t0\tipb_pass_hash\t${hash}`,
    ].join('\n');
    expect(parseEhCookie(netscape)).toEqual({ memberId: '99', passHash: hash });
  });

  it('imports HttpOnly Netscape cookie-file exports', () => {
    const netscape = [
      '# Netscape HTTP Cookie File',
      '#HttpOnly_.e-hentai.org\tTRUE\t/\tTRUE\t0\tipb_member_id\t99',
      `#HttpOnly_.e-hentai.org\tTRUE\t/\tTRUE\t0\tipb_pass_hash\t${hash}`,
    ].join('\n');
    expect(parseEhCookie(netscape)).toEqual({ memberId: '99', passHash: hash });
  });

  it('ignores the mystery igneous value that means no ExHentai access', () => {
    const credentials = parseEhCookie(`ipb_member_id=99; ipb_pass_hash=${hash}; igneous=mystery`);
    expect(credentials).toEqual({ memberId: '99', passHash: hash });
    expect(ehHostFor(credentials!)).toBe('e-hentai.org');
  });

  it('rejects incomplete or malformed input', () => {
    expect(parseEhCookie('')).toBeUndefined();
    expect(parseEhCookie('ipb_member_id=1234')).toBeUndefined();
    expect(parseEhCookie(`ipb_member_id=abc; ipb_pass_hash=${hash}`)).toBeUndefined();
    expect(parseEhCookie('ipb_member_id=1234; ipb_pass_hash=short')).toBeUndefined();
  });

  it('derives a stable account id from the member id', () => {
    expect(ehAccountIdFor({ memberId: '1234', passHash: hash })).toBe('eh-1234');
  });
});
