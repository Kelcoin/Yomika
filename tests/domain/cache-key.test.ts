import { describe, expect, it } from 'vitest';

import { createImageCacheKey } from '../../src/domain/cache';

describe('image cache key', () => {
  it('changes across scope, server, page, rendition, source path, model, and transform', () => {
    const base = { scopeId: 'scope-a', archiveId: 'archive-1', pageIndex: 0, rendition: 'source' as const };
    const keys = new Set([
      createImageCacheKey(base),
      createImageCacheKey({ ...base, scopeId: 'scope-b' }),
      createImageCacheKey({ ...base, serverId: 'server-b' }),
      createImageCacheKey({ ...base, pageIndex: 1 }),
      createImageCacheKey({ ...base, rendition: 'thumbnail' }),
      createImageCacheKey({ ...base, rendition: 'reader-page', sourcePath: '01.jpg' }),
      createImageCacheKey({ ...base, rendition: 'reader-page', sourcePath: '02.jpg' }),
      createImageCacheKey({ ...base, rendition: 'enhanced', modelVersion: 'v1' }),
      createImageCacheKey({ ...base, transform: 'rotate-90' }),
    ]);
    expect(keys.size).toBe(9);
  });

  it('is stable regardless of optional property order', () => {
    expect(createImageCacheKey({ scopeId: 's', archiveId: 'a', pageIndex: 3, rendition: 'enhanced', modelVersion: 'v1', transform: 'none' }))
      .toBe(createImageCacheKey({ transform: 'none', modelVersion: 'v1', rendition: 'enhanced', pageIndex: 3, archiveId: 'a', scopeId: 's' }));
  });
});
