/** Accent colour handling for the custom-theme setting.
 *
 * The design system funnels every accent through `--brand-vermilion`, so a
 * custom accent is one variable override plus its derived shades. Keep the
 * maths here (pure, testable) rather than in the component.
 */
export const DEFAULT_ACCENT_COLOR = '#b63a2e';

export const ACCENT_PRESETS = [
  { value: '#b63a2e', label: '朱红' },
  { value: '#1f6f8b', label: '靛蓝' },
  { value: '#2f7a4d', label: '竹绿' },
  { value: '#7a4e9c', label: '紫藤' },
  { value: '#a05f10', label: '琥珀' },
  { value: '#3f4a55', label: '墨灰' },
] as const;

export function normalizeAccentColor(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-f]{3}$/.test(withHash)) {
    const [, r, g, b] = withHash;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return /^#[0-9a-f]{6}$/.test(withHash) ? withHash : undefined;
}

function channels(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function relativeLuminance(color: string): number {
  const linear = channels(color).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG 2.1 contrast ratio, rounded to two decimals. */
export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return Math.round(((lighter! + 0.05) / (darker! + 0.05)) * 100) / 100;
}

/** Accent colours carry white text on buttons, so 4.5:1 against white is the
 * bar that matters (WCAG AA for normal text). */
export function isAccessibleAccent(color: string): boolean {
  return contrastRatio(color, '#ffffff') >= 4.5;
}
