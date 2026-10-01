import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { COLOR_SCHEMES, CSS_THEME_PRESETS, upgradeCssThemePreset } from './cssThemePresets';
import { CSS_THEME_PRESETS as legacyPresets } from './legacyCssThemePresets';

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/gi)!.map((n) => parseInt(n, 16) / 255)
    .map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}

/**
 * ehentai-classic 的取值全部抄自站点真实样式表，不凭印象：
 *   首页 https://e-hentai.org/ 只有一条外链样式表，指向
 *   https://e-hentai.org/z/0381/g.css（29,949 字节，站点全部规则都在里面）。
 * 下面每条断言都注明了它对应 g.css 里的哪一条原始声明，改预设时对照着改。
 */
describe('ehentai-classic preset wears the measured e-hentai.org skin', () => {
  const preset = CSS_THEME_PRESETS.find((p) => p.id === 'ehentai-classic');

  /** 取显式 data-theme 分支里最终生效的声明（后者覆盖前者，和浏览器一致）。 */
  function declarationsFor(mode: 'light' | 'dark'): Map<string, string> {
    if (!preset) throw new Error('ehentai-classic preset is missing');
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
    const values = new Map<string, string>();
    postcss.parse(preset.css).walkRules((rule) => {
      // 只看 data-theme 分支：system 分支的选择器是 :root:not([data-theme])，
      // 这里根节点始终带着显式属性，取不到它才是对的。
      if (rule.parent?.type === 'atrule') return;
      if (!root.matches(rule.selector)) return;
      rule.walkDecls((decl) => { values.set(decl.prop, decl.value.trim().toLowerCase()); });
    });
    root.removeAttribute('data-theme');
    return values;
  }

  it('takes canvas, panel, muted and ink straight out of g.css', () => {
    const light = declarationsFor('light');
    // body{color:#5C0D11;background:#E3E0D1;padding:2px;margin:0;text-align:center}
    expect(light.get('--surface-canvas')).toBe('#e3e0d1');
    expect(light.get('--ink-primary')).toBe('#5c0d11');
    // table.itg>tbody>tr:nth-child(2n+1){background:#F2F0E4}  —— 列表纸面最亮的一档
    expect(light.get('--surface-panel')).toBe('#f2f0e4');
    // table.mt{background:#E0DED3}  —— 信息表比正文纸面深一档
    expect(light.get('--surface-muted')).toBe('#e0ded3');
    // input:hover / .ptb td:hover{background:#F2EFDF}
    expect(light.get('--surface-elevated')).toBe('#f3f0e0');
  });

  it('keeps the flat EH hairline, the 2px control border and the square corners', () => {
    const light = declarationsFor('light');
    // td.itd{border-right:1px solid #D9D7CC} / .gld{border-left:1px solid #D9D7CC}
    expect(light.get('--hairline')).toBe('#d9d7cc');
    // input[type="text"]{border:2px solid #B5A4A4;border-radius:3px}
    expect(light.get('--hairline-strong')).toBe('#b5a4a4');
    // input,select,option,optgroup,textarea{color:#5C0D12;background-color:#EDEADA}
    expect(light.get('--control-background')).toBe('#edeada');
    // input:hover,...{background-color:#F3F0E0}, border-color:#977273
    expect(light.get('--control-background-hover')).toBe('#f3f0e0');
    // input::placeholder{color:#9F746F}
    expect(light.get('--control-placeholder')).toBe('#9f746f');
    // EH 没有圆角文化：3px 来自 input 的 border-radius，5px 来自 div.gt/.tha 的角。
    expect(light.get('--radius-control')).toBe('3px');
    expect(light.get('--radius-card')).toBe('3px');
    expect(light.get('--radius-overlay')).toBe('5px');
    // EH 靠 2px ridge #5C0D12 的表格边框分层，没有任何投影。
    expect(light.get('--shadow-card')).toBe('none');
  });

  it('uses EH own accents: orange for the active state, gamecg blue for support', () => {
    const light = declarationsFor('light');
    // .tha:hover{background:#F2EFDF;color:#9B4E03} / td.ptds{color:#9B4E03 !important}
    expect(light.get('--brand-vermilion')).toBe('#9b4e03');
    // a:hover{color:#8F4701}，比 9B4E03 更深，正好当“按下”那一档。
    expect(light.get('--brand-vermilion-strong')).toBe('#8f4701');
    // .cs,.cn,.cw{color:#f1f1f1}  —— EH 自己的按钮前景色
    expect(light.get('--ink-on-brand')).toBe('#f1f1f1');
    // .ct6{background:radial-gradient(#2756aa,#5f5fff);border:1px solid #2756aa}
    expect(light.get('--brand-cyan')).toBe('#2756aa');
    // 正文里唯一的文字色分级就是这两档，EH 全站都泡在 5C0D11/5C0D12 里。
    expect(light.get('--ink-secondary')).toBe('#5c0d12');
    // a:visited .glink,a:active .glink{color:#8F6063}：EH 里唯一既“淡”又还
    // 压得住米黄纸面的那一档（在 --surface-panel 上 4.57:1，刚过 4.5:1 契约）。
    // 站点更淡的 #C2A8A4 分页灰只有约 3.4:1，不能直接抄。
    expect(light.get('--ink-faint')).toBe('#8f6063');
  });

  it('writes the link colours EH actually declares, visited state included', () => {
    const css = preset!.css;
    // a:hover{color:#8F4701}
    expect(css).toMatch(/a:hover\s*\{[^}]*color:\s*#8F4701/i);
    // a:visited .glink,a:active .glink{color:#8F6063}
    expect(css).toMatch(/a:visited\s*\{[^}]*color:\s*#8F6063/i);
    // 静止态 EH 的链接就是正文色（a{color:#5C0D11}），本应用由 `--ink-primary`
    // 经 base.css 的 `a{color:inherit}` 拿到同一个值，所以预设不重写 `a{}`，
    // 只补 EH 真正换色的两个状态。
    expect(css).not.toMatch(/(^|\})a\s*\{/);
  });

  it('drops to EH density: 9pt root type, arial, 1.42 leading', () => {
    const light = declarationsFor('light');
    // :root{font-size:9pt;font-family:arial,helvetica,sans-serif}
    expect(light.get('--text-xs')).toBe('11px');   // 8pt
    expect(light.get('--text-sm')).toBe('12px');   // 9pt = EH 的根字号
    expect(light.get('--text-md')).toBe('13px');   // 10pt
    expect(light.get('--text-base')).toBe('14px'); // 11pt
    // EH 的字体栈；中文交给后面的 Noto 回退，拉丁文先吃到 EH 的字形。
    expect(light.get('--font-body')).toContain('arial');
    expect(light.get('--font-body')).toContain('noto sans sc variable');
    // #nb{line-height:19px} 配 10pt、td.gdt1{height:17px} 配 9pt，都是 1.42 左右。
    expect(light.get('--leading-normal')).toBe('1.42');
    // td.itd{padding:3px 4px} / table.itc td{padding:3px 5px}：3px 一档的呼吸
    expect(light.get('--space-1')).toBe('3px');
  });

  it('recolours the category chips with EH own .ct1–.cta palette', () => {
    const light = declarationsFor('light');
    expect(light.get('--category-default')).toBe('#707070');     // .ct1
    expect(light.get('--category-misc')).toBe('#fc4e4e');        // .ct2 misc
    expect(light.get('--category-doujinshi')).toBe('#e78c1a');   // .ct3 doujinshi
    expect(light.get('--category-manga')).toBe('#c7bf07');       // .ct4 manga
    expect(light.get('--category-artist-cg')).toBe('#1a9317');   // .ct5 artistcg
    expect(light.get('--category-game-cg')).toBe('#2756aa');     // .ct6 gamecg
    expect(light.get('--category-image-set')).toBe('#8800c3');   // .ct7 imageset
    expect(light.get('--category-cosplay')).toBe('#b452a5');     // .ct8 cosplay
    expect(light.get('--category-asian-porn')).toBe('#0f9ebd');  // .ct9 asianporn
    expect(light.get('--category-non-h')).toBe('#5dc13b');       // .cta nonh
    // div.gt{border-radius:5px;border:1px solid #806769;background:#F2EFDF}
    expect(light.get('--chip-background')).toBe('#f2efdf');
    expect(light.get('--chip-ink')).toBe('#5c0d11');
  });

  it('re-states the same hues for the dark branch instead of falling back to grey', () => {
    const dark = declarationsFor('dark');
    // EH 站点自己没有深色皮肤，这一支是照着同一族暖褐推导的：
    // 画布必须够黑（预设契约要求 luminance < .1），文字仍走 9B4E03 那一族的暖橙。
    expect(dark.get('--surface-canvas')).toBe('#1c1714');
    expect(dark.get('--brand-vermilion')).toBe('#e09248');
    expect(dark.get('--hairline')).toBe('#453a33');
    expect(dark.get('--chip-background')).toBe('#3a302a');
    expect(dark.get('--ink-primary')).toBe('#f0e4d8');
  });

  it('keeps the persistent id but relabels it to the measured skin', () => {
    // id 是持久化键，改掉会让老用户已保存的选中失效。
    expect(preset!.id).toBe('ehentai-classic');
    expect(preset!.label).toBe('E-Hentai 经典');
    expect(preset!.description).toContain('米黄');
    expect(preset!.description).toContain('砖红');
  });
});

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
