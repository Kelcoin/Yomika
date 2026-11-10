import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readerGestureTextureSize, useReaderGestureTexture } from '../../src/lib/useReaderGestureTexture';

it('bounds a 6000×8000 page without changing the original source', () => {
  const size = readerGestureTextureSize(6000, 8000)!;
  expect(size.width * size.height).toBeLessThanOrEqual(4_000_000);
  expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(3072);
  expect(size.width / size.height).toBeCloseTo(0.75, 3);
  expect(readerGestureTextureSize(1000, 1600)).toBeUndefined();
  expect(readerGestureTextureSize(0, 8000)).toBeUndefined();
});

describe('large-page gesture texture lifetime', () => {
  it('defers preparation while the reader owns an active gesture', async () => {
    vi.useFakeTimers();
    const root = document.createElement('main');
    root.dataset.imageInteraction = 'true';
    const image = new Image();
    root.append(image);
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 6000 }, naturalHeight: { value: 8000 } });
    const close = vi.fn();
    const decode = vi.fn(async () => ({ close } as unknown as ImageBitmap));
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { callback(); return 1; });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const ref = { current: image };
    const { result, unmount } = renderHook(() => useReaderGestureTexture(ref, 'page'));
    Object.defineProperty(result.current.canvas, 'current', { value: document.createElement('canvas'), writable: true });
    await act(async () => { await Promise.resolve(); });
    expect(decode).not.toHaveBeenCalled();
    root.dataset.imageInteraction = 'false';
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(decode).toHaveBeenCalledOnce();
    expect(result.current.ready).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    unmount();
    spy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('does not allocate unused textures for continuous webtoon scrolling', () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const image = new Image();
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 6000 }, naturalHeight: { value: 8000 } });
    const { result, unmount } = renderHook(() => useReaderGestureTexture({ current: image }, 'page', false));
    expect(result.current.ready).toBe(false);
    expect(decode).not.toHaveBeenCalled();
    unmount();
    vi.unstubAllGlobals();
  });
  it('releases an asynchronous result after navigation and does not draw it', async () => {
    const image = new Image();
    Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 6000 }, naturalHeight: { value: 8000 } });
    let finish!: (bitmap: ImageBitmap) => void;
    const close = vi.fn();
    const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; }));
    const drawImage = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { callback(); return 1; });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const ref = { current: image };
    const { result, unmount } = renderHook(() => useReaderGestureTexture(ref, 'original'));
    Object.defineProperty(result.current.canvas, 'current', { value: document.createElement('canvas'), writable: true });
    await act(async () => { await Promise.resolve(); });
    expect(decode).toHaveBeenCalledOnce();
    unmount();
    await act(async () => { finish({ close } as unknown as ImageBitmap); });
    expect(close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.unstubAllGlobals();
  });
});
