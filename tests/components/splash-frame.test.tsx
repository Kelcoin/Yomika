import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SplashFrame } from '../../src/components/SplashFrame';
import { COLOR_SCHEMES } from '../../src/lib/cssThemePresets';
import { YomikaMark } from '../../src/components/YomikaMark';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const parsed = new DOMParser().parseFromString(html, 'text/html');
const bootstrap = [...parsed.scripts].find(script => script.textContent?.includes("localStorage.getItem('yomika.last-theme')"))!.textContent!;

function restore(theme: string | null, systemDark: boolean) {
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  if (theme !== null) localStorage.setItem('yomika.last-theme', theme);
  vi.stubGlobal('matchMedia', () => ({ matches: systemDark }));
  document.head.innerHTML = '<meta name="theme-color" content="">';
  Function(bootstrap)();
}

describe('one first frame', () => {
  it('never replays a timed React overlay, including development/native launches', () => {
    vi.stubEnv('MODE', 'development');
    const { container } = render(<SplashFrame />);
    expect(container).toBeEmptyDOMElement();
    vi.unstubAllEnvs();
  });
  it('restores validated explicit themes before body markup', () => {
    expect(html.indexOf(bootstrap)).toBeLessThan(html.indexOf('</head>'));
    restore('dark', false);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta')?.content).toBe('#121412');
    restore('light', true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta')?.content).toBe('#fbf8f3');
    vi.unstubAllGlobals();
  });
  it('uses system fallback for absent, system and corrupted mirror values', () => {
    for (const theme of [null, 'system', 'corrupted']) {
      restore(theme, true);
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
      expect(document.querySelector('meta')?.content).toBe('#121412');
    }
    vi.unstubAllGlobals();
  });
  it('keeps restored preset semantic mark colors identical before and after app CSS loads', () => {
    const appTokens = readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8');
    const declarations = [...html.matchAll(/--yomika-mark-(plate|ink-accent):\s*([^;]+);/g)];
    expect(declarations).toHaveLength(6); // default, explicit dark, system dark
    for (const preset of COLOR_SCHEMES.filter(preset => preset.css)) {
      const semantics = new Map([...preset.css.matchAll(/(--surface-container-highest|--on-surface-variant):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
      expect(semantics.size).toBe(2);
      for (const [, slot, value] of declarations) {
        const semantic = slot === 'plate' ? '--surface-container-highest' : '--on-surface-variant';
        expect(value).toMatch(new RegExp(`^var\\(${semantic}, #[0-9a-f]+\\)$`));
        expect(appTokens).toContain(`--yomika-mark-${slot}: var(${semantic})`);
        // Both aliases resolve to this restored palette expression, including color-mix.
        expect(semantics.get(value!.match(/var\((--[\w-]+)/)![1])).toBe(semantics.get(semantic));
      }
    }
  });
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5, true, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0, true, false],
    ['Mozilla/5.0 (iPad; CPU OS 17_0)', 5, true, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5, false, false],
  ])('does not replay the static brand for native mobile UA %s', (userAgent, maxTouchPoints, native, hidden) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
    if (native) Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    else delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete document.documentElement.dataset.nativeMobile;
    restore('light', false);
    expect(document.documentElement.dataset.nativeMobile === 'true').toBe(hidden);
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('uses the same mother paths for static and React marks', () => {
    const { container } = render(<YomikaMark />);
    const paths = (element: ParentNode) => [...element.querySelectorAll('path')].map(path => path.getAttribute('d'));
    expect(paths(container)).toEqual(paths(parsed));
    expect(paths(container)).toHaveLength(4);
    const fills = (element: ParentNode) => [...element.querySelectorAll('rect, path')].map(shape => shape.getAttribute('fill'));
    expect(fills(container)).toEqual(fills(parsed));
    expect(fills(container)).toContain('currentColor');
    expect(fills(container)).toContain('var(--yomika-mark-plate, #0D0D0D)');
    expect(fills(container)).toContain('var(--yomika-mark-ink-accent, #B63A2E)');
  });
});
