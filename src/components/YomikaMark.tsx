/** The Yomika brand mark, drawn inline.
 *
 * It used to be an `<img src="…svg">` — but an image-loaded SVG is its own
 * document, so the `currentColor` inside it never sees the page's theme colour
 * and the mark stayed black on dark backgrounds. Inline, the strokes ride the
 * host element's colour and the plate rides `--yomika-mark-plate`, so both
 * follow the theme and the colour schemes. */
export function YomikaMark({ size = 38, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`yomika-mark${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      role="img"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="112" fill="var(--yomika-mark-plate, #0D0D0D)" />
      {/* The frame rides the theme accent while the glyph rides the ink: three
          tiers (plate / accent frame / ink glyph) keep every element legible
          against its neighbours in both themes and every colour scheme. */}
      <rect x="112" y="112" width="288" height="288" rx="20" stroke="var(--yomika-mark-frame, var(--primary))" strokeWidth="18" fill="none" />
      <g stroke="currentColor">
        <line x1="184" y1="184" x2="184" y2="328" strokeWidth="18" strokeLinecap="round" />
        <line x1="184" y1="184" x2="264" y2="184" strokeWidth="18" strokeLinecap="round" />
        <line x1="224" y1="184" x2="224" y2="264" strokeWidth="18" strokeLinecap="round" />
        <line x1="264" y1="224" x2="328" y2="224" strokeWidth="18" strokeLinecap="round" />
      </g>
      <circle cx="288" cy="296" r="22" fill="currentColor" />
    </svg>
  );
}
