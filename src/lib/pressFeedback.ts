/** 触屏按下去要看得见。机制在这里，颜色在样式表里。
 *
 * 38e138c 把每一条 hover 规则挪进 `@media (hover: hover)`，因为触屏上 `:hover` 会
 * 留在屏幕上——点过的卡片一直浮着、点过的行一直填着色。代价是那条路径上什么都没剩
 * 下：触屏拿到的唯一反馈是 `button:active, a:active { translateY(1px) }`，而实测按住
 * 900ms 期间 `:active` 一直是 false，只在抬手那一帧短暂为真；`-webkit-tap-highlight-
 * color: transparent` 又把系统自带的高亮关掉了。于是点下去毫无动静。
 *
 * 所以"按下去"由这里自己记：pointerdown 落在哪个可点元素上，就给它一个瞬时的
 * `is-pressed`，抬手 / 取消 / 手指滑走 / 页面滚动立刻撤掉。它是瞬时的，所以不会变成
 * 那个粘在屏幕上的 hover。鼠标不参与——桌面本来就有 hover。
 *
 * 只负责标记，不负责画：`is-pressed` 落成什么颜色由样式表决定，加一个新组件不必改
 * 这里。
 */

/** 会接住按压的东西：与 base.css 里那条 touch-action 名单同一批，外加几类实际承载
 * 点击的容器（列表行、卡片是 button/Link，但选择项的主按钮是 button）。 */
const PRESSABLE = [
  'button',
  'a',
  'summary',
  'label',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ');

const PRESSED_CLASS = 'is-pressed';
/** 手指不是静止的：挪出这个距离就算滑走，和长按菜单用同一个阈值。 */
const SLOP_PX = 10;
/** 兜底：万一 pointerup 没送到，高亮也不能留在屏幕上。 */
const SAFETY_MS = 1500;

export function installPressFeedback(): () => void {
  let pressed: Element | undefined;
  let origin = { x: 0, y: 0 };
  let safety: number | undefined;

  const release = () => {
    if (safety !== undefined) window.clearTimeout(safety);
    safety = undefined;
    pressed?.classList.remove(PRESSED_CLASS);
    pressed = undefined;
  };

  const onPointerDown = (event: PointerEvent) => {
    // 桌面有 hover，鼠标按下去不需要这一层。
    if (event.pointerType === 'mouse') return;
    release();
    const target = event.target instanceof Element ? event.target.closest(PRESSABLE) : null;
    if (!target) return;
    pressed = target;
    origin = { x: event.clientX, y: event.clientY };
    target.classList.add(PRESSED_CLASS);
    safety = window.setTimeout(release, SAFETY_MS);
  };

  // 手指滑走就不算"按着"了——否则松开时会在别处留着一块高亮。
  const onPointerMove = (event: PointerEvent) => {
    if (!pressed) return;
    if (Math.abs(event.clientX - origin.x) > SLOP_PX || Math.abs(event.clientY - origin.y) > SLOP_PX) release();
  };

  // 开始滚动同样撤掉：下拉刷新、翻列表都不该让某一项一直亮着。
  const onScroll = () => { if (pressed) release(); };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener('scroll', onScroll, true);
  return () => {
    release();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', release, true);
    document.removeEventListener('scroll', onScroll, true);
  };
}
