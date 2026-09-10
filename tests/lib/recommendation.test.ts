import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_LIMIT,
  pickSeedTags,
  rankRecommendations,
  sameCreatorTags,
  scoreCandidate,
  normalizeSourceTags,
  tagWeight,
  sortSameCreatorRecommendations,
} from '../../src/lib/recommendation';

describe('recommendation rules', () => {
  it('weights taste tags above bookkeeping namespaces', () => {
    expect(tagWeight('female:futanari')).toBe(5);
    expect(tagWeight('parody:fate grand order')).toBe(2);
    expect(tagWeight('artist:someone')).toBe(0.1);
    expect(tagWeight('language:chinese')).toBe(0);
    expect(tagWeight('date_added:1756512000')).toBe(0);
    expect(tagWeight('unknown')).toBe(0);
  });

  it('seeds the search from taste tags, falling back to character and parody', () => {
    const taste = pickSeedTags(['female:glasses', 'male:yaoi', 'parody:x', 'language:chinese'], 3);
    expect(taste).toEqual(['female:glasses', 'male:yaoi']);

    expect(pickSeedTags(['parody:x', 'character:y', 'artist:z'], 3)).toEqual(['parody:x', 'character:y']);
    expect(pickSeedTags(['artist:z', 'language:chinese'], 3)).toEqual([]);
  });

  it('scales the seed count with how many tags the archive carries', () => {
    const many = Array.from({ length: 45 }, (_, index) => `female:tag-${index}`);
    expect(pickSeedTags(many)).toHaveLength(7);
    expect(pickSeedTags(many.slice(0, 25))).toHaveLength(5);
    expect(pickSeedTags(many.slice(0, 10))).toHaveLength(3);
  });

  it('scores only shared tags and halves a finished archive', () => {
    const source = normalizeSourceTags(['female:glasses', 'female:futanari', 'language:chinese']);
    expect(scoreCandidate(source, { archiveId: 'a', tags: ['female:glasses'] })).toBe(1.5);
    expect(scoreCandidate(source, { archiveId: 'b', tags: ['female:glasses', 'female:futanari'] })).toBe(6.5);
    // language weighs nothing, so an archive sharing only that scores zero
    expect(scoreCandidate(source, { archiveId: 'c', tags: ['language:chinese'] })).toBe(0);
    expect(scoreCandidate(source, { archiveId: 'd', tags: ['female:futanari'], pageCount: 10, readPages: 10 })).toBe(2.5);
  });

  it('prefers the same category before filling from other categories', () => {
    const source = ['category:manga', 'female:glasses', 'female:futanari'];
    const ranked = rankRecommendations(source, [
      { archiveId: 'other-category-strong', tags: ['female:glasses', 'female:futanari', 'category:doujinshi'] },
      { archiveId: 'same-category-weak', tags: ['female:glasses', 'category:manga'] },
      { archiveId: 'no-overlap', tags: ['male:yaoi'] },
    ]);

    expect(ranked.map((item) => item.archiveId)).toEqual(['same-category-weak', 'other-category-strong']);
  });

  it('caps the result at the shared limit', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({ archiveId: `a-${index}`, tags: ['female:glasses'] }));
    expect(rankRecommendations(['female:glasses'], candidates)).toHaveLength(RECOMMENDATION_LIMIT);
  });

  it('groups a cosplay set by cosplayer and everything else by artist or group', () => {
    expect(sameCreatorTags(['category:cosplay', 'cosplayer:someone', 'artist:ignored'])).toEqual({ namespace: 'cosplayer', tags: ['cosplayer:someone'] });
    expect(sameCreatorTags(['cosplayer:someone', 'artist:preferred'])).toEqual({ namespace: 'artist', tags: ['artist:preferred'] });
    expect(sameCreatorTags(['artist:a', 'group:b', 'female:glasses'])).toEqual({ namespace: 'artist', tags: ['artist:a', 'group:b'] });
    expect(sameCreatorTags(['female:glasses'])).toEqual({ namespace: 'artist', tags: [] });
  });

  it('puts completed creator matches last and sorts each group by archive title', () => {
    const sorted = sortSameCreatorRecommendations([
      { archiveId: 'z', title: 'Zeta', tags: ['artist:a'], pageCount: 10, readPages: 10 },
      { archiveId: 'b', title: 'Beta', tags: ['artist:a'], pageCount: 10, readPages: 0 },
      { archiveId: 'a', title: 'Alpha', tags: ['artist:a'], pageCount: 10, readPages: 2 },
      { archiveId: 'c', title: 'Alpha', tags: ['artist:a'], pageCount: 10, readPages: 2 },
    ]);
    expect(sorted.map((item) => item.archiveId)).toEqual(['a', 'c', 'b', 'z']);
  });
});
