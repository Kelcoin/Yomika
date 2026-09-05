export type ImageRendition = 'source' | 'thumbnail' | 'preview' | 'enhanced' | 'cover' | 'page-thumbnail' | 'reader-page';

export interface ImageCacheIdentity {
  scopeId: string;
  serverId?: string;
  archiveId: string;
  pageIndex: number;
  rendition: ImageRendition;
  sourcePath?: string;
  /** Upscale model this rendition was produced with. Part of the key so
   * switching models does not serve the previous one's output. */
  modelId?: string;
  transform?: string;
}

export function createImageCacheKey(identity: ImageCacheIdentity): string {
  const fields = [
    identity.scopeId,
    identity.serverId ?? '',
    identity.archiveId,
    String(Math.max(0, Math.floor(identity.pageIndex))),
    identity.rendition,
    // Reader page order can change after a forced file-list refresh; without the
    // source path the same page index would keep serving the old image.
    identity.sourcePath ?? '',
    identity.modelId ?? '',
    identity.transform ?? '',
  ];
  return `image:v1:${fields.map((value) => `${value.length}:${value}`).join('')}`;
}
