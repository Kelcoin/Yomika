import { CSS_THEME_PRESETS as legacyPresets } from './legacyCssThemePresets';

export interface CssThemePreset {
  id: string;
  label: string;
  description: string;
  css: string;
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
  return `
  color-scheme: ${dark ? 'dark' : 'light'};
  --surface-canvas: ${p.canvas};
  --surface-panel: ${p.panel};
  --surface-elevated: ${p.elevated};
  --surface-muted: ${p.muted};
  --surface-overlay: ${dark ? 'rgb(10 12 14 / .94)' : 'rgb(35 38 40 / .9)'};
  --backdrop-overlay: rgb(0 0 0 / ${dark ? '.72' : '.56'});
  --ink-primary: ${p.ink};
  --ink-secondary: ${p.secondary};
  --ink-faint: ${p.faint};
  --ink-on-brand: ${dark ? '#17191b' : '#ffffff'};
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

function adaptiveCss(light: Palette, dark: Palette, extra = ''): string {
  const darkCss = paletteCss(dark, true);
  // Explicit mode wins over the OS; system mode is represented by no data-theme.
  return `:root {${paletteCss(light, false)}
  --radius-control: 6px;
  --radius-card: 8px;
  --radius-overlay: 8px;
}
:root[data-theme='dark'] {${darkCss}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {${darkCss}  }
}
.metadata-chip { border-radius: 4px; }
html { scrollbar-color: var(--ink-faint) var(--surface-canvas); }
${extra}`;
}

export const CSS_THEME_PRESETS: readonly CssThemePreset[] = [
  { id: 'none', label: '无', description: '清空自定义 CSS，回到默认主题。', css: '' },
  {
    id: 'morandi', label: '莫兰迪', description: '灰绿、雾粉与灰蓝，随深浅主题柔和切换。',
    css: adaptiveCss(
      { canvas: '#e5e8e5', panel: '#f1f3ef', elevated: '#fafbf8', muted: '#d8dfda', ink: '#303b36', secondary: '#505f59', faint: '#5d6963', accent: '#87616b', accentHover: '#714e58', cyan: '#607d88' },
      { canvas: '#222927', panel: '#2b3430', elevated: '#343e39', muted: '#3b4741', ink: '#e5ebe5', secondary: '#c1cdc4', faint: '#a8b8ae', accent: '#d1a8b3', accentHover: '#e0bbc4', cyan: '#a1bcc5' },
    ),
  },
  {
    id: 'paper-reading', label: '纸张阅读', description: '白昼纸张与夜间暖墨，跟随深浅主题。',
    css: adaptiveCss(
      { canvas: '#eee8dc', panel: '#f8f4eb', elevated: '#fffdf7', muted: '#e3dccf', ink: '#29251f', secondary: '#625a4f', faint: '#71685c', accent: '#9d4b35', accentHover: '#7f3928', cyan: '#506e6b' },
      { canvas: '#24211d', panel: '#2f2a24', elevated: '#39322b', muted: '#453c31', ink: '#eee5d6', secondary: '#cdc0ab', faint: '#b6a891', accent: '#dda38a', accentHover: '#edbba4', cyan: '#9dbbb3' },
    ),
  },
  {
    id: 'navy-workbench', label: '海军蓝工作台', description: '日间蓝灰与夜间海军蓝，清晰区分控件层级。',
    css: adaptiveCss(
      { canvas: '#e7eef4', panel: '#f3f7fa', elevated: '#ffffff', muted: '#d9e4ee', ink: '#203246', secondary: '#496174', faint: '#566d80', accent: '#345e86', accentHover: '#294c6d', cyan: '#39717e' },
      { canvas: '#101a27', panel: '#172536', elevated: '#203246', muted: '#294054', ink: '#e8f0f7', secondary: '#b5c5d3', faint: '#91a6b8', accent: '#e08a62', accentHover: '#f1a47d', cyan: '#69b7c4' },
    ),
  },
  {
    id: 'ehentai-classic', label: 'E-Hentai 经典', description: '经典灰底与细边框，浅色蓝链、深色柔蓝。',
    css: adaptiveCss(
      { canvas: '#dedede', panel: '#e9e9e9', elevated: '#f5f5f5', muted: '#cfcfcf', ink: '#303030', secondary: '#555555', faint: '#646464', accent: '#4e639d', accentHover: '#40558d', cyan: '#506f97' },
      { canvas: '#202020', panel: '#2b2b2b', elevated: '#353535', muted: '#414141', ink: '#ededed', secondary: '#c3c3c3', faint: '#aaaaaa', accent: '#a6b7e5', accentHover: '#c0cdf0', cyan: '#9dbad9' },
      `:root { --radius-control: 3px; --radius-card: 4px; --radius-overlay: 5px; --shadow-card: none; }
.archive-row { border: 1px solid var(--hairline); box-shadow: none; }
.tag-search-link { color: var(--brand-vermilion); }
.tag-search-link:hover { color: var(--brand-vermilion-strong); }
`,
    ),
  },
];

/** Presets are saved as CSS, not IDs. Upgrade exact matches only. */
export function upgradeCssThemePreset(css: string): string {
  const previous = legacyPresets.find((preset) => preset.css === css);
  return previous ? CSS_THEME_PRESETS.find((preset) => preset.id === previous.id)?.css ?? css : css;
}
