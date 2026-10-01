/** 发起配对那一端报给对面的身份：这台设备叫什么、是什么。
 *
 * 名字为什么必须由前端报：后端 `request_pairing` 发的 `name` 取 `host_name()`，而它
 * 只读 `COMPUTERNAME` / `HOSTNAME` 两个环境变量，认不出来就兜底成字面量「Yomika」——
 * Android 上这两个变量都不存在，于是对面「管理已有配对」里每台手机都叫「Yomika」。
 * 机型只写在 WebView 的 UA 里，屏幕尺寸也只在这一侧，所以这两件事都属于这里。
 *
 * 两个函数都收一个可选的 `ua`：纯函数好单测，UA 不必真的去改 jsdom。 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop';

function defaultUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** Android UA 里的机型名。常见的几种形状：
 *
 *   `(Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv)` → `SM-S918B`
 *   `(Linux; Android 13; Pixel 7 Pro)`                        → `Pixel 7 Pro`
 *   `(Linux; U; Android 4.0.3; de-ch; HTC Sensation Build/…)` → `HTC Sensation`
 *   `(Linux; Android 10; K)`                                  → `''`
 *
 * 机型都紧跟在 `Android <版本>;` 后面，同一段里还夹着 `Build/…`、`wv`（WebView 标记）
 * 和语言区域，都要剔掉。什么都认不出来就回空串——后端会退回 `host_name()`，那也不如
 * 在对面列表里显示一个「K」（Android 10 起简版 UA 把机型抹成了这一个字母）。 */
export function deviceDisplayName(ua: string = defaultUserAgent()): string {
  const after = /Android[^;)]*;\s*([^)]*)/i.exec(ua)?.[1] ?? '';
  for (const segment of after.split(';')) {
    const model = segment.replace(/\bBuild\/.*$/i, '').replace(/\bwv\b/gi, '').trim();
    // 老 UA 会在机型前夹一个语言区域（`de-ch`），单字母机型也不当名字。
    if (model.length < 2 || /^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(model)) continue;
    return model;
  }
  return '';
}

/** 这台设备是手机、平板还是桌面。
 *
 * Android 的手机与平板共用一个 UA，只能看屏幕短边：600 是 Android 自己的分界
 * （`smallestScreenWidthDp >= 600` 才叫平板）。非 Android 一律当桌面——宁可图标
 * 不精确，也别把台式机画成手机。 */
export function deviceKind(ua: string = defaultUserAgent()): DeviceKind {
  if (!ua.includes('Android')) return 'desktop';
  const display = typeof window === 'undefined' ? undefined : window.screen;
  const shortest = Math.min(display?.width ?? 0, display?.height ?? 0);
  return shortest >= 600 ? 'tablet' : 'phone';
}
