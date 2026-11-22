import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import type { ZoomState } from '../domain/reader';
import { invokeCommand } from '../bridge/invoke';
import { oversizedTileCandidate } from './readerTileDimensions';
import { createContext, createElement, useContext, useEffect, useRef } from 'react';

type Bridge = { postMessage(message: string): void };
type ReaderWindow = Window & { YomikaTiles?: Bridge; __yomikaNativeReaderPreview?: boolean; __yomikaNativePinchInput?: boolean; __yomikaNativeWheelZoom?: boolean; __yomikaNativeContinuousInput?: "touch" | "wheel" };
function androidBridge(): Bridge | undefined { return (window as ReaderWindow).YomikaTiles; }
export function readerUsesShellGestures(): boolean {
  return typeof window !== 'undefined' && (window as ReaderWindow).__yomikaNativeReaderPreview === true;
}
export function hasNativePinchInput(): boolean {
  return typeof window !== 'undefined' && (window as ReaderWindow).__yomikaNativePinchInput === true;
}

export type WheelZoomSample = [x: number, y: number, delta: number, snapToFit: 0 | 1];
export function hasNativeWheelZoom(): boolean {
  return (window as ReaderWindow).__yomikaNativeWheelZoom === true;
}
export async function sampleNativeWheelZoom(session: number, page: number, maximum: number, samples: WheelZoomSample[]): Promise<ZoomState | undefined> {
  // A page turn can enqueue the new page's fit transform before the first
  // pinch sample. Apply that transform first so it cannot erase the pinch.
  while (transforming) await transforming;
  const result = await invoke<[number, number, number] | null>('reader_native_wheel_zoom', {
    session, page, pixelRatio: window.devicePixelRatio || 1, maximum, samples,
  }).catch(() => null);
  if (result) {
    const [scale, panX, panY] = result;
    return { scale, panX, panY };
  }
}

let pinchConfiguration = Promise.resolve<unknown>(undefined);
export function configureNativePinchInput(session: number, page: number, enabled: boolean, maximum: number, reduceMotion: boolean, left?: number, right?: number, exitLeft?: boolean): Promise<boolean> {
  if (!hasNativePinchInput()) return Promise.resolve(false);
  const result = pinchConfiguration.then(() => invoke('reader_native_pinch_input', { session, page, enabled, maximum, reduceMotion, ...(left && { left }), ...(right && { right }), ...(exitLeft !== undefined && { exitLeft }) }));
  pinchConfiguration = result.catch(() => undefined);
  return result.then(() => true, () => false);
}

const pendingUnpresent = new Map<number, () => void>();
const nativePreviewBridge: Bridge = {
  postMessage(message) {
    const { op, id } = JSON.parse(message) as { op: string; id: number };
    pendingUnpresent.get(id)?.();
    if (op === 'drop-after-web-frame' || op === 'unpresent') {
      // The next native slot or the decoded DOM fallback can paint before the
      // outgoing underlay is erased. The timeout covers a suspended compositor.
      let pending = true;
      const cancel = () => {
        pending = false;
        window.clearTimeout(timeout);
        if (op === 'unpresent') pendingUnpresent.delete(id);
      };
      const retire = () => {
        if (!pending) return;
        cancel();
        void invoke('reader_native_slot_message', { op: op === 'unpresent' ? op : 'drop', slot: id }).catch(() => undefined);
      };
      const timeout = window.setTimeout(retire, 96);
      if (op === 'unpresent') pendingUnpresent.set(id, cancel);
      window.requestAnimationFrame(() => { if (pending) window.requestAnimationFrame(retire); });
    } else if (op === 'present' || op === 'drop' || op === 'continuous-hide' || op === 'arm' || op === 'disarm') {
      void invoke('reader_native_slot_message', { op, slot: id }).catch(() => undefined);
    }
  },
};
function bridge(): Bridge | undefined {
  return androidBridge() ?? (readerUsesShellGestures() ? nativePreviewBridge : undefined);
}

// Send at most one transform at a time. A burst of wheel events cannot queue
// hundreds of old zoom samples ahead of the next page presentation.
export const NativeReaderSession = createContext(0);
let nextSession = 0;
export function allocateNativeReaderSession(): number { return ++nextSession; }

