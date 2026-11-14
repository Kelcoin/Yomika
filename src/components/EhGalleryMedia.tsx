import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, RotateCw } from 'lucide-react';
import { NativeEhRepository, type EhGallery } from '../repositories/nativeEhRepository';
import { err, type CommandResult } from '../domain/result';
import { DetailPageThumbnail } from './DetailPageThumbnail';

// Hot images survive closing a gallery; the native layer retains the disk copy.
const hotImages = new Map<string, string>();
let hotBytes = 0;
let hotEpoch = 0;
export function clearGalleryImageMemoryCache() { hotImages.clear(); hotBytes = 0; hotEpoch++; }
function rememberImage(key: string, value: string) {
  hotBytes -= hotImages.get(key)?.length ?? 0;
  hotImages.delete(key);
  hotImages.set(key, value);
  hotBytes += value.length;
  while (hotBytes > 12 * 1024 * 1024 && hotImages.size) {
    const oldest = hotImages.keys().next().value!;
    hotBytes -= hotImages.get(oldest)!.length;
    hotImages.delete(oldest);
  }
}

function thumbnailIndex(items: Iterable<EhGallery['thumbnails'][number]>) {
  const pages = new Map(Array.from(items, item => [item.page, item]));
  const seen = new Set<string>();
  const sprites = new Set<string>();
  for (const item of pages.values()) {
    if (seen.has(item.url) || item.offset !== 0) sprites.add(item.url);
    seen.add(item.url);
  }
  return { items: pages, sprites };
}

/** Server batches stay an implementation detail. A visible virtual range can
 * jump straight to its batch, without fetching every intervening gallery page. */
export function useGalleryThumbnails(gallery: EhGallery | undefined, accountId: string, galleryId: string, token: string) {
  const base = gallery?.thumbnails;
  const count = gallery?.pageCount ?? 0;
  const batches = gallery?.thumbnailPageCount ?? 0;
  const seed = useMemo(() => thumbnailIndex(base ?? []), [base]);
  const [state, setState] = useState({ source: base, ...seed, error: undefined as string | undefined });
  const range = useRef({ start: 0, end: 0 });
  const control = useRef<{ request: () => void; retry: () => void }>();
  const loadRange = useCallback((start: number, end: number) => { range.current = { start, end }; control.current?.request(); }, []);
  const retry = useCallback(() => control.current?.retry(), []);
  useEffect(() => {
    if (!base?.length) return;
    let alive = true;
    let running = false;
    let error: string | undefined;
    const items = new Map(seed.items);
    const loaded = new Set([0]);
    const failed = new Set<number>();
    const batchSize = base.length;
    const repository = new NativeEhRepository();
    const publish = () => setState({ source: base, ...thumbnailIndex(items.values()), error });
    const request = () => {
      if (!alive || running) return;
      const first = Math.floor(range.current.start / batchSize);
      const last = Math.min(batches - 1, Math.floor((Math.min(count, range.current.end) - 1) / batchSize));
      let next = first;
      while (next <= last && (loaded.has(next) || failed.has(next))) next++;
      if (next > last) return;
      running = true;
      void repository.getGallery(accountId, galleryId, token, next).then(result => {
        if (!alive) return;
        if (result.ok && result.value.thumbnails.length > 0) {
          loaded.add(next);
          for (const thumbnail of result.value.thumbnails) items.set(thumbnail.page, thumbnail);
        } else {
          failed.add(next);
          error = result.ok ? '此批缩略图暂不可用' : result.error.message;
        }
        publish();
      }).finally(() => { running = false; request(); });
    };
    control.current = { request, retry: () => { failed.clear(); error = undefined; publish(); request(); } };
    publish();
    request();
    return () => { alive = false; control.current = undefined; };
  }, [base, seed, accountId, galleryId, token, count, batches]);
  return { ...(state.source === base ? state : { ...seed, error: undefined }), loadRange, retry };
}

/** One gallery owns its queue: shared sprite URLs transfer once, only three
 * images transfer concurrently, and leaving the gallery drops queued work. */
