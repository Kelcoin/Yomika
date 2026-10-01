import { shouldAutoEnableUpscale } from '../../src/lib/autoUpscale';

describe('automatic upscaling tags', () => {
  // 平均一页 400KB，低于 500KB 的阈值：体积那一半放行，下面这些用例只问标签规则。
  const options = {
    enabled: true, pageCount: 10, sizeBytes: 4_000_000, thresholdBytes: 500_000,
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

  it('normalizes case and only picks up pages that average below the threshold', () => {
    expect(shouldAutoEnableUpscale(['Category:Manga'], options)).toBe(true);
    // 平均一页 1MB，已经到阈值之上：本来就大的页再超只是白烧算力。
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: 10_000_000 })).toBe(false);
    // 正好等于阈值也不开（与 `>=` 的语义一致）。
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: 5_000_000 })).toBe(false);
    // 很小的一页：体积那一半放行，仍然由标签决定。
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: 100 })).toBe(true);
    expect(shouldAutoEnableUpscale(['category:western'], { ...options, sizeBytes: 100 })).toBe(false);
    // 数据不全宁可不开。
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: Number.NaN })).toBe(false);
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, sizeBytes: 0 })).toBe(false);
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, thresholdBytes: 0 })).toBe(false);
    expect(shouldAutoEnableUpscale(['category:manga'], { ...options, pageCount: 0 })).toBe(false);
  });
});
