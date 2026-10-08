/** 阅读器里「算出来的图」的引用计数表。
 *
 * 与 `unifiedImageCache` 长得像，但管的是**另一种东西**：算出来的图不是 `Blob`，而是宿主
 * 发的一张租借——`url` 是宿主自己的 scheme，背后有一份文件和一个 pin（§7.4）。所以
 *
 * - 释放必须按来源分开：`blob` 用 `revokeObjectURL`，租借用 `releaseLease`（还 host 的 pin）。
 *   无差别 revoke 会漏掉 pin；只在内存 Map 里 `delete` 也等于漏掉 pin。
 * - 同一份内容可能同时有两个消费者（同一页的两处视图）：引用计数归零才真的还。
 * - 预算按**解码后**的位图算（§9.3）：上限满了就拒绝新的，而不是偷偷丢掉正在显示的那一张
 *   ——谁该被丢由阅读器说了算，不是缓存背后删。
 */

export type ComputedImageSource =
  | { kind: 'lease'; leaseId: string; url: string; estimatedDecodedBytes: number }
  | { kind: 'blob'; url: string; bytes: number };

/** 交给调用方的把手。`leaseId` 只有租借来源才有。 */
export interface ComputedImageHandle {
  key: string;
  url: string;
  leaseId?: string;
  estimatedDecodedBytes: number;
}

export interface ComputedImageCacheOptions {
  /** 把租借还给宿主（`compute_artifact_release`）。 */
  releaseLease: (leaseId: string) => Promise<unknown> | void;
  revokeObjectURL: (url: string) => void;
  /** 同时留着的解码位图上限，默认 512 MiB（阅读器自己还会再紧一道）。 */
  maxDecodedBytes?: number;
}

interface Entry {
  key: string;
  url: string;
  leaseId?: string;
  decodedBytes: number;
  /** 退订/换页时用来兜底释放的资源。 */
  release: () => void;
  refs: number;
}

const DEFAULT_MAX_DECODED_BYTES = 512 * 1024 * 1024;

export class ComputedImageCache {
  private readonly entries = new Map<string, Entry>();
  /** 每个把手对应它当初拿到的那一条：旧把手不许动新一代的账。 */
  private readonly handles = new WeakMap<ComputedImageHandle, Entry>();
  private readonly releasedHandles = new WeakSet<ComputedImageHandle>();
  private readonly releaseLease: (leaseId: string) => Promise<unknown> | void;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly maxDecodedBytes: number;
  private liveDecodedBytes = 0;

  constructor(options: ComputedImageCacheOptions) {
    this.releaseLease = options.releaseLease;
    this.revokeObjectURL = options.revokeObjectURL;
    this.maxDecodedBytes = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  }

  /** 收下一张图并记一次引用。同一个 key 再收一次只是 refs++（返回的是新的把手）。 */
  adopt(key: string, source: ComputedImageSource): ComputedImageHandle {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      // Two consumers can both miss retain(), await acquire, and arrive here
      // with distinct host pins. Keep one URL and return the redundant resource.
      if (source.kind === 'lease' && source.leaseId !== existing.leaseId) {
        void this.releaseLease(source.leaseId);
      } else if (source.kind === 'blob' && source.url !== existing.url) {
        this.revokeObjectURL(source.url);
      }
      existing.refs += 1;
      return this.handleFor(existing);
    }

    const decodedBytes = source.kind === 'lease' ? source.estimatedDecodedBytes : source.bytes;
    if (this.liveDecodedBytes + decodedBytes > this.maxDecodedBytes) {
      // 拒绝**新的**：调用方手里那张租借还没被交出去，得由它自己还（缓存不代还）。
      throw new Error(
        `超出计算图缓存预算：已占 ${this.liveDecodedBytes} 字节，再加 ${decodedBytes} 字节会超过 ${this.maxDecodedBytes} 字节上限`,
      );
    }

    const entry: Entry =
      source.kind === 'lease'
        ? {
            key,
            url: source.url,
            leaseId: source.leaseId,
            decodedBytes,
            refs: 1,
            release: () => { void this.releaseLease(source.leaseId); },
          }
        : {
            key,
            url: source.url,
            decodedBytes,
            refs: 1,
            release: () => { this.revokeObjectURL(source.url); },
          };
    this.entries.set(key, entry);
    this.liveDecodedBytes += decodedBytes;
    return this.handleFor(entry);
  }

  /** 已经收过这个 key 就再记一次引用（不给新的租借），没有就什么都不做。
   *
   * 阅读器用它在向宿主开口之前先问一句：同一份内容已经有 URL 了，就不必再租一次。 */
  retain(key: string): ComputedImageHandle | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    entry.refs += 1;
    return this.handleFor(entry);
  }

  /** 还一次引用。重复还同一个把手是无操作的（卸载路径与错误路径会重叠）。 */
  release(handle: ComputedImageHandle): void {
    if (this.releasedHandles.has(handle)) return;
    this.releasedHandles.add(handle);
    const entry = this.handles.get(handle);
    if (entry === undefined || this.entries.get(entry.key) !== entry) return;
    if (entry.refs > 1) {
      entry.refs -= 1;
      return;
    }
    this.entries.delete(entry.key);
    this.liveDecodedBytes -= entry.decodedBytes;
    entry.release();
  }

  peekUrl(key: string): string | undefined {
    return this.entries.get(key)?.url;
  }

  size(): number {
    return this.entries.size;
  }

  decodedBytes(): number {
    return this.liveDecodedBytes;
  }

  /** 关闭阅读器：所有还活着的引用一次还清。 */
  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.key);
      this.liveDecodedBytes -= entry.decodedBytes;
      entry.release();
    }
  }

  private handleFor(entry: Entry): ComputedImageHandle {
    const handle: ComputedImageHandle = {
      key: entry.key,
      url: entry.url,
      estimatedDecodedBytes: entry.decodedBytes,
      ...(entry.leaseId === undefined ? {} : { leaseId: entry.leaseId }),
    };
    this.handles.set(handle, entry);
    return handle;
  }
}
