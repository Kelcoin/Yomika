import { describe, expect, it } from 'vitest';
import { buildModelAssetUrl, mirrorPrefix, MODEL_MIRROR_PRESETS } from './modelRelease';

describe('model release mirrors', () => {
  it('exposes known presets', () => expect(MODEL_MIRROR_PRESETS.map((x) => x.id)).toEqual(['direct', 'gh-proxy', 'ghfast', 'ghproxy']));
  it('builds direct and custom URLs', () => {
    expect(buildModelAssetUrl('', 'o/r', 'v1', 'a b.onnx')).toContain('a%20b.onnx');
    expect(buildModelAssetUrl(mirrorPrefix('custom', 'https://mirror/'), 'o/r', 'v1', 'm.onnx')).toContain('https://mirror/https://github.com');
  });
});
