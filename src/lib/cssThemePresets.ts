/** 用户可见的 CSS 主题预设：一套是配色方案（`COLOR_SCHEMES`），一套是完整的自定义
 *  CSS（`CSS_THEME_PRESETS`），两者都能被用户存下来、下次启动时按 id 认回来。
 *
 * 升级路径在这里：`legacyCssThemePresets.ts` 只保留**旧值**，存过的预设经
 * `upgradeCssThemePreset` 对齐到当前令牌，认不出来的才退回默认。上游那份 CSS 的
 * 出处与逐条映射写在常量旁边，别搬到这里。
 */
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
  { id: 'default', label: '默认', description: '朱砂×青瓷×琥珀的品牌色系，温暖平衡。', css: '', swatch: ['#a83b32', '#4b635d', '#f5f2ed'] },
  {
    id: 'celadon', label: '青瓷', description: '青瓷绿主色与灰青纸面，静谧清雅。',
    css: colorSchemeCss(
      { canvas: '#e1ebe4', panel: '#ecf4ee', elevated: '#f5faf7', muted: '#d4e0d8', ink: '#1f2d26', secondary: '#4a6556', faint: '#587466', accent: '#2a7556', accentHover: '#225e45', cyan: '#3d8a82' },
      { canvas: '#141f1a', panel: '#1c2a24', elevated: '#26362f', muted: '#2e413a', ink: '#e3ede7', secondary: '#b5cabf', faint: '#99b0a3', accent: '#7fd1b0', accentHover: '#99ddc2', cyan: '#6ec0b8' },
    ),
    swatch: ['#2a7556', '#ecf4ee', '#7fd1b0'],
  },
  {
    id: 'indigo-ink', label: '黛蓝', description: '墨蓝主色与冷灰纸面，沉稳专业。',
    css: colorSchemeCss(
      { canvas: '#dee6f2', panel: '#eaf1fa', elevated: '#f5f9ff', muted: '#d0dff0', ink: '#1b2638', secondary: '#3f5370', faint: '#526688', accent: '#3660aa', accentHover: '#2d4d8a', cyan: '#3e8599' },
      { canvas: '#131b29', panel: '#1c263a', elevated: '#26334a', muted: '#2f3e58', ink: '#e5ecf7', secondary: '#bac8de', faint: '#98a9c5', accent: '#90b5f0', accentHover: '#a9c9f6', cyan: '#6fc2d0' },
    ),
    swatch: ['#3660aa', '#eaf1fa', '#90b5f0'],
  },
  {
    id: 'rosewood', label: '紫檀', description: '紫檀褐紫与暖灰纸面，典雅内敛。',
    css: colorSchemeCss(
      { canvas: '#ebe3ed', panel: '#f4eef7', elevated: '#fbf8fc', muted: '#dfd2e4', ink: '#2a2030', secondary: '#574562', faint: '#695975', accent: '#824f7a', accentHover: '#6a3f64', cyan: '#826b98' },
      { canvas: '#1d1721', panel: '#29202f', elevated: '#352b3d', muted: '#3e324a', ink: '#ede5f1', secondary: '#c9b7d2', faint: '#ad98b8', accent: '#dba8d5', accentHover: '#e8c0e1', cyan: '#b29fcb' },
    ),
    swatch: ['#824f7a', '#f4eef7', '#dba8d5'],
  },
  {
    id: 'sakura', label: '绯樱', description: '樱粉纸面与玫红点睛，温柔明媚。',
    css: colorSchemeCss(
      { canvas: '#f0dfe2', panel: '#f8ecee', elevated: '#fef7f8', muted: '#e6d0d4', ink: '#301f25', secondary: '#694853', faint: '#7a5a65', accent: '#ab4a5f', accentHover: '#913d4f', cyan: '#966270' },
      { canvas: '#221a1d', panel: '#2e2327', elevated: '#3b2d32', muted: '#44353b', ink: '#f3e8eb', secondary: '#d4b9c0', faint: '#b79da5', accent: '#eaa9b8', accentHover: '#f4c1cd', cyan: '#ca9ba7' },
    ),
    swatch: ['#ab4a5f', '#f8ecee', '#eaa9b8'],
  },
  {
    id: 'amber', label: '琥珀', description: '琥珀金主色与米黄纸面，温润厚重。',
    css: colorSchemeCss(
      { canvas: '#ede3c8', panel: '#f7f0de', elevated: '#fdf8ec', muted: '#e3d6b8', ink: '#2d2614', secondary: '#665937', faint: '#786a48', accent: '#9c6d1b', accentHover: '#825915', cyan: '#758240' },
      { canvas: '#211d13', panel: '#2d2819', elevated: '#393320', muted: '#433c28', ink: '#f1ead6', secondary: '#d3c5a2', faint: '#b6a982', accent: '#e8c36e', accentHover: '#f4d68a', cyan: '#b0bf72' },
    ),
    swatch: ['#9c6d1b', '#f7f0de', '#e8c36e'],
  },
  {
    id: 'midnight', label: '子夜', description: '深蓝纸面与冰蓝点睛，神秘高冷。',
    css: colorSchemeCss(
      { canvas: '#d8e0eb', panel: '#e6edf6', elevated: '#f3f7fc', muted: '#cbd8e7', ink: '#1a2433', secondary: '#3d4d65', faint: '#516280', accent: '#2d5ea8', accentHover: '#254b8a', cyan: '#3580a0' },
      { canvas: '#0f1419', panel: '#171e28', elevated: '#202a38', muted: '#283548', ink: '#e0e8f2', secondary: '#b0c0d8', faint: '#8fa4c0', accent: '#70a8f0', accentHover: '#8bc0f8', cyan: '#5daad0' },
    ),
    swatch: ['#2d5ea8', '#e6edf6', '#70a8f0'],
  },
  {
    id: 'forest', label: '深林', description: '墨绿纸面与翠绿点睛，清新沉稳。',
    css: colorSchemeCss(
      { canvas: '#dce8de', panel: '#e9f2eb', elevated: '#f4f9f5', muted: '#d0e0d4', ink: '#1c2a20', secondary: '#3e5645', faint: '#526a58', accent: '#2d7050', accentHover: '#245b40', cyan: '#3d8570' },
      { canvas: '#121a16', panel: '#1a251f', elevated: '#24312a', muted: '#2d3e36', ink: '#e2ede5', secondary: '#b2c9b8', faint: '#94ad9c', accent: '#6fc598', accentHover: '#8ad8ac', cyan: '#65b598' },
    ),
    swatch: ['#2d7050', '#e9f2eb', '#6fc598'],
  },
  {
    id: 'sky-cyan', label: '天青', description: '天青蓝主色与薄雾纸面，清透疏朗。',
    css: colorSchemeCss(
      { canvas: '#dbe7ed', panel: '#e7f1f6', elevated: '#f2f8fb', muted: '#ccdde5', ink: '#18262e', secondary: '#3d5763', faint: '#4f6b78', accent: '#1f6b86', accentHover: '#17556b', cyan: '#2f8ba3' },
      { canvas: '#0f181d', panel: '#17252b', elevated: '#21333a', muted: '#2a3f48', ink: '#e0edf2', secondary: '#b0c8d2', faint: '#93aeb9', accent: '#6cc0dd', accentHover: '#8bd3ea', cyan: '#5fb3cc' },
    ),
    swatch: ['#1f6b86', '#e7f1f6', '#6cc0dd'],
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
