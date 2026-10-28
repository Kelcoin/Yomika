/** These are distinct verified weights, grouped only in the user interface. */
export const CUGAN_VARIANTS = [
  { value: 'realcugan-2x-conservative', label: '保守' },
  { value: 'realcugan-2x-denoise3x', label: '强降噪' },
] as const;

export function upscaleFamily(id: string): string {
  return CUGAN_VARIANTS.some((variant) => variant.value === id) ? 'realcugan' : id;
}

/** Stable product names, independent of catalog quality/scale annotations. */
export function upscaleModelLabel(id: string, fallback?: string): string {
  const names: Record<string, string> = {
    'waifu2x-upconv7': 'Waifu2x',
    anime4k: 'Anime4K', 'anime4k-hq': 'Anime4K', 'anime4k-ultra': 'Anime4K',
    realcugan: 'Real-CUGAN',
    'span-nomosuni-photo': 'NomosUni Photo',
    'realesr-general': 'Real-ESRGAN', 'realesr-general-x4v3': 'Real-ESRGAN',
    'realesrgan-x4plus': 'Real-ESRGAN Plus',
    'aletheia-lens': 'Aletheia Lens', '4x-Fatal-Pixels': 'Fatal Pixels',
    'imported-model': '导入的模型',
  };
  return names[upscaleFamily(id)] ?? fallback ?? id.replaceAll('-', ' ');
}

export function chooseUpscaleFamily(family: string, current: string, installed: readonly string[]): string {
  if (family !== 'realcugan') return family;
  if (upscaleFamily(current) === family) return current;
  return installed.find((id) => upscaleFamily(id) === family) ?? CUGAN_VARIANTS[0].value;
}

export function groupUpscaleOptions(options: { value: string; label: string }[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const family = upscaleFamily(option.value);
    if (seen.has(family)) return [];
    seen.add(family);
    return [{ value: family, label: upscaleModelLabel(family, option.label) }];
  });
}

/** Fixed-scale graphs expose only their actual native multiplier. */
export function upscaleScaleOptions(nativeScale: number): { value: string; label: string }[] {
  const scale = Math.min(4, Math.max(1, Math.floor(nativeScale)));
  return [{ value: '0', label: `${scale}×` }];
}
