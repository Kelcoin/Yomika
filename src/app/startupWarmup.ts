/** Startup tasks must yield to the first frame and never run in parallel. */
export function scheduleStartupWarmup(tasks: readonly (() => Promise<unknown>)[]): () => void {
  let stopped = false;
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;
  const next = async () => {
    if (stopped || index >= tasks.length) return;
    try { await tasks[index++]!(); } catch { /* A failed page must not stop other pages. */ }
    if (!stopped && index < tasks.length) timer = setTimeout(() => { void next(); }, 150);
  };
  timer = setTimeout(() => { void next(); }, 500);
  return () => { stopped = true; clearTimeout(timer); };
}
