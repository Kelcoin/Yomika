import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReaderTileSlot, sampleNativeWheelZoom, configureNativeContinuousInput, repositionNativeContinuousInput, trackNativeContinuousInput, forgetTileSource, rememberTileSource, updateNativeReaderEdge, updateNativeReaderSlide, updateNativeReaderTransform } from '../../src/lib/readerNativeTiles';
import { readerDerivedRetainedBytes } from '../../src/lib/unifiedImageCache';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('moves the native preview at the boundary and returns the same page to rest', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  updateNativeReaderEdge(17, -0.06);
  updateNativeReaderEdge(17, 0, 360);
  expect(invoke).toHaveBeenCalledWith('reader_native_view_transform', expect.objectContaining({
    transform: expect.objectContaining({ page: 17, edgeOffset: -0.06 }),
  }), undefined);
  await vi.advanceTimersByTimeAsync(400);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith('reader_native_view_transform', expect.objectContaining({
    transform: expect.objectContaining({ page: 17, edgeOffset: 0 }),
    transition: { from: -0.06, durationMs: 360, boundary: true },
  }), undefined);
});


it('accounts for the retained file rather than a full RGBA bitmap for a native reader lease', () => {
  vi.stubGlobal('YomikaTiles', { postMessage: vi.fn() });
  const handle = { key: 'page-5', url: 'lease:page-5', bytes: 16_000_000, estimatedDecodedBytes: 7680 * 4320 * 4 };
  rememberTileSource(handle.url, { contentHash: 'hash', leaseId: 'lease', decodedBytes: handle.estimatedDecodedBytes });
  try {
    expect(readerDerivedRetainedBytes(handle)).toBe(handle.bytes);
    expect(readerDerivedRetainedBytes({ ...handle, url: 'blob:fallback' })).toBe(handle.estimatedDecodedBytes);
  } finally {
    forgetTileSource(handle.url);
  }
});

it('drops a queued edge transform when a different reader session opens at the same page', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  let finishFirst!: () => void;
  const invoke = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve; })).mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  updateNativeReaderEdge(17, -0.1, 0, 100);
  updateNativeReaderEdge(17, 0, 360, 100);
  updateNativeReaderTransform(17, { scale: 1, panX: 0, panY: 0 }, 101);
  finishFirst();
  await vi.advanceTimersByTimeAsync(400);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith('reader_native_view_transform', expect.objectContaining({
    transform: expect.objectContaining({ session: 101, page: 17, edgeOffset: 0 }),
  }), undefined);
});


it('carries the warmed neighbour through a native slide and clears it for the next page', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  updateNativeReaderSlide(13, 11, .3, 102);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('reader_native_view_transform', {
    transform: expect.objectContaining({ session: 102, page: 13, neighbourPage: 11, edgeOffset: .3 }),
  }, undefined));
  updateNativeReaderTransform(11, { scale: 1.6, panX: 0, panY: 0 }, 102);
  await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('reader_native_view_transform', {
    transform: expect.objectContaining({ session: 102, page: 11, neighbourPage: undefined, edgeOffset: 0, scale: 1.6 }),
  }, undefined));
});


it('sends one native slide transition and lets the next gesture replace it', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  updateNativeReaderSlide(13, 11, 1, 103, { from: .35, durationMs: 160 });
  await vi.advanceTimersByTimeAsync(64);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('reader_native_view_transform', {
    transform: expect.objectContaining({ session: 103, page: 13, neighbourPage: 11, edgeOffset: 1 }),
    transition: { from: .35, durationMs: 160 },
  }, undefined);
  updateNativeReaderTransform(11, { scale: 1.5, panX: 4, panY: 2 }, 103);
  await vi.advanceTimersByTimeAsync(250);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith('reader_native_view_transform', {
    transform: expect.objectContaining({ session: 103, page: 11, edgeOffset: 0, scale: 1.5 }),
  }, undefined);
});


it('sends Android continuous geometry once and clears it when the final anchor unmounts', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.stubGlobal('devicePixelRatio', 1);
  const postMessage = vi.fn();
  vi.stubGlobal('YomikaTiles', { postMessage });
  const url = 'tile:continuous';
  rememberTileSource(url, 'hash');
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 20, 800, 1200));
  const view = render(createElement('div', { className: 'reader-webtoon' },
    createElement('div', { className: 'reader-webtoon-slot' },
      createElement(ReaderTileSlot, { url, index: 0, current: false, present: true, continuous: true }))));
  const layouts = () => postMessage.mock.calls.map(([message]) => JSON.parse(message))
    .filter(message => message.op === 'continuous-layout');
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect(layouts()).toEqual([expect.objectContaining({
      scrollTop: 0, entries: [{ id: expect.any(Number), rect: [0, 20, 800, 1200] }],
    })]);
    const scroller = view.container.firstElementChild!;
    scroller.scrollTop = 151;
    bounds.mockClear();
    scroller.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);
    expect(bounds).not.toHaveBeenCalled();
    expect(layouts()[1]).toEqual({ op: 'continuous-layout', id: 0, scrollTop: 151 });
    view.unmount();
    expect(layouts()[2]).toEqual({ op: 'continuous-layout', id: 0, entries: [], scrollTop: 0 });
  } finally {
    view.unmount();
    bounds.mockRestore();
    forgetTileSource(url);
  }
});

