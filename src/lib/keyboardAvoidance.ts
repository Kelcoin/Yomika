import { isIosDevice } from './layoutMode';

/** 软键盘的高度补偿（用户 2026-10-18：悬浮底栏不应该对软键盘进行避让）。
 *
 * Android WebView 按 index.html 里 `interactive-widget=resizes-content` 缩短布局视口，
 * 于是每条 `position: fixed` 的底栏都会跟着往上让位。这里把「视口被缩短了多少」写成
 * `--keyboard-inset`（base.css 在 html 上预置 0px），悬浮底栏的 bottom 反向减掉它，
 * 屏幕上的位置就不再随键盘移动。基线取观察到的最大高度：键盘落下、视口回弹，
 * 差值自然归零。只认原生移动端（index.html 的 data-native-mobile）：桌面端把窗口
 * 拉矮不是键盘。
 *
 * iOS 另有两件 Android 没有的事（用户 2026-11-24 第 7 项）：
 *
 * 1. `dvh` 会跟着键盘一起缩短，`.workspace`、`.library-shell` 这些按
 *    `--viewport-height` 定高的壳层于是整体重排——看起来就是「所有层级的页面一起
 *    避让」。键盘落下期间把 `--viewport-height` 钉在落下前的高度，页面本身不动。
 * 2. 只有**确实需要避让的那一块**（当前焦点所在的菜单/对话框）才往上让：算出它下沿
 *    与键盘上沿的差，写成 `--keyboard-lift`，CSS 用 `translate` 这一条独立属性抬起它
 *    （不能改 `transform`，`.dialog-content` 自己还要靠它居中）。抬升量夹在「不把标题
 *    顶出屏幕上沿」的范围内。 */

/** 可能装着输入框、需要自己避开键盘的浮层。 */
export const AVOIDING_PANEL_SELECTOR =
  '.settings-choice-panel, .dialog-content, .search-preset-panel, .tag-suggest-panel';

/** 面板下沿与键盘之间留的那一点。 */
const KEYBOARD_GAP = 12;

type KeyboardViewport = EventTarget & {
  height: number;
  width: number;
  offsetTop?: number;
};

export interface KeyboardAvoidanceOptions {
  /** 默认 `window.visualViewport`；测试里塞一个可 dispatch 的假件。 */
  viewport?: KeyboardViewport | null;
  root?: HTMLElement;
  doc?: Document;
  /** 默认走 layoutMode 的 isIosDevice（原生能力上报的 platform）。 */
  ios?: () => boolean;
}

/** 装好监听，返回卸载函数。 */
export function installKeyboardAvoidance(options: KeyboardAvoidanceOptions = {}): () => void {
  const doc = options.doc ?? document;
  const root = options.root ?? doc.documentElement;
  const ios = options.ios ?? isIosDevice;
  const viewport = options.viewport === undefined
    ? (window.visualViewport as KeyboardViewport | null)
    : options.viewport;
  if (!viewport) return () => {};

  let baseline = viewport.height;
  let width = viewport.width;
  let frozenHeight: string | null = null;
  let lifted: HTMLElement | null = null;

  const dropLift = () => {
    if (!lifted) return;
    lifted.removeAttribute('data-keyboard-lifted');
    lifted.style.removeProperty('--keyboard-lift');
    lifted = null;
  };

  const unfreeze = () => {
    if (frozenHeight === null) return;
    if (frozenHeight) root.style.setProperty('--viewport-height', frozenHeight);
    else root.style.removeProperty('--viewport-height');
    frozenHeight = null;
  };

  const liftFocusedPanel = (keyboardTop: number) => {
    const active = doc.activeElement as HTMLElement | null;
    const panel = (active?.closest?.(AVOIDING_PANEL_SELECTOR) ?? null) as HTMLElement | null;
    if (panel !== lifted) {
      dropLift();
      lifted = panel;
    }
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const needed = Math.round(rect.bottom + KEYBOARD_GAP - keyboardTop);
    const room = Math.max(0, Math.round(rect.top - KEYBOARD_GAP));
    const lift = Math.min(needed, room);
    if (lift <= 0) {
      panel.removeAttribute('data-keyboard-lifted');
      panel.style.removeProperty('--keyboard-lift');
      return;
    }
    panel.style.setProperty('--keyboard-lift', `${lift}px`);
    panel.setAttribute('data-keyboard-lifted', '');
  };

  const sync = () => {
    /* 换档（横竖屏切换）会把基线留在更高的那一档上——竖屏 800 变横屏 360 会被当成
       440px 的键盘，底栏被推到屏幕外。宽度变了就跟着新视口重取基线。 */
    if (viewport.width !== width) {
      width = viewport.width;
      baseline = viewport.height;
    }
    baseline = Math.max(baseline, viewport.height);
    const inset = Math.max(0, Math.round(baseline - viewport.height));
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    if (inset === 0) {
      delete root.dataset.keyboard;
      dropLift();
      unfreeze();
      return;
    }
    root.dataset.keyboard = 'open';
    if (!ios()) return;
    if (frozenHeight === null) {
      frozenHeight = root.style.getPropertyValue('--viewport-height');
      root.style.setProperty('--viewport-height', `${baseline}px`);
    }
    liftFocusedPanel((viewport.offsetTop ?? 0) + viewport.height);
  };

  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  doc.addEventListener('focusin', sync);
  sync();

  return () => {
    viewport.removeEventListener('resize', sync);
    viewport.removeEventListener('scroll', sync);
    doc.removeEventListener('focusin', sync);
    dropLift();
    unfreeze();
  };
}
