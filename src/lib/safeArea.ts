import { getSystemInsets } from '../bridge/platform';

/**
 * 把系统栏高度写进 CSS 变量：页面用 `var(--safe-top)` / `var(--safe-bottom)` 避开状态栏与
 * 手势条。`tokens.css` 里那两条先由 `env(safe-area-inset-*)` 兜底，而那个在 Android 上只给
 * 刘海——系统栏的真实高度只有原生侧量得出来（见 `MainActivity`）。
 *
 * 运行时变化（旋转、手势条切换、折叠）由**原生侧**直接写这两个变量，这里管的是启动那次：
 * 原生在页面还没起来时的写入会随新文档丢掉。
 */
export function applySystemInsets(top: number, bottom: number): void {
  const root = document.documentElement;
  root.style.setProperty('--safe-top', `${top}px`);
  root.style.setProperty('--safe-bottom', `${bottom}px`);
}

/** 问一次原生并落到变量上。两个都是 0 时**清掉**内联值——iOS 那边 `env()` 是准的，写死
 * 0 会把真实的安全区抹平（`:root` 里那条才是对的）。 */
export async function syncSystemInsets(): Promise<void> {
  const result = await getSystemInsets();
  if (!result.ok) return;
  const root = document.documentElement;
  if (result.value.top === 0 && result.value.bottom === 0) {
    root.style.removeProperty('--safe-top');
    root.style.removeProperty('--safe-bottom');
    return;
  }
  applySystemInsets(result.value.top, result.value.bottom);
}
