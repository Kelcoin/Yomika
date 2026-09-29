export type ImageRendition =
  | 'source'
  | 'thumbnail'
  | 'preview'
  | 'enhanced'
  | 'cover'
  | 'page-thumbnail'
  | 'reader-page'
  | 'decensored'
  /** DLSS5 跑过一页的产物（Windows 桌面）。 */
  | 'dlssnr'
  /** 交给局域网里那台桌面端处理后的产物。 */
  | 'remote';

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
  /** De-censoring bundle this rendition was produced with. On `enhanced` it also
   * says the upscaler read the de-censored page rather than the plain one, so the
   * two pipelines chain; part of the key for the same reason as `modelId`. */
  decensorModelId?: string;
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
    identity.decensorModelId ?? '',
    identity.transform ?? '',
  ];
  return `image:v1:${fields.map((value) => `${value.length}:${value}`).join('')}`;
}
