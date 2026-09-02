import { describe, expect, it } from 'vitest';

import {
  formatArchiveDate,
  formatArchivePageMeta,
  isWideCoverRatio,
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
});
