import { describe, expect, it } from 'vitest';

import {
  formatArchiveDate,
  formatArchivePageMeta,
  isWideCoverRatio,
  pickCardTags,
  pickRandomSample,
} from '../../src/lib/archiveCardPresentation';

describe('archive card presentation', () => {
  it('uses the Readoshi wide-card threshold', () => {
    expect(isWideCoverRatio(1)).toBe(false);
    expect(isWideCoverRatio(1.01)).toBe(true);
    expect(isWideCoverRatio(null)).toBe(false);
  });

  it('formats added date and reading progress for card corners', () => {
    expect(formatArchiveDate(1776038400)).toBe('2026-04-13');
    expect(formatArchivePageMeta(259, 8)).toBe('8/259 页');
    expect(formatArchivePageMeta(259)).toBe('259 页');
  });

  it('keeps a stable metadata slot when no date or progress exists', () => {
    expect(formatArchiveDate(null)).toBe('');
    expect(formatArchivePageMeta(0)).toBe('');
  });

  it('samples the random rail without repeats and without keeping the source order', () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    // Fisher-Yates with a maximal draw each step reverses-in the tail items, so
    // the biased `sort(() => Math.random() - 0.5)` shape (leading 0, 1, 2 …) is
    // provably gone.
    const sample = pickRandomSample(items, 4, () => 0.999999);

    expect(sample).toHaveLength(4);
    expect(new Set(sample).size).toBe(4);
    expect(sample[0]).not.toBe(0);
    expect(items).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  it('clamps the random rail request to the archive count', () => {
    expect(pickRandomSample([1, 2], 8, () => 0)).toEqual([1, 2]);
    expect(pickRandomSample([], 8)).toEqual([]);
    expect(pickRandomSample([1, 2, 3], -1)).toEqual([]);
  });

  it('ranks content namespaces ahead of bookkeeping ones on a card', () => {
    const tags = ['language:chinese', 'artist:someone', 'female:big breasts', 'parody:original', 'male:glasses', 'character:alice'];

    expect(pickCardTags(tags, 4)).toEqual(['female:big breasts', 'male:glasses', 'character:alice', 'parody:original']);
  });

  it('drops namespaces a card already shows elsewhere', () => {
    const tags = ['date_added:1760742000', 'source:example.com', 'uploader:someone', 'category:manga', 'timestamp:1760742000', 'female:tag'];

    expect(pickCardTags(tags, 6)).toEqual(['female:tag']);
  });

  it('keeps the original order inside one namespace and honours the limit', () => {
    const tags = ['female:b', 'female:a', 'female:c', 'group:z'];

    expect(pickCardTags(tags, 2)).toEqual(['female:b', 'female:a']);
    expect(pickCardTags(tags, 0)).toEqual([]);
    expect(pickCardTags(undefined, 3)).toEqual([]);
  });

  it('keeps unknown namespaces last instead of dropping them', () => {
    expect(pickCardTags(['weird:tag', 'female:tag'], 5)).toEqual(['female:tag', 'weird:tag']);
  });
});
