import { afterEach, describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_LIMIT,
  createRecommendationSeed,
  createSeededShuffle,
  pickSeedTags,
  pickPopularSeedTags,
  rankRecommendations,
  sameCreatorTags,
  scoreCandidate,
  normalizeSourceTags,
  TASTE_NAMESPACE_WEIGHT,
  tagJitter,
  tagRarity,
  tagWeight,
  sortSameCreatorRecommendations,
} from '../../src/lib/recommendation';
import { installTagCounts } from '../../src/lib/tagCountService';

afterEach(() => {
  installTagCounts([]);
});

describe('recommendation rules', () => {
  it('samples popular matching tags without using metadata tags or losing variety', () => {
    const common = 'female:common';
    const rare = 'female:rare';
    const tags = [common, rare, 'language:chinese', 'category:manga', 'uploader:name', 'artist:name'];
    installTagCounts([[common, 500_000], [rare, 5], ['language:chinese', 1_000_000]]);
    expect(new Set(pickPopularSeedTags([...tags, ' Female:COMMON '], 10))).toEqual(new Set([common, rare]));
    const draws = Array.from({ length: 200 }, (_, seed) => pickPopularSeedTags(tags, seed + 1, 1)[0]);
    expect(draws.filter(tag => tag === common).length).toBeGreaterThan(130);
    expect(draws).toContain(rare);
    expect(pickPopularSeedTags(tags, 10)).toEqual(pickPopularSeedTags(tags, 10));
  });

  it('discounts large low-coverage tag catalogues and counts duplicate tags once', () => {
    const source = normalizeSourceTags(['female:glasses', 'female:yuri']);
    const focused = { archiveId: 'focused', tags: ['female:glasses', 'female:yuri'] };
    const broad = { archiveId: 'broad', tags: [...focused.tags, ...Array.from({ length: 80 }, (_, i) => `female:unrelated-${i}`)] };
    expect(scoreCandidate(source, focused)).toBeGreaterThan(scoreCandidate(source, broad) * 3);
    expect(scoreCandidate(source, { ...focused, tags: [...focused.tags, ' female:GLASSES ', 'language:chinese', 'source:url'] }))
      .toBe(scoreCandidate(source, focused));
    const partial = { archiveId: 'partial', tags: ['female:glasses', 'female:unrelated'] };
    expect(scoreCandidate(source, partial)).toBeLessThan(scoreCandidate(source, { archiveId: 'exact', tags: ['female:glasses'] }));
  });
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

  it('fills from unfinished matches before completed same-category matches', () => {
    const tags = ['category:manga', 'artist:a'];
    const pool = [{ archiveId: 'finished', tags, readPages: 8, pageCount: 8 },
      { archiveId: 'unfinished', tags: ['artist:a'], readPages: 2, pageCount: 8 }];
    expect(rankRecommendations(tags, pool, 1)).toEqual([pool[1]]);
    expect(rankRecommendations(tags, pool, 2)).toEqual([pool[1], pool[0]]);
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

describe('frequency-backed weights and per-search jitter', () => {
  it('gives an unlisted taste tag a baseline instead of dropping the archive', () => {
    // 手写表只列了六十来个标签；剩下的取向标签从前一律 0 分，等于「表没提过就
    // 不参与相似度」。基准分让全站频次表来决定它们的相对轻重。
    expect(tagWeight('female:unlisted')).toBe(TASTE_NAMESPACE_WEIGHT);
    expect(tagWeight('language:chinese')).toBe(0);
    expect(tagWeight('unknown')).toBe(0);
    const source = normalizeSourceTags(['female:unlisted']);
    expect(scoreCandidate(source, { archiveId: 'a', tags: ['female:unlisted'] })).toBe(TASTE_NAMESPACE_WEIGHT);
  });

  it('keeps the hand-written weights and scores untouched while the table is empty', () => {
    const source = normalizeSourceTags(['female:glasses', 'female:futanari', 'language:chinese']);
    expect(tagWeight('female:futanari')).toBe(5);
    expect(tagRarity('female:futanari')).toBe(1);
    expect(scoreCandidate(source, { archiveId: 'b', tags: ['female:glasses', 'female:futanari'] })).toBe(6.5);
    expect(scoreCandidate(source, { archiveId: 'd', tags: ['female:futanari'], pageCount: 10, readPages: 10 })).toBe(2.5);
  });

  it('weighs a rare tag above a common one once the frequency table is installed', () => {
    installTagCounts([['female:common', 900_000], ['female:rare', 5]]);
    expect(tagRarity('female:rare')).toBeGreaterThan(tagRarity('female:common'));
    expect(tagRarity('female:common')).toBeLessThan(1.01);

    const source = ['female:common', 'female:rare'];
    const candidates = [
      { archiveId: 'common-only', tags: ['female:common'] },
      { archiveId: 'rare-only', tags: ['female:rare'] },
    ];
    expect(rankRecommendations(source, candidates).map((item) => item.archiveId))
      .toEqual(['rare-only', 'common-only']);

    // 表被清空后两者同分，名次只剩 id 兜底——这张表确实是那一步的承重件。
    installTagCounts([]);
    expect(rankRecommendations(source, candidates).map((item) => item.archiveId))
      .toEqual(['common-only', 'rare-only']);
  });

  it('shuffles seeds by seed, reproducibly', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const shuffle = createSeededShuffle(7);
    expect(shuffle(items)).toEqual(shuffle(items));
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => createSeededShuffle(seed)(items).join('')));
    expect(orders.size).toBeGreaterThan(1);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);

    // 问哪几个标签也要随种子变，不然每次搜索的起点都一样。
    const source = ['female:a', 'female:b', 'female:c', 'female:d', 'female:e'];
    expect(pickSeedTags(source, 3, createSeededShuffle(7))).toEqual(pickSeedTags(source, 3, createSeededShuffle(7)));
    const picks = new Set([1, 2, 3, 4].map((seed) => pickSeedTags(source, 3, createSeededShuffle(seed)).join(',')));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('nudges near-equal candidates apart while the same seed stays put', () => {
    const source = ['female:a', 'female:b', 'female:c', 'female:d', 'female:e', 'female:f'];
    const candidates = [
      { archiveId: 'first', tags: ['female:a'] },
      { archiveId: 'second', tags: ['female:f'] },
    ];
    const order = (seed: number) => rankRecommendations(source, candidates, RECOMMENDATION_LIMIT, { seed })
      .map((item) => item.archiveId).join(',');
    expect(order(3)).toBe(order(3));
    expect(new Set(Array.from({ length: 16 }, (_, seed) => order(seed))).size).toBe(2);
    expect(order(0)).toBe(order(0));
  });

  it('never lets the jitter outrank a strong match', () => {
    const source = ['female:futanari', 'female:a', 'female:b', 'female:c', 'female:d', 'female:e', 'female:f', 'female:g'];
    const candidates = [
      { archiveId: 'weak', tags: ['female:a', 'female:b', 'female:c'] },
      { archiveId: 'strong', tags: ['female:futanari'] },
    ];
    for (let seed = 0; seed < 128; seed += 1) {
      expect(rankRecommendations(source, candidates, RECOMMENDATION_LIMIT, { seed })[0]?.archiveId).toBe('strong');
    }
  });

  it('draws a fresh, reproducible seed for every visit', () => {
    const seed = createRecommendationSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(0x7fffffff);
    expect(tagJitter('female:a', 5)).toBe(tagJitter('female:a', 5));
    expect(tagJitter('female:a', 5)).not.toBe(tagJitter('female:a', 6));
  });
});
