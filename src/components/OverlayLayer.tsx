import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** 全屏浮层的落点：挂到 body，而不是留在页面的结构里。
 *
 * 页面里的容器会建立层叠上下文，浮层一旦留在里面，它自己的 z-index 就被关在那一层：
 * `.library-shell-list` 的 `z-index: --z-raised` 是为了让列表面板压在详情面板上，
 * `.workspace` 的入场动画也曾经留下一个 translateY(0) 的 transform。手机底栏在更外层
 * （`--z-compact-nav`），于是无论浮层写的是 `--z-overlay` 还是 `--z-modal`，都会被底栏
 * 压在下面——用户看到的就是设置菜单、检索预设、封面预览被导航条切掉一截。
 *
 * Radix 的对话框（Dialog.Portal）和标签建议一直是这么出去的；手写的浮层现在也走
 * 同一条路，这样「浮层的 z-index 一定比底栏大」不再取决于它被渲染在哪个页面容器里。
 *
 * 主题在 `:root[data-theme]` 上，挂到 body 不会掉主题。 */
export function OverlayLayer({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
