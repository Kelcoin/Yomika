/** Resolve a CSS canvas through browser color computation, then convert CSS
 * RGBA to Android's ARGB hex. Never pass raw CSS functions to Color.parseColor. */
export function nativeCanvasColor(dark: boolean): { css: string; native: string } {
  const fallback = dark ? '#121412' : '#fbf8f3';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim();
  if (!raw) return { css: fallback, native: fallback };
  const probe = document.createElement('span');
  probe.style.backgroundColor = raw;
  probe.style.display = 'none';
  document.documentElement.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (!probe.style.backgroundColor || !resolved) return { css: fallback, native: fallback };
  let rgba: number[] | undefined;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(resolved);
  if (rgb) rgba = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Math.round(Number(rgb[4] ?? 1) * 255)];
  else {
    // Canvas converts modern computed colors (color-mix, wide-gamut color()) to
    // sRGB bytes. Older engines reject unsupported colors and use the fallback.
    try {
      const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (context) {
        context.fillStyle = '#010203';
        context.fillStyle = resolved;
        const first = context.fillStyle;
        context.fillStyle = '#040506';
        context.fillStyle = resolved;
        if (context.fillStyle !== first) return { css: fallback, native: fallback };
        context.fillRect(0, 0, 1, 1);
        rgba = [...context.getImageData(0, 0, 1, 1).data];
      }
    } catch { /* unavailable canvas */ }
  }
  if (!rgba || rgba.some(value => !Number.isFinite(value))) return { css: fallback, native: fallback };
  const hex = rgba.map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'));
  const opaque = rgba[3] === 255;
  return { css: `#${hex.slice(0, 3).join('')}${opaque ? '' : hex[3]}`, native: `#${opaque ? '' : hex[3]}${hex.slice(0, 3).join('')}` };
}
