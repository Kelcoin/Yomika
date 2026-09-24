import { useEffect, useRef } from 'react';

/** 一个开着的浮层：关掉它的动作，以及「刚才没关掉就把守卫补回去」。 */
type Overlay = { close: () => void; restore: () => void };

const stack: Overlay[] = [];
/** 自己按下的那几次后退：`popstate` 要认出来并忽略。 */
let selfPops = 0;
let bound = false;

function onPopState() {
  if (selfPops > 0) {
    selfPops -= 1;
    return;
  }
  const top = stack.pop();
  if (!top) return;
  top.close();
  // 有的浮层会拒绝这一次关闭（正在忙的确认框、脏表单）：那它得把自己的守卫补回去，
  // 不然下一次返回就直接弹到页面上去了。
  window.setTimeout(top.restore, 0);
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
    if (!bound) {
      window.addEventListener('popstate', onPopState);
      bound = true;
    }
    const overlay: Overlay = {
      close: () => latestClose.current(),
      restore: () => {
        if (!openRef.current || stack.includes(overlay)) return;
        stack.push(overlay);
        pushGuard(stack.length);
      },
    };
    stack.push(overlay);
    pushGuard(stack.length);
    return () => {
      const index = stack.indexOf(overlay);
      // 历史里那一条已经被返回手势弹掉了（正是它关掉了这一层），这里不用再动历史。
      if (index < 0) return;
      stack.splice(index, 1);
      selfPops += 1;
      window.history.back();
    };
  }, [open]);
}

/** URL 不变，所以路由不动；`idx` 之类的既有状态照搬，react-router 靠它算 pop 的方向。 */
function pushGuard(depth: number): void {
  window.history.pushState({ ...(window.history.state ?? {}), yomikaOverlay: depth }, '');
}

/** 测试用：栈是模块级的，一个用例留下的浮层会决定下一个用例的返回行为。 */
export function resetOverlayBackGuardForTests(): void {
  stack.length = 0;
  selfPops = 0;
}
