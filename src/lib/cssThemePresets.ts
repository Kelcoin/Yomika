/** Ready-made themes for the custom CSS box.
 *
 * Every preset is plain CSS against the documented token names, so a user can
 * start from one and edit it — the point of moving from a single accent colour
 * to a CSS blob.
 */
export interface CssThemePreset {
  id: string;
  label: string;
  description: string;
  css: string;
}

export const CSS_THEME_PRESETS: readonly CssThemePreset[] = [
  {
    id: 'none',
    label: '无',
    description: '清空自定义 CSS，回到默认主题。',
    css: '',
  },
  {
    id: 'ink',
    label: '水墨',
    description: '低饱和灰蓝，弱化描边与阴影。',
    css: `:root {
  --brand-vermilion: #3f6b7d;
  --brand-cyan: #6b8f9c;
  --hairline: color-mix(in srgb, #3f6b7d 16%, transparent);
}

.archive-row,
.settings-section,
.panel {
  box-shadow: none;
}
`,
  },
  {
    id: 'amber',
    label: '暖灯',
    description: '琥珀色强调，纸张感底色。',
    css: `:root {
  --brand-vermilion: #b4731f;
  --brand-cyan: #8a6a3a;
  --brand-paper: #f6efe3;
}

.metadata-chip {
  border-radius: 999px;
}
`,
  },
  {
    id: 'contrast',
    label: '高对比',
    description: '加粗描边与文字，适合强光环境。',
    css: `:root {
  --hairline: color-mix(in srgb, currentColor 42%, transparent);
  --ink-secondary: var(--ink-primary);
}

strong,
h1,
h2,
h3 {
  font-weight: 780;
}

button,
a {
  text-underline-offset: 3px;
}
`,
  },
  {
    id: 'compact',
    label: '紧凑',
    description: '缩小卡片与列表间距，一屏放更多内容。',
    css: `.archive-row-tags .metadata-chip {
  min-height: 16px;
  font-size: 9px;
  line-height: 16px;
}

.workspace {
  padding-top: 20px;
  padding-bottom: 48px;
}
`,
  },
];
