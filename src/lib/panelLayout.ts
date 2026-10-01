import type { Layout } from 'react-resizable-panels';

/**
 * 分栏的初始比例：用户拖过就用存下来的那一份，没拖过就用声明的那一份。
 *
 * 为什么不能靠 `Panel` 的 `defaultSize`：react-resizable-panels v4 只认 `Group` 的
 * `defaultLayout`。实测 4.12.3（jsdom，两个面板分别写 `defaultSize="58"` / `"42"`，不
 * 存布局）渲染出来两个都是 `flex-grow: 50`；同一对面板只在 `Group` 上补一句
 * `defaultLayout={{ a: 58, b: 42 }}` 才是 58/42。也就是说各页 `defaultSize` 一直写着、
 * 却从来没生效过：没存过布局的页面（`useDefaultLayout` 这时返回 `undefined`）统统五五
 * 开——「首页的比例和别的页不一样」其实只取决于哪一页被拖过，跟声明的比例无关。
 *
 * 布局本身是「面板 id → flexGrow」的映射。只挂一个面板时，映射里多出来的那个 id 会被
 * 忽略、在场的那一个被拉满（同一次实测：单面板 + 两条 `defaultLayout` → `flex-grow:
 * 100`），所以声明的那一份可以无脑往下传，不必为「详情没开」单独写一套。
 */
export function panelLayout(saved: Layout | undefined, declared: Layout): Layout {
  return saved ?? declared;
}
