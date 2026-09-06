import { describe, expect, it } from 'vitest';

import { ehAccountIdFor, ehHostFor, formatEhCookie, parseEhCookie } from '../../src/lib/ehCookie';

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
