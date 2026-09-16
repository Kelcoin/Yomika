/** The E-Hentai mark, drawn inline in the app's own mark language.
 *
 * The first cut traced the EhViewer reference icon literally — teal plate,
 * slab-serif "Eh", a flat long shadow. That is another app's material language
 * (a Material 2 long shadow at that); the redraw keeps only the letters and
 * reshapes the rest as a Material 3 tonal tile: one rounded plate from the
 * theme's primary container, the "Eh" letterforms as rounded strokes in the
 * on-container ink, no shadow, no frame — the same family YomikaMark draws in,
 * so the two marks sit side by side without one of them looking imported.
 *
 * Colours ride the theme tokens, so every colour scheme recolours it.
 *
 * `plate={false}` drops the tile and keeps only the letterforms, scaled into the
 * 24-grid with a 2px stroke — the shape the settings rows draw every other icon
 * in, where a filled chip next to a row of plain glyphs read as a foreign badge. */
export function EhMark({ size = 20, className, plate = true }: { size?: number; className?: string; plate?: boolean }) {
  const classes = `eh-mark${className ? ` ${className}` : ''}`;
  const letterforms = (
    <>
      {/* E: stem plus three arms, the middle one shorter. */}
      <path d="M152 172 V340" />
      <path d="M152 172 H260" />
      <path d="M152 256 H244" />
      <path d="M152 340 H260" />
      {/* h: ascender stem, arch shoulder into the right leg. */}
      <path d="M300 172 V340" />
      <path d="M300 258 C300 238 314 230 330 230 C348 230 360 244 360 266 L360 340" />
    </>
  );

  if (!plate) {
    // The letterforms already sit centred on (256, 256) in the 512 box, so the
    // glyph version is just a scale into the icon grid: 0.0909 × 22 units keeps
    // the 2px stroke weight the other row icons are drawn with.
    return (
      <svg className={classes} width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-hidden="true">
        <g
          transform="translate(12 12) scale(0.0909) translate(-256 -256)"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {letterforms}
        </g>
      </svg>
    );
  }

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="112" fill="var(--eh-mark-plate, var(--primary-container))" />
      <g
        stroke="var(--eh-mark-ink, var(--on-primary-container))"
        strokeWidth="22"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {letterforms}
      </g>
    </svg>
  );
}