type PreviewTransform = ZoomState & { session: number; page: number; pixelRatio: number; edgeOffset: number; neighbourPage?: number | undefined };
let previewTransform: PreviewTransform | undefined;
type SlideTransition = { from: number; durationMs: number; boundary?: boolean; zoomFrom?: ZoomState };
let latestTransform: { transform: PreviewTransform; transition?: SlideTransition } | undefined;
let transforming: Promise<void> | undefined;
export function updateNativeReaderTransform(page: number, zoom: ZoomState, session = 0, zoomFrom?: ZoomState): void {
  if (!readerUsesShellGestures()) return;
  const previous = previewTransform;
  const samePage = previous?.page === page && previous.session === session;
  sendPreviewTransform({
    ...zoom, session, page, pixelRatio: window.devicePixelRatio || 1,
    edgeOffset: samePage ? previous.edgeOffset : 0,
    neighbourPage: samePage ? previous.neighbourPage : undefined,
  }, zoomFrom ? { from: samePage ? previous.edgeOffset : 0, durationMs: 140, zoomFrom } : undefined);
}

function sendPreviewTransform(transform: PreviewTransform, transition?: SlideTransition): void {
  previewTransform = transform;
  latestTransform = transition ? { transform, transition } : { transform };
  if (transforming) return;
  transforming = (async () => {
    try {
      while (latestTransform) {
        const request = latestTransform;
        latestTransform = undefined;
        await invoke('reader_native_view_transform', request).catch(() => undefined);
      }
    } finally {
      transforming = undefined;
    }
  })();
}

type ContinuousScrollState = { session: number; revision: number; sample: number };
const continuousScrollStates = new WeakMap<HTMLElement, ContinuousScrollState & { capturing: boolean }>();
const nativeScrollEvent = 'yomika-reader-continuous-scroll';
let continuousInputQueue = Promise.resolve<unknown>(undefined);
function sendContinuousInput(args: Record<string, unknown>): void {
  continuousInputQueue = continuousInputQueue.then(() => invoke('reader_native_continuous_input', args)).catch(() => undefined);
}

