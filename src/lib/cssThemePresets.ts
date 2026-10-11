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

/**
 * 自适应预设的注入槽。拆成四段而不是让调用方在尾巴上拼一个 `:root{...}`：
 * 尾巴上的裸 `:root` 是 (0,1,0)，而深色块 `:root[data-theme='dark']` 是 (0,1,1)，
 * 于是「看起来生效」的浅色尾巴在深色主题里会被整个压掉——一个令牌要么两支都写，
 * 要么写进浅色块里靠级联继承。这里让每段各归其位，就没有这种写法了。
 */
interface AdaptiveExtras {
  /** 与主题无关的令牌。写进浅色 :root；深色分支不重声明，于是两边同值。 */
  tokens?: string;
  /** 只属于浅色分支的令牌。排在 paletteCss 之后，同一条规则里后写者胜。 */
  lightTokens?: string;
  /** 只属于深色分支的令牌。显式属性与系统深色两条分支各写一份。 */
  darkTokens?: string;
  /** 与主题无关的规则，追加在所有主题块之后。 */
  rules?: string;
}

function adaptiveCss(light: Palette, dark: Palette, extras: AdaptiveExtras = {}): string {
  const { tokens = '', lightTokens = '', darkTokens = '', rules = '' } = extras;
  const darkCss = paletteCss(dark, true);
  return `:root {${paletteCss(light, false)}
  --radius-control: 6px;
  --radius-card: 8px;
  --radius-overlay: 8px;
${tokens}
${lightTokens}
}
:root[data-theme='dark'] {${darkCss}
${darkTokens}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {${darkCss}
${darkTokens}  }
}
html { scrollbar-color: var(--ink-faint) var(--surface-canvas); }
${rules}`;
}

/** 基础配色：一键套用的新配色方案。swatch 为菜单卡片的三色预览条。
 *
 * 浅色模式的三档（canvas → panel → elevated）必须真的分得开：底色是纸，不是白纸。
 * 用户报过「几个预设配色的浅色模式基本就是纯白」——根因就是 elevated 直接取了 #fbfdfa
 * 这类近乎纯白的值，铺满对话框和卡片之后整屏发白。现在这一族的亮度台阶是
 * 画布 ≤ .82、panel 高 .05 以上、elevated 再高 .04 以上且封顶 .95，
 * 由 tests/design-system-contract.test.ts 里那条「浅色配色不该靠近纯白」钉住。
 */
