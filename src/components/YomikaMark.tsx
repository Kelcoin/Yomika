/** The Yomika brand mark, drawn inline.
 *
 * It used to be an `<img src="…svg">` — but an image-loaded SVG is its own
 * document, so the `currentColor` inside it never sees the page's theme colour
 * and the mark stayed black on dark backgrounds. Inline, the slots resolve
 * against the page's own custom properties.
 *
 * ## One picture, four surfaces
 *
 * These coordinates are `assets/yomika-mark.svg`'s, verbatim — the file the
 * window/installer/Android/iOS icon set and the tray bitmap are all derived
 * from (`.github/scripts/derive-logo.mjs`). There used to be three drawings
 * of the mark: a stroked one here, a separate hand-drawn tray glyph, and a
 * fourth copy in the packed set. They had drifted, so the logo was a different
 * picture in the sidebar, the title bar and the notification area; at 16px the
 * in-app one was the worst of the three. Now there is one, and the contract
 * test `draws one mark, not four: the in-app component mirrors the master`
 * fails if this file stops agreeing with the master.
 *
 * ## The three colour slots
 *
 * The master names its colours instead of inlining them, because one drawing
 * has to serve two colour worlds. Here they resolve against the theme:
 *
 *   YOMIKA_PLATE  → `--yomika-mark-plate` — the app's plates are lifted
 *                   surfaces, not the literal brand black the packed icon uses.
 *   YOMIKA_INK    → `currentColor` — the glyph rides the host element's colour,
 *                   so it follows the theme and all six colour schemes.
 *   YOMIKA_ACCENT → `--yomika-mark-ink-accent` — the dot. It is the one part of
 *                   the mark that says "this machine, not the other one", so it
 *                   keeps its own tier in both worlds.
 *
 * The old stroked version also carried an accent **frame** (`--yomika-mark-frame`,
 * a stroked square riding `--primary`). It is gone: at 16px the frame took the
 * width the glyph needs, and the plate already carries the identity — the same
 * reason the tray candidate "C-framed" was rejected in `debug_outputs/tray-icons`. */
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
      <g id="yomika-glyph">
        <rect x="88" y="64" width="128" height="384" rx="64" fill="currentColor" />
        <rect x="88" y="64" width="320" height="128" rx="64" fill="currentColor" />
        <rect x="216" y="224" width="96" height="64" rx="32" fill="currentColor" />
        <circle cx="368" cy="368" r="80" fill="var(--yomika-mark-ink-accent, #E8E8E8)" />
      </g>
    </svg>
  );
}
