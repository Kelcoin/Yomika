/** Merge discrete wheel notches into one continuous, frame-rate independent
 * approach to the destination. High-resolution trackpad input stays native. */
export function isDiscreteWheel(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): boolean {
  return event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 40);
}

export function createWheelMotion() {
  let frame: number | undefined;
  let host: HTMLElement | undefined;
  let goal = 0;
  let lastTop = 0;
  let direction = 0;
  let at = 0;
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
    const dt = Math.max(1, Math.min(40, now - at));
    at = now;
    const remaining = goal - host.scrollTop;
    const step = Math.min(Math.abs(remaining), Math.max(1, Math.abs(remaining) * (1 - Math.exp(-dt / 65))));
    host.scrollTop += Math.sign(remaining) * step;
    lastTop = host.scrollTop;
    if (Math.abs(goal - lastTop) < 0.75) {
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
        at = performance.now();
      }
      direction = Math.sign(delta);
      goal = Math.max(0, Math.min(maximum, goal + delta));
      if (frame === undefined) frame = requestAnimationFrame(tick);
      return true;
    },
  };
}