it('commits one shell transform for a near-fit page turn and its zoom reset', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  const zoomFrom = { scale: 1.035, panX: 3, panY: -2 };
  updateNativeReaderSlide(7, 9, -1, 104, { from: -.35, durationMs: 140, zoomFrom });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(invoke).toHaveBeenCalledWith('reader_native_view_transform', {
    transform: expect.objectContaining({ session: 104, page: 7, neighbourPage: 9, edgeOffset: -1, scale: 1, panX: 0, panY: 0 }),
    transition: { from: -.35, durationMs: 140, zoomFrom },
  }, undefined);
});


it('mirrors native continuous offsets and rejects samples from an old session or before a seek', () => {
  vi.stubGlobal('devicePixelRatio', 2);
  const postMessage = vi.fn();
  vi.stubGlobal('YomikaTiles', { postMessage });
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientHeight', { value: 400 });
  const update = vi.fn();
  const detach = trackNativeContinuousInput(container, 71, update)!;
  const scroll = (session: number, revision: number, sample: number, offset: number) => {
    window.dispatchEvent(new CustomEvent('yomika-reader-continuous-scroll', { detail: { session, revision, sample, offset } }));
  };
  const lastMessage = () => JSON.parse(postMessage.mock.lastCall![0]);
  try {
    configureNativeContinuousInput(container, true, 1400, false);
    expect(lastMessage()).toMatchObject({ op: 'continuous-input', session: 71, active: true, limit: 2000 });
    scroll(70, 0, 1, 120);
    expect(update).not.toHaveBeenCalled();
    scroll(71, 0, 2, 160);
    scroll(71, 0, 1, 120);
    expect(update.mock.calls).toEqual([[80]]);
    expect(container.scrollTop).toBe(80);
    repositionNativeContinuousInput(container, 330);
    expect(lastMessage()).toMatchObject({ op: 'continuous-reposition', session: 71, revision: 1, offset: 660, relative: false });
    scroll(71, 0, 3, 220);
    expect(container.scrollTop).toBe(80);
    scroll(71, 1, 4, 660);
    expect(container.scrollTop).toBe(330);
    repositionNativeContinuousInput(container, -40, true);
    expect(lastMessage()).toMatchObject({ op: 'continuous-reposition', session: 71, revision: 2, offset: -80, relative: true });
  } finally {
    detach();
  }
  expect(lastMessage()).toMatchObject({ op: 'continuous-input', session: 71, active: false });
  scroll(71, 2, 5, 580);
  expect(container.scrollTop).toBe(330);
});


it('batches Windows wheel input and does not replay it after a jump', async () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeContinuousInput', 'wheel');
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
  const detach = trackNativeContinuousInput(scroller, 90, vi.fn())!;
  const wheel = (deltaY: number, ctrlKey = false) => scroller.dispatchEvent(new WheelEvent('wheel', { cancelable: true, deltaY, ctrlKey }));
  try {
    configureNativeContinuousInput(scroller, true, 1_400, false);
    expect(wheel(10)).toBe(false);
    expect(wheel(15)).toBe(false);
    expect(wheel(20, true)).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(invoke).toHaveBeenCalledWith('reader_native_continuous_input', { session: 90, revision: 0, offset: 25, wheel: true }, undefined);
    wheel(30);
    repositionNativeContinuousInput(scroller, 600);
    await vi.advanceTimersByTimeAsync(20);
    expect(invoke.mock.calls.filter(([, args]) => args.wheel)).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith('reader_native_continuous_input', { session: 90, revision: 1, offset: 600, relative: false }, undefined);
  } finally {
    detach();
  }
});

it('applies the first wheel batch after a queued new-page fit transform', async () => {
  let finishSlide!: () => void;
  const sliding = new Promise<void>(resolve => { finishSlide = resolve; });
  const invoke = vi.fn()
    .mockReturnValueOnce(sliding)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce([1.2, -4, 0]);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  updateNativeReaderSlide(17, 18, -1, 104);
  updateNativeReaderTransform(18, { scale: 1, panX: 0, panY: 0 }, 104);
  const zoom = sampleNativeWheelZoom(104, 18, 6, [[24, 0, -120, 0]]);
  try {
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    finishSlide();
    await zoom;
  }
  expect(invoke).toHaveBeenNthCalledWith(2, 'reader_native_view_transform', expect.objectContaining({
    transform: expect.objectContaining({ session: 104, page: 18, scale: 1 }),
  }), undefined);
  expect(invoke).toHaveBeenNthCalledWith(3, 'reader_native_wheel_zoom', expect.objectContaining({
    session: 104, page: 18, maximum: 6, samples: [[24, 0, -120, 0]],
  }), undefined);
  expect(await zoom).toEqual({ scale: 1.2, panX: -4, panY: 0 });
});
