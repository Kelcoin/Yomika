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

The order is therefore 32×32 first, then the rest. (`tauri icon` writes them ascending
after the 32; the hand-made file that predates the manifest had them largest-first —
Windows picks by size either way, and only the **first** entry is load-bearing.
Re-exporting this file from a design tool will silently reorder it; put 32×32 back in
front.

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

`android-foreground.svg` 里的 mark 画在画布的 **42%**（`default` 那份 print 图标是 53%），
外面套一层 `scale(0.8)`。原因是 Android 只显示 108dp 自适应画布**中间那 72dp**：同一份
53% 的画落到可见范围里就是 ~80%，白框几乎贴着启动器遮罩的边缘（实测就是这样，用户报
「四周边缘太小、图标占得太满」）。42% 落到可见范围约 63%，正好留出启动器图标惯常的那圈
~17% 留白。

`android_fg_scale` 这个 manifest 字段**在 tauri-cli 2.11.4 里是空的**：填 80、甚至填 50，
生成出来的 `ic_launcher_foreground.png` 逐字节不变（量过）。缩放只能写在源 SVG 里。

A regeneration also rewrites the desktop set, `icon.ico` included. That one comes
out with 32×32 still in front, so it keeps working — the warning above is about
design-tool exports, not about this command.

## The tray icon is a separate mark

`tray-32.png` is **not** part of the set above and must not be regenerated from
`icon-manifest.json`: the tray borrows nothing from the app icon.

The notification area gives an icon 16px (32 at 200% DPI), and the print mark's
strokes are 18 units of 512 — 0.56px there. Measured on the real bitmap: the app
icon at 32×32 carries **1** pixel bright enough to read as ink, because every
0.6px stroke anti-aliases away. That is the user report 「小尺寸下很难看清」.

`assets/yomika-tray.svg` is the tray's own master: same rounded plate and same
two-tier ink, but the glyph is filled rather than stroked, reduced from five
elements to three, and every edge sits on a 32-unit boundary so the 512-unit
master downsamples 1:2 to the tray bitmap and 1:32 to a 16px render on exact pixel
boundaries. It carries 334 readable ink pixels at 32×32 where the app icon has 1.

Regenerate the bitmap (the output directory is a scratch one — only `32x32.png`
is kept, renamed to `tray-32.png`; the rest of the generated set would clobber the
app icons):

    npx tauri icon assets/yomika-tray.svg -o /tmp/yomika-tray
    cp /tmp/yomika-tray/32x32.png src-tauri/icons/tray-32.png

`lib.rs` embeds that PNG with `include_bytes!` and hands it to the tray
(`Image::from_bytes`, which is why `tauri` carries the `image-png` feature). If the
bitmap ever fails to decode the tray falls back to the app icon, because a blurry
tray icon beats no tray icon.