export const COLOR_SCHEMES: readonly ColorScheme[] = [
  { id: 'default', label: '默认', description: '回到应用默认主题。', css: '', swatch: ['#a83b32', '#4b635d', '#f5f2ed'] },
  {
    id: 'celadon', label: '青瓷', description: '青瓷绿主色与灰青纸面，安静耐看。',
    css: colorSchemeCss(
      { canvas: '#dcebe0', panel: '#e9f3ec', elevated: '#f3f9f5', muted: '#cfe2d5', ink: '#22312a', secondary: '#4e6d5d', faint: '#587263', accent: '#2c6b52', accentHover: '#245643', cyan: '#3b7a73' },
      { canvas: '#131f1a', panel: '#1b2923', elevated: '#24342d', muted: '#2b3f35', ink: '#dfece4', secondary: '#b2c9bb', faint: '#96ac9f', accent: '#82c6a6', accentHover: '#9bd8ba', cyan: '#6fb5ae' },
    ),
    swatch: ['#2c6b52', '#e9f3ec', '#82c6a6'],
  },
  {
    id: 'indigo-ink', label: '黛蓝', description: '墨蓝主色与冷调纸面，层级分明。',
    css: colorSchemeCss(
      { canvas: '#dbe3f1', panel: '#e8eefa', elevated: '#f3f7ff', muted: '#cbd9ee', ink: '#1f2a3d', secondary: '#455878', faint: '#556784', accent: '#3a5aa4', accentHover: '#2f4986', cyan: '#3d7f8f' },
      { canvas: '#131a28', panel: '#1b2537', elevated: '#243147', muted: '#2b3a52', ink: '#e2e9f6', secondary: '#b7c3dc', faint: '#93a3c0', accent: '#93b2ec', accentHover: '#acc6f4', cyan: '#6cb7c6' },
    ),
    swatch: ['#3a5aa4', '#e8eefa', '#93b2ec'],
  },
  {
    id: 'rosewood', label: '紫檀', description: '紫檀褐紫与暖灰纸面，沉稳内敛。',
    css: colorSchemeCss(
      { canvas: '#e9e0ec', panel: '#f2ebf5', elevated: '#faf6fc', muted: '#dccde1', ink: '#2d2333', secondary: '#5b4967', faint: '#6a5976', accent: '#7a4a73', accentHover: '#63395d', cyan: '#7a6390' },
      { canvas: '#1e1822', panel: '#291f2e', elevated: '#34283b', muted: '#3c2f45', ink: '#ece2f0', secondary: '#c6b3cf', faint: '#a995b4', accent: '#d5a3cd', accentHover: '#e3badb', cyan: '#ab96c4' },
    ),
    swatch: ['#7a4a73', '#f2ebf5', '#d5a3cd'],
  },
  {
    id: 'sakura', label: '绯樱', description: '樱粉纸面与玫红点睛，柔和明亮。',
    css: colorSchemeCss(
      { canvas: '#eedcdf', panel: '#f7e9eb', elevated: '#fdf5f6', muted: '#e3cbcf', ink: '#33242a', secondary: '#6d4c56', faint: '#7d5b66', accent: '#a3495d', accentHover: '#88394c', cyan: '#8f6470' },
      { canvas: '#221a1d', panel: '#2d2226', elevated: '#382a2f', muted: '#403136', ink: '#f2e6e9', secondary: '#d1b6bd', faint: '#b39aa2', accent: '#e6a6b4', accentHover: '#f1bcc8', cyan: '#c298a4' },
    ),
    swatch: ['#a3495d', '#f7e9eb', '#e6a6b4'],
  },
  {
    id: 'amber', label: '琥珀', description: '琥珀金主色与米黄纸面，温暖厚重。',
    css: colorSchemeCss(
      { canvas: '#ece0c4', panel: '#f6eddb', elevated: '#fdf8ec', muted: '#e0d2b2', ink: '#2f2818', secondary: '#6a5b3a', faint: '#796a49', accent: '#96691e', accentHover: '#7c5517', cyan: '#6f7d3f' },
      { canvas: '#211d13', panel: '#2c2718', elevated: '#373120', muted: '#3f3926', ink: '#f0e8d2', secondary: '#d0c39e', faint: '#b3a67f', accent: '#e5bc6c', accentHover: '#f1d088', cyan: '#a9b96e' },
    ),
    swatch: ['#96691e', '#f6eddb', '#e5bc6c'],
  },
];

