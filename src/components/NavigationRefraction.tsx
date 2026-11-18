import { useId, useLayoutEffect, useState } from 'react';

// Inspired by QWEA0/Liquid-Glass-Android's SDF edge compression. Chromium can
// sample the WebView backdrop directly, so all we need is the displacement field.
const displacementScale = 48;

function capsuleMap(width: number, height: number, displacement: number): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;

  const image = context.createImageData(width, height);
  const radius = Math.min(width, height) / 2;
  const band = Math.min(radius * 0.55, 14);
  const straightX = width / 2 - radius;
  const straightY = height / 2 - radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const localX = x + 0.5 - width / 2;
      const localY = y + 0.5 - height / 2;
      const dx = Math.max(0, Math.abs(localX) - straightX) * Math.sign(localX);
      const dy = Math.max(0, Math.abs(localY) - straightY) * Math.sign(localY);
      const len = Math.hypot(dx, dy);
      const depth = radius - len;
      const index = (y * width + x) * 4;
      // Sampling inwards at the bevel compresses backdrop detail near the rim.
      // The center is neutral and keeps text and artwork underneath recognizable.
      const strength = len > 0 && depth >= 0 && depth < band
        ? -displacement * (1 - depth / band) ** 2 / len : 0;
      image.data[index] = 255 * (0.5 + dx * strength / displacementScale);
      image.data[index + 1] = 255 * (0.5 + dy * strength / displacementScale);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function useNavigationRefraction(nav: HTMLElement | null, enabled: boolean) {
  const id = useId();
  const barId = `nav-bar-lens${id}`;
  const tabId = `nav-tab-lens${id}`;
  const [maps, setMaps] = useState<{ bar?: string; tab?: string }>();
  useLayoutEffect(() => {
    if (!enabled || !nav || !/\b(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)) return;
    let lastSize = '';
    const update = () => {
      const tab = nav.querySelector<HTMLElement>('[data-nav-route]');
      if (!tab || !nav.offsetWidth || !nav.offsetHeight || !tab.offsetWidth || !tab.offsetHeight) return;
      const size = `${nav.offsetWidth}:${nav.offsetHeight}:${tab.offsetWidth}:${tab.offsetHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      const bar = capsuleMap(nav.offsetWidth, nav.offsetHeight, 18);
      const tabMap = capsuleMap(tab.offsetWidth, tab.offsetHeight, 22);
      if (bar && tabMap) setMaps({ bar, tab: tabMap });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [enabled, nav]);
  if (!enabled || !maps?.bar || !maps.tab) return undefined;
  return {
    barFilter: `url("#${barId}")`,
    tabFilter: `url("#${tabId}")`,
    definitions: <svg width="0" height="0" className="nav-optics" aria-hidden="true" focusable="false">
      <defs>
        <Lens id={barId} map={maps.bar} />
        <Lens id={tabId} map={maps.tab} />
      </defs>
    </svg>,
  };
}

function Lens({ id, map }: { id: string; map: string }) {
  return <filter id={id} x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
    <feImage href={map} x="0%" y="0%" width="100%" height="100%" preserveAspectRatio="none" result="displacement" />
    <feDisplacementMap in="SourceGraphic" in2="displacement" scale={displacementScale} xChannelSelector="R" yChannelSelector="G" />
  </filter>;
}
