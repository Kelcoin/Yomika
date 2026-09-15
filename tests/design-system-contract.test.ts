import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
// 归一化行尾：git 的 autocrlf checkout 会把源文件写成 CRLF，而合同的换行
// 断言只应关心内容本身。
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

type Rgb = [number, number, number];

function cssVariables(block: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) variables.set(name, value.trim());
  }
  return variables;
}

/** The token file is wrapped in `@layer tokens`, so a rule body cannot be found
 * by scanning to the next line-initial `}` — that would swallow the rest of the
 * layer and merge the dark overrides into the light theme. Count braces. */
function ruleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{`).exec(source);
  const open = match ? match.index + match[0].lastIndexOf('{') : -1;
  if (open < 0) throw new Error(`Rule not found: ${selector}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && (depth -= 1) === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unbalanced rule: ${selector}`);
}

function rgb(value: string, backdrop?: Rgb): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
  const channels = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/);
  if (!channels) throw new Error(`Unsupported test color: ${value}`);
  const foreground = channels.slice(1, 4).map(Number) as Rgb;
  const alpha = Number(channels[4] ?? 1);
  return foreground.map((channel, index) => Math.round(channel * alpha + (backdrop?.[index] ?? 255) * (1 - alpha))) as Rgb;
}

function contrast(left: Rgb, right: Rgb): number {
  const luminance = (color: Rgb) => 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

describe('design system contract', () => {
  it('does not stretch shelf errors into a full-page obstruction', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.shelf-workspace\s*>\s*\.form-error\s*\{[^}]*align-self:\s*start/);
  });
  it('binds the supplied logo assets to native builds', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json')) as { bundle?: { icon?: string[] } };
    expect(config.bundle?.icon).toEqual(expect.arrayContaining([
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.ico',
      'icons/icon.icns',
    ]));
  });

  it('keeps form controls and actions on semantic theme tokens', () => {
    const base = read('src/styles/base.css');
    const buttonRule = base.match(/button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(base).toMatch(/input,\s*select,\s*textarea\s*\{[\s\S]*?background:\s*var\(--control-background\)/);
    expect(buttonRule).toMatch(/font-family:\s*inherit/);
    expect(buttonRule).toMatch(/align-items:\s*center/);
  });

  it('gives every settings section one full-width column', () => {
    const shell = read('src/styles/shell.css');
    // One rule for both, and one column. A fixed label column used to hold the
    // section title the sidebar already shows: it left a blank strip beside
    // every control, and a section whose content was its own first child (sync,
    // about) was laid out *inside* that strip at a fraction of the width.
    const settingsRule = shell.match(/\.settings-section,\s*\n\.preferences-panel\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(settingsRule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(settingsRule).not.toMatch(/grid-template-columns:[^;]*\d+px/);
    expect(shell).toMatch(/\.settings-section > \*,\s*\n\.preferences-form\s*\{[\s\S]*?min-width:\s*0/);
    expect(shell).toMatch(/\.legacy-import-form\s*\{[\s\S]*?max-width:\s*680px/);
    expect(shell).toMatch(/\.legacy-import-form textarea\s*\{[\s\S]*?width:\s*100%/);
    expect(shell).toMatch(/\.legacy-import-form > input\s*\{[\s\S]*?width:\s*100%/);
  });

  it('defines compact metadata and category surface tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    expect(tokens).toMatch(/--category-manga:/);
    expect(tokens).toMatch(/--category-doujinshi:/);
    expect(shell).toMatch(/\.metadata-chip\s*\{/);
    expect(shell).toMatch(/\.archive-row-category\[data-category='Manga'\][\s\S]*border-color:/);
    expect(shell).toMatch(/\.archive-row-category\[data-category='Cosplay'\][\s\S]*background:/);
  });

  it('defines semantic card and reader surface tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const reader = read('src/styles/reader.css');
    const shell = read('src/styles/shell.css');
    expect(tokens).toMatch(/--shadow-card:/);
    expect(tokens).toMatch(/--brand-vermilion-strong:/);
    expect(tokens).toMatch(/--reader-border:/);
    expect(tokens).toMatch(/--reader-backdrop:/);
    expect(tokens).toMatch(/--z-reader-chrome:/);
    expect(tokens).toMatch(/--z-reader-overview:/);
    expect(reader).not.toMatch(/rgb\(255 255 255|rgb\(0 0 0/);
    expect(reader).not.toMatch(/--radius-panel/);
    expect(shell).not.toMatch(/color-mix\([^;]*#000/);
  });

  it('keeps compact content above navigation without a padded black band', () => {
    const shell = read('src/styles/shell.css');
    const compactMain = shell.match(/@media \(max-width: 900px\)[\s\S]*?\.app-main\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const archiveList = ruleBody(shell, '.archive-list');
    expect(compactMain).toMatch(/height:\s*calc\(100dvh - \(64px \+ env\(safe-area-inset-bottom\)\)\)/);
    expect(archiveList).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(shell).not.toMatch(/\.workspace\.is-library-workspace \.archive-list\s*\{[\s\S]*padding-bottom:\s*calc\(80px/);
  });

  it('uses the content surface behind short workspaces instead of exposing canvas', () => {
    const shell = read('src/styles/shell.css');
    const appMain = ruleBody(shell, '.app-main');
    expect(appMain).toMatch(/background:\s*var\(--surface-panel\)/);
  });

  it('keeps the archive count in the product font on the status bar', () => {
    // The count lives in a status-bar entry now; the old .library-heading > span
    // (and its dead wrapper classes) are gone from both markup and stylesheet.
    const shell = read('src/styles/shell.css');
    expect(shell).not.toMatch(/\.archive-row-meta\s*\{/);
    expect(shell).not.toMatch(/\.library-heading/);
    expect(shell).toMatch(/\.status-item\s*\{[^}]*font-family:\s*var\(--font-body\)/);
  });

  it('enables the native Windows credential backend for release builds', () => {
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toMatch(/keyring\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*['"]windows-native['"]/s);
  });

  it('uses a two-level settings layout with stable rail targets', () => {
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings).toMatch(/className=\{`settings-layout/);
    expect(settings).toMatch(/className="settings-sidebar"/);
    expect(settings).toMatch(/className="settings-nav"/);
    expect(shell).toMatch(/\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(164px,\s*208px\)/);
    expect(shell).toMatch(/\.settings-nav a\s*\{[\s\S]*min-height:\s*40px/);
    expect(shell).toMatch(/\.sidebar-toggle\s*\{[\s\S]*flex:\s*0 0 44px/);
    expect(shell).toMatch(/\.segmented-control\s*\{[\s\S]*width:\s*fit-content/);
  });

  it('uses one sidebar hover box and clips detail covers to the visible art', () => {
    const shell = read('src/styles/shell.css');
    const nav = ruleBody(shell, '.nav-link');
    const collapsed = ruleBody(shell, '.is-sidebar-collapsed .side-nav .nav-link');
    const collapsedShell = ruleBody(shell, '.app-shell.is-sidebar-collapsed');
    const collapsedSidebar = ruleBody(shell, '.is-sidebar-collapsed .sidebar');
    const cover = ruleBody(shell, '.archive-detail-route-cover img');
    expect(nav).not.toMatch(/transform:/);
    expect(collapsedShell).toMatch(/grid-template-columns:\s*65px/);
    expect(collapsedSidebar).toMatch(/padding-inline:\s*10px/);
    expect(collapsed).toMatch(/width:\s*44px/);
    expect(collapsed).toMatch(/margin-inline:\s*0/);
    expect(cover).toMatch(/object-fit:\s*cover/);
  });

  it('keeps hover rules free of geometry so a hover never resizes a control', () => {
    const shell = read('src/styles/shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // A previous style merge fused the brand mark's 38px sizing into the chrome
    // hover rule: titlebar buttons shrank on hover and the settings nav's rows
    // collapsed into one-character columns (vertical text). The chrome hover
    // tier carries colour only, and every hover selector list may only mix
    // members of one component family (e.g. a resting state and its hover).
    const chromeHover = shell.match(/\.titlebar-control:hover,\n[\s\S]*?\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(chromeHover).toMatch(/\.nav-link:hover/);
    expect(chromeHover).toMatch(/\.sidebar-toggle:hover/);
    expect(chromeHover).toMatch(/background:\s*var\(--surface-container-high\)/);
    expect(chromeHover).not.toMatch(/(^|\s)(width|height):/);
    // The final compound of every non-hover member must also be the final
    // compound of some hover member in the same list — otherwise two unrelated
    // components were fused by an identical-declaration merge.
    const subjectOf = (selector: string): string => (
      selector.replace(/:not\([^)]*\)/g, '').replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim().split(/\s+/).pop() ?? ''
    );
    let depth = 0;
    let body = '';
    let header = '';
    const rules: Array<{ selector: string; body: string }> = [];
    for (const character of shell) {
      if (character === '{') {
        depth += 1;
        if (depth === 1) { header = body.trim(); body = ''; }
        continue;
      }
      if (character === '}') {
        depth -= 1;
        if (depth === 0) { rules.push({ selector: header, body }); body = ''; header = ''; }
        continue;
      }
      body += character;
    }
    for (const rule of rules) {
      const { selector } = rule;
      if (!selector || selector.startsWith('@')) continue;
      const parts = selector.split(',').map((part) => part.trim()).filter(Boolean);
      const hoverSubjects = new Set(parts.filter((part) => /:hover/.test(part)).map(subjectOf));
      if (hoverSubjects.size === 0 || hoverSubjects.size === parts.length) continue;
      for (const part of parts) {
        if (/:hover/.test(part)) continue;
        expect(
          hoverSubjects.has(subjectOf(part)),
          `hover rule mixes unrelated selectors: ${selector.replace(/\s+/g, ' ')}`,
        ).toBe(true);
      }
    }
    const markRule = shell.match(/\.brand \.yomika-mark\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(markRule).toMatch(/width:\s*38px/);
    expect(markRule).not.toMatch(/:hover/);
  });

  it('keeps design tokens in a cascade layer so user CSS can override them', () => {
    // The reason presets appeared to do nothing twice over: a preset's
    // `:root { --brand-vermilion: … }` is (0,1,0) and loses on specificity to
    // `:root[data-theme='dark']` and `:root:not([data-theme])`. Injected user CSS
    // is unlayered, and unlayered rules beat every layered rule regardless of
    // specificity — so the token file must stay wrapped, and no other stylesheet
    // may declare tokens on :root outside a layer.
    const tokens = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(tokens).toMatch(/@layer tokens\s*\{/);
    const themeBlocks = [/:root\[data-theme='dark'\]/, /:root:not\(\[data-theme\]\)/];
    const layerStart = tokens.indexOf('@layer tokens {');
    for (const block of themeBlocks) {
      const at = tokens.search(block);
      expect(at).toBeGreaterThan(layerStart);
    }
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, body] of sheet.matchAll(/:root[^{]*\{([^}]*)\}/g)) {
        expect(body).not.toMatch(/--[\w-]+\s*:/);
      }
    }
  });

  it('keeps archive toolbar icon actions compact and select fields flexible', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.library-toolbar\s*\{[\s\S]*display:\s*flex/);
    expect(shell).toMatch(/\.library-toolbar\s*>\s*\.secondary-action\s*\{[\s\S]*flex:\s*0\s*0\s*var\(--control-height\)/);
    expect(shell).toMatch(/\.library-toolbar\s+\.select-field\s*\{[\s\S]*flex:\s*1\s*1\s*0/);
  });

  it('keeps recommendation rails horizontal and lets wide covers span the thumbnail grid', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/);
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*align-items:\s*flex-start/);
    expect(shell).toMatch(/\.archive-thumb-card\s*\{[\s\S]*width:\s*150px/);
    expect(shell).toMatch(/\.archive-thumb-card\.is-wide\s*\{[\s\S]*width:\s*316px/);
    expect(shell).toMatch(/\.archive-thumb-card-media\s*\{[\s\S]*height:\s*210px/);
    expect(shell).toMatch(/\.archive-thumb-card-body\s*\{[\s\S]*grid-template-rows:\s*36px 48px 15px[\s\S]*height:\s*135px/);
    expect(shell).toMatch(/\.archive-thumb-card-tags\s*\{[\s\S]*align-items:\s*flex-start[\s\S]*align-content:\s*flex-start/);
    // The rail card and the library grid share one tag geometry: a 20px chip in a
    // 48px two-row slot, so two rows need 44px and keep 4px clearance — the second
    // row's bottom edge is never shaved by the clip box.
    expect(shell).toMatch(/\.archive-thumb-card-tags \.metadata-chip\s*\{[\s\S]*min-height:\s*20px[\s\S]*font-size:\s*var\(--text-xs\)/);
    expect(shell).toMatch(/\.archive-thumb-card-tags\s*\{[\s\S]*height:\s*48px/);
    // Thumbnail grid rows are packed in JS (fixed 180px columns, wide covers
    // exactly two columns plus the gap) so the grid can virtualize by row.
    expect(shell).toMatch(/\.archive-thumb-grid-row\s*\{[\s\S]*position:\s*absolute[\s\S]*display:\s*flex[\s\S]*gap:\s*var\(--card-gap\)/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\s*\{[\s\S]*width:\s*180px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\.is-cover-wide\s*\{[\s\S]*width:\s*368px/);
    // The grid card reuses the rail card's classes: .archive-thumb-card with a
    // 220px media frame and the shared body/title/tags/meta stack.
    const gridCard = ruleBody(shell, '.archive-list.is-thumbnail .archive-thumb-card');
    expect(gridCard).toMatch(/grid-template-rows:\s*220px 1fr/);
    expect(gridCard).toMatch(/height:\s*350px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-thumb-card \.archive-thumb-card-body\s*\{[\s\S]*grid-template-rows:\s*34px 48px 18px/);
    expect(shell).not.toMatch(/\.archive-list\.is-thumbnail \.archive-row-copy/);
    // List rows share the footer layout and drop the trailing chevron column.
    expect(shell).toMatch(/\.archive-row-footer\s*\{[\s\S]*justify-content:\s*space-between/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row\s*\{[\s\S]*grid-template-columns:\s*100px minmax\(0, 1fr\);/);
    // The wide card has the biggest tag area in the app, so it gets full-size
    // chips: it used to pair the largest area with the smallest chips.
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-tags \.metadata-chip\s*\{[\s\S]*font-size:\s*var\(--text-xs\)/);
    // 宽行卡的标签区是 JHenTai 画廊详情的分组行形态：分组行纵向堆叠，行内
    // 不折行，前三条完整物理行由 JS 打包（WideTagRows）——像素封顶会把组内
    // 续行拦腰切掉半枚芯片。
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-tags\s*\{[\s\S]*flex-direction:\s*column/);
    expect(shell).toMatch(/\.archive-row-tag-line\s*\{[\s\S]*flex-wrap:\s*nowrap/);
    expect(shell).toMatch(/\.card-tag-measures\s*\{[\s\S]*visibility:\s*hidden/);
    expect(shell).not.toMatch(/\.is-cover-wide \.archive-row-thumb\s*\{[\s\S]*aspect-ratio/);
    expect(shell).toMatch(/\.archive-row-thumb\s*\{[\s\S]*overflow:\s*hidden[\s\S]*border-radius:\s*var\(--radius-control\)/);
    expect(shell).toMatch(/\.archive-row-thumb img\s*\{[\s\S]*border-radius:\s*inherit/);
    expect(shell).not.toMatch(/@container app-main \(max-width: 1280px\)/);
  });

  it('uses the project font and stable icon slots for status chrome', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    const reader = read('src/styles/reader.css');
    expect(tokens).toMatch(/--icon-button-size:\s*44px/);
    expect(shell).toMatch(/\.status-item\s*\{[\s\S]*font-family:\s*var\(--font-body\)/);
    expect(shell).toMatch(/\.icon-button\s*\{[\s\S]*width:\s*var\(--icon-button-size\)[\s\S]*height:\s*var\(--icon-button-size\)/);
    expect(reader).toMatch(/\.reader-icon-button,[\s\S]*?\.reader-toolbar button\s*\{[\s\S]*width:\s*var\(--icon-button-size\)[\s\S]*height:\s*var\(--icon-button-size\)/);
  });

  it('anchors the enabled switch thumb to the track end even if its flex row shrinks', () => {
    const shell = read('src/styles/shell.css');
    // Material 3 expressive switch: 52x30 track; the checked handle slides by
    // transform (animatable) to sit flush against the track edge, and both
    // handle states ride the theme's primary colour. The off handle is a
    // centred circle — a wider-than-tall thumb drew an oval instead.
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\s*\{[^}]*flex:\s*0 0 52px[^}]*min-width:\s*52px/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\s*\{[^}]*height:\s*30px[^}]*\}/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]::after\s*\{[^}]*width:\s*22px[^}]*height:\s*22px[^}]*border-radius:\s*50%/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]::after\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\[aria-checked="true"\]::after\s*\{[^}]*transform:\s*translateX\(18px\)[^}]*width:\s*28px[^}]*height:\s*28px/);
  });

  it('defines the Material 3 color roles and shape scale', () => {
    const tokens = read('src/styles/tokens.css');
    const roles = [
      '--primary', '--on-primary', '--primary-container', '--on-primary-container',
      '--secondary', '--on-secondary', '--secondary-container', '--on-secondary-container',
      '--tertiary', '--on-tertiary', '--tertiary-container', '--on-tertiary-container',
      '--error', '--success', '--warning',
      '--surface', '--surface-container-low', '--surface-container', '--surface-container-high',
      '--surface-container-highest', '--on-surface', '--on-surface-variant', '--outline', '--outline-variant',
    ];
    for (const role of roles) {
      expect(tokens).toMatch(new RegExp(`${role}:\\s*[^;]+;`));
    }
    // 8px controls, 12px cards, 28px dialogs, full pills.
    expect(tokens).toMatch(/--radius-control:\s*8px/);
    expect(tokens).toMatch(/--radius-card:\s*12px/);
    expect(tokens).toMatch(/--radius-overlay:\s*28px/);
    expect(tokens).toMatch(/--radius-pill:\s*999px/);
  });

  it('keeps the toast on the radius scale and the scale free of extra tokens', () => {
    const shell = read('src/styles/shell.css');
    const tokens = read('src/styles/tokens.css');
    // The toast used to carry a private 4px token outside the documented
    // scale; it now rides the control radius like inputs and chips.
    expect(shell).toMatch(/\.toast-card\s*\{[^}]*border-radius:\s*var\(--radius-control\)/);
    expect(tokens).not.toMatch(/--radius-toast/);
    expect(tokens).not.toMatch(/--card-radius/);
    expect(tokens).not.toMatch(/--shape-corner-/);
  });

  it('keeps UI type on the token scale with a small weight set', () => {
    const tokens = read('src/styles/tokens.css');
    // Nothing smaller than 12px, and one heading step so section titles stop
    // drifting between 18 and 24.
    expect(tokens).toMatch(/--text-xs:\s*12px/);
    expect(tokens).toMatch(/--text-heading:\s*24px/);
    const allowedWeights = [400, 500, 600, 700];
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      // No raw pixel font sizes anywhere in component CSS.
      expect(sheet).not.toMatch(/font-size:\s*\d+px/);
      for (const [, weight] of sheet.matchAll(/font-weight:\s*(\d+)/g)) {
        expect(allowedWeights).toContain(Number(weight));
      }
    }
  });

  it('keeps literal colors out of component stylesheets', () => {
    // Tokens are the only place a hex, rgb() or rgba() may appear. Components
    // reference semantic tokens so the brand triad and both themes stay swappable.
    for (const path of ['src/styles/base.css', 'src/styles/shell.css', 'src/styles/reader.css']) {
      const sheet = read(path).replace(/\/\*[\s\S]*?\*\//g, '');
      expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(sheet).not.toMatch(/\brgba?\(/);
    }
  });

  it('gives every archive card an 8px gap, its own edge and a 12px radius', () => {
    const shell = read('src/styles/shell.css');
    const wrap = ruleBody(shell, '.archive-list.is-wide .archive-row-wrap');
    expect(wrap).toMatch(/height:\s*166px/);
    // The 8px between cards is the card's own margin, so the timeline rail — which
    // stretches to the wrap — runs unbroken from one row to the next.
    expect(wrap).not.toMatch(/padding-block/);
    const row = ruleBody(shell, '.archive-list.is-wide .archive-row');
    expect(row).toMatch(/margin-block:\s*4px/);
    // The edge is an inner outline, not a border: a border inside the fixed
    // border-box height stole 2px and clipped the second tag row.
    expect(row).toMatch(/outline:\s*1px solid var\(--outline-variant\)/);
    expect(row).toMatch(/outline-offset:\s*-1px/);
    expect(row).toMatch(/border:\s*0/);
    expect(row).toMatch(/border-radius:\s*var\(--radius-card\)/);
    expect(row).toMatch(/background:\s*var\(--surface-container-high\)/);
    expect(row).toMatch(/overflow:\s*hidden/);
    const thumbRow = ruleBody(shell, '.archive-list.is-thumbnail .archive-thumb-card');
    expect(thumbRow).toMatch(/outline:\s*1px solid var\(--outline-variant\)/);
    expect(thumbRow).toMatch(/border:\s*0/);
    expect(thumbRow).toMatch(/border-radius:\s*var\(--radius-card\)/);
    // A continuous list must not be faked with shared edges or negative margins.
    expect(shell).not.toMatch(/margin-top:\s*-1px/);
    expect(shell).not.toMatch(/\.archive-row-wrap:not\(\[data-first=/);
  });

  it('renders the library grid thumbnail with the shared card component', () => {
    const source = read('src/components/LibraryWorkspace.tsx');
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // The grid branch builds the rail's card, not a second card implementation.
    expect(source).toMatch(/className=\{`archive-thumb-card/);
    expect(source).toMatch(/<ArchiveThumbCardBody/);
    expect(source).toMatch(/archive-thumb-card-media/);
    // ...and the body it renders is the exported shared component.
    expect(card).toMatch(/export function ArchiveThumbCardBody/);
    // The meta line is identical in both places: page count on the left, date on
    // the right, so the grid card and the rail card cannot drift apart.
    expect(card).toMatch(/meta=\{<><span>\{formatArchivePageMeta\(/);
    expect(source).toMatch(/meta=\{<><span>\{formatArchivePageMeta\(/);
  });

  it('uses one circular icon-button shape, one nav treatment and one icon weight', () => {
    const shell = read('src/styles/shell.css');
    const base = read('src/styles/base.css');
    const iconAction = ruleBody(shell, '.icon-action');
    // Material 3 filled tonal icon button: circular, secondary-container fill,
    // no outline.
    expect(iconAction).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(iconAction).toMatch(/background:\s*var\(--secondary-container\)/);
    expect(iconAction).toMatch(/color:\s*var\(--on-secondary-container\)/);
    expect(iconAction).not.toMatch(/border:\s*1px/);
    // The settings nav shares the main nav's left indicator instead of its own
    // left border.
    expect(ruleBody(shell, '.settings-nav a')).toMatch(/position:\s*relative/);
    expect(shell).not.toMatch(/\.settings-nav a\.is-active\s*\{[^}]*border-left-color/);
    expect(shell).toMatch(/\.settings-nav a::before,[\s\S]*?\.settings-nav button::before\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(shell).toMatch(/\.settings-nav a\.is-active::before,[\s\S]*?\.settings-nav button\.is-active::before\s*\{[^}]*opacity:\s*1/);
    // Every icon renders at one optical weight.
    expect(base).toMatch(/svg\.lucide\s*\{[\s\S]*stroke-width:\s*1\.75/);
    expect(shell).not.toMatch(/stroke-width:\s*1\.[458]/);
  });

  it('keeps route titles as hidden landmarks and counts in the product font', () => {
    const shell = read('src/styles/shell.css');
    // The archive count is UI text, not a monospaced utility string; it renders
    // in a status-bar entry styled with the product font.
    expect(shell).toMatch(/\.status-item\s*\{[^}]*font-family:\s*var\(--font-body\)/);
    // The big page headline is gone visually but stays in the accessibility tree.
    expect(shell).toMatch(/\.workspace-heading h1,[\s\S]*?\.metadata-edit-header h1\s*\{[\s\S]*clip-path:\s*inset\(50%\)/);
    expect(read('src/components/LibraryRouteWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">档案库<\/h1>/);
    expect(read('src/components/SettingsWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">设置<\/h1>/);
    expect(read('src/components/TaskCenter.tsx')).toMatch(/<h1 className="visually-hidden">下载<\/h1>/);
    expect(read('src/components/SyncWorkspace.tsx')).toMatch(/<h1 className="visually-hidden">同步<\/h1>/);
  });

  it('centres the history rail node on the rail line', () => {
    const shell = read('src/styles/shell.css');
    // The rail is the scroller's own background: 82px timeline column minus the
    // 13px node centre, plus the scroller's 4px side padding, puts the 2px line
    // exactly under the node by construction. Desktop only — the compact layout
    // resets it and groups by the dated section bars instead.
    expect(shell).toMatch(/\.archive-row-timeline\s*\{[\s\S]*--timeline-rail-center:\s*13px/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[\s\S]*right 73px top \/ 2px 100%/);
    expect(shell).toMatch(/\.archive-row-timeline::after\s*\{[\s\S]*left:\s*var\(--timeline-rail-center\)[\s\S]*width:\s*8px[\s\S]*transform:\s*translateX\(-50%\)/);
  });

  it('lets the flow routes grow their cached panel so the tail can scroll out', () => {
    const shell = read('src/styles/shell.css');
    const routes = read('src/app/routes.tsx');
    // route-cache-panel 的 height:100% 钳制会把溢出尾困在面板外：首页与书架
    // 面板必须随内容生长（is-flow），≤900 则所有路由（含档案库页面滚动）放开。
    expect(routes).toContain("flow={!['/library', '/history', '/watchlist', '/to-read'].includes(key)}");
    expect(read('src/app/RetainedPage.tsx')).toContain("flow ? ' is-flow'");
    expect(shell).toMatch(/\.route-cache-panel\.is-flow \{ height: auto; \}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)/);
  });

  it('gives the shelves the library workspace so their list can scroll to the end', () => {
    const shell = read('src/styles/shell.css');
    const appShell = read('src/components/AppShell.tsx');
    expect(appShell).toMatch(/is-library-workspace/);
    expect(appShell).toMatch(/history\|watchlist\|to-read/);
    // The compact override that shrank their end clearance again is gone.
    expect(shell).not.toMatch(/\.workspace\.is-library-workspace \.archive-list\s*\{\s*padding-bottom/);
  });

  it('splits compact history by day and keeps the rail on desktop', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    expect(workspace).toMatch(/archive-day-divider/);
    // Hidden by default, horizontal sections only under the compact breakpoint,
    // where the right-hand rail folds away.
    expect(shell).toMatch(/\.archive-day-divider\s*\{\s*display:\s*none;\s*\}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)[\s\S]*\.archive-row-timeline\s*\{\s*display:\s*none;\s*\}/);
    expect(shell).toMatch(/@media \(max-width: 900px\)[\s\S]*\.archive-day-divider\s*\{[\s\S]*display:\s*flex/);
  });

  it('keeps the history timeline in its own rail outside the clickable card', () => {
    const shell = read('src/styles/shell.css');
    const source = read('src/components/LibraryWorkspace.tsx');
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-wrap:has\(\.archive-row-timeline\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*82px/);
    // The timeline is rendered as a sibling of the card button, never inside it.
    expect(source).toMatch(/<\/button>[\s\S]{0,400}archive-row-timeline/);
  });

  it('keeps the list row stride in step with the card gap', () => {
    const layout = read('src/lib/archiveGridLayout.ts');
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_HEIGHT\s*=\s*158/);
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_GAP\s*=\s*8/);
    expect(layout).toMatch(/ARCHIVE_LIST_ROW_STRIDE\s*=\s*ARCHIVE_LIST_ROW_HEIGHT \+ ARCHIVE_LIST_ROW_GAP/);
    // The compact day divider adds height to a day's first row.
    expect(layout).toMatch(/ARCHIVE_DAY_DIVIDER_HEIGHT\s*=\s*28/);
    const workspace = read('src/components/LibraryWorkspace.tsx');
    expect(workspace).toMatch(/estimateSize:\s*\(index\)\s*=>\s*ARCHIVE_LIST_ROW_STRIDE/);
  });

  it('paints detail tag groups with a hue per namespace and one chip per tag', () => {
    const shell = read('src/styles/shell.css');
    const tokens = read('src/styles/tokens.css');
    // Each namespace carries its own background + ink pair…
    for (const ns of ['artist', 'group', 'parody', 'character', 'female', 'male', 'mixed', 'language', 'category', 'source']) {
      expect(tokens).toMatch(new RegExp('--tag-ns-' + ns + '-bg:'));
      expect(tokens).toMatch(new RegExp('--tag-ns-' + ns + '-ink:'));
      expect(shell).toMatch(new RegExp('\\.tag-group-' + ns + ' \\{ --tag-ns-bg:'));
    }
    // …every tag inside is the same chip family: one deeper fill token, no
    // border. A border used to be the contrast fix and read as an outline the
    // user did not ask for; the fill alone carries the contrast now.
    expect(shell).toMatch(/\.tag-group \.metadata-chip \{\s*background: var\(--chip-background\)/);
    expect(shell).toMatch(/\.tag-group \.metadata-chip \{\s*[\s\S]{0,120}?border: 0/);
    expect(shell).not.toMatch(/--chip-edge/);
    expect(shell).toMatch(/\.tag-group h2,[\s\S]{0,40}\.tag-group h3 \{[^}]*border: 0/);
  });


  it('keeps one dropdown shape, one sort control, and one selection bar', () => {
    const base = read('src/styles/base.css');
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    const settings = read('src/components/SettingsWorkspace.tsx');
    // A tick on the right of every dropdown said what the option background
    // already said, once per menu.
    expect(read('src/components/SelectField.tsx')).not.toMatch(/Check/);
    expect(base).toMatch(/\.select-option-trailing \{/);
    // The sort direction lives in the field it belongs to; the separate button
    // is gone, and its place is where the multi-select toggle sits.
    expect(shell).not.toMatch(/library-sort-direction/);
    expect(workspace).toMatch(/select-trailing/);
    expect(workspace).toMatch(/optionTrailing=/);
    expect(workspace).toMatch(/if \(value === sortMode\) updateSortOrder/);
    // One row shape for every setting, and the complex ones open a panel that
    // shares the preset sheet's frame.
    expect(shell).toMatch(/\.settings-row \{/);
    // The whole row is the control, and its right side is text, not a field:
    // a row that only answered on its value, which looked like a select box,
    // gave two different things to click.
    expect(shell).toMatch(/\.settings-row-button \{/);
    expect(shell).not.toMatch(/settings-choice-trigger/);
    expect(settings).toMatch(/className="settings-row settings-row-button"/);
    // No section may wrap its rows in a frame of its own: a legend or a fieldset
    // padding put the first row of that section lower than every other section's,
    // which is the jump between sections.
    expect(settings).not.toMatch(/model-feature-block/);
    expect(shell).not.toMatch(/model-feature-block|model-stage-row/);
    expect(shell).toMatch(/\.search-preset-overlay,\n\.settings-choice-overlay \{/);
    // Both panels share one sheet shape, but a settings menu is allowed to be
    // taller than a preset list, so the panel rules are separate now.
    expect(shell).toMatch(/\.search-preset-panel \{[^}]*max-height:\s*min\(70vh, 520px\)/);
    expect(shell).toMatch(/\.settings-choice-panel \{[^}]*max-height:\s*min\(85vh, 760px\)/);
    expect(settings).toMatch(/function SettingsRow\(/);
    expect(settings).toMatch(/function SettingsChoice\(/);
    // The selection is a mode with its own bar, not a checkbox glued to a card.
    expect(shell).toMatch(/\.archive-selection-bar \{/);
    expect(shell).toMatch(/\.archive-card-check \{/);
    expect(workspace).toMatch(/role: 'checkbox', 'aria-checked': isSelected/);
    expect(workspace).toMatch(/modifiers.shiftKey && anchor >= 0/);
  });

  it('blurs covers and thumbnails in SFW mode and reveals only the image surface', () => {
    const shell = read('src/styles/shell.css');
    const preferences = read('src/app/preferences.tsx');
    // 开关只翻转根属性：模糊与显隐是纯 CSS 合同，自定义 CSS 无需知道开关。
    expect(preferences).toMatch(/documentElement\.dataset\.sfw/);
    // 列表封面、rail/网格封面与详情封面都参与模糊；SFW 下点击卡片（获得焦点）也算显示意图。
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-row-thumb img/);
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-thumb-card-media img/);
    expect(shell).toMatch(/:root\[data-sfw='true'\] \.archive-detail-cover-trigger img/);
    // 悬停封面本身与卡片焦点/按下都解除模糊。
    expect(shell).toMatch(/\.archive-row-thumb:hover img/);
    expect(shell).not.toMatch(/\.archive-thumb-card:(hover|focus|active) img/);
    expect(shell).toMatch(/\.archive-page-thumbnail img/);
    expect(shell).not.toMatch(/\.archive-row:(hover|focus-visible|active) img/);
    expect(shell).toMatch(/\.archive-detail-cover-trigger:focus-visible img/);
  });

  it('draws the E-Hentai mark as a tonal M3 tile from theme tokens', () => {
    const tokens = read('src/styles/tokens.css');
    const mark = read('src/components/EhMark.tsx');
    // The tile rides the theme (primary container pair), so every colour
    // scheme recolours it; no literal brand teal, no shadow token.
    expect(tokens).toMatch(/--eh-mark-plate: var\(--primary-container\)/);
    expect(tokens).toMatch(/--eh-mark-ink: var\(--on-primary-container\)/);
    expect(tokens).not.toMatch(/--eh-mark-shadow/);
    expect(mark).toMatch(/var\(--eh-mark-plate/);
    expect(mark).toMatch(/var\(--eh-mark-ink/);
    // M3 form: full-bleed rounded plate like YomikaMark, rounded-stroke
    // letterforms, and no skeuomorphic long-shadow stack (no clip/use).
    expect(mark).toMatch(/rx="112"/);
    expect(mark).toMatch(/strokeLinecap="round"/);
    expect(mark).not.toMatch(/clipPath/);
    expect(mark).not.toMatch(/<use /);
  });

  it('pins the settings nav to one offset, whatever the section', () => {
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    // The nav is sticky inside a stretched slot, and sticks at 0. The sticky
    // offset is measured from the scrollport's content edge — already 32px down —
    // so any non-zero inset pushed the list down by that much on exactly the
    // sections whose content was taller than the nav, and the list jumped on
    // every switch between a tall and a short one.
    expect(shell).toMatch(/\.settings-sidebar-slot \{\n  align-self: stretch/);
    expect(shell).toMatch(/\.settings-sidebar \{\n  position: sticky;\n[\s\S]{0,400}?top: 0;/);
    expect(settings).toMatch(/className="settings-sidebar-slot"/);
  });

  it('paints the history rail on the scroller but never leaks it into the compact layout', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    const card = read('src/components/ArchiveThumbnailCard.tsx');
    // The per-row overshoot used to extend the scroller's scrollable area —
    // ~190px of dead scroll. The rail is scroller background now: full height at
    // rest, pinned to the edges mid-gesture, never scrollable — and explicitly
    // reset in the compact block so the phone groups by the day bars instead.
    expect(workspace).toMatch(/timelineByArchiveId \? 'has-timeline'/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{[^}]*no-repeat right 73px top \/ 2px 100%/);
    expect(shell).toMatch(/\.archive-list\.has-timeline\s*\{\s*background:\s*none/);
    expect(shell).not.toMatch(/archive-row-timeline::before/);
    expect(card).toMatch(/headingIcon/);
  });

  it('answers overscroll by moving the list, and pins the refresh disc over it', () => {
    const shell = read('src/styles/shell.css');
    const workspace = read('src/components/LibraryWorkspace.tsx');
    // The notice that faded in over the first row and could outstay the gesture
    // is gone, along with the wheel-delta heuristic that fired it.
    expect(shell).not.toMatch(/library-refresh-hint/);
    expect(workspace).not.toMatch(/library-refresh-hint|pullTicks/);
    // The gesture is answered by the content: one signed offset slides the list
    // past either end, and touch tracks the finger while the wheel eases.
    expect(workspace).toMatch(/className="archive-list-pull"/);
    expect(workspace).toMatch(/data-overscroll=\{overscrollGesture \?\? undefined\}/);
    expect(shell).toMatch(/\.archive-list-pull\[data-overscroll='touch'\] \{ transition: none; \}/);
    // The disc is an overlay, not part of the sliding content: the list springs
    // back on release and the disc stays pinned and spinning above it.
    const disc = ruleBody(shell, '.library-pull-indicator');
    expect(disc).toMatch(/position: sticky/);
    expect(disc).toMatch(/z-index: var\(--z-sticky\)/);
    expect(shell).toMatch(/\.library-pull-indicator\.is-visible \.library-pull-disc \{ opacity: 1/);
    expect(workspace).toMatch(/className=\{`library-pull-indicator/);
    // Never build a class name by appending a possibly-undefined value: the
    // string "undefined" matches no rule, so the element renders raw.
    expect(workspace).not.toMatch(/\$\{[^}]*\?[^}]*:\s*undefined\s*\}/);
  });

  it('keeps toast text at WCAG AA contrast in light and dark themes', () => {
    const tokens = read('src/styles/tokens.css');
    const shell = read('src/styles/shell.css');
    const light = cssVariables(ruleBody(tokens, ':root'));
    const dark = new Map([
      ...light,
      ...cssVariables(ruleBody(tokens, ":root[data-theme='dark']")),
    ]);
    // A failed capture must not pass by checking the dark theme twice.
    expect(light.get('--surface-canvas')).not.toBe(dark.get('--surface-canvas'));
    const toast = shell.match(/\.toast-card\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const backgroundToken = toast.match(/background:\s*var\((--[\w-]+)\)/)?.[1] ?? '';
    const foregroundToken = toast.match(/color:\s*var\((--[\w-]+)\)/)?.[1] ?? '';

    for (const theme of [light, dark]) {
      const canvas = rgb(theme.get('--surface-canvas') ?? '');
      const background = rgb(theme.get(backgroundToken) ?? '', canvas);
      const foreground = rgb(theme.get(foregroundToken) ?? '', background);
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
