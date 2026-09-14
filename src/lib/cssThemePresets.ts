import { CSS_THEME_PRESETS as legacyPresets } from './legacyCssThemePresets';

export interface CssThemePreset {
  id: string;
  label: string;
  description: string;
  css: string;
}

/** 基础配色方案：同预设，但额外带一个三色条用于菜单里的卡片预览。 */
export interface ColorScheme extends CssThemePreset {
  swatch: [string, string, string];
}

interface Palette {
  canvas: string;
  panel: string;
  elevated: string;
  muted: string;
  ink: string;
  secondary: string;
  faint: string;
  accent: string;
  accentHover: string;
  cyan: string;
}

function paletteCss(p: Palette, dark: boolean): string {
  const onBrand = dark ? '#17191b' : '#ffffff';
  return `
  color-scheme: ${dark ? 'dark' : 'light'};
  /* M3 角色整套覆盖：组件样式读的是这些语义 token，缺了就只剩部分背景被换色。 */
  --primary: ${p.accent};
  --on-primary: ${onBrand};
  --primary-hover: ${p.accentHover};
  --primary-container: color-mix(in srgb, ${p.accent} 24%, ${p.panel});
  --on-primary-container: ${p.ink};
  --secondary: ${p.cyan};
  --on-secondary: ${onBrand};
  --secondary-hover: color-mix(in srgb, ${p.cyan} 78%, ${p.ink});
  --secondary-container: color-mix(in srgb, ${p.cyan} 22%, ${p.panel});
  --on-secondary-container: ${p.ink};
  --tertiary: ${p.accentHover};
  --on-tertiary: ${onBrand};
  --tertiary-container: color-mix(in srgb, ${p.accentHover} 22%, ${p.panel});
  --on-tertiary-container: ${p.ink};
  --surface: ${p.canvas};
  --surface-container-low: ${p.panel};
  --surface-container: color-mix(in srgb, ${p.ink} 6%, ${p.panel});
  --surface-container-high: color-mix(in srgb, ${p.ink} 12%, ${p.panel});
  --surface-container-highest: color-mix(in srgb, ${p.ink} 18%, ${p.panel});
  --on-surface: ${p.ink};
  --on-surface-variant: ${p.secondary};
  --outline: var(--hairline-strong);
  --outline-variant: var(--hairline);
  --inverse-surface: ${p.ink};
  --inverse-on-surface: ${dark ? '#17191b' : p.panel};
  --inverse-primary: ${p.accent};
  --success: ${dark ? '#8dc4a5' : '#396c51'};
  --on-success: ${onBrand};
  --success-container: color-mix(in srgb, ${dark ? '#8dc4a5' : '#396c51'} 22%, ${p.panel});
  --on-success-container: ${p.ink};
  --warning: ${dark ? '#d8b77e' : '#856027'};
  --on-warning: ${dark ? '#17191b' : '#ffffff'};
  --warning-container: color-mix(in srgb, ${dark ? '#d8b77e' : '#856027'} 22%, ${p.panel});
  --on-warning-container: ${p.ink};
  --error: ${dark ? '#e6a0ae' : '#a04a5e'};
  --on-error: ${onBrand};
  --error-container: color-mix(in srgb, ${dark ? '#e6a0ae' : '#a04a5e'} 22%, ${p.panel});
  --on-error-container: ${p.ink};
  /* 旧别名（迁移期兼容），与新角色保持同值。 */
  --surface-canvas: ${p.canvas};
  --surface-panel: ${p.panel};
  --surface-elevated: ${p.elevated};
  --surface-muted: ${p.muted};
  --surface-overlay: ${dark ? 'rgb(10 12 14 / .94)' : 'rgb(35 38 40 / .9)'};
  --backdrop-overlay: rgb(0 0 0 / ${dark ? '.72' : '.56'});
  --ink-primary: ${p.ink};
  --ink-secondary: ${p.secondary};
  --ink-faint: ${p.faint};
  --ink-on-brand: ${onBrand};
  --ink-on-overlay: #ffffff;
  --brand-ink: ${p.ink};
  --brand-vermilion: ${p.accent};
  --brand-vermilion-strong: ${p.accentHover};
  --brand-paper: ${p.muted};
  --brand-violet: ${p.secondary};
  --brand-cyan: ${p.cyan};
  --state-success: ${dark ? '#8dc4a5' : '#396c51'};
  --state-warning: ${dark ? '#d8b77e' : '#856027'};
  --state-danger: ${dark ? '#e6a0ae' : '#a04a5e'};
  --hairline: color-mix(in srgb, ${p.ink} 18%, ${p.panel});
  --hairline-strong: color-mix(in srgb, ${p.ink} 40%, ${p.panel});
  --focus-ring: ${p.accent};
  --focus-shadow: 0 0 0 3px color-mix(in srgb, ${p.accent} 28%, transparent);
  --selection-background: ${p.accent};
  --selection-ink: var(--ink-on-brand);
  --control-background: ${p.elevated};
  --control-background-hover: ${p.muted};
  --control-border: var(--hairline-strong);
  --control-text: ${p.ink};
  --control-placeholder: ${p.faint};
  --control-selected-background: ${p.accent};
  --control-selected-text: var(--ink-on-brand);
  --shadow-menu: 0 12px 30px rgb(0 0 0 / ${dark ? '.45' : '.16'});
  --shadow-overlay: 0 24px 64px rgb(0 0 0 / ${dark ? '.55' : '.24'});
  --shadow-tooltip: 0 6px 18px rgb(0 0 0 / ${dark ? '.4' : '.14'});
  --shadow-card: 0 4px 14px rgb(0 0 0 / ${dark ? '.28' : '.08'});
`;
}

