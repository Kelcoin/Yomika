import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

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
    expect(shell).toMatch(/\.archive-row-meta\s*\{/);
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

  it('keeps embedded sync controls aligned to the full settings column', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.settings-sync-content,[\s\S]*?\.settings-sync-content \.sync-form\s*\{[\s\S]*?width:\s*100%[\s\S]*?max-width:\s*none/);
  });

  it('enables the native Windows credential backend for release builds', () => {
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toMatch(/keyring\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*['"]windows-native['"]/s);
  });

  it('uses a JHenTai-style two-level settings layout with stable rail targets', () => {
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
    expect(shell).toMatch(/\.library-shell\s+\.library-heading\s*\{\s*align-items:\s*stretch/);
  });

  it('keeps recommendation rails horizontal and lets wide covers span the thumbnail grid', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/);
    expect(shell).toMatch(/\.archive-rail-grid\s*\{[\s\S]*align-items:\s*flex-start/);
    expect(shell).toMatch(/\.archive-thumb-card\s*\{[\s\S]*width:\s*150px/);
    expect(shell).toMatch(/\.archive-thumb-card\.is-wide\s*\{[\s\S]*width:\s*316px/);
    expect(shell).toMatch(/\.archive-thumb-card-media\s*\{[\s\S]*height:\s*210px/);
    expect(shell).toMatch(/\.archive-thumb-card-body\s*\{[\s\S]*grid-template-rows:\s*40px 44px 15px[\s\S]*height:\s*135px/);
    expect(shell).toMatch(/\.archive-thumb-card-tags\s*\{[\s\S]*align-items:\s*flex-start[\s\S]*align-content:\s*flex-start/);
    // The rail card is 150px wide, so its chips run at the same compact size as
    // the library grid's rather than the default 12px.
    expect(shell).toMatch(/\.archive-thumb-card-tags \.metadata-chip\s*\{[\s\S]*min-height:\s*20px[\s\S]*font-size:\s*11px/);
    // Thumbnail grid rows are packed in JS (fixed 180px columns, wide covers
    // exactly two columns plus the 12px gap) so the grid can virtualize by row.
    expect(shell).toMatch(/\.archive-thumb-grid-row\s*\{[\s\S]*position:\s*absolute[\s\S]*display:\s*flex[\s\S]*gap:\s*12px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\s*\{[\s\S]*width:\s*180px/);
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-wrap\.is-cover-wide\s*\{[\s\S]*width:\s*372px/);
    // Fixed card geometry: 220 cover + 8 gap + 106 copy + 2x8 padding = 350px.
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row\s*\{[\s\S]*grid-template-rows:\s*220px 106px[\s\S]*height:\s*350px/);
    // Three fixed copy slots so the second row of chips is never clipped.
    expect(shell).toMatch(/\.archive-list\.is-thumbnail \.archive-row-copy\s*\{[\s\S]*grid-template-rows:\s*34px 48px 16px[\s\S]*height:\s*106px/);
    // List rows share the footer layout and drop the trailing chevron column.
    expect(shell).toMatch(/\.archive-row-footer\s*\{[\s\S]*justify-content:\s*space-between/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row\s*\{[\s\S]*grid-template-columns:\s*100px minmax\(0, 1fr\);/);
    // The wide card has the biggest tag area in the app, so it gets full-size
    // chips: it used to pair the largest area with the smallest chips.
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-tags \.metadata-chip\s*\{[\s\S]*font-size:\s*12px/);
    expect(shell).toMatch(/\.archive-list\.is-wide \.archive-row-tags\s*\{[\s\S]*grid-template-rows:\s*repeat\(3,/);
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
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\s*\{[^}]*flex:\s*0 0 44px[^}]*min-width:\s*44px/);
    expect(shell).toMatch(/\.switch-control\[role="switch"\]\[aria-checked="true"\]::after\s*\{[^}]*left:\s*auto[^}]*right:\s*3px/);
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
