/** Exact old CSS values, retained only to upgrade unedited saved presets. */
export interface CssThemePreset { id: string; label: string; description: string; css: string; }
const shared = `button,input,select,textarea{border-radius:6px}.metadata-chip{border-radius:4px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}`;
export const CSS_THEME_PRESETS: readonly CssThemePreset[] = [
 {
   id: 'morandi',
   label: '莫兰迪',
   description: '浅雾灰底色，搭配灰绿、雾粉与灰蓝，柔和而清晰。',
   css: `:root {
  color-scheme: light;
  --surface-canvas: #e5e8e5;
  --surface-panel: #f1f3ef;
  --surface-elevated: #fafbf8;
  --surface-muted: #d8dfda;
  --surface-overlay: rgb(49 57 54 / .9);
  --backdrop-overlay: rgb(32 40 37 / .6);
  --ink-primary: #303b36;
  --ink-secondary: #505f59;
  --ink-faint: #5d6963;
  --ink-on-brand: #ffffff;
  --ink-on-overlay: #ffffff;
  --brand-ink: #465b51;
  --brand-vermilion: #87616b;
  --brand-vermilion-strong: #714e58;
  --brand-paper: #dce4dd;
  --brand-violet: #7b7086;
  --brand-cyan: #607d88;
  --state-success: #4b715c;
  --state-warning: #88632e;
  --state-danger: #a04f60;
  --hairline: #c3cdc5;
  --hairline-strong: #8b9b91;
  --focus-ring: #526f7b;
  --focus-shadow: 0 0 0 3px rgb(82 111 123 / .24);
  --selection-background: #dcd0d7;
  --selection-ink: #303b36;
  --control-background: var(--surface-elevated);
  --control-background-hover: #dce4dd;
  --control-border: var(--hairline-strong);
  --control-text: var(--ink-primary);
  --control-placeholder: var(--ink-faint);
  --control-selected-background: #465b51;
  --control-selected-text: #ffffff;
  --shadow-menu: 0 12px 30px rgb(49 57 54 / .16);
  --shadow-overlay: 0 24px 64px rgb(49 57 54 / .24);
  --shadow-tooltip: 0 6px 18px rgb(49 57 54 / .14);
  --shadow-card: 0 4px 14px rgb(49 57 54 / .08);
  --radius-control: 6px;
  --radius-card: 8px;
  --radius-overlay: 8px;
}
${shared}
html { scrollbar-color: #8b9b91 var(--surface-canvas); }
`,
 },
 {id:'none',label:'无',description:'清空自定义 CSS，回到默认主题。',css:''},
 {id:'paper-reading',label:'纸张阅读',description:'温暖纸张底色与柔和墨色，适合长时间阅读。',css:`:root{--surface-canvas:#eee8dc;--surface-panel:#f8f4eb;--surface-elevated:#fffdf7;--surface-muted:#e3dccf;--ink-primary:#29251f;--ink-secondary:#625a4f;--ink-faint:#776f63;--brand-vermilion:#9d4b35;--brand-vermilion-strong:#7f3928;--brand-paper:#e9dfce;--brand-cyan:#587b78;--hairline:rgb(73 60 44/.18);--hairline-strong:rgb(73 60 44/.3);--shadow-card:0 4px 14px rgb(73 60 44/.1);--radius-card:10px}${shared}`},
 {id:'navy-workbench',label:'海军蓝工作台',description:'沉稳蓝灰层级与高可见状态色，适合管理检索。',css:`:root{--surface-canvas:#101a27;--surface-panel:#172536;--surface-elevated:#203246;--surface-muted:#263b50;--ink-primary:#e8f0f7;--ink-secondary:#b5c5d3;--ink-faint:#91a6b8;--brand-ink:#e8f0f7;--brand-vermilion:#e08a62;--brand-vermilion-strong:#f1a47d;--brand-paper:#294054;--brand-cyan:#69b7c4;--hairline:rgb(196 220 236/.16);--hairline-strong:rgb(196 220 236/.28);--control-background:#203246;--control-background-hover:#294054;--control-border:var(--hairline);--shadow-card:0 8px 22px rgb(3 10 18/.28);--radius-card:8px}${shared}.archive-row:hover,.settings-section:hover{border-color:var(--brand-cyan)}`},
 {id:'ehentai-classic',label:'E-Hentai 经典',description:'灰底、蓝链、细边框与紧凑信息密度的经典站点风格。',css:`:root{--surface-canvas:#dedede;--surface-panel:#e9e9e9;--surface-elevated:#f5f5f5;--surface-muted:#cfcfcf;--ink-primary:#303030;--ink-secondary:#555;--ink-faint:#707070;--brand-ink:#303030;--brand-vermilion:#5d75b4;--brand-vermilion-strong:#40558d;--brand-paper:#d8d8d8;--brand-cyan:#6688b8;--hairline:#b8b8b8;--hairline-strong:#999;--control-background:#f8f8f8;--control-background-hover:#fff;--control-border:#aaa;--radius-control:3px;--radius-card:4px;--radius-overlay:5px;--shadow-card:0 1px 2px rgb(0 0 0/.14);--text-sm:12px;--text-md:13px}${shared}a{color:#384f9f}a:hover{color:#b33a3a}.workspace{max-width:1400px}.archive-row,.settings-section,.panel{border:1px solid var(--hairline);box-shadow:none}`},
 // 2026 年修复前线上那一版 ehentai 预设的逐字输出：老用户存下来的就是这一串，
 // 收在这里才能在他们重开设置页时静默升级到修好的配色。
 {id:'ehentai-classic',label:'E-Hentai 经典',description:'冷灰底、蓝链与紧凑信息密度，贴近 E-Hentai 站点外观。',css:`:root {
  color-scheme: light;
  /* M3 角色整套覆盖：组件样式读的是这些语义 token，缺了就只剩部分背景被换色。 */
  --primary: #3d64b8;
  --on-primary: #ffffff;
  --primary-hover: #2f51a0;
  --primary-container: color-mix(in srgb, #3d64b8 24%, #e6e6e6);
  --on-primary-container: #2f2f2f;
  --secondary: #4a7fb5;
  --on-secondary: #ffffff;
  --secondary-hover: color-mix(in srgb, #4a7fb5 78%, #2f2f2f);
  --secondary-container: color-mix(in srgb, #4a7fb5 22%, #e6e6e6);
  --on-secondary-container: #2f2f2f;
  --tertiary: #2f51a0;
  --on-tertiary: #ffffff;
  --tertiary-container: color-mix(in srgb, #2f51a0 22%, #e6e6e6);
  --on-tertiary-container: #2f2f2f;
  --surface: #dcdcdc;
  --surface-container-low: #e6e6e6;
  --surface-container: color-mix(in srgb, #2f2f2f 6%, #e6e6e6);
  --surface-container-high: color-mix(in srgb, #2f2f2f 12%, #e6e6e6);
  --surface-container-highest: color-mix(in srgb, #2f2f2f 18%, #e6e6e6);
  --on-surface: #2f2f2f;
  --on-surface-variant: #4f4f4f;
  --outline: var(--hairline-strong);
  --outline-variant: var(--hairline);
  --inverse-surface: #2f2f2f;
  --inverse-on-surface: #e6e6e6;
  --inverse-primary: #3d64b8;
  --success: #396c51;
  --on-success: #ffffff;
  --success-container: color-mix(in srgb, #396c51 22%, #e6e6e6);
  --on-success-container: #2f2f2f;
  --warning: #856027;
  --on-warning: #ffffff;
  --warning-container: color-mix(in srgb, #856027 22%, #e6e6e6);
  --on-warning-container: #2f2f2f;
  --error: #a04a5e;
  --on-error: #ffffff;
  --error-container: color-mix(in srgb, #a04a5e 22%, #e6e6e6);
  --on-error-container: #2f2f2f;
  /* 旧别名（迁移期兼容），与新角色保持同值。 */
  --surface-canvas: #dcdcdc;
  --surface-panel: #e6e6e6;
  --surface-elevated: #f2f2f2;
  --surface-muted: #cccccc;
  --surface-overlay: rgb(35 38 40 / .9);
  --backdrop-overlay: rgb(0 0 0 / .56);
  --ink-primary: #2f2f2f;
  --ink-secondary: #4f4f4f;
  --ink-faint: #5e5e5e;
  --ink-on-brand: #ffffff;
  --ink-on-overlay: #ffffff;
  --brand-ink: #2f2f2f;
  --brand-vermilion: #3d64b8;
  --brand-vermilion-strong: #2f51a0;
  --brand-paper: #cccccc;
  --brand-violet: #4f4f4f;
  --brand-cyan: #4a7fb5;
  --state-success: #396c51;
  --state-warning: #856027;
  --state-danger: #a04a5e;
  --hairline: color-mix(in srgb, #2f2f2f 18%, #e6e6e6);
  --hairline-strong: color-mix(in srgb, #2f2f2f 40%, #e6e6e6);
  --focus-ring: #3d64b8;
  --focus-shadow: 0 0 0 3px color-mix(in srgb, #3d64b8 28%, transparent);
  --selection-background: #3d64b8;
  --selection-ink: var(--ink-on-brand);
  --control-background: #f2f2f2;
  --control-background-hover: #cccccc;
  --control-border: var(--hairline-strong);
  --control-text: #2f2f2f;
  --control-placeholder: #5e5e5e;
  --control-selected-background: #3d64b8;
  --control-selected-text: var(--ink-on-brand);
  --shadow-menu: 0 12px 30px rgb(0 0 0 / .16);
  --shadow-overlay: 0 24px 64px rgb(0 0 0 / .24);
  --shadow-tooltip: 0 6px 18px rgb(0 0 0 / .14);
  --shadow-card: 0 4px 14px rgb(0 0 0 / .08);

  --radius-control: 6px;
  --radius-card: 8px;
  --radius-overlay: 8px;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  /* M3 角色整套覆盖：组件样式读的是这些语义 token，缺了就只剩部分背景被换色。 */
  --primary: #8bacea;
  --on-primary: #17191b;
  --primary-hover: #a3bff0;
  --primary-container: color-mix(in srgb, #8bacea 24%, #1f1f1f);
  --on-primary-container: #e6e6e6;
  --secondary: #7d9cc9;
  --on-secondary: #17191b;
  --secondary-hover: color-mix(in srgb, #7d9cc9 78%, #e6e6e6);
  --secondary-container: color-mix(in srgb, #7d9cc9 22%, #1f1f1f);
  --on-secondary-container: #e6e6e6;
  --tertiary: #a3bff0;
  --on-tertiary: #17191b;
  --tertiary-container: color-mix(in srgb, #a3bff0 22%, #1f1f1f);
  --on-tertiary-container: #e6e6e6;
  --surface: #171717;
  --surface-container-low: #1f1f1f;
  --surface-container: color-mix(in srgb, #e6e6e6 6%, #1f1f1f);
  --surface-container-high: color-mix(in srgb, #e6e6e6 12%, #1f1f1f);
  --surface-container-highest: color-mix(in srgb, #e6e6e6 18%, #1f1f1f);
  --on-surface: #e6e6e6;
  --on-surface-variant: #c2c2c2;
  --outline: var(--hairline-strong);
  --outline-variant: var(--hairline);
  --inverse-surface: #e6e6e6;
  --inverse-on-surface: #17191b;
  --inverse-primary: #8bacea;
  --success: #8dc4a5;
  --on-success: #17191b;
  --success-container: color-mix(in srgb, #8dc4a5 22%, #1f1f1f);
  --on-success-container: #e6e6e6;
  --warning: #d8b77e;
  --on-warning: #17191b;
  --warning-container: color-mix(in srgb, #d8b77e 22%, #1f1f1f);
  --on-warning-container: #e6e6e6;
  --error: #e6a0ae;
  --on-error: #17191b;
  --error-container: color-mix(in srgb, #e6a0ae 22%, #1f1f1f);
  --on-error-container: #e6e6e6;
  /* 旧别名（迁移期兼容），与新角色保持同值。 */
  --surface-canvas: #171717;
  --surface-panel: #1f1f1f;
  --surface-elevated: #292929;
  --surface-muted: #333333;
  --surface-overlay: rgb(10 12 14 / .94);
  --backdrop-overlay: rgb(0 0 0 / .72);
  --ink-primary: #e6e6e6;
  --ink-secondary: #c2c2c2;
  --ink-faint: #9e9e9e;
  --ink-on-brand: #17191b;
  --ink-on-overlay: #ffffff;
  --brand-ink: #e6e6e6;
  --brand-vermilion: #8bacea;
  --brand-vermilion-strong: #a3bff0;
  --brand-paper: #333333;
  --brand-violet: #c2c2c2;
  --brand-cyan: #7d9cc9;
  --state-success: #8dc4a5;
  --state-warning: #d8b77e;
  --state-danger: #e6a0ae;
  --hairline: color-mix(in srgb, #e6e6e6 18%, #1f1f1f);
  --hairline-strong: color-mix(in srgb, #e6e6e6 40%, #1f1f1f);
  --focus-ring: #8bacea;
  --focus-shadow: 0 0 0 3px color-mix(in srgb, #8bacea 28%, transparent);
  --selection-background: #8bacea;
  --selection-ink: var(--ink-on-brand);
  --control-background: #292929;
  --control-background-hover: #333333;
  --control-border: var(--hairline-strong);
  --control-text: #e6e6e6;
  --control-placeholder: #9e9e9e;
  --control-selected-background: #8bacea;
  --control-selected-text: var(--ink-on-brand);
  --shadow-menu: 0 12px 30px rgb(0 0 0 / .45);
  --shadow-overlay: 0 24px 64px rgb(0 0 0 / .55);
  --shadow-tooltip: 0 6px 18px rgb(0 0 0 / .4);
  --shadow-card: 0 4px 14px rgb(0 0 0 / .28);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
  color-scheme: dark;
  /* M3 角色整套覆盖：组件样式读的是这些语义 token，缺了就只剩部分背景被换色。 */
  --primary: #8bacea;
  --on-primary: #17191b;
  --primary-hover: #a3bff0;
  --primary-container: color-mix(in srgb, #8bacea 24%, #1f1f1f);
  --on-primary-container: #e6e6e6;
  --secondary: #7d9cc9;
  --on-secondary: #17191b;
  --secondary-hover: color-mix(in srgb, #7d9cc9 78%, #e6e6e6);
  --secondary-container: color-mix(in srgb, #7d9cc9 22%, #1f1f1f);
  --on-secondary-container: #e6e6e6;
  --tertiary: #a3bff0;
  --on-tertiary: #17191b;
  --tertiary-container: color-mix(in srgb, #a3bff0 22%, #1f1f1f);
  --on-tertiary-container: #e6e6e6;
  --surface: #171717;
  --surface-container-low: #1f1f1f;
  --surface-container: color-mix(in srgb, #e6e6e6 6%, #1f1f1f);
  --surface-container-high: color-mix(in srgb, #e6e6e6 12%, #1f1f1f);
  --surface-container-highest: color-mix(in srgb, #e6e6e6 18%, #1f1f1f);
  --on-surface: #e6e6e6;
  --on-surface-variant: #c2c2c2;
  --outline: var(--hairline-strong);
  --outline-variant: var(--hairline);
  --inverse-surface: #e6e6e6;
  --inverse-on-surface: #17191b;
  --inverse-primary: #8bacea;
  --success: #8dc4a5;
  --on-success: #17191b;
  --success-container: color-mix(in srgb, #8dc4a5 22%, #1f1f1f);
  --on-success-container: #e6e6e6;
  --warning: #d8b77e;
  --on-warning: #17191b;
  --warning-container: color-mix(in srgb, #d8b77e 22%, #1f1f1f);
  --on-warning-container: #e6e6e6;
  --error: #e6a0ae;
  --on-error: #17191b;
  --error-container: color-mix(in srgb, #e6a0ae 22%, #1f1f1f);
  --on-error-container: #e6e6e6;
  /* 旧别名（迁移期兼容），与新角色保持同值。 */
  --surface-canvas: #171717;
  --surface-panel: #1f1f1f;
  --surface-elevated: #292929;
  --surface-muted: #333333;
  --surface-overlay: rgb(10 12 14 / .94);
  --backdrop-overlay: rgb(0 0 0 / .72);
  --ink-primary: #e6e6e6;
  --ink-secondary: #c2c2c2;
  --ink-faint: #9e9e9e;
  --ink-on-brand: #17191b;
  --ink-on-overlay: #ffffff;
  --brand-ink: #e6e6e6;
  --brand-vermilion: #8bacea;
  --brand-vermilion-strong: #a3bff0;
  --brand-paper: #333333;
  --brand-violet: #c2c2c2;
  --brand-cyan: #7d9cc9;
  --state-success: #8dc4a5;
  --state-warning: #d8b77e;
  --state-danger: #e6a0ae;
  --hairline: color-mix(in srgb, #e6e6e6 18%, #1f1f1f);
  --hairline-strong: color-mix(in srgb, #e6e6e6 40%, #1f1f1f);
  --focus-ring: #8bacea;
  --focus-shadow: 0 0 0 3px color-mix(in srgb, #8bacea 28%, transparent);
  --selection-background: #8bacea;
  --selection-ink: var(--ink-on-brand);
  --control-background: #292929;
  --control-background-hover: #333333;
  --control-border: var(--hairline-strong);
  --control-text: #e6e6e6;
  --control-placeholder: #9e9e9e;
  --control-selected-background: #8bacea;
  --control-selected-text: var(--ink-on-brand);
  --shadow-menu: 0 12px 30px rgb(0 0 0 / .45);
  --shadow-overlay: 0 24px 64px rgb(0 0 0 / .55);
  --shadow-tooltip: 0 6px 18px rgb(0 0 0 / .4);
  --shadow-card: 0 4px 14px rgb(0 0 0 / .28);
  }
}
html { scrollbar-color: var(--ink-faint) var(--surface-canvas); }
:root { --radius-control: 2px; --radius-card: 3px; --radius-overlay: 4px; --shadow-card: none; --text-md: 13px; }
.archive-row { border: 1px solid var(--hairline); box-shadow: none; }
.tag-search-link { color: var(--brand-vermilion); }
.tag-search-link:hover { color: var(--brand-vermilion-strong); text-decoration: underline; }
.workspace { max-width: none; }
`}
];
