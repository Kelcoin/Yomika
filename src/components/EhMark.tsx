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
 * Colours ride the theme tokens, so every colour scheme recolours it. */
export function EhMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`eh-mark${className ? ` ${className}` : ''}`}
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
        {/* E: stem plus three arms, the middle one shorter. */}
        <path d="M152 172 V340" />
        <path d="M152 172 H260" />
        <path d="M152 256 H244" />
        <path d="M152 340 H260" />
        {/* h: ascender stem, arch shoulder into the right leg. */}
        <path d="M300 172 V340" />
        <path d="M300 258 C300 238 314 230 330 230 C348 230 360 244 360 266 L360 340" />
      </g>
    </svg>
  );
}
