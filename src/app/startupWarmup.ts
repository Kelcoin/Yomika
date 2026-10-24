/** Warm code/data between interactions, without mounting hidden pages. */
export function scheduleStartupWarmup(tasks: readonly (() => Promise<unknown>)[]): () => void {
  let stopped = false;
  let index = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let busyUntil = 0;
  const pointers = new Set<number>();
  const schedule = (delay: number) => {
    if (!stopped && index < tasks.length) timer = setTimeout(request, delay);
  };
  const request = () => {
    timer = undefined;
    if (stopped || running || document.visibilityState === 'hidden') return;
    // Font decoding/layout belongs to the first visible frame, ahead of code
    // for screens the user hasn't opened. Don't compete with CJK font startup.
    if (document.fonts?.status === 'loading') { schedule(250); return; }
    if (pointers.size || Date.now() < busyUntil) { schedule(250); return; }
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(deadline => {
        idle = undefined;
        if (stopped) return;
        if (document.visibilityState === 'hidden') return;
        if (pointers.size || Date.now() < busyUntil || (!deadline.didTimeout && deadline.timeRemaining() < 8)) {
          schedule(250); return;
        }
        void next();
      }, { timeout: 1500 });
    } else void next();
  };
  const next = async () => {
    if (stopped || index >= tasks.length) return;
    running = true;
    try { await tasks[index++]!(); } catch { /* A failed page must not stop other pages. */ }
    running = false;
    schedule(150);
  };
  const input = () => { busyUntil = Date.now() + 350; };
  const down = (event: PointerEvent) => { pointers.add(event.pointerId); input(); };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); input(); };
  const visibility = () => {
    if (document.visibilityState !== 'hidden' && !running && timer === undefined && idle === undefined) schedule(350);
  };
  const blur = () => { pointers.clear(); input(); };
  window.addEventListener('pointerdown', down, { passive: true, capture: true });
  window.addEventListener('pointerup', up, { passive: true, capture: true });
  window.addEventListener('pointercancel', up, { passive: true, capture: true });
  for (const type of ['wheel', 'scroll', 'keydown']) window.addEventListener(type, input, { passive: true, capture: true });
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  schedule(500);
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    for (const type of ['wheel', 'scroll', 'keydown']) window.removeEventListener(type, input, true);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', visibility);
  };
}
