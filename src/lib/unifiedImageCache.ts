import { createImageCacheKey, type ImageCacheIdentity } from '../domain/cache';
import { createSemaphore, type Semaphore } from './concurrency';

export interface CachedImageData {
  bytes: Uint8Array;
  mime: string;
}

export interface ImageCacheRepository {
  read(identity: ImageCacheIdentity): Promise<CachedImageData | null>;
  fetch(identity: ImageCacheIdentity, signal?: AbortSignal): Promise<CachedImageData>;
  store(identity: ImageCacheIdentity, data: CachedImageData): Promise<void>;
}

export interface ImageHandle {
  key: string;
  url: string;
  bytes: number;
}

export interface UnifiedImageCacheOptions {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  maxBytes: number;
  maxEntries?: number;
  /** How many repository fetches may be in flight at once. */
  maxConcurrentFetches?: number;
}

interface MemoryEntry extends ImageHandle {
  identity: ImageCacheIdentity;
  refs: number;
  lastUsed: number;
}

interface PendingEntry {
  promise: Promise<CachedImageData>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export class UnifiedImageCache {
  private readonly fetchGate: Semaphore;

  constructor(
    private readonly repository: ImageCacheRepository,
    private readonly options: UnifiedImageCacheOptions,
  ) {
    this.fetchGate = createSemaphore(options.maxConcurrentFetches ?? 4);
  }

  private readonly memory = new Map<string, MemoryEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private memoryBytes = 0;

  async load(identity: ImageCacheIdentity, options: { signal?: AbortSignal } = {}): Promise<ImageHandle> {
    const key = createImageCacheKey(identity);
    // Check the signal before the memory fast path: a consumer that already
    // aborted never receives the handle, so it can never release the extra
    // reference and the entry would be pinned in memory for good.
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const existing = this.memory.get(key);
    if (existing) {
      existing.refs += 1;
      existing.lastUsed = Date.now();
      return { key, url: existing.url, bytes: existing.bytes };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = { promise: Promise.resolve(null as never), controller, consumers: 0, settled: false };
      pending.promise = this.readOrFetch(identity, controller.signal);
      this.pending.set(key, pending);
      const entry = pending;
      void pending.promise.then(() => {
        entry.settled = true;
        if (this.pending.get(key) === entry) this.pending.delete(key);
      }, () => {
        entry.settled = true;
        if (this.pending.get(key) === entry) this.pending.delete(key);
      });
    }

    pending.consumers += 1;
    const data = await this.forConsumer<CachedImageData>(key, pending, options.signal);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const cached = this.memory.get(key);
    if (cached) {
      cached.refs += 1;
      cached.lastUsed = Date.now();
      return { key, url: cached.url, bytes: cached.bytes };
    }
    const blob = new Blob([Uint8Array.from(data.bytes).buffer], { type: data.mime || 'application/octet-stream' });
    const url = this.options.createObjectURL(blob);
    const entry: MemoryEntry = { key, identity, url, bytes: data.bytes.byteLength, refs: 1, lastUsed: Date.now() };
    this.memory.set(key, entry);
    this.memoryBytes += entry.bytes;
    this.evictMemory();
    return { key, url, bytes: entry.bytes };
  }

  release(handle: ImageHandle): void {
    const entry = this.memory.get(handle.key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsed = Date.now();
    if (entry.refs === 0) {
      this.memory.delete(entry.key);
      this.memoryBytes -= entry.bytes;
      this.options.revokeObjectURL(entry.url);
      return;
    }
    this.evictMemory();
  }

  inFlightCount(): number {
    return this.pending.size;
  }

  private async readOrFetch(identity: ImageCacheIdentity, signal: AbortSignal): Promise<CachedImageData> {
    const cached = await this.repository.read(identity);
    if (cached && cached.bytes.byteLength > 0) return cached;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const fetched = await this.fetchGate.run(() => this.repository.fetch(identity, signal));
    if (fetched.bytes.byteLength === 0) throw new Error('Image response was empty');
    await this.repository.store(identity, fetched);
    return fetched;
  }

  private forConsumer<T>(key: string, entry: PendingEntry, signal?: AbortSignal): Promise<T> {
    const finish = () => {
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers === 0 && !entry.settled) {
        if (this.pending.get(key) === entry) this.pending.delete(key);
        entry.controller.abort();
      }
    };
    if (!signal) return entry.promise.finally(finish) as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const complete = () => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        finish();
      };
      const abort = () => { complete(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      entry.promise.then((value) => { complete(); resolve(value as T); }, (error) => { complete(); reject(error); });
    });
  }

  private evictMemory(): void {
    const maxBytes = Math.max(1, this.options.maxBytes);
    const maxEntries = Math.max(1, this.options.maxEntries ?? 128);
    while (this.memoryBytes > maxBytes || this.memory.size > maxEntries) {
      const candidate = Array.from(this.memory.values())
        .filter((entry) => entry.refs === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!candidate) break;
      this.memory.delete(candidate.key);
      this.memoryBytes -= candidate.bytes;
      this.options.revokeObjectURL(candidate.url);
    }
  }
}
