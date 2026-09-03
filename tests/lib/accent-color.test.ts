import { describe, expect, it } from 'vitest';

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_COLOR,
  contrastRatio,
  isAccessibleAccent,
  normalizeAccentColor,
} from '../../src/lib/accentColor';

describe('accent colour', () => {
  it('accepts hex with or without the hash, and expands shorthand', () => {
    expect(normalizeAccentColor('#B63A2E')).toBe('#b63a2e');
    expect(normalizeAccentColor('b63a2e')).toBe('#b63a2e');
    expect(normalizeAccentColor(' #ABC ')).toBe('#aabbcc');
  });

  it('rejects anything that is not a hex colour', () => {
    expect(normalizeAccentColor('')).toBeUndefined();
    expect(normalizeAccentColor('red')).toBeUndefined();
    expect(normalizeAccentColor('#12345')).toBeUndefined();
    expect(normalizeAccentColor('#gggggg')).toBeUndefined();
  });

  it('computes WCAG contrast against white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(isAccessibleAccent('#767676')).toBe(true);
    expect(isAccessibleAccent('#ffe066')).toBe(false);
  });

  it('ships presets that all clear AA on white', () => {
    expect(isAccessibleAccent(DEFAULT_ACCENT_COLOR)).toBe(true);
    for (const preset of ACCENT_PRESETS) {
      expect(normalizeAccentColor(preset.value)).toBe(preset.value);
      expect(isAccessibleAccent(preset.value), `${preset.label} ${preset.value}`).toBe(true);
    }
  });
});
