/** Merge discrete wheel notches into a bounded ease-out. High-resolution
 * trackpad input stays native; a slow frame must never prolong the tail. */
export function isDiscreteWheel(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): boolean {
  return event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 40);
}

export function createWheelMotion() {
  let frame: number | undefined;
  let host: HTMLElement | undefined;
  let goal = 0;
  let lastTop = 0;
  let direction = 0;
  let start = 0;
  let at = 0;
  let from = 0;
  let behavior = '';
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (host) host.style.scrollBehavior = behavior;
    host = undefined;
  };
  const tick = (now: number) => {
    frame = undefined;
    if (!host || !host.isConnected || Math.abs(host.scrollTop - lastTop) > 2) { cancel(); return; }
    const maximum = Math.max(0, host.scrollHeight - host.clientHeight);
    goal = Math.max(0, Math.min(goal, maximum));
    // Use elapsed wall time, rather than a capped per-frame exponential step.
    // A busy home page otherwise stretches the small remaining distance across
    // many slow frames, making the page appear to scroll by itself for seconds.
    // A compositor that hands back a timestamp which does not advance (paused
    // window, throttled tab, frozen clock in a test harness) must not turn the
    // ease into an endless frame loop: step such a frame by a nominal 16 ms on
    // top of the previous stamp, so progress keeps accumulating and still ends.
    const stamp = now > at ? now : at + 16;
    at = stamp;
    const progress = Math.max(0, Math.min(1, (stamp - start) / 200));
    host.scrollTop = from + (goal - from) * (1 - (1 - progress) ** 3);
    lastTop = host.scrollTop;
    if (progress === 1 || Math.abs(goal - lastTop) < 0.75) {
      host.scrollTop = goal;
      cancel();
    } else frame = requestAnimationFrame(tick);
  };
  return {
    cancel,
    push(element: HTMLElement, delta: number) {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      if (!maximum || delta < 0 && element.scrollTop <= 0 || delta > 0 && element.scrollTop >= maximum) return false;
      if (host !== element || direction !== Math.sign(delta)) {
        cancel();
        host = element;
        behavior = host.style.scrollBehavior;
        host.style.scrollBehavior = 'auto';
        goal = lastTop = host.scrollTop;
      }
      direction = Math.sign(delta);
      from = lastTop = host.scrollTop;
      start = at = performance.now();
      goal = Math.max(0, Math.min(maximum, goal + delta));
      if (frame === undefined) frame = requestAnimationFrame(tick);
      return true;
    },
  };
}