/** 基础配色只动颜色变量：不碰圆角、组件结构与滚动条，保持应用原形状。 */
function colorSchemeCss(light: Palette, dark: Palette): string {
  const darkCss = paletteCss(dark, true);
  // Explicit mode wins over the OS; system mode is represented by no data-theme.
  return `:root {${paletteCss(light, false)}
}
:root[data-theme='dark'] {${darkCss}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {${darkCss}  }
}
`;
}

function adaptiveCss(light: Palette, dark: Palette, extra = ''): string {
  const darkCss = paletteCss(dark, true);
  return `:root {${paletteCss(light, false)}
  --radius-control: 6px;
  --radius-card: 8px;
  --radius-overlay: 8px;
}
:root[data-theme='dark'] {${darkCss}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {${darkCss}  }
}
html { scrollbar-color: var(--ink-faint) var(--surface-canvas); }
${extra}`;
}

/** 基础配色：一键套用的新配色方案。swatch 为菜单卡片的三色预览条。 */
export const COLOR_SCHEMES: readonly ColorScheme[] = [
  { id: 'default', label: '默认', description: '回到应用默认主题。', css: '', swatch: ['#a83b32', '#4b635d', '#f5f2ed'] },
  {
    id: 'celadon', label: '青瓷', description: '青瓷绿主色与灰青纸面，安静耐看。',
    css: colorSchemeCss(
      { canvas: '#e7efe9', panel: '#f1f7f2', elevated: '#fbfdfa', muted: '#d6e4d9', ink: '#22312a', secondary: '#4e6d5d', faint: '#587263', accent: '#2c6b52', accentHover: '#245643', cyan: '#3b7a73' },
      { canvas: '#131f1a', panel: '#1b2923', elevated: '#24342d', muted: '#2b3f35', ink: '#dfece4', secondary: '#b2c9bb', faint: '#96ac9f', accent: '#82c6a6', accentHover: '#9bd8ba', cyan: '#6fb5ae' },
    ),
    swatch: ['#2c6b52', '#f1f7f2', '#82c6a6'],
  },
  {
    id: 'indigo-ink', label: '黛蓝', description: '墨蓝主色与冷调纸面，层级分明。',
    css: colorSchemeCss(
      { canvas: '#e6eaf2', panel: '#f1f4fa', elevated: '#fbfcff', muted: '#d4deee', ink: '#1f2a3d', secondary: '#455878', faint: '#556784', accent: '#3a5aa4', accentHover: '#2f4986', cyan: '#3d7f8f' },
      { canvas: '#131a28', panel: '#1b2537', elevated: '#243147', muted: '#2b3a52', ink: '#e2e9f6', secondary: '#b7c3dc', faint: '#93a3c0', accent: '#93b2ec', accentHover: '#acc6f4', cyan: '#6cb7c6' },
    ),
    swatch: ['#3a5aa4', '#f1f4fa', '#93b2ec'],
  },
  {
    id: 'rosewood', label: '紫檀', description: '紫檀褐紫与暖灰纸面，沉稳内敛。',
    css: colorSchemeCss(
      { canvas: '#efe9f0', panel: '#f8f3f9', elevated: '#fdfbff', muted: '#e1d6e4', ink: '#2d2333', secondary: '#5b4967', faint: '#6a5976', accent: '#7a4a73', accentHover: '#63395d', cyan: '#7a6390' },
      { canvas: '#1e1822', panel: '#291f2e', elevated: '#34283b', muted: '#3c2f45', ink: '#ece2f0', secondary: '#c6b3cf', faint: '#a995b4', accent: '#d5a3cd', accentHover: '#e3badb', cyan: '#ab96c4' },
    ),
    swatch: ['#7a4a73', '#f8f3f9', '#d5a3cd'],
  },
  {
    id: 'sakura', label: '绯樱', description: '樱粉纸面与玫红点睛，柔和明亮。',
    css: colorSchemeCss(
      { canvas: '#f2e9ea', panel: '#faf2f3', elevated: '#fffbfb', muted: '#e7d4d7', ink: '#33242a', secondary: '#6d4c56', faint: '#7d5b66', accent: '#a3495d', accentHover: '#88394c', cyan: '#8f6470' },
      { canvas: '#221a1d', panel: '#2d2226', elevated: '#382a2f', muted: '#403136', ink: '#f2e6e9', secondary: '#d1b6bd', faint: '#b39aa2', accent: '#e6a6b4', accentHover: '#f1bcc8', cyan: '#c298a4' },
    ),
    swatch: ['#a3495d', '#faf2f3', '#e6a6b4'],
  },
  {
    id: 'amber', label: '琥珀', description: '琥珀金主色与米黄纸面，温暖厚重。',
    css: colorSchemeCss(
      { canvas: '#f1ead9', panel: '#faf4e6', elevated: '#fffdf4', muted: '#e5dac1', ink: '#2f2818', secondary: '#6a5b3a', faint: '#796a49', accent: '#96691e', accentHover: '#7c5517', cyan: '#6f7d3f' },
      { canvas: '#211d13', panel: '#2c2718', elevated: '#373120', muted: '#3f3926', ink: '#f0e8d2', secondary: '#d0c39e', faint: '#b3a67f', accent: '#e5bc6c', accentHover: '#f1d088', cyan: '#a9b96e' },
    ),
    swatch: ['#96691e', '#faf4e6', '#e5bc6c'],
  },
];

