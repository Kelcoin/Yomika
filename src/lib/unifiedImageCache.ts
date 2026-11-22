import { canPresentNativePage, rememberTileSource, forgetTileSource } from './readerNativeTiles';
import { createImageCacheKey, type ImageCacheIdentity } from '../domain/cache';
import { createSemaphore, type Semaphore } from './concurrency';

function memoryKey(identity: ImageCacheIdentity): string {
  const key = createImageCacheKey(identity);
  return identity.readerSession === undefined ? key : `${key}:reader:${identity.readerSession}`;
}

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
  /** Encoded payload/Blob length, retained for the existing cache quota. */
  bytes: number;
  /** Known decoded RGBA residency for host-leased images (width * height * 4). */
  estimatedDecodedBytes?: number;
}

export function imageResidentBytes(handle: ImageHandle): number {
  return Math.max(handle.bytes, handle.estimatedDecodedBytes ?? 0);
}

/** The session holds a lease URL. Decoded native surfaces have their own slot
 * and tile limits, and are released independently when a frame leaves view. */
export function readerDerivedRetainedBytes(handle: ImageHandle): number {
  return canPresentNativePage(handle.url) ? handle.bytes : imageResidentBytes(handle);
}

/** 认领来的图：URL 由别处持有，丢掉它的时候要按**它的**规矩还，而不是撤一个本进程的
 * blob URL。
 *
 * 当前唯一的来源是宿主的 compute 租借（`yomika-image://`）：那个 URL 后面有一份文件和
 * 一个 pin（§7.4），该还的是那个 pin。缓存不需要分辨租借还是 blob——把「怎么还」封进
 * `release`，这一层就只需要在**唯一那个出口**（`forget`）上调用它。 */
export interface AdoptedImage {
  url: string;
  bytes: number;
  estimatedDecodedBytes?: number;
  contentHash?: string;
  leaseId?: string;
  release(): void;
}

export interface ImageLoadOptions {
  signal?: AbortSignal;
  /** Evaluated when a slot opens, so reader navigation can promote queued pages. */
  priority?: () => number;
  /** 最后一个消费者放手之后，这张图继续留在内存里（仍受下面的 LRU 预算约束），好让
   * 重新挂载的第一帧就能用 `peek`/`peekUrl` 同步拿到它。
   *
   * 只有封面用它：切页、回到前台时，封面正是「还在原地、却被重新请求一次」的那一张，
   * 而它每次重挂载都要重新走一遍异步取图，就是切换页面时那一下闪烁——先渲染占位块，
   * 等图落地才换成 `<img>`。默认**不**保留：阅读器的整页图一放手就该撤（一页 1.5MB，
   * 会话派生图更多），而且「重绘到 0 引用即撤销」是调用方唯一确定的回收边界。 */
  retain?: boolean;
}

export interface ImageAdoptOptions {
  /** 同 `ImageLoadOptions.retain`：最后一个消费者放手之后仍留在表里。 */
  retain?: boolean;
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
  /** 释放到 0 引用之后是否继续留着（见 `ImageLoadOptions.retain`）。 */
  retain: boolean;
  /** 认领进来的图怎么还（见 `adopt`）。本缓存自己造的 blob 没有这一项。 */
  release?: () => void;
}

interface PendingEntry {
  promise: Promise<CachedImageData>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

export class UnifiedImageCache {
  private fetchGate: Semaphore;
  // Computation may never return. It must not occupy a slot used to fetch the
  // ordinary pages that keep navigation usable while the worker recovers.
  private readonly computeGate = createSemaphore(1);

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
  private readonly invalidated = new Map<string, MemoryEntry>();
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
    forgetTileSource(entry.url);
    if (this.memory.get(entry.key) === entry) this.memory.delete(entry.key);
    this.invalidated.delete(entry.url);
    this.memoryBytes -= entry.bytes;
    // 认领来的条目不是本进程 `createObjectURL` 出来的：该还的是它的 `release`（当前是
    // 宿主那条租借 pin）。对那个 URL 调 `revokeObjectURL` 既是错的，也漏掉了真正要还的
    // 东西——一条还不回去的 pin 会让那份产物在本进程退出前一直不能被回收。
    if (entry.release) entry.release();
    else this.options.revokeObjectURL(entry.url);
  }

