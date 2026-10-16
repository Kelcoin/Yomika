import { useEffect, useRef } from 'react';

/** 一个开着的浮层：关掉它的动作、「刚才没关掉就把守卫补回去」，以及它在历史里的层号。 */
type Overlay = { close: () => void; restore: () => void; depth: number };

const stack: Overlay[] = [];
let bound = false;

/**
 * 现在这一格历史是守卫区里的第几层。
 *
 * 压守卫时把层号写进 `history.state.yomikaOverlay`，返回手势落地时读的就是它：裸的页面格
 * （路由自己压的、或者被一次真跳转替换掉的）读到 0。
 */
function guardDepth(): number {
  const depth = (window.history.state as { yomikaOverlay?: unknown } | null)?.yomikaOverlay;
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 0;
}

function onPopState() {
  // 退几层由**落地那一格的层号**说了算，不由事件个数说了算。手机上同一次手势会被补发成
  // 两个 `popstate`（一个是延迟送达的）；按事件个数退就会一次关掉两层——用户看到的是
  // 「当前这一层和整个页面一起返回了」。
  const landedAt = guardDepth();
  const layers = stack.length - landedAt;
  // <= 0：这一下没有退进守卫区——补发的重复事件、退的是压在守卫上面的页面格、或者是我们
  // 自己那次 `history.back()` 落回了已经对齐的层号。
  if (layers <= 0) return;
  for (let index = 0; index < layers; index += 1) {
    const top = stack.pop();
    if (!top) break;
    top.close();
    // 有的浮层会拒绝这一次关闭（正在忙的确认框、脏表单）：那它得把自己的守卫补回去，
    // 不然下一次返回就直接弹到页面上去了。
    window.setTimeout(top.restore, 0);
  }
}

/**
 * 二级菜单 / 对话框的返回栈。
 *
 * 手机上的返回手势（以及浏览器的后退、iOS 的侧滑返回）走的是 **webview 的历史**：Tauri 的
 * `AppPlugin` 把返回键交给 `webView.goBack()`。所以在应用里按返回，动的是**页面**（路由往
 * 回跳）——菜单开着的时候那不合直觉，人要的是先关掉眼前这一层。
 *
 * 做法是每个浮层打开时往历史里压一条**守卫条目**（`pushState`，URL 不变，所以路由不动）：
 * 返回手势弹掉的正是它，`popstate` 一到就关掉最上面那层，页面原地不动。浮层自己关掉的
 * （点空白、Esc、右上角）要把守卫自己吃掉（`history.back()`），否则下一次返回会先弹掉这条
 * 没人认领的记录——按一下什么都不发生。
 *
 * 已知的边角：关掉一层的同一瞬间又开一层（连点两个设置行）时，`history.back()` 与新
 * `pushState` 谁先谁后由浏览器定；最坏情况是那一次返回被吃掉，页面不会被带走。
 */
export function useOverlayBackGuard(open: boolean, close: () => void): void {
  const latestClose = useRef(close);
  latestClose.current = close;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    let active = true;
    if (!bound) {
      window.addEventListener('popstate', onPopState);
      bound = true;
    }
    const overlay: Overlay = {
      depth: stack.length + 1,
      close: () => latestClose.current(),
      restore: () => {
        if (!active || !openRef.current || stack.includes(overlay)) return;
        overlay.depth = stack.length + 1;
        stack.push(overlay);
        pushGuard(overlay.depth);
      },
    };
    stack.push(overlay);
    pushGuard(overlay.depth);
    return () => {
      active = false;
      const index = stack.indexOf(overlay);
      // 历史里那一条已经被返回手势弹掉了（正是它关掉了这一层），这里不用再动历史。
      if (index < 0) return;
      stack.splice(index, 1);
      const landedAt = guardDepth();
      // 我们压的那一格已经不在了：被一次真跳转替换掉了（确认框点了「去更新」、把人送到设置
      // 页之类）。地址可能原样没变——所以判据是层号而不是地址——这时再 `history.back()`
      // 退掉的是刚跳过来的那一格，用户看到的是「点了没反应」，严重时整页跟着后退。
      if (landedAt === 0) return;
      if (landedAt === overlay.depth) {
        // 还站在自己那一格上：把这一格也收回去，免得下一次返回先弹掉没人认领的记录。落地时
        // `stack.length` 恰好是 `depth - 1`，`onPopState` 靠层号对齐认出这是自己那一下。
        window.history.back();
        return;
      }
      // 退掉的是压在它上面的那一格（外层浮层先关了）：把当前格的层号对齐到现在的层数。
      renumberGuard(stack.length);
    };
  }, [open]);
}

/** URL 不变，所以路由不动；`idx` 之类的既有状态照搬，react-router 靠它算 pop 的方向。 */
function pushGuard(depth: number): void {
  window.history.pushState({ ...(window.history.state ?? {}), yomikaOverlay: depth }, '');
}

/** 就地改写当前这一格的层号（同样不动 URL、不压新格）。 */
function renumberGuard(depth: number): void {
  const state: Record<string, unknown> = { ...(window.history.state ?? {}) };
  if (depth > 0) state.yomikaOverlay = depth;
  else delete state.yomikaOverlay;
  window.history.replaceState(state, '');
}

/** 测试用：栈是模块级的，一个用例留下的浮层会决定下一个用例的返回行为。 */
export function resetOverlayBackGuardForTests(): void {
  stack.length = 0;
}
