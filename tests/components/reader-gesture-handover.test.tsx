import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
import { ReaderScreen } from '../../src/components/ReaderScreen';
import { setImageDecoderForTests } from '../../src/lib/decodeImage';
import { forgetTileSource, rememberTileSource } from '../../src/lib/readerNativeTiles';

afterEach(() => { setImageDecoderForTests(undefined); vi.restoreAllMocks(); });
beforeEach(() => {
  // These tests operate on an already displayed/decoded original image.
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(128);
});
const plain = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const touches = (distance: number) => [{ clientX: 200 - distance / 2, clientY: 300 }, { clientX: 200 + distance / 2, clientY: 300 }];
const view = (derived = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain]} derivedPages={derived} /></MemoryRouter>;

it('keeps the touch target mounted when inference completes mid-pinch, then settles before promoting', async () => {
  setImageDecoderForTests(async () => {});
  const { rerender } = render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(40) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  const frame = target.closest('.reader-single') as HTMLElement;
  const scale = Number(frame.style.transform.match(/scale\(([^)]+)\)/)?.[1]);
  expect(scale).toBeGreaterThan(0.88);
  expect(scale).toBeLessThan(1);
  await act(async () => { rerender(view(new Map([[0, 'blob:enhanced']]))); });
  // Touch events stay targeted at the element from touchstart, even if removed.
  expect(target.isConnected).toBe(true);
  expect(screen.getByRole('img', { name: '第 1 页' })).toBe(target);
  fireEvent.touchEnd(target, { touches: [], changedTouches: touches(40) });
  expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', 'blob:enhanced');
});

it('does not promote an already decoding candidate while a new pinch owns the displayed image', async () => {
  let complete!: () => void;
  setImageDecoderForTests(() => new Promise(resolve => { complete = resolve; }));
  const { rerender } = render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  rerender(view(new Map([[0, 'blob:enhanced']])));
  fireEvent.touchStart(target, { touches: touches(200) });
  await act(async () => { complete(); });
  expect(target.isConnected).toBe(true);
  fireEvent.touchCancel(target);
});

it('runs undershoot recovery from explicit last-painted keyframes without awaiting another render', async () => {
  render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  const frame = target.closest('.reader-single') as HTMLElement;
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel, onfinish: null }));
  Object.defineProperty(frame, 'animate', { configurable: true, value: animate });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(40) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  const from = frame.style.transform;
  fireEvent.touchEnd(target, { touches: [], changedTouches: touches(40) });
  expect(animate).toHaveBeenCalledWith([{ transform: from }, { transform: 'scale(1) translate(0px, 0px)' }], { duration: 140, easing: 'ease-out' });
  expect(frame.style.transform).toBe('scale(1) translate(0px, 0px)');
  fireEvent.touchCancel(target);
  expect(cancel).not.toHaveBeenCalled();
  // A new gesture interrupts recovery immediately instead of chasing its target.
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(300) });
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps the remaining touch pan alive when the other finger loses implicit capture', async () => {
  render(view());
  const target = screen.getByRole('img', { name: '第 1 页' });
  fireEvent.touchStart(target, { touches: touches(200) });
  fireEvent.touchMove(target, { touches: touches(400) });
  await act(async () => { await new Promise(requestAnimationFrame); });
  fireEvent.touchEnd(target, { touches: [{ clientX: 200, clientY: 300 }], changedTouches: [{ clientX: 400, clientY: 300 }] });
  fireEvent.lostPointerCapture(target, { pointerType: 'touch', pointerId: 2 });
  fireEvent.touchMove(target, { touches: [{ clientX: 260, clientY: 330 }] });
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect((target.closest('.reader-single') as HTMLElement).style.transform).toContain('scale(2)');
  expect((target.closest('.reader-single') as HTMLElement).style.transform).not.toContain('translate(0px, 0px)');
  fireEvent.touchEnd(target, { touches: [] });
});