  async load(identity: ImageCacheIdentity, options: ImageLoadOptions = {}): Promise<ImageHandle> {
    const key = memoryKey(identity);
    // Check the signal before the memory fast path: a consumer that already
    // aborted never receives the handle, so it can never release the extra
    // reference and the entry would be pinned in memory for good.
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const existing = this.memory.get(key);
    if (existing) {
      if (options.retain) existing.retain = true;
      this.touch(existing);
      return { key, url: existing.url, bytes: existing.bytes, ...(existing.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: existing.estimatedDecodedBytes }) };
    }

    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = { promise: Promise.resolve(null as never), controller, consumers: 0, settled: false };
      pending.promise = this.readOrFetch(identity, controller.signal, options.priority);
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
      if (options.retain) cached.retain = true;
      this.touch(cached);
      return { key, url: cached.url, bytes: cached.bytes, ...(cached.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: cached.estimatedDecodedBytes }) };
    }
    // 直接把字节交给 Blob：`Uint8Array.from(...).buffer` 在多一份完整拷贝——一页
    // 1.5MB 的 JPEG 就是主线程上白拷 1.5MB，而预览窗口一次来三页。Blob 自己会拷进
    // 它的存储，视图的部分用不上第二份。
    const blob = new Blob([data.bytes], { type: data.mime || 'application/octet-stream' });
    const url = this.options.createObjectURL(blob);
    if (['reader-page', 'remote', 'dlssnr'].includes(identity.rendition)) rememberTileSource(url, blob, data.bytes);
    const entry: MemoryEntry = { key, url, bytes: data.bytes.byteLength, refs: 1, retain: Boolean(options.retain) };
    this.memory.set(key, entry);
    this.memoryBytes += entry.bytes;
    this.evictMemory();
    return { key, url, bytes: entry.bytes };
  }

  /** 收下一张**不是本缓存造的**图，并记一次引用。
   *
   * 与 `load` 只差一件事：这张图的 URL 不是这里 `createObjectURL` 出来的，所以丢它的时候
   * 不能撤 URL，得调用 `image.release()` 把东西还给它的主人。
   *
   * 存在的理由：阅读器那张账（`retainDerived` 的字节预算、翻页/卸载时的 `release`、
   * `peek`/`peekUrl`）认的都是 `ImageHandle{key,url,bytes}`。宿主的租借只要能变成同一形状
   * 的句柄，那些账一行都不用改，而「还 pin」就落在 `forget` 上——那也正是「这张图真的不在
   * 内存里了」唯一的那个时刻。
   *
   * 同一身份已经有条目时**不替换**：把刚拿到的这张当场还掉（否则第二次认领就等于多留一个
   * 宿主的 pin），再按命中处理（引用 +1，返回已有条目）。 */
  adopt(identity: ImageCacheIdentity, image: AdoptedImage, options: ImageAdoptOptions = {}): ImageHandle {
    const key = memoryKey(identity);
    const existing = this.memory.get(key);
    if (existing) {
      image.release();
      if (options.retain) existing.retain = true;
      this.touch(existing);
      return { key, url: existing.url, bytes: existing.bytes, ...(existing.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: existing.estimatedDecodedBytes }) };
    }
    if (image.contentHash) rememberTileSource(image.url, image.leaseId
      ? { contentHash: image.contentHash, leaseId: image.leaseId, ...(image.estimatedDecodedBytes === undefined ? {} : { decodedBytes: image.estimatedDecodedBytes }) }
      : image.contentHash);
    const entry: MemoryEntry = {
      key,
      url: image.url,
      bytes: image.bytes,
      ...(image.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: image.estimatedDecodedBytes }),
      refs: 1,
      retain: Boolean(options.retain),
      release: image.release,
    };
    this.memory.set(key, entry);
    this.memoryBytes += entry.bytes;
    this.evictMemory();
    return { key, url: entry.url, bytes: entry.bytes, ...(entry.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: entry.estimatedDecodedBytes }) };
  }

  /** Stop serving a rejected URL to new consumers without disrupting a view
   * that still owns it. A replacement can be adopted under the same key. */
  invalidate(handle: ImageHandle): void {
    const entry = this.memory.get(handle.key);
    if (!entry || entry.url !== handle.url) return;
    if (entry.refs === 0) {
      this.forget(entry);
      return;
    }
    this.memory.delete(entry.key);
    entry.retain = false;
    this.invalidated.set(entry.url, entry);
  }

  release(handle: ImageHandle): void {
    const current = this.memory.get(handle.key);
    const entry = current?.url === handle.url ? current : this.invalidated.get(handle.url);
    if (!entry || entry.key !== handle.key) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0 && !entry.retain) {
      this.forget(entry);
      return;
    }
    this.evictMemory();
  }

  /** 同步看一眼内存里有没有这张图，命中就**增加一次引用**并把条目挪到 LRU 末尾。
   *
   * 引用计数规则：命中的返回值必须配一次 `release(handle)`，和 `load` 拿到的 handle
   * 完全一样——多拿不还，条目会一直被跳过回收（`evictMemory` 不动 `refs > 0` 的）。
   * 没命中返回 undefined，不产生引用，也不会顺路去取一次图。
   *
   * 存在的理由只有一个：重新挂载的第一帧要能同步拿到已经有的一图，而不是先渲染骨架
   * 再等一次 Promise。取图入口仍然是异步的 `load`。 */
  peek(identity: ImageCacheIdentity): ImageHandle | undefined {
    const entry = this.memory.get(memoryKey(identity));
    if (!entry) return undefined;
    this.touch(entry);
    return { key: entry.key, url: entry.url, bytes: entry.bytes, ...(entry.estimatedDecodedBytes === undefined ? {} : { estimatedDecodedBytes: entry.estimatedDecodedBytes }) };
  }

  /** 渲染期用的纯读版本：只报 URL，**不动引用计数**。
   *
   * 这样才安全：`release` 到 0 引用时只有 `retain` 过的条目会留下，所以这里读到的
   * URL 要么有人正拿着、要么被保留着，不会在读完之后被撤掉。反过来它不能顺手「保住」
   * 一张图——渲染可能被丢弃（StrictMode 双跑、并发渲染里被放弃的那一版），多出来的
   * 引用就永远没人还，条目被钉死在表里。 */
  peekUrl(identity: ImageCacheIdentity): string | undefined {
    return this.memory.get(memoryKey(identity))?.url;
  }

  inFlightCount(): number {
    return this.pending.size;
  }

  private async readOrFetch(identity: ImageCacheIdentity, signal: AbortSignal, priority?: () => number): Promise<CachedImageData> {
    const derived = identity.rendition === 'enhanced' || identity.rendition === 'dlssnr' || identity.rendition === 'remote';
    // Completed enhancements must remain available while a different page is
    // computing. The compute gate serializes inference, not cache hits.
    if (derived) {
      const cached = await this.repository.read(identity);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (cached && cached.bytes.byteLength > 0) return cached;
    }
    const gate = derived ? this.computeGate : this.fetchGate;
    return gate.run(() => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const request = (async () => {
        // Disk hits also transfer the full image over IPC. Starting all reads
        // before the gate floods the bridge just as surely as parallel fetches.
        const cached = derived ? null : await this.repository.read(identity);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (cached && cached.bytes.byteLength > 0) return cached;
        const fetched = await this.repository.fetch(identity, signal);
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (fetched.bytes.byteLength === 0) throw new Error('Image response was empty');
        await this.repository.store(identity, fetched);
        return fetched;
      })();
      if (derived) return request;
      // Native IPC may ignore AbortSignal, including during disk reads.
      return new Promise<CachedImageData>((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }, { signal, ...(priority ? { priority } : {}) });
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
   * 表里留着的条目**要么有引用、要么是被 `retain` 保留的封面**（没保留的释放到 0 引用
   * 当场就撤掉了），所以这一步实际是兜底：超过上限时先丢最久没被碰过的那张，而且永远
   * 不动别人手上还拿着的那一张。保留也不会无上限：96MiB / 256 条那套预算照样把它挤出去。
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

/** `peek` 的安全版本：注入进来的缓存可能是个只有 `load`/`release` 的精简替身（组件
 * 测试里的 mock、只读适配层），直接调 `peek` 会把一整屏卡片崩掉。没有同步接口就当没
 * 命中，照旧走异步取图——这正是引入它之前的行为。 */
export function peekCachedImage(cache: UnifiedImageCache, identity: ImageCacheIdentity): ImageHandle | undefined {
  if (typeof cache?.peek !== 'function') return undefined;
  return cache.peek(identity);
}

/** `peekUrl` 的安全版本，理由同上。命中的 URL 不需要还引用（它本来就不加引用）。 */
export function peekCachedImageUrl(cache: UnifiedImageCache, identity: ImageCacheIdentity): string | undefined {
  if (typeof cache?.peekUrl !== 'function') return undefined;
  return cache.peekUrl(identity);
}
