import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { hapticFeedback } from './haptics';

/** How long a finger has to stay put before the press counts as a hold. */
const HOLD_MS = 450;
/** How far it may drift and still count: a finger resting on glass is never
 * perfectly still, and a scroll is a definite distance away. */
const SLOP_PX = 10;

/** Press-and-hold, for the platforms where a right click does not exist.
 *
 * Android's Chromium fires `contextmenu` on a long press, so the card menus
 * happened to work there. iOS WKWebView never fires it, so on an iPhone the same
 * menu was simply unreachable.
 *
 * The release after a hold still produces a click, so this also swallows it:
 * without that, holding a card opens the menu and then navigates behind it, and
 * the menu the user asked for is gone before they can read it.
 *
 * The pending hold is keyed on the element rather than kept in a closure, so it
 * survives a re-render mid-press — a thumbnail finishing its load must not
 * orphan the timer that is about to open the menu.
 *
 * 450 毫秒之后手指下面什么都不会变，所以手机还欠一次「按住了」的确认：震动就发在这
 * 一处（三个调用点共用它），见 `haptics.ts`。桌面上它自己会跳过。
 */
const holds = new WeakMap<EventTarget, { timer: number | undefined; x: number; y: number; held: boolean; suppressUntil: number }>();

function holdOf(element: EventTarget) {
  let hold = holds.get(element);
  if (!hold) {
    hold = { timer: undefined, x: 0, y: 0, held: false, suppressUntil: 0 };
    holds.set(element, hold);
  }
  return hold;
}

function cancel(hold: { timer: number | undefined }) {
  if (hold.timer !== undefined) window.clearTimeout(hold.timer);
  hold.timer = undefined;
}

/** Handlers for one card. Spread them onto the card element; the caller keeps
 * its own click, context menu and selection behaviour. */
export function longPressHandlers(open: (at: { x: number; y: number }) => void) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      // A mouse has a right button and a real contextmenu event; this is for
      // fingers only, so a desktop drag or click is left entirely alone.
      if (event.pointerType === 'mouse') return;
      const hold = holdOf(event.currentTarget);
      hold.x = event.clientX;
      hold.y = event.clientY;
      hold.held = false;
      hold.suppressUntil = 0;
      cancel(hold);
      hold.timer = window.setTimeout(() => {
        hold.timer = undefined;
        hold.held = true;
        // 菜单出现之前先让手指知道它被听见了（桌面/无马达的设备是空操作）。
        hapticFeedback('medium');
        open({ x: hold.x, y: hold.y });
      }, HOLD_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const hold = holds.get(event.currentTarget);
      if (!hold || hold.timer === undefined) return;
      if (Math.abs(event.clientX - hold.x) > SLOP_PX || Math.abs(event.clientY - hold.y) > SLOP_PX) {
        cancel(hold);
        hold.held = true; // A drag must not turn into an archive activation on lift.
      }
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const hold = holdOf(event.currentTarget);
      cancel(hold);
      if (hold.held) hold.suppressUntil = Date.now() + 300;
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => cancel(holdOf(event.currentTarget)),
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => cancel(holdOf(event.currentTarget)),
    // 这一段的职责只有一件：**长按之后紧接着合成出来的那一次 click 不能再去触发别的动作**
    // （菜单已经开了）。所以抑制窗口**之内**照样吞掉点击，窗口过了才放行——不是「窗口内
    // 放行」（8182ca3 的提交说明把方向写反了，代码与测试才是准的）。
    //
    // 300 ms 是经典合成点击延迟的量级：留这个窗口是为了让「按住→松手」那一下的 click 落在
    // 窗口里，而把 `held` 清掉是为了不让这个标志一直挂着、吃掉很久之后一次无关的点击。
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      const hold = holds.get(event.currentTarget);
      if (!hold?.held) return;
      hold.held = false;
      if (hold.suppressUntil && Date.now() > hold.suppressUntil) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
