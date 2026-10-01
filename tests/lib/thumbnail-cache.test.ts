import { describe, expect, it } from 'vitest';

import {
  getThumbnail,
  loadThumbnailOnce,
  resetThumbnailCacheForTests,
  setThumbnail,
} from '../../src/lib/thumbnailCache';

describe('thumbnail cache', () => {
  it('keeps a bounded number of thumbnails, dropping the oldest first', () => {
    resetThumbnailCacheForTests();
    for (let index = 0; index < 500; index += 1) setThumbnail('scope', `a${index}`, `data:image/png;base64,${index}`);

    expect(getThumbnail('scope', 'a0')).toBeUndefined();
    expect(getThumbnail('scope', 'a499')).toBe('data:image/png;base64,499');
  });

  it('holds no more bytes than the budget allows', () => {
    resetThumbnailCacheForTests();
    // Thumbnails are data URLs: a few hundred KB each, so the count cap alone
    // would still let tens of megabytes through.
    const heavy = `data:image/png;base64,${'x'.repeat(1_000_000)}`;
    for (let index = 0; index < 20; index += 1) setThumbnail('scope', `heavy${index}`, heavy);

    expect(getThumbnail('scope', 'heavy0')).toBeUndefined();
    expect(getThumbnail('scope', 'heavy19')).toBe(heavy);
  });

  it('bounds what loadThumbnailOnce stores as well', async () => {
    resetThumbnailCacheForTests();
    for (let index = 0; index < 500; index += 1) {
      await loadThumbnailOnce(`scope:a${index}`, async () => `data:image/png;base64,${index}`);
    }

    expect(getThumbnail('scope', 'a0')).toBeUndefined();
    expect(getThumbnail('scope', 'a499')).toBe('data:image/png;base64,499');
  });
});
