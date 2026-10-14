# Generated platform icons

The only geometry is `assets/yomika-mark.svg`: open pages converge into a Y spine,
with a vermilion bookmark. The glyph has at least 21% canvas padding.

```sh
node .github/scripts/derive-logo.mjs --icons
node .github/scripts/derive-logo.mjs --check
```

The first command derives SVG/React/static HTML, invokes Tauri icon generation,
copies the 32px export to tray-32.png, synchronizes the Android fallback set with
the generated Android project, and records all raster hashes tied to the master.
The check is read-only. Do not hand-edit platform bitmaps or generated geometry.

Android adaptive foreground is scaled uniformly to 68% inside its mask safe zone.
Packed colors are dark plate/light pages/vermilion bookmark. Inline application
colors use the existing plate/ink/accent theme slots. At 16px the book/Y silhouette
is the identity; the bookmark detail is intentionally secondary.

Windows ICO, macOS ICNS, appx, Android and iOS assets are generated together.
The tray bitmap is exactly the generated 32px application bitmap. Existing native
tray decode/fallback behavior is retained. See docs/30-splash-screen.md for startup
lifecycle and Android OS launch-theme limitations.
