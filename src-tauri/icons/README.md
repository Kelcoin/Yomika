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