export function trackNativeContinuousInput(scroller: HTMLElement, session: number, onScroll: (offset: number) => void): (() => void) | undefined {
  const host = androidBridge();
  const mode = (window as ReaderWindow).__yomikaNativeContinuousInput;
  if (!host && !mode) return;
  const state = { session, revision: 0, sample: 0, capturing: false };
  let wheelFrame = 0;
  let delta = 0;
  let wheelRevision = 0;
  const onWheel = (event: WheelEvent) => {
    if (!state.capturing || !event.cancelable || event.ctrlKey || event.shiftKey
      || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (wheelRevision !== state.revision) {
      delta = 0;
      wheelRevision = state.revision;
    }
    delta += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
    if (wheelFrame) return;
    wheelFrame = window.requestAnimationFrame(() => {
      wheelFrame = 0;
      if (state.capturing && wheelRevision === state.revision && delta) {
        sendContinuousInput({ session, revision: wheelRevision, offset: delta, wheel: true });
      }
      delta = 0;
    });
  };
  if (mode === 'wheel') scroller.addEventListener('wheel', onWheel, { passive: false });
  continuousScrollStates.set(scroller, state);
  const mirror = (event: Event) => {
    const detail = (event as CustomEvent<ContinuousScrollState & { offset: number }>).detail;
    if (detail.session !== session || detail.revision !== state.revision || detail.sample < state.sample || !Number.isFinite(detail.offset)) return;
    state.sample = detail.sample;
    const offset = detail.offset / (host ? window.devicePixelRatio || 1 : 1);
    if (scroller.scrollTop !== offset) scroller.scrollTop = offset;
    onScroll(scroller.scrollTop);
  };
  window.addEventListener(nativeScrollEvent, mirror);
  return () => {
    window.removeEventListener(nativeScrollEvent, mirror);
    if (mode === 'wheel') scroller.removeEventListener('wheel', onWheel);
    if (wheelFrame) window.cancelAnimationFrame(wheelFrame);
    if (host) host.postMessage(JSON.stringify({ op: 'continuous-input', id: 0, session, active: false }));
    else sendContinuousInput({ session, active: false, offset: scroller.scrollTop });
    delete scroller.dataset.nativeTouchScroll;
    continuousScrollStates.delete(scroller);
  };
}

export function configureNativeContinuousInput(scroller: HTMLElement, active: boolean, totalHeight: number, reduceMotion: boolean): void {
  const state = continuousScrollStates.get(scroller);
  if (!state) return;
  const host = androidBridge();
  if (!host) {
    const limit = Math.max(0, totalHeight - scroller.clientHeight);
    const capturing = active && limit > 0;
    state.capturing = capturing;
    if (capturing && (window as ReaderWindow).__yomikaNativeContinuousInput === 'touch') scroller.dataset.nativeTouchScroll = 'true';
    else delete scroller.dataset.nativeTouchScroll;
    sendContinuousInput({ session: state.session, active: capturing, limit, offset: scroller.scrollTop, reduceMotion });
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  host.postMessage(JSON.stringify({
    op: 'continuous-input', id: 0, session: state.session, active, reduceMotion,
    limit: Math.max(0, Math.round((totalHeight - scroller.clientHeight) * ratio)), scrollTop: Math.round(scroller.scrollTop * ratio),
  }));
}

export function repositionNativeContinuousInput(scroller: HTMLElement, offset: number, relative = false): void {
  const state = continuousScrollStates.get(scroller);
  if (!state) return;
  state.revision += 1;
  const host = androidBridge();
  if (!host) {
    sendContinuousInput({ session: state.session, revision: state.revision, offset, relative });
    return;
  }
  host.postMessage(JSON.stringify({
    op: 'continuous-reposition', id: 0, session: state.session, revision: state.revision,
    offset: Math.round(offset * (window.devicePixelRatio || 1)), relative,
  }));
}

type ContinuousAnchor = { element: HTMLElement };
const continuousAnchors = new Map<number, ContinuousAnchor>();
let continuousFrame = 0;
let continuousObserver: ResizeObserver | undefined;
let continuousSending = false;
type ContinuousSnapshot = { placements?: { slot: number; rect: number[] }[]; pixelRatio: number; scrollTop: number; viewportHeight: number; scrollInput?: ContinuousScrollState };
let continuousLatest: ContinuousSnapshot | undefined;
let continuousGeometryDirty = true;

export function invalidateContinuousReaderLayout(): void {
  continuousGeometryDirty = true;
  if (continuousAnchors.size) scheduleContinuousLayout();
}

function sendContinuousSnapshot(snapshot: NonNullable<typeof continuousLatest>): void {
  const placements = snapshot.placements ?? continuousLatest?.placements;
  continuousLatest = placements ? { ...snapshot, placements } : snapshot;
  if (continuousSending) return;
  continuousSending = true;
  void (async () => {
    try {
      while (continuousLatest) {
        const next = continuousLatest;
        continuousLatest = undefined;
        await invoke('reader_native_continuous_layout', next).catch(() => { continuousGeometryDirty = true; });
      }
    } finally {
      continuousSending = false;
    }
  })();
}

function scheduleContinuousLayout(): void {
  if (continuousFrame) return;
  continuousFrame = window.requestAnimationFrame(() => {
    continuousFrame = 0;
    const ratio = window.devicePixelRatio || 1;
    const height = window.innerHeight;
    const scroller = continuousAnchors.values().next().value?.element.closest('.reader-webtoon');
    const scrollTop = scroller?.scrollTop ?? 0;
    const android = androidBridge();
    const placements: NonNullable<ContinuousSnapshot['placements']> = [];
    if (continuousGeometryDirty) for (const [id, anchor] of continuousAnchors) {
      const box = anchor.element.getBoundingClientRect();
      const width = Math.min(box.width, 900);
      if (width > 0 && box.height > 0 && placements.length < 48) {
        placements.push({ slot: id, rect: [box.left + (box.width - width) / 2, box.top + scrollTop, width, box.height] });
      }
    }
    const dirty = continuousGeometryDirty;
    continuousGeometryDirty = false;
    const input = scroller instanceof HTMLElement ? continuousScrollStates.get(scroller) : undefined;
    if (android) {
      const entries = dirty ? placements.map(({ slot, rect }) => ({ id: slot, rect: rect.map(value => Math.round(value * ratio)) })) : undefined;
      android.postMessage(JSON.stringify({ op: 'continuous-layout', id: 0, entries, scrollTop: Math.round(scrollTop * ratio), ...(input ? { session: input.session, revision: input.revision, sample: input.sample } : {}) }));
    } else if (readerUsesShellGestures()) {
      sendContinuousSnapshot({ ...(dirty ? { placements } : {}), scrollTop, viewportHeight: height, pixelRatio: ratio, ...(input ? { scrollInput: { session: input.session, revision: input.revision, sample: input.sample } } : {}) });
    }
  });
}

function trackContinuousPage(id: number, element: HTMLElement): () => void {
  if (!continuousAnchors.size) {
    window.addEventListener('scroll', scheduleContinuousLayout, { capture: true, passive: true });
    window.addEventListener('resize', invalidateContinuousReaderLayout);
    if (typeof ResizeObserver !== 'undefined') continuousObserver = new ResizeObserver(invalidateContinuousReaderLayout);
  }
  continuousAnchors.set(id, { element });
  continuousObserver?.observe(element);
  invalidateContinuousReaderLayout();
  return () => {
    continuousAnchors.delete(id);
    if (![...continuousAnchors.values()].some(anchor => anchor.element === element)) continuousObserver?.unobserve(element);
    if (continuousAnchors.size) {
      invalidateContinuousReaderLayout();
      return;
    }
    window.removeEventListener('scroll', scheduleContinuousLayout, true);
    window.removeEventListener('resize', invalidateContinuousReaderLayout);
    continuousObserver?.disconnect();
    continuousObserver = undefined;
    if (continuousFrame) window.cancelAnimationFrame(continuousFrame);
    continuousFrame = 0;
    continuousGeometryDirty = true;
    const android = androidBridge();
    if (android) {
      android.postMessage(JSON.stringify({ op: 'continuous-layout', id: 0, entries: [], scrollTop: 0 }));
    } else if (readerUsesShellGestures()) {
      sendContinuousSnapshot({ placements: [], scrollTop: 0, viewportHeight: window.innerHeight, pixelRatio: window.devicePixelRatio || 1 });
    }
  };
}

export function hasNativeReaderTiles(): boolean {
  return typeof window !== 'undefined' && Boolean(bridge());
}
type TileSource = Blob | string | { contentHash: string; leaseId: string; decodedBytes?: number };
export function canDecodeReaderLease(mime: string, decodedBytes: number): boolean {
  return hasNativeReaderTiles() && decodedBytes > 0 &&
    (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp');
}
const sources = new Map<string, TileSource>();
export function rememberTileSource(url: string, source: TileSource, bytes?: Uint8Array) {
  if (typeof window !== 'undefined' && bridge() && (!bytes || oversizedTileCandidate(bytes))) sources.set(url, source);
}
export function hasAndroidReaderTileSource(url: string): boolean {
  return Boolean(androidBridge() && sources.has(url));
}
export function canPresentNativePage(url: string): boolean {
  const source = sources.get(url);
  return typeof source === 'object' && 'leaseId' in source && (source.decodedBytes ?? 0) > 0;
}

export function requestNativeReaderDoubleTap(page: number, x: number, y: number, reduceMotion: boolean, session: number): boolean {
  const host = androidBridge();
  if (!host || !window.innerWidth || !window.innerHeight) return false;
  host.postMessage(JSON.stringify({ op: 'double-tap', id: 0, page, session, x: x / window.innerWidth, y: y / window.innerHeight, reduceMotion }));
  return true;
}

export function settleNativeReaderFitForTurn(page: number, session: number, reduceMotion: boolean): void {
  androidBridge()?.postMessage(JSON.stringify({ op: 'fit-for-turn', id: 0, page, session, reduceMotion }));
}

export function updateNativeReaderSlide(page: number, neighbourPage: number | undefined, offset: number, session: number, transition?: SlideTransition): void {
  if (!readerUsesShellGestures()) return;
  const previous = previewTransform;
  const zoom = !transition?.zoomFrom && previous?.page === page && previous.session === session
    ? previous : { scale: 1, panX: 0, panY: 0 };
  sendPreviewTransform({ ...zoom, page, session, pixelRatio: window.devicePixelRatio || 1,
    edgeOffset: offset, neighbourPage }, transition);
}

export function updateNativeReaderEdge(page: number, offset: number, duration = 0, session = 0): void {
  const host = androidBridge();
  if (host) {
    host.postMessage(JSON.stringify({ op: 'edge-drag', id: 0, page, session, offset, duration }));
    return;
  }
  if (!readerUsesShellGestures()) return;
  const base = previewTransform?.page === page && previewTransform.session === session ? previewTransform : {
    session, page, scale: 1, panX: 0, panY: 0, pixelRatio: window.devicePixelRatio || 1, edgeOffset: 0,
  };
  const transition = duration > 0 && base.edgeOffset !== offset
    ? { from: base.edgeOffset, durationMs: duration, boundary: true }
    : undefined;
  sendPreviewTransform({ ...base, edgeOffset: offset, neighbourPage: undefined }, transition);
}

export interface ReaderTileViewport { scale: number; x: number; y: number }

export function requestNativeReaderViewport(page: number, session: number, onViewport: (viewport?: ReaderTileViewport) => void): () => void {
  const host = androidBridge();
  if (!host) { onViewport(); return () => {}; }
  const id = ++nextId;
  const cleanup = () => {
    window.removeEventListener('yomika-reader-tile-viewport', receive);
    window.clearTimeout(timeout);
  };
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<{ id: number; viewport?: ReaderTileViewport }>).detail;
    if (detail.id !== id) return;
    cleanup();
    onViewport(detail.viewport);
  };
  const timeout = window.setTimeout(() => { cleanup(); onViewport(); }, 6000);
  window.addEventListener('yomika-reader-tile-viewport', receive);
  host.postMessage(JSON.stringify({ op: 'viewport', id, page, session }));
  return cleanup;
}

export function forgetTileSource(url: string) { sources.delete(url); }
export type ReaderTilePageSize = { naturalWidth: number; naturalHeight: number };

interface TileSlotProps {
  url: string;
  spread?: { rightUrl: string; aspect: number };
  index: number;
  current: boolean;
  present?: boolean;
  replacement?: boolean;
  continuous?: boolean;
  readViewport?: (() => ReaderTileViewport | undefined) | undefined;
  retireAfterWebFrame?: (url: string) => boolean;
  onPresented?: () => void;
  turnTargets?: { left: number; right: number; reduceMotion: boolean } | undefined;
  committed?: boolean;
  nativeOnly?: boolean;
  onReady?: (width: number, height: number, pages?: ReaderTilePageSize[]) => void;
  onError?: () => void;
}

export function ReaderTileSlot({ url, spread, index, current, present, replacement, continuous, retireAfterWebFrame, nativeOnly, committed, turnTargets, readViewport, onReady, onPresented, onError }: TileSlotProps) {
  const slot = useRef(0);
  const continuousAnchor = useRef<HTMLSpanElement>(null);
  const session = useContext(NativeReaderSession);
  const rightUrl = spread?.rightUrl;
  const aspect = spread?.aspect;
  const callbacks = useRef({ onReady, onPresented, onError, readViewport });
  callbacks.current = { onReady, onPresented, onError, readViewport };
  const committedRef = useRef(committed);
  committedRef.current = committed;
  const replacementRef = useRef(replacement);
  replacementRef.current = replacement;
  useEffect(() => {
    const host = bridge();
    const source = sources.get(url);
    const right = rightUrl ? sources.get(rightUrl) : undefined;
    if (!host || !source) return;
    if (rightUrl && !(right && typeof right === 'object' && 'leaseId' in right)) {
      callbacks.current.onError?.();
      return;
    }
    const id = ++nextId;
    slot.current = id;
    const status = (event: Event) => {
      const detail = (event as CustomEvent<{ slot: number; width: number; height: number; pages?: ReaderTilePageSize[] }>).detail;
      if (detail.slot !== id) return;
      if (detail.width && detail.height) callbacks.current.onReady?.(detail.width, detail.height, detail.pages);
      else callbacks.current.onError?.();
    };
    if (nativeOnly) window.addEventListener('yomika-reader-tile-status', status);
    const prepare = (hash: string) => host.postMessage(JSON.stringify({ op: 'prepare', id, hash, page: index + 1, session }));
    let worker: Worker | undefined;
    let retirement: "drop" | "drop-after-web-frame" = "drop";
    if (typeof source === 'string') prepare(source);
    else if ('leaseId' in source) {
      void invokeCommand('reader_prepare_native_slot', { leaseId: source.leaseId, rightLeaseId: right && typeof right === 'object' && 'leaseId' in right ? right.leaseId : undefined, aspect, session, slot: id, page: index + 1, committed: committedRef.current === true }, z.boolean()).then(result => {
        if (slot.current !== id) {
          host.postMessage(JSON.stringify({op: retirement, id}));
        } else if (!result.ok || !result.value) {
          if (nativeOnly) callbacks.current.onError?.();
          else prepare(source.contentHash);
        }
      });
    } else {
      worker = new Worker(new URL('./readerTileHash.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({data}) => { if (data && slot.current === id) prepare(data); worker?.terminate(); };
      worker.postMessage({ blob: source });
    }
    return () => {
      window.removeEventListener('yomika-reader-tile-status', status);
      worker?.terminate();
      slot.current = 0;
      retirement = retireAfterWebFrame?.(url) ? 'drop-after-web-frame' : 'drop';
      host.postMessage(JSON.stringify({ op: retirement, id }));
    };
  }, [url, rightUrl, aspect, index, session, nativeOnly, retireAfterWebFrame]);
  useEffect(() => {
    const id = slot.current;
    if (!id || !committed) return;
    bridge()?.postMessage(JSON.stringify({op: 'arm', id, page: index + 1, session}));
    return () => bridge()?.postMessage(JSON.stringify({op: 'disarm', id, page: index + 1, session}));
  }, [url, rightUrl, aspect, index, session, committed, nativeOnly]);
  useEffect(() => {
    const id = slot.current;
    if (!id || !present) return;
    const presented = (event: Event) => {
      if ((event as CustomEvent<{ slot: number }>).detail.slot === id) callbacks.current.onPresented?.();
    };
    window.addEventListener('yomika-reader-tile-presented', presented);
    const anchor = continuous ? continuousAnchor.current : null;
    const slotElement = anchor?.closest<HTMLElement>('.reader-webtoon-slot');
    const untrack = slotElement ? trackContinuousPage(id, slotElement) : undefined;
    if (!slotElement) {
      bridge()?.postMessage(JSON.stringify({op: 'present', id, replacement: replacementRef.current || undefined, viewport: callbacks.current.readViewport?.()}));
    }
    return () => {
      window.removeEventListener('yomika-reader-tile-presented', presented);
      untrack?.();
      if (slot.current === id) bridge()?.postMessage(JSON.stringify({op: slotElement ? 'continuous-hide' : 'unpresent', id}));
    };
  }, [url, rightUrl, aspect, index, session, present, nativeOnly, continuous]);
  useEffect(() => {
    const id = slot.current;
    if (!id || !current) return;
    bridge()?.postMessage(JSON.stringify(turnTargets ? {op: 'select', id, ...turnTargets} : {op: 'select', id}));
  }, [url, rightUrl, aspect, index, session, current, nativeOnly, turnTargets?.left, turnTargets?.right, turnTargets?.reduceMotion]);
  useEffect(() => {
    const id = slot.current;
    if (!id || !current) return;
    return () => bridge()?.postMessage(JSON.stringify({op:'deselect', id}));
  }, [url, rightUrl, aspect, index, session, current, nativeOnly]);
  return continuous ? createElement('span', { ref: continuousAnchor, hidden: true }) : null;
}
let nextId = 0;
