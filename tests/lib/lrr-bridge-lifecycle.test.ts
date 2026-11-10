import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  scopes: [] as string[], version: 1,
  config: vi.fn(), collectionList: vi.fn(), detect: vi.fn(), list: vi.fn(), flush: vi.fn(), listServers: vi.fn(),
}));
vi.mock('../../src/repositories/nativeLrrBridgeRepository', () => ({
  getEnabledLrrBridgeScopes: async () => service.scopes,
  NativeLrrBridgeRepository: class {
    collectionList = service.collectionList; config = service.config; detect = service.detect; list = service.list; flush = service.flush;
  },
}));
vi.mock('../../src/repositories/nativeLibraryRepository', () => ({
  NativeLibraryRepository: class { listServers = service.listServers; },
}));
import { BRIDGE_POLL_MS, BRIDGE_PROGRESS_FLUSH_MS, BRIDGE_STARTUP_MS, startLrrBridgeLifecycle } from '../../src/lib/lrrBridgeLifecycle';

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  service.scopes = ['scope-a']; service.version = 1;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  service.listServers.mockResolvedValue({ ok: true, value: [{ scopeId: 'scope-a' }] });
  service.config.mockResolvedValue({ ok: true, value: { enabled: true } });
  service.detect.mockImplementation(async () => ({ ok: true, value: { serverId: 'a', epoch: 'e', version: service.version } }));
  service.collectionList.mockResolvedValue({ ok: true, value: [] });
  service.list.mockResolvedValue({ ok: true, value: [] });
  service.flush.mockResolvedValue({ ok: true, value: { pending: 0, conflicts: 0 } });
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

it('does not probe disabled scopes', async () => {
  service.scopes = [];
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 2);
  expect(service.detect).not.toHaveBeenCalled();
  expect(service.flush).not.toHaveBeenCalled();
});

it('refreshes lists only when the server version changes and pauses hidden polling', async () => {
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  expect(service.list).toHaveBeenCalledTimes(2);
  expect(service.collectionList).toHaveBeenCalledWith('scope-a', 'search_presets');
  expect(service.collectionList).toHaveBeenCalledWith('scope-a', 'non_duplicates');
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS);
  expect(service.list).toHaveBeenCalledTimes(2);
  expect(service.collectionList).toHaveBeenCalledWith('scope-a', 'search_presets');
  expect(service.collectionList).toHaveBeenCalledTimes(2);
  service.version++;
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS);
  expect(service.list).toHaveBeenCalledTimes(4);
  expect(service.collectionList).toHaveBeenCalledTimes(4);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const calls = service.detect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 2);
  expect(service.detect).toHaveBeenCalledTimes(calls);
});

it('coalesces progress writes', async () => {
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  service.flush.mockClear();
  for (let i = 0; i < 8; i++) window.dispatchEvent(new CustomEvent('yomika:lrr-bridge-write', { detail: { scopeId: 'scope-a', kind: 'progress' } }));
  await vi.advanceTimersByTimeAsync(BRIDGE_PROGRESS_FLUSH_MS - 1);
  expect(service.flush).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(service.flush).toHaveBeenCalledTimes(1);
});

it('flushes queued changes immediately when entering the background', async () => {
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  service.flush.mockClear();
  window.dispatchEvent(new CustomEvent('yomika:lrr-bridge-write', { detail: { scopeId: 'scope-a', kind: 'progress' } }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(1);
  expect(service.flush).toHaveBeenCalledTimes(1);
});

it('backs off unavailable servers and removes scheduled work on stop', async () => {
  service.detect.mockResolvedValue({ ok: false, error: { code: 'REMOTE_UNAVAILABLE' } });
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  expect(service.detect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS);
  expect(service.detect).toHaveBeenCalledTimes(1);
  stop(); stop = undefined;
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 4);
  expect(service.detect).toHaveBeenCalledTimes(1);
});

it('backs off failed outbox uploads without dropping queued work', async () => {
  service.flush.mockResolvedValue({ ok: false, error: { code: 'REMOTE_UNAVAILABLE' } });
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  expect(service.flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BRIDGE_PROGRESS_FLUSH_MS);
  expect(service.flush).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(BRIDGE_PROGRESS_FLUSH_MS);
  expect(service.flush).toHaveBeenCalledTimes(2);
});


it('retries the same revision after a collection refresh fails', async () => {
  service.collectionList.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_UNAVAILABLE' } });
  stop = startLrrBridgeLifecycle({ bridge: service as unknown as import('../../src/repositories/nativeLrrBridgeRepository').NativeLrrBridgeRepository, library: service as unknown as import('../../src/repositories/nativeLibraryRepository').NativeLibraryRepository, scopes: async () => service.scopes });
  await vi.advanceTimersByTimeAsync(BRIDGE_STARTUP_MS + 100);
  expect(service.collectionList).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(BRIDGE_POLL_MS * 3);
  expect(service.collectionList).toHaveBeenCalledTimes(4);
});
