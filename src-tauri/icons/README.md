# Window and taskbar icons

`icon.ico`'s **entry order is load-bearing**, and not in the way an ICO usually is.

Windows itself picks the best-matching size out of a group, so order is normally
irrelevant. Two things here do not:

- `tauri-codegen` decodes **only the first entry** of `bundle.icon`'s `.ico` to
  build `default_window_icon` (`CachedIcon::new_ico` → `entries()[0]`).
- Tauri passes that single image to tao as `with_window_icon`, which sends
  `WM_SETICON` with **`ICON_SMALL`** only. `ICON_BIG` is never set, so the taskbar
  button falls back to the window class icon — the group icon linked into the exe
  by `tauri-build`, which contains every size.

So the first entry is the app's *small* icon: the one in the window's own title
area and in the taskbar's hover preview. A 256×256 image in that slot is not
scaled down, it simply fails to draw, which is how the hover preview lost its icon.

The order is therefore 32×32 first, then the rest largest to smallest. Re-exporting
this file from a design tool will silently reorder it; put 32×32 back in front.

## Mobile icons

Android and iOS take their launcher art from `tauri icon`, which writes into the
*generated* project when one exists (`gen/android/app/src/main/res`,
`gen/apple/Assets.xcassets/AppIcon.appiconset`) and falls back to `icons/android`
and `icons/ios` otherwise. It therefore has to run *after* `tauri android init` /
`tauri ios init` — the packaging workflow does that, and a local run refreshes the
fallback copies checked in here:

    npx tauri icon src-tauri/icons/icon-manifest.json

`icon-manifest.json` is the input: `assets/yomika-mark-print.svg` for the flat
icons, `android-foreground.svg` (the mark without its rounded square) as the
adaptive icon's foreground and monochrome layer, and `#0D0D0D` for the plate
behind them. The separate foreground is what keeps Android from drawing the whole
black square inside a white circle: the foreground is what gets scaled into the
mask's safe area.

A regeneration also rewrites the desktop set, `icon.ico` included. That one comes
out with 32×32 still in front, so it keeps working — the warning above is about
design-tool exports, not about this command.
