import { describe, expect, it } from 'vitest';

import { isCommittableSearchQuery } from '../../src/lib/searchQuery';

describe('search query submission', () => {
  it('holds back partial words', () => {
    expect(isCommittableSearchQuery('a')).toBe(false);
    expect(isCommittableSearchQuery('artist')).toBe(false);
    expect(isCommittableSearchQuery('artist:sam')).toBe(false);
  });

  it('submits once a tag is finished or the field is cleared', () => {
    expect(isCommittableSearchQuery('artist:sample$')).toBe(true);
    expect(isCommittableSearchQuery('artist:sample,')).toBe(true);
    expect(isCommittableSearchQuery('artist:sample, ')).toBe(true);
    expect(isCommittableSearchQuery('')).toBe(true);
    expect(isCommittableSearchQuery('   ')).toBe(true);
  });
});