it('coalesces wheel transforms without reconciling the reader for each wheel event', async () => {
  let commits = 0;
  render(<Profiler id="reader" onRender={() => commits++}>{view()}</Profiler>);
  await act(async () => { await new Promise(requestAnimationFrame); });
  commits = 0;
  const reader = screen.getByRole('main', { name: '漫画阅读器' });
  const frame = reader.querySelector('.reader-single')!;
  const readinessChecks = vi.spyOn(frame, 'querySelectorAll');
  for (let i = 0; i < 40; i++) fireEvent.wheel(reader, { deltaY: -2, clientX: 200, clientY: 300 });
  expect(readinessChecks.mock.calls.filter(([selector]) => selector === 'img.reader-page:not(.is-candidate)')).toHaveLength(1);
  readinessChecks.mockRestore();
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(commits).toBeLessThanOrEqual(3);
  const transform = (screen.getByRole('img', { name: '第 1 页' }).closest('.reader-single') as HTMLElement).style.transform;
  expect(Number(/scale\(([^)]+)/.exec(transform)?.[1])).toBeCloseTo(Math.exp(.12), 10);
});

it('prepares the processed native slot before promotion and selects that same slot after promotion', async () => {
  const events: { op: string; id: number; hash?: string }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => events.push(JSON.parse(message)) });
  const processed = 'blob:prepared-enhanced';
  const hash = 'a'.repeat(64);
  rememberTileSource(processed, hash);
  let finishDecode!: () => void;
  setImageDecoderForTests(() => new Promise(resolve => { finishDecode = resolve; }));
  try {
    const rendered = render(view());
    rendered.rerender(view(new Map([[0, processed]])));
    expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', plain);
    expect(events).toEqual([{ op: 'prepare', id: expect.any(Number), hash, page: 1, session: expect.any(Number) }]);
    const id = events[0]!.id;
    await act(async () => { finishDecode(); });
    expect(events.map(event => [event.op, event.id])).toEqual([['prepare', id], ['select', id]]);
    rendered.unmount();
    expect(events.filter(event => event.op === 'drop')).toEqual([{ op: 'drop', id }]);
  } finally {
    forgetTileSource(processed);
    vi.unstubAllGlobals();
  }
});

it('drops superseded native candidates without selecting them', async () => {
  const events: { op: string; id: number; hash?: string }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => events.push(JSON.parse(message)) });
  const first = 'blob:first-processed';
  const last = 'blob:last-processed';
  const hashes = ['b'.repeat(64), 'c'.repeat(64)];
  rememberTileSource(first, hashes[0]!);
  rememberTileSource(last, hashes[1]!);
  const pending = new Map<string, () => void>();
  setImageDecoderForTests(url => new Promise(resolve => { pending.set(url, resolve); }));
  try {
    const rendered = render(view());
    rendered.rerender(view(new Map([[0, first]])));
    rendered.rerender(view(new Map([[0, last]])));
    const prepared = events.filter(event => event.op === 'prepare');
    expect(prepared.map(event => event.hash)).toEqual(hashes);
    expect(events.filter(event => event.op === 'drop').map(event => event.id)).toEqual([prepared[0]!.id]);
    await act(async () => { pending.get(first)!(); });
    expect(events.filter(event => event.op === 'select')).toEqual([]);
    await act(async () => { pending.get(last)!(); });
    expect(events.filter(event => event.op === 'select').map(event => event.id)).toEqual([prepared[1]!.id]);
    rendered.unmount();
  } finally {
    forgetTileSource(first);
    forgetTileSource(last);
    vi.unstubAllGlobals();
  }
});


