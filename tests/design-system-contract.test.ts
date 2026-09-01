import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('design system contract', () => {
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

  it('uses bounded settings columns instead of an intrinsic auto action column', () => {
    const shell = read('src/styles/shell.css');
    const settingsRule = shell.match(/\.settings-section\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(settingsRule).not.toMatch(/grid-template-columns:[^;]*\bauto\b/);
    expect(settingsRule).toMatch(/grid-template-columns:[^;]*minmax\(/);
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
  });

  it('enables the native Windows credential backend for release builds', () => {
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toMatch(/keyring\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*['"]windows-native['"]/s);
  });

  it('uses a JHenTai-style two-level settings layout with stable rail targets', () => {
    const shell = read('src/styles/shell.css');
    const settings = read('src/components/SettingsWorkspace.tsx');
    expect(settings).toMatch(/className="settings-layout"/);
    expect(settings).toMatch(/className="settings-sidebar"/);
    expect(settings).toMatch(/className="settings-nav"/);
    expect(shell).toMatch(/\.settings-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(164px,\s*208px\)/);
    expect(shell).toMatch(/\.settings-nav a\s*\{[\s\S]*min-height:\s*40px/);
    expect(shell).toMatch(/\.sidebar-toggle\s*\{[\s\S]*flex:\s*0 0 44px/);
    expect(shell).toMatch(/\.segmented-control\s*\{[\s\S]*width:\s*fit-content/);
  });

  it('keeps archive toolbar icon actions compact and select fields flexible', () => {
    const shell = read('src/styles/shell.css');
    expect(shell).toMatch(/\.library-toolbar\s*\{[\s\S]*display:\s*flex/);
    expect(shell).toMatch(/\.library-toolbar\s*>\s*\.secondary-action\s*\{[\s\S]*flex:\s*0\s*0\s*var\(--control-height\)/);
    expect(shell).toMatch(/\.library-toolbar\s+\.select-field\s*\{[\s\S]*flex:\s*1\s*1\s*0/);
    expect(shell).toMatch(/\.library-shell\s+\.library-heading\s*\{\s*align-items:\s*stretch/);
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
});
