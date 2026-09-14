import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { COLOR_SCHEMES, CSS_THEME_PRESETS, upgradeCssThemePreset } from './cssThemePresets';
import { CSS_THEME_PRESETS as legacyPresets } from './legacyCssThemePresets';

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((n) => parseInt(n, 16) / 255)
    .map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}

describe('preset theme modes', () => {
  it('upgrades saved presets without replacing user edits or clearing the default', () => {
    for (const old of legacyPresets) {
      const upgraded = upgradeCssThemePreset(old.css);
      const current = CSS_THEME_PRESETS.find((preset) => preset.id === old.id);
      if (current) {
        // 仍存在的预设：精确升级到新 CSS。
        expect(upgraded).toBe(current.css);
      } else {
        // 已移除的纯配色预设：原样保留，不动用户已保存的数据。
        expect(upgraded).toBe(old.css);
      }
      const edited = `${old.css}\n/* user customization */`;
      expect(upgradeCssThemePreset(edited)).toBe(edited);
    }
    expect(upgradeCssThemePreset('')).toBe('');
    for (const current of CSS_THEME_PRESETS) {
      expect(upgradeCssThemePreset(current.css)).toBe(current.css);
    }
    for (const scheme of COLOR_SCHEMES) {
      expect(upgradeCssThemePreset(scheme.css)).toBe(scheme.css);
    }
  });
  for (const preset of [...CSS_THEME_PRESETS, ...COLOR_SCHEMES].filter((p) => p.css)) {
    for (const mode of ['light', 'dark', 'system'] as const) {
      for (const systemDark of [false, true]) {
        it(`${preset.id}: ${mode}, system dark=${systemDark}`, () => {
          const root = document.documentElement;
          if (mode === 'system') root.removeAttribute('data-theme');
          else root.setAttribute('data-theme', mode);
          const values = new Map<string, string>();
          postcss.parse(preset.css).walkRules((rule) => {
            if (rule.parent?.type === 'atrule' && !systemDark) return;
            if (!root.matches(rule.selector)) return;
            rule.walkDecls((d) => { values.set(d.prop, d.value); });
          });
          const resolve = (name: string): string => {
            const value = values.get(name);
            if (!value) throw new Error(`Missing ${name}`);
            return value.startsWith('var(') ? resolve(value.slice(4, -1)) : value;
          };
          const dark = mode === 'dark' || (mode === 'system' && systemDark);
          expect(resolve('color-scheme')).toBe(dark ? 'dark' : 'light');
          expect(luminance(resolve('--surface-canvas')) < .1).toBe(dark);
          // Navigation, muted text, primary actions and selected controls must all be legible.
          for (const [fg, bg] of [
            ['--brand-ink', '--brand-paper'],
            ['--ink-primary', '--surface-canvas'],
            ['--ink-secondary', '--surface-panel'],
            ['--ink-faint', '--surface-panel'],
            ['--ink-on-brand', '--brand-vermilion'],
            ['--ink-on-brand', '--brand-vermilion-strong'],
            ['--control-selected-text', '--control-selected-background'],
          ]) {
            const a = luminance(resolve(fg!));
            const b = luminance(resolve(bg!));
            expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
          }
          root.removeAttribute('data-theme');
        });
      }
    }
  }
});