export function createGalleryImageLoader(accountId: string) {
  const repository = new NativeEhRepository();
  const cache = new Map<string, Promise<CommandResult<string>>>();
  const queue: Array<() => void> = [];
  let running = 0;
  let disposed = false;
  let cachedBytes = 0;
  let cacheEpoch = hotEpoch;
  let disposal: ReturnType<typeof setTimeout> | undefined;
  return {
    peek(url: string) { return hotImages.get(`${accountId}\0${url}`); },
    activate() { clearTimeout(disposal); },
    dispose() { disposal = setTimeout(() => { disposed = true; cache.clear(); for (const start of queue.splice(0)) start(); }, 0); },
    load(url: string): Promise<CommandResult<string>> {
      if (cacheEpoch !== hotEpoch) { cache.clear(); cachedBytes = 0; cacheEpoch = hotEpoch; }
      if (url.startsWith('data:image/')) return Promise.resolve({ ok: true, value: url });
      const hot = hotImages.get(`${accountId}\0${url}`);
      if (hot) { rememberImage(`${accountId}\0${url}`, hot); return Promise.resolve({ ok: true, value: hot }); }
      const existing = cache.get(url);
      if (existing) return existing;
      const promise = new Promise<CommandResult<string>>(resolve => {
        const start = () => {
          if (disposed) { resolve(err('EH_UNAVAILABLE', '已离开画廊', false)); return; }
          running++;
          const requestEpoch = hotEpoch;
          void repository.getGalleryImage(accountId, url).then(result => {
            if (!result.ok) { if (requestEpoch === hotEpoch) cache.delete(url); }
            else if (requestEpoch === hotEpoch) {
              rememberImage(`${accountId}\0${url}`, result.value);
              cachedBytes += result.value.length;
              if (cachedBytes > 12 * 1024 * 1024) { cache.clear(); cachedBytes = result.value.length; }
            }
            resolve(result);
          }).finally(() => { running--; queue.shift()?.(); });
        };
        if (running < 3) start(); else queue.push(start);
      });
      cache.set(url, promise);
      return promise;
    },
  };
}

export type GalleryImageLoader = ReturnType<typeof createGalleryImageLoader>;

export function useGalleryImage(url: string | null | undefined, loader: GalleryImageLoader, enabled = true) {
  const [result, setResult] = useState<{ url: string; value?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!url || !enabled) return;
    let alive = true;
    const hot = loader.peek(url);
    if (hot) { setResult({ url, value: hot }); return; }
    setResult(undefined);
    void loader.load(url).then(response => {
      if (alive) setResult(response.ok ? { url, value: response.value } : { url, error: response.error.message });
    });
    return () => { alive = false; };
  }, [url, loader, enabled, retry]);
  return { image: result?.url === url ? result?.value : url ? loader.peek(url) : undefined, error: result?.url === url ? result?.error : undefined, retry: () => setRetry(value => value + 1) };
}

export function EhGalleryThumbnail({ thumbnail, loader, sprite = false }: { thumbnail: EhGallery['thumbnails'][number]; loader: GalleryImageLoader; sprite?: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const { image, error, retry } = useGalleryImage(thumbnail.url, loader, visible);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <DetailPageThumbnail page={thumbnail.page} mediaRef={node => { ref.current = node; }} loading={!image && !error}>
    {image && (sprite
      ? <ThumbnailSprite image={image} thumbnail={thumbnail} />
      : <img src={image} alt={`第 ${thumbnail.page} 页缩略图`} decoding="async" />)}
    {error && <button type="button" className="reader-icon-button" aria-label={`重试第 ${thumbnail.page} 页缩略图`} onClick={retry}><ImageOff /><RotateCw /></button>}
  </DetailPageThumbnail>;
}

function ThumbnailSprite({ image, thumbnail }: { image: string; thumbnail: EhGallery['thumbnails'][number] }) {
  // Crop the original sprite coordinate system first, then fill the same 3:4
  // frame as ordinary thumbnails. Stretching the whole sprite caused gaps.
  const fill = Math.max(1, (3 / 4) / (thumbnail.width / thumbnail.height));
  return <span className="eh-thumbnail-sprite" style={{ aspectRatio: `${thumbnail.width} / ${thumbnail.height}`, width: `${fill * thumbnail.width / thumbnail.height / (3 / 4) * 100}%`, height: 'auto' }}>
    <img src={image} alt={`第 ${thumbnail.page} 页缩略图`} decoding="async" style={{ left: `${thumbnail.offset / thumbnail.width * 100}%` }} />
  </span>;
}
