import { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { invokeCommand } from '../bridge/invoke';
import { ComputedImageLeaseSchema } from '../domain/compute';
import { getNativeComputeRepository } from '../repositories/nativeComputeRepository';
import { forgetTileSource, readerSourceLeaseId, rememberTileSource } from './readerNativeTiles';

type PageSize = { width: number; height: number };
type Request = { index: number; originalSource?: string | undefined };
const CropInsetsSchema = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
const CropResultSchema = z.object({ lease: ComputedImageLeaseSchema, insets: CropInsetsSchema });
type Crop = { url: string; insets: z.infer<typeof CropInsetsSchema>; release: () => void };

/** Keep temporary renditions within the reader's existing retained page window. */
export function useReaderCrop(session: number, requested: ReadonlyMap<string, Request>, active: boolean) {
  const results = useRef(new Map<string, Crop | null>());
  const queue = useRef<ReadonlyMap<string, Request>>(new Map());
  const sizes = useRef(new Map<number, { cropped: PageSize; original: PageSize }>());
  const owners = useRef(new Map<string, Request>());
  const predecessors = useRef(new Map<number, string>());
  const mayRun = useRef(false);
  const running = useRef(false);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    queue.current = requested;
    mayRun.current = active;
    const retainedPages = new Set([...requested.values()].map(({ index }) => index));
    // Keep one outgoing processed image available while the next rendition is
    // cropped and decoded, including when it arrives during a gesture.
    for (const source of results.current.keys()) {
      const owner = owners.current.get(source);
      if (owner?.originalSource && !requested.has(source) && retainedPages.has(owner.index)
        && results.current.get(source)) predecessors.current.set(owner.index, source);
    }
    for (const [index] of predecessors.current) {
      if (!retainedPages.has(index)) predecessors.current.delete(index);
    }
    const retainedSources = new Set(predecessors.current.values());
    for (const [source, crop] of results.current) {
      if (requested.has(source) || retainedSources.has(source)) continue;
      crop?.release();
      results.current.delete(source);
      owners.current.delete(source);
    }
    if (!active || running.current) return;
    running.current = true;
    void (async () => {
      try {
        while (mayRun.current) {
          const next = [...queue.current].find(([source]) => !results.current.has(source));
          if (!next) break;
          const [source, { index, originalSource }] = next;
          const leaseId = readerSourceLeaseId(source);
          const reference = originalSource === undefined ? undefined : results.current.get(originalSource)?.insets;
          const response = leaseId && (originalSource === undefined || reference)
            ? await invokeCommand('reader_crop_borders', { leaseId, session, page: index + 1, reference }, CropResultSchema.nullable())
            : undefined;
          const result = response?.ok ? response.value : null;
          const lease = result?.lease;
          const release = () => {
            if (!lease) return;
            forgetTileSource(lease.url);
            void getNativeComputeRepository().releaseArtifact(lease.leaseId).catch(() => undefined);
          };
          if (!queue.current.has(source)) {
            release();
            continue;
          }
          if (lease) {
            rememberTileSource(lease.url, { contentHash: lease.artifactId, leaseId: lease.leaseId, decodedBytes: lease.estimatedDecodedBytes });
            if (originalSource === undefined && result) {
              const { left, right, top, bottom } = result.insets;
              sizes.current.set(index, {
                original: { width: Math.round(lease.width / (1 - left - right)), height: Math.round(lease.height / (1 - top - bottom)) },
                cropped: { width: lease.width, height: lease.height },
              });
            }
          }
          owners.current.set(source, { index, originalSource });
          results.current.set(source, result ? { url: result.lease.url, insets: result.insets, release } : null);
          refresh(value => value + 1);
        }
      } finally {
        running.current = false;
      }
    })();
  }, [active, requested, session]);
  useEffect(() => () => {
    queue.current = new Map();
    mayRun.current = false;
    for (const crop of results.current.values()) crop?.release();
    results.current.clear();
  }, []);
  return { results: results.current, sizes: sizes.current, predecessors: predecessors.current, revision };
}
