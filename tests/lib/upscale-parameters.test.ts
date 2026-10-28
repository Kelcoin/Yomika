import { describe, expect, it } from 'vitest';
import { chooseUpscaleFamily, groupUpscaleOptions, upscaleScaleOptions, upscaleModelLabel, CUGAN_VARIANTS } from '../../src/lib/upscaleParameters';
import { createImageCacheKey } from '../../src/domain/cache';

describe('upscale parameters', () => {
  it('uses stable names instead of remote catalog parameter and quality suffixes', () => {
    expect(groupUpscaleOptions([
      { value: 'waifu2x-upconv7', label: 'waifu2x upconv7 2x 高质量' },
      { value: 'span-nomosuni-photo', label: 'NomosUni Photo · SPAN 2x' },
      { value: 'anime4k-hq', label: 'Anime4K 高质量' },
      { value: 'realesr-general-x4v3', label: 'Real-ESRGAN 通用 x4' },
    ]).map((option) => option.label)).toEqual(['Waifu2x', 'NomosUni Photo', 'Anime4K', 'Real-ESRGAN']);
    expect(upscaleModelLabel('span-nomosuni-photo')).toBe('NomosUni Photo');
    expect(upscaleModelLabel('custom-model', 'My Model')).toBe('My Model');
    expect(CUGAN_VARIANTS[1].label).toBe('强降噪');
  });
  it('groups CUGAN weights while preserving installed selections and unrelated models', () => {
    expect(groupUpscaleOptions([
      { value: 'realcugan-2x-conservative', label: 'old general' },
      { value: 'realcugan-2x-denoise3x', label: 'old manga' },
      { value: 'custom-cugan', label: 'Custom' },
    ])).toEqual([{ value: 'realcugan', label: 'Real-CUGAN' }, { value: 'custom-cugan', label: 'Custom' }]);
    expect(chooseUpscaleFamily('realcugan', 'realcugan-2x-denoise3x', [])).toBe('realcugan-2x-denoise3x');
    expect(chooseUpscaleFamily('realcugan', 'waifu2x-upconv7', ['realcugan-2x-denoise3x', 'realcugan-2x-conservative'])).toBe('realcugan-2x-denoise3x');
  });

  it('only exposes the actual native multiplier', () => {
    expect(upscaleScaleOptions(2)).toEqual([{ value: '0', label: '2×' }]);
    expect(upscaleScaleOptions(4)).toEqual([{ value: '0', label: '4×' }]);
  });

  it('does not reuse a different output size in memory', () => {
    const identity = { scopeId: 's', archiveId: 'a', pageIndex: 0, rendition: 'enhanced' as const, modelId: 'm' };
    expect(createImageCacheKey({ ...identity, outputScale: 1 })).not.toBe(createImageCacheKey({ ...identity, outputScale: 2 }));
    expect(createImageCacheKey({ ...identity, outputScale: 0 })).not.toBe(createImageCacheKey({ ...identity, outputScale: 2 }));
    expect(createImageCacheKey(identity)).toBe(createImageCacheKey({ ...identity, outputScale: 2 }));
  });
});
