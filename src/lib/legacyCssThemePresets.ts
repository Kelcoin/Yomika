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
 {id:'ehentai-classic',label:'E-Hentai 经典',description:'灰底、蓝链、细边框与紧凑信息密度的经典站点风格。',css:`:root{--surface-canvas:#dedede;--surface-panel:#e9e9e9;--surface-elevated:#f5f5f5;--surface-muted:#cfcfcf;--ink-primary:#303030;--ink-secondary:#555;--ink-faint:#707070;--brand-ink:#303030;--brand-vermilion:#5d75b4;--brand-vermilion-strong:#40558d;--brand-paper:#d8d8d8;--brand-cyan:#6688b8;--hairline:#b8b8b8;--hairline-strong:#999;--control-background:#f8f8f8;--control-background-hover:#fff;--control-border:#aaa;--radius-control:3px;--radius-card:4px;--radius-overlay:5px;--shadow-card:0 1px 2px rgb(0 0 0/.14);--text-sm:12px;--text-md:13px}${shared}a{color:#384f9f}a:hover{color:#b33a3a}.workspace{max-width:1400px}.archive-row,.settings-section,.panel{border:1px solid var(--hairline);box-shadow:none}`}
];
