import { shouldAutoEnableUpscale } from '../../src/lib/autoUpscale';

describe('automatic upscaling tags', () => {
  const options = {
    enabled: true, pageCount: 10, sizeBytes: 10_000_000, thresholdBytes: 500_000,
    tagMode: 'whitelist' as const,
    whitelist: 'category:doujinshi\ncategory:manga',
    blacklist: 'other:3d\ncategory:cosplay\ncategory:asian porn',
  };

  it('uses only the selected list and can be turned off', () => {
    expect(shouldAutoEnableUpscale(['category:manga'], options)).toBe(true);
    expect(shouldAutoEnableUpscale(['category:manga', 'other:3d'], options)).toBe(true);
    expect(shouldAutoEnableUpscale(['category:western'], options)).toBe(false);
    expect(shouldAutoEnableUpscale(['category:manga', 'other:3d'], { ...options, tagMode: 'blacklist' })).toBe(false);
    expect(shouldAutoEnableUpscale(['category:western'], { ...options, tagMode: 'blacklist' })).toBe(true);
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, enabled: false })).toBe(false);
  });

  it('normalizes case and keeps the size threshold', () => {
    expect(shouldAutoEnableUpscale(['Category:Manga'], options)).toBe(true);
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: 100 })).toBe(false);
  });
});