it.each([4, 128])('presents a leased %i MiB static page without mounting a WebView image', async (decodedMiB) => {
  const send = vi.fn();
  vi.stubGlobal('YomikaTiles', { postMessage: send });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  rememberTileSource(plain, { contentHash: 'd'.repeat(64), leaseId: 'lease', decodedBytes: decodedMiB * 1024 * 1024 });
  try {
    const viewRoot = render(view());
    expect(screen.getByRole('img', { name: '第 1 页' }).tagName).toBe('DIV');
    const request = invoke.mock.calls[0]![1]!;
    expect(send).toHaveBeenCalledWith(JSON.stringify({ op: 'present', id: request.slot }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', {
        detail: { slot: request.slot, width: 7680, height: 4320 },
      }));
    });
    expect(viewRoot.container.querySelector('[data-native-reader-visible]')).toBeTruthy();
    expect(viewRoot.container.querySelector('img.reader-page')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', {
        detail: { slot: request.slot, width: 0, height: 0 },
      }));
    });
    expect(screen.getByRole('img', { name: '第 1 页' }).tagName).toBe('IMG');
  } finally {
    forgetTileSource(plain);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('keeps the previous native page and its display handle until the host presents the processed page', async () => {
  const messages: { op: string; id: number }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const processed = 'blob:leased-processed';
  for (const url of [plain, processed]) {
    rememberTileSource(url, { contentHash: 'e'.repeat(64), leaseId: url, decodedBytes: 128 * 1024 * 1024 });
  }
  const displayed = vi.fn();
  const reader = (derived = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain]} derivedPages={derived} onDerivedDisplayed={displayed} /></MemoryRouter>;
  const hostEvent = (type: string, slot: unknown) => act(async () => {
    window.dispatchEvent(new CustomEvent(type, { detail: { slot, width: 7680, height: 4320 } }));
  });
  const rendered = render(reader());
  try {
    const original = invoke.mock.calls[0]![1]!.slot;
    await hostEvent('yomika-reader-tile-status', original);
    const previous = screen.getByRole('img', { name: '第 1 页' });
    rendered.rerender(reader(new Map([[0, processed]])));
    const candidate = invoke.mock.calls[1]![1]!.slot;
    await hostEvent('yomika-reader-tile-status', candidate);
    expect(messages).toContainEqual(expect.objectContaining({ op: 'present', id: candidate }));
    expect(screen.getByRole('img', { name: '第 1 页' })).toBe(previous);
    expect(messages).not.toContainEqual({ op: 'drop', id: original });
    expect(displayed).not.toHaveBeenCalledWith(0, processed);
    await hostEvent('yomika-reader-tile-presented', original);
    expect(previous.isConnected).toBe(true);
    await hostEvent('yomika-reader-tile-presented', candidate);
    expect(previous.isConnected).toBe(false);
    expect(messages).toContainEqual({ op: 'drop', id: original });
    expect(displayed).toHaveBeenCalledWith(0, processed);
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    forgetTileSource(processed);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it.each(['native-original', 'hashed-original', 'failed-native-candidate'])('transfers viewport before retiring the original in %s', async (scenario) => {
  const leased = scenario !== 'hashed-original';
  const failedNativeCandidate = scenario === 'failed-native-candidate';
  const messages: { op: string; id: number; page?: number }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const hash = 'f'.repeat(64);
  rememberTileSource(plain, leased ? { contentHash: hash, leaseId: 'original', decodedBytes: 128 * 1024 * 1024 } : hash);
  const processed = 'blob:dom-processed';
  if (failedNativeCandidate) {
    rememberTileSource(processed, { contentHash: hash, leaseId: 'processed', decodedBytes: 128 * 1024 * 1024 });
  }
  let finishDecode!: () => void;
  setImageDecoderForTests(() => new Promise(resolve => { finishDecode = resolve; }));
  const rendered = render(view());
  try {
    const original = leased ? invoke.mock.calls[0]![1]!.slot : messages.find(message => message.op === 'prepare')!.id;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', {
        detail: { slot: original, width: 7680, height: 4320 },
      }));
      rendered.rerender(view(new Map([[0, processed]])));
    });
    expect(screen.getByRole('img', { name: '第 1 页' }).tagName).toBe(leased ? 'DIV' : 'IMG');
    expect(messages).not.toContainEqual({ op: 'drop-after-web-frame', id: original });
    if (failedNativeCandidate) {
      const candidate = invoke.mock.calls.find(([, request]) => request?.leaseId === 'processed')?.[1]?.slot;
      expect(candidate).toBeDefined();
      await act(async () => {
        window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', { detail: { slot: candidate, width: 0, height: 0 } }));
      });
      expect(screen.getByRole('img', { name: '第 1 页' }).tagName).toBe('DIV');
    }
    await act(async () => { finishDecode(); });
    expect(screen.getByRole('img', { name: '第 1 页' }).tagName).toBe(leased ? 'DIV' : 'IMG');
    if (!leased) expect(screen.getByRole('img', { name: '第 1 页' })).toHaveAttribute('src', plain);
    const request = messages.find(message => message.op === 'viewport');
    expect(request?.page).toBe(1);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-viewport', {
        detail: { id: request!.id, viewport: { scale: 2.25, x: 0.6, y: 0.55 } },
      }));
    });
    const result = screen.getByRole('img', { name: '第 1 页' });
    expect(result).toHaveAttribute('src', 'blob:dom-processed');
    expect((result.closest('.reader-single') as HTMLElement).style.transform).toContain('scale(2.25)');
    expect(messages).toContainEqual({ op: 'drop-after-web-frame', id: original });
    expect(messages).not.toContainEqual({ op: 'drop', id: original });
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    forgetTileSource(processed);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('positions leased continuous pages without selecting a native pagination gesture target', async () => {
  const messages: unknown[] = [];
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('reader-webtoon-slot') ? DOMRect.fromRect({ x: 20, y: -30, width: 400, height: 700 }) : bounds.call(this);
  });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  rememberTileSource(plain, { contentHash: 'f'.repeat(64), leaseId: 'original', decodedBytes: 16 });
  const rendered = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="webtoon" pages={[plain]} /></MemoryRouter>);
  try {
    const slot = invoke.mock.calls[0]![1]!.slot;
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(messages).toContainEqual(expect.objectContaining({ op: 'continuous-layout', id: 0, entries: [{ id: slot, rect: [20, -30, 400, 700] }], scrollTop: 0, session: expect.any(Number), revision: 1, sample: 0 }));
    expect(messages).not.toContainEqual(expect.objectContaining({ op: 'select', id: slot }));
    rendered.unmount();
    expect(messages).toContainEqual({ op: 'drop', id: slot });
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('keeps the displayed native slot pinchable when the processing toolbar is opened', async () => {
  const messages: { op: string; id: number }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  rememberTileSource(plain, { contentHash: 'f'.repeat(64), leaseId: 'original', decodedBytes: 128 * 1024 * 1024 });
  const rendered = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain]} upscale={{ configured: true, active: false, toggle: vi.fn() }} /></MemoryRouter>);
  try {
    const slot = invoke.mock.calls[0]![1]!.slot;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', {
        detail: { slot, width: 7680, height: 4320 },
      }));
    });
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    expect(screen.getByRole('button', { name: /超分/ })).toBeTruthy();
    expect(messages).not.toContainEqual({ op: 'deselect', id: slot });
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('keeps a large cached original selected while its processing controls are visible', () => {
  const messages: { op: string; id: number }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  rememberTileSource(plain, 'f'.repeat(64));
  const reader = (processing = false) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single"
    pages={[plain]} derivingPages={processing ? new Set([0]) : undefined}
    upscale={{ configured: true, active: processing, toggle: vi.fn() }} /></MemoryRouter>;
  const rendered = render(reader());
  try {
    const slot = messages.find(({ op }) => op === 'select')!.id;
    fireEvent.click(screen.getByRole('main', { name: '漫画阅读器' }));
    rendered.rerender(reader(true));
    expect(messages).not.toContainEqual(expect.objectContaining({ op: 'deselect', id: slot }));
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    vi.unstubAllGlobals();
  }
});

