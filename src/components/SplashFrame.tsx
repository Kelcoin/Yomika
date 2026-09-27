import { useEffect, useState } from 'react';

/** 应用首帧的品牌开屏（docs/30）：index.html 里的静态品牌帧可能赶不上
 * 合成器的第一次呈现就被 React 换掉——这层由 React 自己渲染，确定性地
 * 展示一拍再淡出，谁先谁后看到的都是同一帧。测试环境直接不出现。 */
export function SplashFrame() {
  const [phase, setPhase] = useState<'show' | 'leave' | 'gone'>(
    import.meta.env.MODE === 'test' ? 'gone' : 'show',
  );
  useEffect(() => {
    if (phase !== 'show') return undefined;
    let cancelled = false;
    const timers: number[] = [];
    let frame = 0;
    // 两跳 rAF：先让品牌帧真的被呈现，再开始计时，避免「挂载即拆」的竞态。
    frame = requestAnimationFrame(() => {
      if (cancelled) return;
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          setPhase('leave');
        }, 380),
      );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [phase]);
  // 『gone』由独立 effect 调度：『leave』的清理只清它自己的定时器。
  // 上一版把两段定时器放进同一个数组——setPhase('leave') 触发重渲染时，
  // phase='show' 的清理把刚排进去的『gone』一并清掉，开屏层以透明形态
  // 永远留在 DOM 里，pointer-events 挡住整窗，应用看起来就是死机。
  useEffect(() => {
    if (phase !== 'leave') return undefined;
    const timer = window.setTimeout(() => setPhase('gone'), 320);
    return () => window.clearTimeout(timer);
  }, [phase]);
  if (phase === 'gone') return null;
  return (
    <div className={`app-splash${phase === 'leave' ? ' is-leaving' : ''}`} aria-hidden="true">
      <div className="app-splash-brand">
        <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="512" height="512" rx="112" fill="#0D0D0D" />
          <rect x="112" y="112" width="288" height="288" rx="20" stroke="#F5F5F5" stroke-width="18" fill="none" />
          <line x1="184" y1="184" x2="184" y2="328" stroke="#F5F5F5" stroke-width="18" stroke-linecap="round" />
          <line x1="184" y1="184" x2="264" y2="184" stroke="#F5F5F5" stroke-width="18" stroke-linecap="round" />
          <line x1="224" y1="184" x2="224" y2="264" stroke="#F5F5F5" stroke-width="18" stroke-linecap="round" />
          <line x1="264" y1="224" x2="328" y2="224" stroke="#E8E8E8" stroke-width="18" stroke-linecap="round" />
          <circle cx="288" cy="296" r="22" fill="#E8E8E8" />
        </svg>
        <p className="app-splash-wordmark">Yomika<i>.</i></p>
      </div>
    </div>
  );
}
