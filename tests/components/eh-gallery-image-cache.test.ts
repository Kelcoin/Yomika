import { afterEach, expect, it, vi } from 'vitest';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { clearGalleryImageMemoryCache, createGalleryImageLoader } from '../../src/components/EhGalleryMedia';

afterEach(() => { resetInvokeAdapterForTests(); clearGalleryImageMemoryCache(); vi.useRealTimers(); });

it('does not repopulate a cleared cache from an older in-flight request', async () => {
  let finish!: (value: unknown) => void;
  const adapter = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  setInvokeAdapterForTests(adapter);
  const loader = createGalleryImageLoader('clear-during-download');
  const url = 'https://ehgt.org/pending-clear.png';
  const pending = loader.load(url);
  clearGalleryImageMemoryCache();
  finish({ ok: true, value: 'data:image/png;base64,Y2FjaGU=' });
  await pending;
  expect(createGalleryImageLoader('clear-during-download').peek(url)).toBeUndefined();
  const next = loader.load(url);
  expect(adapter).toHaveBeenCalledTimes(2);
  finish({ ok: true, value: 'data:image/png;base64,bmV3' });
  await next;
  expect(loader.peek(url)).toBe('data:image/png;base64,bmV3');
});

it('reuses successful thumbnails after leaving a gallery and isolates accounts', async () => {
  const adapter = vi.fn(async () => ({ ok: true, value: 'data:image/png;base64,Y2FjaGU=' }));
  setInvokeAdapterForTests(adapter);
  const url = 'https://ehgt.org/cache-reopen-test.png';
  const first = createGalleryImageLoader('cache-account');
  await first.load(url);
  first.dispose();
  await new Promise(resolve => setTimeout(resolve, 5));
  const reopened = createGalleryImageLoader('cache-account');
  expect(reopened.peek(url)).toBe('data:image/png;base64,Y2FjaGU=');
  expect(await reopened.load(url)).toEqual({ ok: true, value: 'data:image/png;base64,Y2FjaGU=' });
  expect(adapter).toHaveBeenCalledTimes(1);
  await createGalleryImageLoader('different-account').load(url);
  expect(adapter).toHaveBeenCalledTimes(2);
});

it('does not retain failed image requests', async () => {
  const adapter = vi.fn(async () => ({ ok: false, error: { code: 'EH_UNAVAILABLE', message: 'offline', retryable: true } }));
  setInvokeAdapterForTests(adapter);
  await createGalleryImageLoader('failed-cache').load('https://ehgt.org/failed.png');
  await createGalleryImageLoader('failed-cache').load('https://ehgt.org/failed.png');
  expect(adapter).toHaveBeenCalledTimes(2);
});