export const CSS_THEME_PRESETS: readonly CssThemePreset[] = [
  { id: 'none', label: '无', description: '清空自定义 CSS，回到默认主题。', css: '' },
  /**
   * E-Hentai 经典：值全部抄自站点真实样式表，不留印象。
   *
   * 来源（本机抓取，`https://e-hentai.org/` 只有这一条外链样式表，站点全部
   * 规则都在里面、没有 inline 颜色）：
   *   首页       https://e-hentai.org/
   *   样式表     https://e-hentai.org/z/0381/g.css   29,949 字节
   *
   * 实测原样 → 落到哪个令牌：
   *   body{color:#5C0D11;background:#E3E0D1}          → --ink-primary / --surface-canvas
   *   table.itg>tbody>tr:nth-child(2n+1){#F2F0E4}     → --surface-panel（列表纸面最亮一档）
   *   table.mt{background:#E0DED3}                    → --surface-muted（信息表深一档）
   *   input:hover{background-color:#F3F0E0}           → --surface-elevated
   *   a{color:#5C0D11}                                → 与 --ink-primary 同值；base.css 已经写了
   *                                                     a{color:inherit}，所以静止态自动对上，
   *                                                     预设不需要再写一条 a{}
   *   a:hover{color:#8F4701}                          → --brand-vermilion-strong 与 rules 里的 a:hover
   *   a:visited .glink{color:#8F6063}                 → --ink-faint 与 rules 里的 a:visited
   *   td.itd{border-right:1px solid #D9D7CC}          → --hairline
   *   input[type=text]{border:2px solid #B5A4A4}      → --hairline-strong / --control-border
   *   input,select,textarea{background-color:#EDEADA} → --control-background
   *   input::placeholder{color:#9F746F}               → --control-placeholder
   *   .tha:hover / td.ptds{color:#9B4E03}             → --brand-vermilion（站点唯一的活动橙）
   *   .cs,.cn,.cw{color:#f1f1f1}                      → --ink-on-brand（站点反白按钮的字色）
   *   .ct6{...#2756AA...}                             → --brand-cyan / --category-game-cg
   *   div.gt{background:#F2EFDF;border:1px solid #806769;border-radius:5px}
   *                                                   → --chip-background / --chip-ink / --radius-overlay
   *   input[type=text]{border-radius:3px}             → --radius-control / --radius-card
   *   :root{font-size:9pt;font-family:arial,helvetica,sans-serif}
   *                                                   → --text-* / --font-body（9pt≈12px，站点只有
   *                                                     8/9/10/11/12/14pt 六档，这里按同比例缩放）
   *   #nb{line-height:19px}、td.gdt1{height:17px}     → --leading-normal: 1.42（19/13.5px 行盒）
   *   td.itd{padding:3px 4px}                         → --space-1: 3px
   *   .ct1–.cta 那十个分类色块                        → --category-*（一一对应，见下）
   *
   * 两处刻意不照抄站点，都有理由：
   *  1. EH 自己的次要文字色跑不过本仓库的对比度合同：分页灰 #C2A8A4 在 #F2F0E4 上
   *     约 3.4:1、已访问 #8F6063 在 #EDEBDF 上只有 4.375:1，都低于 4.5:1。
   *     所以正文分级退回站点唯一的那档文字色 #5C0D11/#5C0D12，faint 用刚好过线的
   *     #8F6063（在 #F2F0E4 上 4.566:1）。EH 正文本来也只有一档，层级靠字重与字号，
   *     这里还原的是它的排版逻辑而不是它的低对比。
   *  2. EH 没有深色皮肤。深色分支照同一族暖褐纸面推导，只保证两件事：画布够黑
   *     （预设合同要求 luminance < .1，取 #1C1714≈0.009）与活动色仍是暖橙。
   *
   * 另外不动 `--radius-pill`（999px，被圆形开关/进度条复用，是刻意的另一种形状）
   * 与 `--text-title`/`--text-page-title`（EH 没有对应的大字号，属于应用自身 chrome）。
   */
  {
    id: 'ehentai-classic', label: 'E-Hentai 经典', description: '米黄纸面、砖红墨色与砖橙活动色，直角细边框，贴近 E-Hentai 站点原样。',
    css: adaptiveCss(
      { canvas: '#E3E0D1', panel: '#F2F0E4', elevated: '#F3F0E0', muted: '#E0DED3', ink: '#5C0D11', secondary: '#5C0D12', faint: '#8F6063', accent: '#9B4E03', accentHover: '#8F4701', cyan: '#2756AA' },
      { canvas: '#1C1714', panel: '#2A2320', elevated: '#352C28', muted: '#221D1A', ink: '#F0E4D8', secondary: '#D8C4B4', faint: '#C79A6A', accent: '#E09248', accentHover: '#F0A860', cyan: '#7FA8E8' },
      {
        tokens: `  /* 站点是直角：输入框和标签都是 border-radius:3px，栏位 5px。 */
  --radius-control: 3px;
  --radius-card: 3px;
  --radius-overlay: 5px;
  /* 站点全篇没有投影，列表靠 1px 分隔线分行。 */
  --shadow-card: none;
  /* :root{font-size:9pt} 加站点的 8/9/10/11/12/14pt 六档，等比挪到应用的档位上。 */
  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-base: 14px;
  --text-lg: 17px;
  --text-heading: 19px;
  /* #nb{line-height:19px}、td.gdt1{height:17px}：站点是 13px 字配 19px 行盒。 */
  --leading-tight: 1.25;
  --leading-snug: 1.35;
  --leading-normal: 1.42;
  --leading-relaxed: 1.55;
  /* td.itd{padding:3px 4px}。 */
  --space-1: 3px;
  /* 站点只有 arial/helvetica（正文）与 verdana（表格右侧计数）。中文字形 EH 交给
     系统兜底，这里同样让拉丁走 Arial、中文回退到应用自带的 Noto。 */
  --font-body: Arial, Helvetica, "Noto Sans SC Variable", "Noto Sans JP Variable", ui-sans-serif, system-ui, sans-serif;
  --font-display: Arial, Helvetica, "Noto Sans SC Variable", "Noto Sans JP Variable", ui-sans-serif, system-ui, sans-serif;
  /* g.css 的 .ct1–.cta，取每块 radial-gradient 的起始色（外圈深色）。
     .ct1 无注释即未分类；.ct2 misc；.ct3 doujinshi；.ct4 manga；.ct5 artistcg；
     .ct6 gamecg；.ct7 imageset；.ct8 cosplay；.ct9 asianporn；.cta nonh。
     站点的 western 没有对应色块，所以 --category-western 保持默认，不瞎编。 */
  --category-default: #707070;
  --category-misc: #FC4E4E;
  --category-doujinshi: #E78C1A;
  --category-manga: #C7BF07;
  --category-artist-cg: #1A9317;
  --category-game-cg: #2756AA;
  --category-image-set: #8800C3;
  --category-cosplay: #B452A5;
  --category-asian-porn: #0F9EBD;
  --category-non-h: #5DC13B;
`,
        lightTokens: `  /* 站点反白按钮的字色（.cs/.cn/.cw） */
  --ink-on-brand: #F1F1F1;
  --hairline: #D9D7CC;
  --hairline-strong: #B5A4A4;
  --control-background: #EDEADA;
  --control-background-hover: #F3F0E0;
  --control-border: #B5A4A4;
  --control-placeholder: #9F746F;
  /* div.gt 标签：米黄方块 + 砖红字。 */
  --chip-background: #F2EFDF;
  --chip-ink: #5C0D11;
`,
        darkTokens: `  /* EH 无深色皮肤，以下全部由浅色分支同一族暖褐推导。 */
  --ink-on-brand: #17191B;
  --hairline: #453A33;
  --hairline-strong: #6B574A;
  --control-background: #2A2320;
  --control-background-hover: #352C28;
  --control-border: #6B574A;
  --control-placeholder: #A08A78;
  --chip-background: #3A302A;
  --chip-ink: #F0E4D8;
`,
        rules: `/* td.itd 那一行：1px 暖灰分隔线，没有投影。 */
.archive-row { border: 1px solid var(--hairline); box-shadow: none; }

/* 站点整页铺满（table.itg{width:99%}），不留居中细栏。 */
.workspace { max-width: none; }

/* EH 只在这两个状态换链接色：悬停到砖橙、访问过转灰粉。静止态与正文同色，
   由 base.css 的 a{color:inherit} 经 --ink-primary 拿到，这里不重复声明。
   深色分支单独写一份，否则暖橙在暖褐底上会糊掉。 */
a:hover { color: #8F4701; }
a:visited { color: #8F6063; }
:root[data-theme='dark'] a:hover { color: #F0A860; }
:root[data-theme='dark'] a:visited { color: #C79A6A; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) a:hover { color: #F0A860; }
  :root:not([data-theme]) a:visited { color: #C79A6A; }
}

/* 标签链接沿用应用自己的钩子，取站点的标签配色。 */
.tag-search-link { color: var(--brand-vermilion); }
.tag-search-link:hover { color: var(--brand-vermilion-strong); text-decoration: underline; }
`,
      },
    ),
  },
];

/** Presets are saved as CSS, not IDs. Upgrade exact matches only. */
export function upgradeCssThemePreset(css: string): string {
  const previous = legacyPresets.find((preset) => preset.css === css);
  return previous ? CSS_THEME_PRESETS.find((preset) => preset.id === previous.id)?.css ?? css : css;
}
