import { createImageCacheKey } from '../domain/cache';

export interface ReaderPageRequest {
  scopeId: string;
  archiveId: string;
  pageIndex: number;
  url: string;
}

export class ReaderPageCache {
  private readonly values = new Map<string, ArrayBuffer>();
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();

  constructor(private readonly fetcher: (url: string) => Promise<ArrayBuffer>) {}

  async load(request: ReaderPageRequest): Promise<ArrayBuffer> {
    const key = createImageCacheKey({
      scopeId: request.scopeId,
      archiveId: request.archiveId,
      pageIndex: request.pageIndex,
      rendition: 'source',
    });
    const cached = this.values.get(key);
    if (cached) return cached.slice(0);
    const existing = this.pending.get(key);
    if (existing) return (await existing).slice(0);
    const operation = this.fetcher(request.url).then((value) => {
      this.values.set(key, value.slice(0));
      this.pending.delete(key);
      return value;
    }, (error) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, operation);
    return (await operation).slice(0);
  }

  clear(): void {
    this.values.clear();
  }
}