export const CSS_THEME_PRESETS: readonly CssThemePreset[] = [
  { id: 'none', label: '无', description: '清空自定义 CSS，回到默认主题。', css: '' },
  {
    id: 'ehentai-classic', label: 'E-Hentai 经典', description: '冷灰底、蓝链与紧凑信息密度，贴近 E-Hentai 站点外观。',
    css: adaptiveCss(
      { canvas: '#dcdcdc', panel: '#e6e6e6', elevated: '#f2f2f2', muted: '#cccccc', ink: '#2f2f2f', secondary: '#4f4f4f', faint: '#5e5e5e', accent: '#3d64b8', accentHover: '#2f51a0', cyan: '#4a7fb5' },
      { canvas: '#171717', panel: '#1f1f1f', elevated: '#292929', muted: '#333333', ink: '#e6e6e6', secondary: '#c2c2c2', faint: '#9e9e9e', accent: '#8bacea', accentHover: '#a3bff0', cyan: '#7d9cc9' },
      `:root { --radius-control: 2px; --radius-card: 3px; --radius-overlay: 4px; --shadow-card: none; --text-md: 13px; }
.archive-row { border: 1px solid var(--hairline); box-shadow: none; }
.tag-search-link { color: var(--brand-vermilion); }
.tag-search-link:hover { color: var(--brand-vermilion-strong); text-decoration: underline; }
.workspace { max-width: none; }
`,
    ),
  },
];

/** Presets are saved as CSS, not IDs. Upgrade exact matches only. */
export function upgradeCssThemePreset(css: string): string {
  const previous = legacyPresets.find((preset) => preset.css === css);
  return previous ? CSS_THEME_PRESETS.find((preset) => preset.id === previous.id)?.css ?? css : css;
}
