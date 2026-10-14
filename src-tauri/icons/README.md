# Window and taskbar icons

Every file in here is derived from **one** master, `assets/yomika-mark.svg`. Nothing
in this directory is hand-drawn, and nothing here may be: the mark used to exist as
four drawings (a stroked master, a separate tray glyph, the packed set, the in-app
component) and they drifted apart, so the logo was a different picture in the
sidebar, in the title bar and in the notification area.

    node .github/scripts/derive-logo.mjs           # writes app-icon.svg + android-foreground.svg
    npx tauri icon src-tauri/icons/icon-manifest.json # writes every bitmap below

The contract test `draws one mark, not four` fails if any surface stops mirroring the
master's geometry, and `names every colour slot the master mark uses` fails if a slot
the master names has no destination in the derive script or in the theme tokens.

## Why there is a derived SVG at all

`assets/yomika-mark.svg` names its three colours instead of inlining them
(`YOMIKA_PLATE`, `YOMIKA_INK`, `YOMIKA_ACCENT`), because one drawing has to serve two
colour worlds: the in-app mark has to follow the theme, and a packed bitmap cannot.
`.github/scripts/derive-logo.mjs` slices the master's plate and glyph verbatim and
resolves those names to literals. `app-icon.svg` in this directory is that output —
it is an input to `tauri icon`, not a second drawing.

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

The order is therefore 32×32 first, then the rest. (`tauri icon` writes the entries
ascending after that; the hand-made file that predates the manifest had them
largest-first — Windows picks by size either way, and only the **first** entry is
load-bearing. Re-exporting this file from a design tool will silently reorder it;
put 32×32 back in front.

## Mobile icons

Android and iOS take their launcher art from `tauri icon`, which writes into the
*generated* project when one exists (`gen/android/app/src/main/res`,
`gen/apple/Assets.xcassets/AppIcon.appiconset`) and falls back to `icons/android`
and `icons/ios` otherwise. It therefore has to run *after* `tauri android init` /
`tauri ios init` — the packaging workflow does that, and a local run refreshes the
fallback copies checked in here:

    npx tauri icon src-tauri/icons/icon-manifest.json

`icon-manifest.json` is the input: `app-icon.svg` (the master with its slots resolved,
plate included) for the flat icons, `android-foreground.svg` (the mark without its
rounded square) as the adaptive icon's foreground and monochrome layer, and `#0D0D0D`
for the plate behind them. The separate foreground is what keeps Android from drawing
the whole black square inside a white circle: the foreground is what gets scaled into
the mask's safe area.

`android-foreground.svg` 把 mark 画在画布的 **68%**，外面套一层 `scale(0.68)`。原因是
Android 只显示 108dp 自适应画布**中间那 72dp**：不缩的画落到可见范围里就是 ~89%，
边缘几乎贴着启动器遮罩（实测就是这样，用户报「四周边缘太小、图标占得太满」）。68%
落到可见范围约 63%，正好留出启动器图标惯常的那圈 ~17% 留白。

`android_fg_scale` 这个 manifest 字段**在 tauri-cli 2.11.4 里是空的**：填 80、甚至填 50，
生成出来的 `ic_launcher_foreground.png` 逐字节不变（量过）。缩放只能写在源 SVG 里。

A regeneration also rewrites the desktop set, `icon.ico` included. That one comes
out with 32×32 still in front, so it keeps working — the warning above is about
design-tool exports, not about this command.

## The tray icon is the same mark

`tray-32.png` used to be a separate hand-drawn glyph: a filled three-element version
whose edges sat on a 32-unit grid, because the old stroked mark dissolved at the 16px
the notification area grants it (its 10-unit strokes are **0.31px** there; measured on
the real bitmap, **zero** pixels came out bright enough to read as ink — the user
report 「小尺寸下很难看清」).

That fix is now the master's, so the tray no longer needs a mark of its own. The
master is drawn as filled shapes with every edge on the 32-unit grid, which is what
makes it survive the small rungs: at 16px it carries **89 readable ink pixels against
248 plate pixels** (34.8%), with a 2px thinnest stroke and a 4px median run; at 32px,
335 against 982. The numbers, and why 32 units is the floor for a feature (a 32-unit
notch measured byte-identical to the un-notched glyph at every size), are written in
the master's own comment — the probe that produced them is
`debug_outputs/logo-audit/ink-probe.mjs`.

`tray-32.png` is still its own *file* because the tray wants a bitmap, not because it
wants a different drawing. Regenerate it straight from the same manifest output:

    cp src-tauri/icons/32x32.png src-tauri/icons/tray-32.png

`lib.rs` embeds that PNG with `include_bytes!` and hands it to the tray
(`Image::from_bytes`, which is why `tauri` carries the `image-png` feature). If the
bitmap ever fails to decode the tray falls back to the app icon, because a blurry
tray icon beats no tray icon.
