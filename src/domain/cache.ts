export type ImageRendition = 'source' | 'thumbnail' | 'preview' | 'enhanced';

export interface ImageCacheIdentity {
  scopeId: string;
  archiveId: string;
  pageIndex: number;
  rendition: ImageRendition;
  modelVersion?: string;
  transform?: string;
}

export function createImageCacheKey(identity: ImageCacheIdentity): string {
  const fields = [
    identity.scopeId,
    identity.archiveId,
    String(Math.max(0, Math.floor(identity.pageIndex))),
    identity.rendition,
    identity.modelVersion ?? '',
    identity.transform ?? '',
  ];
  return `image:v1:${fields.map((value) => `${value.length}:${value}`).join('')}`;
}
