import { NativeLrrBridgeRepository, getEnabledLrrBridgeScopes } from '../repositories/nativeLrrBridgeRepository';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { invalidateRouteCache } from './routeCache';

export const BRIDGE_POLL_MS = 30_000;
export const BRIDGE_PROGRESS_FLUSH_MS = 10_000;
export const BRIDGE_STARTUP_MS = 5_000;
const bridge = new NativeLrrBridgeRepository();
const library = new NativeLibraryRepository();

/** Only hosted scopes participate. This is a small state service, independent
 * with per-record offline operations and server-owned revisions. */
export function startLrrBridgeLifecycle(dependencies = {
  bridge, library, scopes: getEnabledLrrBridgeScopes,
}): () => void {
  const { bridge, library, scopes } = dependencies;
  let stopped = false;
  let running = false;
  let polling: number | undefined;
  let startup: number | undefined;
  let flushing: number | undefined;
  let retryAfter = 0;
  let failures = 0;
  const revisions = new Map<string, string>();
  const dirty = new Set<string>();
  let writeGeneration = 0;
  let flushFailures = 0;

  async function flush() {
    flushing = undefined;
    if (stopped || running) { scheduleFlush(BRIDGE_PROGRESS_FLUSH_MS); return; }
    running = true;
    const generation = writeGeneration;
    let failed = false;
    try {
      for (const scopeId of await scopes()) {
        if (stopped) break;
        const result = await bridge.flush(scopeId);
        if (!result.ok) { dirty.add(scopeId); failed = true; }
        else if (result.value.pending > result.value.conflicts) dirty.add(scopeId);
        else if (generation === writeGeneration) dirty.delete(scopeId);
      }
    } finally {
      running = false;
      flushFailures = failed ? Math.min(flushFailures + 1, 5) : 0;
      if (dirty.size && document.visibilityState === 'visible') scheduleFlush(BRIDGE_PROGRESS_FLUSH_MS * 2 ** flushFailures);
    }
  }

  function scheduleFlush(delay: number) {
    if (stopped) return;
    if (flushing !== undefined) {
      if (delay !== 0) return;
      window.clearTimeout(flushing);
    }
    flushing = window.setTimeout(() => { void flush(); }, delay);
  }

  async function poll() {
    if (stopped || running || document.visibilityState !== 'visible' || Date.now() < retryAfter) return;
    running = true;
    let failed = false;
    try {
      for (const scopeId of await scopes()) {
        if (stopped) break;
        const result = await bridge.detect(scopeId);
        if (!result.ok) { failed = true; continue; }
        const stamp = `${result.value.serverId}/${result.value.epoch}/${result.value.version}`;
        if (revisions.get(scopeId) === stamp) continue;
        // Read serially: both paths publish into the native SQLite mirror.
        const history = await bridge.list(scopeId, 'history');
        if (stopped) break;
        const watchlist = await bridge.list(scopeId, 'watchlist');
        const presets = await bridge.collectionList(scopeId, 'search_presets');
        if (stopped) break;
        const marks = await bridge.collectionList(scopeId, 'non_duplicates');
        if (!history.ok || !watchlist.ok || !presets.ok || !marks.ok) { failed = true; continue; }
        revisions.set(scopeId, stamp);
        invalidateRouteCache('home:');
        invalidateRouteCache('state:');
        invalidateRouteCache('presets:');
        invalidateRouteCache('non-duplicates:');
      }
    } finally {
      running = false;
      failures = failed ? Math.min(failures + 1, 4) : 0;
      retryAfter = failed ? Date.now() + BRIDGE_POLL_MS * 2 ** failures : 0;
      if (dirty.size) scheduleFlush(BRIDGE_PROGRESS_FLUSH_MS);
    }
  }

  function onWrite(event: Event) {
    const detail = (event as CustomEvent<{ scopeId?: string; kind?: string }>).detail;
    writeGeneration++;
    if (detail?.scopeId) dirty.add(detail.scopeId);
    scheduleFlush(detail?.kind === 'progress' ? BRIDGE_PROGRESS_FLUSH_MS : 0);
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') {
      retryAfter = 0;
      scheduleFlush(0);
      void poll();
    } else if (dirty.size) scheduleFlush(0);
  }
  function onOnline() { retryAfter = 0; scheduleFlush(0); void poll(); }

  // Discover configured scopes via local IPC; never probe unconfigured servers.
  async function discover() { await library.listServers().then(async result => {
    if (!result.ok || stopped) return;
    for (const server of result.value) {
      if (stopped) return;
      await bridge.config(server.scopeId);
    }
    if (!stopped) { scheduleFlush(0); void poll(); }
  }); }
  startup = window.setTimeout(() => { startup = undefined; void discover(); }, BRIDGE_STARTUP_MS);
  polling = window.setInterval(() => { void poll(); }, BRIDGE_POLL_MS);
  window.addEventListener('yomika:lrr-bridge-write', onWrite);
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    if (polling !== undefined) window.clearInterval(polling);
    if (startup !== undefined) window.clearTimeout(startup);
    if (flushing !== undefined) window.clearTimeout(flushing);
    polling = undefined;
    flushing = undefined;
    window.removeEventListener('yomika:lrr-bridge-write', onWrite);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
