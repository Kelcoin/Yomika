import { createImageCacheKey, type ImageCacheIdentity } from '../domain/cache';
import { createSemaphore, type Semaphore } from './concurrency';

export interface CachedImageData {
  /** 图片字节。类型写成 `ArrayBuffer` 而不是 `ArrayBufferLike`：这些字节一定来自真的
   * ArrayBuffer（IPC 回包 / Rust 的 `Vec<u8>`），而 `Blob` 只接受真的 ArrayBuffer——
   * 以前这里靠 `Uint8Array.from(...).buffer` 绕过类型检查，代价是每张图在主线程上白拷
   * 一份（一页 1.5MB 的 JPEG 就是 1.5MB，预览窗口一次三页）。 */
  bytes: Uint8Array<ArrayBuffer>;
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
  refs: number;
}

interface PendingEntry {
  promise: Promise<CachedImageData>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export class UnifiedImageCache {
  private fetchGate: Semaphore;

  constructor(
    private readonly repository: ImageCacheRepository,
    private readonly options: UnifiedImageCacheOptions,
  ) {
    this.fetchGate = createSemaphore(options.maxConcurrentFetches ?? 4);
  }

  /** Applied from preferences once they load. */
  setMaxConcurrentFetches(limit: number): void {
    this.fetchGate = createSemaphore(limit);
  }

  private readonly memory = new Map<string, MemoryEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private memoryBytes = 0;

  /** 命中一次：增加引用，并把这一项挪到 LRU 队列的**末尾**。
   *
   * 队列顺序就是 `memory` 这个 Map 的插入顺序——真正的 LRU 靠「先删再插」。以前
   * 每次回收都 `Array.from(...).sort(...)` 扫全表：一次 200 多张图的排序，而阅读器
   * 每翻一页都会触发一次回收。 */
  private touch(entry: MemoryEntry): void {
    entry.refs += 1;
    this.memory.delete(entry.key);
    this.memory.set(entry.key, entry);
  }

  private forget(entry: MemoryEntry): void {
    this.memory.delete(entry.key);
    this.memoryBytes -= entry.bytes;
    this.options.revokeObjectURL(entry.url);
  }

  async load(identity: ImageCacheIdentity, options: { signal?: AbortSignal } = {}): Promise<ImageHandle> {
    const key = createImageCacheKey(identity);
    // Check the signal before the memory fast path: a consumer that already
    // aborted never receives the handle, so it can never release the extra
    // reference and the entry would be pinned in memory for good.
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const existing = this.memory.get(key);
    if (existing) {
      this.touch(existing);
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
      this.touch(cached);
      return { key, url: cached.url, bytes: cached.bytes };
    }
    // 直接把字节交给 Blob：`Uint8Array.from(...).buffer` 在多一份完整拷贝——一页
    // 1.5MB 的 JPEG 就是主线程上白拷 1.5MB，而预览窗口一次来三页。Blob 自己会拷进
    // 它的存储，视图的部分用不上第二份。
    const blob = new Blob([data.bytes], { type: data.mime || 'application/octet-stream' });
    const url = this.options.createObjectURL(blob);
    const entry: MemoryEntry = { key, url, bytes: data.bytes.byteLength, refs: 1 };
    this.memory.set(key, entry);
    this.memoryBytes += entry.bytes;
    this.evictMemory();
    return { key, url, bytes: entry.bytes };
  }

  release(handle: ImageHandle): void {
    const entry = this.memory.get(handle.key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      this.forget(entry);
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

  /** 回收：从 LRU 队列（`memory` 的插入顺序）最前面开始丢，跳过还有引用的。
   *
   * 表里留着的条目**都是**有引用的（释放到 0 引用当场就撤掉了），所以这一步实际是
   * 兜底：超过上限时先丢最久没被碰过的那张，而且永远不动别人手上还拿着的那一张。
   * 顺序由 `touch` 维护，这里不再排序——以前每次回收都要 `Array.from(...).sort(...)`
   * 扫全表，而阅读器每翻一页都会触发一次。 */
  private evictMemory(): void {
    const maxBytes = Math.max(1, this.options.maxBytes);
    const maxEntries = Math.max(1, this.options.maxEntries ?? 128);
    if (this.memoryBytes <= maxBytes && this.memory.size <= maxEntries) return;
    for (const entry of Array.from(this.memory.values())) {
      if (this.memoryBytes <= maxBytes && this.memory.size <= maxEntries) break;
      if (entry.refs > 0) continue;
      this.forget(entry);
    }
  }
}