it('ignores a late Android page turn from a different reader session', () => {
  const events: { op: string; session?: number }[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => events.push(JSON.parse(message)) });
  rememberTileSource(plain, 'f'.repeat(64));
  const progress = vi.fn();
  const rendered = render(<MemoryRouter><ReaderScreen archiveId="new-book" title="Reader" layout="single"
    pages={[plain, plain]} onProgress={progress} /></MemoryRouter>);
  try {
    const session = events.find(({ op }) => op === 'prepare')!.session!;
    const turn = (owner: number) => act(() => window.dispatchEvent(new CustomEvent('yomika-reader-native-turn', {
      detail: { session: owner, from: 1, to: 2, left: true },
    })));
    progress.mockClear();
    turn(session + 1);
    expect(progress).not.toHaveBeenCalled();
    turn(session);
    expect(progress).toHaveBeenCalledWith(1, expect.anything());
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    vi.unstubAllGlobals();
  }
});

it.each([false, true])('passes reduced motion=%s to Android when arming a native swipe', (reduceMotion) => {
  const messages: unknown[] = [];
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduceMotion && query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  rememberTileSource(plain, { contentHash: 'f'.repeat(64), leaseId: 'original', decodedBytes: 16 });
  const rendered = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain, 'blob:next']} /></MemoryRouter>);
  try {
    const slot = invoke.mock.calls[0]![1]!.slot;
    expect(messages).toContainEqual(expect.objectContaining({ op: 'select', id: slot, left: 2, reduceMotion }));
  } finally {
    rendered.unmount();
    forgetTileSource(plain);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('arms a decoded native neighbour rendition without waiting for it to become visible', async () => {
  const messages: unknown[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const original = 'blob:neighbour-original';
  const processed = 'blob:neighbour-processed';
  for (const url of [original, processed]) rememberTileSource(url, { contentHash: 'a'.repeat(64), leaseId: url, decodedBytes: 16 });
  const reader = (derived = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" pages={[plain, original]} derivedPages={derived} /></MemoryRouter>;
  const rendered = render(reader());
  try {
    rendered.rerender(reader(new Map([[1, processed]])));
    const slot = invoke.mock.calls.find(([, args]) => args?.leaseId === processed)![1]!.slot;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', { detail: { slot, width: 7680, height: 4320 } }));
    });
    expect(messages).toContainEqual({ op: 'arm', id: slot, page: 2, session: expect.any(Number) });
    expect(messages).not.toContainEqual(expect.objectContaining({ op: 'present', id: slot }));
  } finally {
    rendered.unmount();
    forgetTileSource(original);
    forgetTileSource(processed);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it('presents an RTL spread as one native slot and retains both predecessors until replacement is acknowledged', async () => {
  const messages: Array<{ op: string; id: number; replacement?: boolean }> = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const first = 'blob:spread-first';
  const second = 'blob:spread-second';
  const replacement = 'blob:spread-replacement';
  for (const url of [first, second, replacement]) rememberTileSource(url, { contentHash: 'b'.repeat(64), leaseId: url, decodedBytes: 16 });
  const reader = (derived = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" initialPage={1} layout="double" direction="rtl" pages={[plain, first, second]} derivedPages={derived} /></MemoryRouter>;
  const rendered = render(reader());
  const event = async (type: string, slot: unknown) => act(async () => {
    window.dispatchEvent(new CustomEvent(`yomika-reader-tile-${type}`, { detail: { slot, width: 800, height: 600 } }));
  });
  try {
    const oldRequest = invoke.mock.calls.find(([, args]) => args?.leaseId === second && args.rightLeaseId === first)?.[1];
    expect(oldRequest).toMatchObject({ page: 2, aspect: expect.any(Number) });
    await event('status', oldRequest!.slot);
    expect(rendered.container.querySelectorAll('img[src^="blob:spread-"]')).toHaveLength(0);
    expect(rendered.container.querySelectorAll('[data-native-reader-visible]')).toHaveLength(2);
    rendered.rerender(reader(new Map([[1, replacement]])));
    const newRequest = invoke.mock.calls.find(([, args]) => args?.rightLeaseId === replacement)?.[1];
    expect(newRequest).toMatchObject({ page: 2, leaseId: second });
    await event('status', newRequest!.slot);
    expect(messages).toContainEqual(expect.objectContaining({ op: 'present', id: newRequest!.slot, replacement: true }));
    expect(messages).not.toContainEqual(expect.objectContaining({ op: 'drop', id: oldRequest!.slot }));
    await event('presented', newRequest!.slot);
    expect(messages).toContainEqual(expect.objectContaining({ op: 'drop', id: oldRequest!.slot }));
  } finally {
    rendered.unmount();
    for (const url of [first, second, replacement]) forgetTileSource(url);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});

it.each([
  { initialPage: 0, endX: 290, page: 1, waitForFrame: true },
  { initialPage: 0, endX: 290, page: 1, waitForFrame: false },
  { initialPage: 1, endX: 150, page: 2, waitForFrame: false },
])('moves the Android native page and springs back at page $page (frame drawn: $waitForFrame)', async ({ initialPage, endX, page, waitForFrame }) => {
  const messages: unknown[] = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const rendered = render(<MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single" initialPage={initialPage} pages={[plain, plain]} /></MemoryRouter>);
  try {
    const frame = screen.getByRole('region', { name: '分页阅读' });
    fireEvent.touchStart(frame, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(frame, { touches: [{ clientX: endX, clientY: 300 }] });
    if (waitForFrame) await act(async () => { await new Promise(requestAnimationFrame); });
    fireEvent.touchEnd(frame, { touches: [], changedTouches: [{ clientX: endX, clientY: 300 }] });
    expect(messages.filter((message) => (message as { op: string }).op === 'edge-drag')).toEqual([
      expect.objectContaining({ page, offset: expect.not.closeTo(0, 4), duration: 0 }),
      expect.objectContaining({ page, offset: 0, duration: 360 }),
    ]);
  } finally {
    rendered.unmount();
    vi.unstubAllGlobals();
  }
});

it('keeps the double-page frame and zoom when a processed rendition crosses the wide-page threshold', async () => {
  setImageDecoderForTests(async () => {});
  const enhanced = 'blob:wide-processed';
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(function (this: HTMLImageElement) {
    return this.src === enhanced ? 180 : 128;
  });
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(160);
  const tiles = [plain, 'blob:left-original', 'blob:right-original'];
  const reader = (derived?: Map<number, string>) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="double" initialPage={1} pages={tiles} derivedPages={derived} /></MemoryRouter>;
  const rendered = render(reader());
  const left = screen.getByRole('img', { name: '第 2 页' });
  const right = screen.getByRole('img', { name: '第 3 页' });
  fireEvent.load(left);
  fireEvent.load(right);
  fireEvent.doubleClick(left, { clientX: 512, clientY: 384 });
  const frame = left.closest('.reader-spread') as HTMLElement;
  expect(frame.style.transform).not.toBe('scale(1) translate(0px, 0px)');
  // Double tap sets a short handoff delay while the viewport animates.
  rendered.rerender(reader(new Map([[1, enhanced]])));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  expect(screen.getByRole('img', { name: '第 2 页' })).toHaveAttribute('src', enhanced);
  expect(screen.getByRole('img', { name: '第 2 页' }).closest('.reader-spread')).toBe(frame);
  expect(frame.style.transform).not.toBe('scale(1) translate(0px, 0px)');
});

it.each([true, false])('keeps the native spread until the web frame decodes (native replacement available: %s)', async (nativeCandidate) => {
  const messages: Array<{ op: string; id: number }> = [];
  vi.stubGlobal('YomikaTiles', { postMessage: (message: string) => messages.push(JSON.parse(message)) });
  const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const [left, right, derived] = ['blob:original-left', 'blob:original-right', 'blob:derived-left'] as const;
  for (const url of nativeCandidate ? [left, right, derived] : [left, right]) rememberTileSource(url, { contentHash: 'b'.repeat(64), leaseId: url, decodedBytes: 16 });
  const rejected = vi.fn();
  const reader = (pages = new Map<number, string>()) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" initialPage={1} layout="double" pages={[plain, left, right]} derivedPages={pages} onDerivedRejected={rejected} /></MemoryRouter>;
  const rendered = render(reader());
  const status = (slot: unknown, width: number) => window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', { detail: { slot, width, height: width } }));
  let decoded!: () => void;
  setImageDecoderForTests(url => url === derived ? new Promise(resolve => { decoded = resolve; }) : Promise.resolve());
  try {
    const original = invoke.mock.calls.find(([, args]) => args?.leaseId === left)?.[1]?.slot;
    expect(original).toBeDefined();
    await act(async () => { status(original, 800); });
    rendered.rerender(reader(new Map([[1, derived]])));
    const candidate = invoke.mock.calls.find(([, args]) => args?.leaseId === derived)?.[1]?.slot;
    if (nativeCandidate) {
      expect(candidate).toBeDefined();
      await act(async () => { status(candidate, 0); });
    } else {
      expect(candidate).toBeUndefined();
    }
    expect(rejected).not.toHaveBeenCalled();
    expect(messages).not.toContainEqual(expect.objectContaining({ op: 'drop', id: original }));
    expect(rendered.container.querySelectorAll('[data-native-reader-visible]')).toHaveLength(2);
    await act(async () => { decoded(); });
    const viewport = messages.find(message => message.op === 'viewport');
    expect(viewport).toBeDefined();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-viewport', { detail: { id: viewport!.id, viewport: { scale: 2, x: .5, y: .5 } } }));
    });
    const page = screen.getByRole('img', { name: '第 2 页' });
    expect(page).toHaveAttribute('src', derived);
    expect((page.closest('.reader-spread') as HTMLElement).style.transform).toContain('scale(2)');
    expect(messages).toContainEqual(expect.objectContaining({ op: 'drop-after-web-frame', id: original }));
  } finally {
    rendered.unmount();
    for (const url of [left, right, derived]) forgetTileSource(url);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});
it('targets the native spread anchor when progress opens on the second page', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  try {
    render(<MemoryRouter><ReaderScreen archiveId="anchor" readerSession={301} title="Reader" initialPage={2} layout="double" pages={[plain, plain, plain]} /></MemoryRouter>);
    const target = screen.getByRole('img', { name: '第 3 页' });
    fireEvent.touchStart(target, { touches: touches(100) });
    fireEvent.touchMove(target, { touches: touches(150) });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('reader_native_view_transform', expect.objectContaining({
      transform: expect.objectContaining({ session: 301, page: 2, scale: 1.5 }),
    }), undefined));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a native iOS zoom sample when the same page is being processed', async () => {
  vi.stubGlobal('__yomikaNativeReaderPreview', true);
  vi.stubGlobal('__yomikaNativePinchInput', true);
  const rawInvoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: rawInvoke });
  const invoke = vi.fn(async (_command: string, _request?: Record<string, unknown>) => ({ ok: true, value: true }));
  setInvokeAdapterForTests(invoke);
  const derived = 'blob:ios-derived';
  for (const url of [plain, derived]) rememberTileSource(url, { contentHash: 'c'.repeat(64), leaseId: url, decodedBytes: 128 * 1024 * 1024 });
  const reader = (processing = false, ready = false) => <MemoryRouter><ReaderScreen archiveId="a" title="Reader" layout="single"
    readerSession={12} pages={[plain]} derivingPages={processing ? new Set([0]) : undefined}
    derivedPages={ready ? new Map([[0, derived]]) : undefined} /></MemoryRouter>;
  const rendered = render(reader());
  const nativeReady = async (url: string) => {
    const slot = invoke.mock.calls.find(([, args]) => args?.leaseId === url)?.[1]?.slot;
    expect(slot).toBeDefined();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-status', { detail: { slot, width: 7680, height: 4320 } }));
    });
    return slot;
  };
  try {
    await nativeReady(plain);
    expect(rawInvoke).toHaveBeenCalledWith('reader_native_pinch_input', expect.objectContaining({ session: 12, page: 1, maximum: 3, enabled: true, reduceMotion: false }), undefined);
    rendered.rerender(reader(true));
    const nativePinch = (session: number, active: boolean) => act(() => {
      window.dispatchEvent(new CustomEvent('yomika-reader-native-pinch', { detail: { session, page: 1, active } }));
    });
    nativePinch(12, true);
    nativePinch(11, false);
    rendered.rerender(reader(false, true));
    expect(invoke.mock.calls.some(([, args]) => args?.leaseId === derived)).toBe(false);
    const report = (session: number, scale: number) => act(() => {
      window.dispatchEvent(new CustomEvent('yomika-reader-native-zoom', { detail: { session, page: 1, scale, panX: 24, panY: -12 } }));
    });
    report(12, 2);
    report(11, 1);
    await act(async () => { nativePinch(12, false); });
    const replacement = await nativeReady(derived);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('yomika-reader-tile-presented', { detail: { slot: replacement } }));
    });
    expect(rendered.container.querySelector('.reader-frame.is-current .reader-zoom') ?? rendered.container.querySelector('[style*="scale(2)"]')).toHaveStyle({ transform: 'scale(2) translate(24px, -12px)' });
  } finally {
    rendered.unmount();
    for (const url of [plain, derived]) forgetTileSource(url);
    resetInvokeAdapterForTests();
    vi.unstubAllGlobals();
  }
});
