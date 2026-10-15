import { useEffect, useState } from 'react';

/** 一个「淡出之后才摘」的布尔值。
 *
 * 入场是一条 CSS 动画（挂上去就播），出场要先把元素留在树上把动画播完——直接按布尔值
 * 条件渲染就只有进场、没有出场（用户报的「只有展开有动画，收起没有」就是这么来的）。
 * 这件事原来交给 `motion` 的 `AnimatePresence`，而它为两条淡入淡出把整个动画运行时拉进了
 * 阅读器那一个 chunk（`ReaderRoute-*.js` 实测含 `motion` 的 visualElement / MotionConfig，
 * 约 55KB gzip）。这里只要一个布尔值和一次定时器。
 *
 * 返回的 `leaving` 是「还在树上、但正在播出场动画」那一段：调用方把它接到类名上，
 * 动画播完（`ms` 之后）节点才真的摘掉——所以「收起即不在文档里」这条对读屏与测试仍然
 * 成立，只是晚了一个出场时长。
 *
 * `ms` 必须与 CSS 里那条出场动画的时长一致（`--duration-exit`）。 */
export function useDelayedUnmount(visible: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [state, setState] = useState({ mounted: visible, leaving: false });
  useEffect(() => {
    if (visible) {
      setState((current) => current.mounted && !current.leaving ? current : { mounted: true, leaving: false });
      return undefined;
    }
    setState((current) => current.mounted && !current.leaving ? { mounted: true, leaving: true } : current);
    const timer = window.setTimeout(
      () => setState((current) => current.mounted || current.leaving ? { mounted: false, leaving: false } : current),
      ms,
    );
    return () => window.clearTimeout(timer);
  }, [visible, ms]);
  return state;
}
