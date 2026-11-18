import { useId, useLayoutEffect, useState } from 'react';

// Inspired by QWEA0/Liquid-Glass-Android's SDF edge compression. Chromium can
// sample the WebView backdrop directly, so all we need is the displacement field.
const displacementScale = 48;
const lensPadding = 16;

function capsuleMap(width: number, height: number, displacement: number, density: number): string | undefined {
  const canvas = document.createElement('canvas');
  const pixelWidth = canvas.width = Math.ceil(width * density);
  const pixelHeight = canvas.height = Math.ceil(height * density);
  const context = canvas.getContext('2d');
  if (!context) return undefined;

  const image = context.createImageData(pixelWidth, pixelHeight);
  const radius = Math.min(width, height) / 2;
  const band = Math.min(radius * 0.66, 17);
  // Keep the sampling position monotonic along the normal. The quadratic
  // bevel has its steepest slope at the rim (2 * displacement / band). A
  // steeper field folds the backdrop and repeats or mirrors text at the rim.
  const inset = Math.min(displacement, band * 0.43);
  const straightX = width / 2 - radius;
  const straightY = height / 2 - radius;
  const pixelSize = Math.max(width / pixelWidth, height / pixelHeight);
  for (let y = 0; y < pixelHeight; y++) {
    for (let x = 0; x < pixelWidth; x++) {
      const localX = (x + 0.5) * width / pixelWidth - width / 2;
      const localY = (y + 0.5) * height / pixelHeight - height / 2;
      const dx = Math.max(0, Math.abs(localX) - straightX) * Math.sign(localX);
      const dy = Math.max(0, Math.abs(localY) - straightY) * Math.sign(localY);
      const len = Math.hypot(dx, dy);
      const depth = radius - len;
      const index = (y * pixelWidth + x) * 4;
      // Sampling inwards at the bevel compresses backdrop detail near the rim.
      // The center is neutral and keeps text and artwork underneath recognizable.
      const strength = len > 0 && depth > -pixelSize / 2 && depth < band
        ? -inset * (1 - Math.max(0, depth) / band) ** 2 / len : 0;
      image.data[index] = 255 * (0.5 + dx * strength / displacementScale);
      image.data[index + 1] = 255 * (0.5 + dy * strength / displacementScale);
      // Encode the bevel highlight in B and the antialiased silhouette in A.
      const normalLight = len > 0 ? Math.max(0, (-dx * 0.42 - dy * 0.91) / len) : 0;
      image.data[index + 2] = 255 * normalLight * Math.exp(-Math.max(0, depth) * 0.87);
      image.data[index + 3] = 255 * Math.min(1, Math.max(0, depth / pixelSize + 0.5));
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function useNavigationRefraction(nav: HTMLElement | null, enabled: boolean) {
  const id = useId();
  const filterId = `nav-optics${id}`;
  const [maps, setMaps] = useState<{ bar: string; tab: string; width: number; height: number }>();
  useLayoutEffect(() => {
    if (!enabled || !nav || !/\b(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)) return;
    let lastSize = '';
    const density = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const update = () => {
      const tab = nav.querySelector<HTMLElement>('[data-nav-route]');
      if (!tab || !nav.offsetWidth || !nav.offsetHeight || !tab.offsetWidth || !tab.offsetHeight) return;
      const size = `${nav.offsetWidth}:${nav.offsetHeight}:${tab.offsetWidth}:${tab.offsetHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      const bar = capsuleMap(nav.offsetWidth, nav.offsetHeight, 6, density);
      const tabMap = capsuleMap(tab.offsetWidth, tab.offsetHeight, 7, density);
      if (bar && tabMap) setMaps({ bar, tab: tabMap, width: nav.offsetWidth, height: nav.offsetHeight });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [enabled, nav]);
  if (!enabled || !maps?.bar || !maps.tab) return undefined;
  return {
    filter: `url("#${filterId}")`,
    padding: `${lensPadding}px`,
    definitions: <svg width="0" height="0" className="nav-optics" aria-hidden="true" focusable="false">
      <defs>
        <filter id={filterId} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={maps.bar} x={lensPadding} y={lensPadding} width={maps.width} height={maps.height}
            preserveAspectRatio="none" result="bar" />
          <feImage data-nav-optical-lens href={maps.tab} x="0" y="0" width="0" height="0"
            preserveAspectRatio="none" result="tab" />
          {/* The upper shape replaces the bar's displacement and highlight.
              Both shapes sample the same backdrop, so the outer rim cannot
              show through as two horizontal reflections inside the tab. */}
          <feComposite in="tab" in2="bar" operator="over" result="field" />
          {(['R', 'G', 'B'] as const).map((channel, index) => <ChannelRefraction key={channel}
            channel={channel} strength={displacementScale + (index - 1) * 1.5} />)}
          <feBlend in="refractedR" in2="refractedG" mode="screen" result="refractedRG" />
          <feBlend in="refractedRG" in2="refractedB" mode="screen" result="refraction" />
          {/* Keep the material tint subtle so the refracted backdrop retains
              its own color. Foreground contrast is handled by the controls. */}
          <feFlood className="nav-optics-tone" floodOpacity="0.12" result="tone" />
          {/* Resample subpixel detail after displacement, without filtering
              the silhouette, rim light, or foreground controls. */}
          <feGaussianBlur in="refraction" stdDeviation="0.38" result="sample" />
          <feComposite in="tone" in2="sample" operator="over" result="toned" />
          <feComposite in="toned" in2="field" operator="in" result="glass" />
          <feColorMatrix in="field" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 .52 0 0" result="light" />
          <feComposite in="light" in2="field" operator="in" result="rim" />
          <feBlend in="rim" in2="glass" mode="screen" />
        </filter>
      </defs>
    </svg>,
  };
}

export function positionNavigationLens(nav: HTMLElement, bounds?: { x: number; y: number; width: number; height: number }) {
  const lens = nav.querySelector<SVGFEImageElement>('[data-nav-optical-lens]');
  if (!lens) return;
  for (const [attribute, value] of Object.entries({
    x: bounds ? bounds.x + lensPadding + 1 : 0,
    y: bounds ? bounds.y + lensPadding + 1 : 0,
    width: bounds?.width ?? 0,
    height: bounds?.height ?? 0,
  })) {
    const next = String(Math.round(value * 8) / 8);
    if (lens.getAttribute(attribute) !== next) lens.setAttribute(attribute, next);
  }
}

// Wavelength-dependent displacement along the same normal. Keep the split
// small so it reads as an edge fringe instead of duplicating background text.
const colorChannels = {
  R: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
  G: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
  B: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
};

function ChannelRefraction({ channel, strength }: { channel: keyof typeof colorChannels; strength: number }) {
  return <>
    <feDisplacementMap in="SourceGraphic" in2="field" scale={strength}
      xChannelSelector="R" yChannelSelector="G" result={`offset${channel}`} />
    <feColorMatrix in={`offset${channel}`} values={colorChannels[channel]} result={`refracted${channel}`} />
  </>;
}
