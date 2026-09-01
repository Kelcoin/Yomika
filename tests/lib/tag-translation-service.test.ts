import {
  TAG_TRANSLATION_CACHE_KEY,
  TAG_TRANSLATION_UPDATE_INTERVAL_MS,
  createTagTranslationService,
} from '../../src/lib/tagTranslationService';
import { installTagTranslations, translateTag } from '../../src/lib/tags';

const NOW = Date.UTC(2026, 7, 30, 12);

function upstreamDb(name = '新译名') {
  return {
    head: { committer: { when: '2026-08-30T08:39:40.000Z' } },
    data: [{ namespace: 'female', data: { 'big breasts': { name } } }],
  };
}

function successfulResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

function cachedTranslations(updatedAt: number, value = '旧译名') {
  return JSON.stringify({
    schemaVersion: 1,
    sourceVersion: '2026-08-20T00:00:00.000Z',
    updatedAt,
    translations: { female: { 'big breasts': value } },
  });
}

describe('runtime tag translation service', () => {
  beforeEach(() => {
    localStorage.clear();
    installTagTranslations({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('downloads and persists translations on first startup', async () => {
    const fetcher = vi.fn(async () => successfulResponse(upstreamDb()));
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    await service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('新译名');
    expect(JSON.parse(localStorage.getItem(TAG_TRANSLATION_CACHE_KEY) ?? '{}')).toEqual({
      schemaVersion: 1,
      sourceVersion: '2026-08-30T08:39:40.000Z',
      updatedAt: NOW,
      translations: { female: { 'big breasts': '新译名' } },
    });
  });

  it('uses a fresh cache immediately without downloading it again', async () => {
    localStorage.setItem(TAG_TRANSLATION_CACHE_KEY, cachedTranslations(NOW - 1_000));
    const fetcher = vi.fn(async () => successfulResponse(upstreamDb()));
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    await service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('旧译名');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('installs an expired cache before refreshing it in the background', async () => {
    localStorage.setItem(
      TAG_TRANSLATION_CACHE_KEY,
      cachedTranslations(NOW - TAG_TRANSLATION_UPDATE_INTERVAL_MS - 1),
    );
    let finishDownload!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finishDownload = resolve; }));
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    const initialization = service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('旧译名');
    finishDownload(successfulResponse(upstreamDb()));
    await initialization;
    expect(translateTag('female', 'big breasts')).toBe('新译名');
  });

  it('keeps an expired cache when every download attempt fails', async () => {
    localStorage.setItem(
      TAG_TRANSLATION_CACHE_KEY,
      cachedTranslations(NOW - TAG_TRANSLATION_UPDATE_INTERVAL_MS - 1),
    );
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    await service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('旧译名');
    expect(localStorage.getItem(TAG_TRANSLATION_CACHE_KEY)).toBe(
      cachedTranslations(NOW - TAG_TRANSLATION_UPDATE_INTERVAL_MS - 1),
    );
  });

  it('deduplicates concurrent startup downloads', async () => {
    let finishDownload!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finishDownload = resolve; }));
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    const first = service.initialize();
    const second = service.initialize();
    finishDownload(successfulResponse(upstreamDb()));
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('extracts readable text from HTML-formatted upstream names', async () => {
    const fetcher = vi.fn(async () => successfulResponse(upstreamDb('<p>巨乳</p>')));
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    await service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('巨乳');
  });

  it('installs a downloaded database even when persistent storage rejects the write', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    };
    const service = createTagTranslationService({
      storage,
      fetcher: vi.fn(async () => successfulResponse(upstreamDb())),
      now: () => NOW,
      retryDelays: [],
    });

    await service.initialize();

    expect(translateTag('female', 'big breasts')).toBe('新译名');
  });

  it('schedules a fresh cache update for its remaining lifetime', async () => {
    localStorage.setItem(
      TAG_TRANSLATION_CACHE_KEY,
      cachedTranslations(NOW - TAG_TRANSLATION_UPDATE_INTERVAL_MS + 12_345),
    );
    const setTimer = vi.fn<(handler: TimerHandler, timeout?: number) => number>(() => 7);
    const service = createTagTranslationService({
      fetcher: vi.fn(async () => successfulResponse(upstreamDb())),
      now: () => NOW,
      retryDelays: [],
      setTimer: setTimer as unknown as typeof window.setTimeout,
      clearTimer: vi.fn(),
    });

    service.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(12_345);
    service.stop();
  });

  it('aborts an active download on stop and permits a new refresh', async () => {
    let calls = 0;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return Promise.resolve(successfulResponse(upstreamDb()));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const service = createTagTranslationService({ fetcher, now: () => NOW, retryDelays: [] });

    const interrupted = service.refresh();
    await Promise.resolve();
    service.stop();
    await interrupted;
    await service.refresh();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(translateTag('female', 'big breasts')).toBe('新译名');
  });

  it('times out a stalled download and releases the request lock', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) return Promise.resolve(successfulResponse(upstreamDb()));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const service = createTagTranslationService({
      fetcher,
      now: () => NOW,
      requestTimeoutMs: 1_000,
      retryDelays: [],
    });

    const stalled = service.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    await stalled;
    await service.refresh();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(translateTag('female', 'big breasts')).toBe('新译名');
  });

  it('does not let an interrupted request clear the replacement request timeout', async () => {
    let releaseInterrupted!: () => void;
    let calls = 0;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            releaseInterrupted = () => reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;
    let nextTimer = 0;
    const setTimer = vi.fn<(handler: TimerHandler, timeout?: number) => number>(() => ++nextTimer);
    const clearTimer = vi.fn();
    const service = createTagTranslationService({
      fetcher,
      now: () => NOW,
      retryDelays: [],
      setTimer: setTimer as unknown as typeof window.setTimeout,
      clearTimer,
    });

    const interrupted = service.refresh();
    service.stop();
    const replacement = service.refresh();
    releaseInterrupted();
    await interrupted;

    expect(clearTimer).not.toHaveBeenCalledWith(2);
    service.stop();
    await replacement;
  });

  it('falls back to memory when the localStorage getter is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => { throw new DOMException('Storage disabled', 'SecurityError'); },
    });
    try {
      const service = createTagTranslationService({
        fetcher: vi.fn(async () => successfulResponse(upstreamDb())),
        now: () => NOW,
        retryDelays: [],
      });
      await service.initialize();
      expect(translateTag('female', 'big breasts')).toBe('新译名');
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});
