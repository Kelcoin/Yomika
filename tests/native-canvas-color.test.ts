import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeCanvasColor } from '../src/lib/nativeCanvasColor';

afterEach(() => { document.documentElement.style.removeProperty('--surface-canvas'); vi.restoreAllMocks(); });

describe('native canvas color boundary', () => {
  it.each([
    ['#1e2832', '#1e2832', '#1e2832'],
    ['rgb(30, 40, 50)', '#1e2832', '#1e2832'],
    ['hsl(210, 25%, 16%)', '#1f2933', '#1f2933'],
    ['rgba(30, 40, 50, 0.5)', '#1e283280', '#801e2832'],
    ['#1e283280', '#1e283280', '#801e2832'],
  ])('normalizes %s for CSS and Android alpha ordering', (color, css, native) => {
    document.documentElement.style.setProperty('--surface-canvas', color);
    expect(nativeCanvasColor(true)).toEqual({ css, native });
  });
  it('uses browser sRGB conversion for modern computed colors', () => {
    document.documentElement.style.setProperty('--surface-canvas', 'color-mix(in srgb, red 50%, blue)');
    const original = getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element === document.documentElement
      ? original(element)
      : { backgroundColor: 'color(srgb 0.5 0 0.5)' } as CSSStyleDeclaration);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '', fillRect: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([128, 0, 128, 255]) }),
    } as unknown as CanvasRenderingContext2D);
    expect(nativeCanvasColor(false)).toEqual({ css: '#800080', native: '#800080' });
  });
  it('falls back for missing or invalid CSS instead of persisting an old canvas', () => {
    expect(nativeCanvasColor(true)).toEqual({ css: '#121412', native: '#121412' });
    document.documentElement.style.setProperty('--surface-canvas', 'not-a-color');
    expect(nativeCanvasColor(false)).toEqual({ css: '#fbf8f3', native: '#fbf8f3' });
  });
});
