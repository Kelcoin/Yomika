import { describe, expect, it } from 'vitest';

import {
  formatArchiveDate,
  formatArchivePageMeta,
  isWideCoverRatio,
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
});
