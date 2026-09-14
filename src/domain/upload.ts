/** Upload queue rules, kept out of the component so the parsing and the
 * de-duplication can be tested without a DOM.
 *
 * Two ways in: local archives, or URLs the server downloads for
 * itself. Both end up as items in one queue with one status each, because the
 * failure that matters ("this one did not go through") is per item.
 */
export const UPLOADABLE_EXTENSIONS = ['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7', 'tar', 'gz', 'pdf'] as const;

const UPLOADABLE = new RegExp(`\\.(${UPLOADABLE_EXTENSIONS.join('|')})$`, 'i');

export type UploadItemStatus = 'queued' | 'running' | 'done' | 'failed';

export interface UploadQueueItem {
  id: string;
  kind: 'file' | 'url';
  /** What the user sees: a file name, or the URL itself. */
  label: string;
  /** The absolute path or the normalised URL handed to the server. */
  source: string;
  status: UploadItemStatus;
  message?: string;
}

export function archiveFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Splits dropped or picked paths into the ones LANraragi accepts and the rest,
 * so a folder or a stray screenshot is reported rather than queued. */
export function partitionUploadPaths(paths: readonly string[]): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    (UPLOADABLE.test(trimmed) ? accepted : rejected).push(trimmed);
  }
  return { accepted, rejected };
}

/** One URL per line. Anything that is not an http(s) URL is reported back rather
 * than silently dropped, since a typo is the likely cause. */
export function parseUploadUrls(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let href: string | undefined;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
    } catch { /* reported as invalid below */ }
    if (!href) {
      if (!invalid.includes(trimmed)) invalid.push(trimmed);
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    valid.push(href);
  }
  return { valid, invalid };
}

/** Appends new items, skipping what the queue already holds. Re-picking the same
 * file after a failure should not stack duplicates. */
export function appendUploadItems(
  current: readonly UploadQueueItem[],
  kind: UploadQueueItem['kind'],
  sources: readonly string[],
): UploadQueueItem[] {
  const known = new Set(current.filter((item) => item.kind === kind).map((item) => item.source));
  const added: UploadQueueItem[] = [];
  for (const source of sources) {
    if (known.has(source)) continue;
    known.add(source);
    added.push({
      id: `${kind}:${source}`,
      kind,
      label: kind === 'file' ? archiveFileName(source) : source,
      source,
      status: 'queued',
    });
  }
  return added.length ? [...current, ...added] : [...current];
}
