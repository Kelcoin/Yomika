export function isWideCoverRatio(ratio: number | null | undefined): boolean {
  return ratio != null && Number.isFinite(ratio) && ratio > 1.0;
}

/** Namespaces that tell a reader what an archive is, most telling first. A card
 * has room for a handful of chips, so the choice matters more than the count:
 * `female:`/`male:` content tags and `character:`/`parody:` beat bookkeeping
 * namespaces like language or date_added. */
export const CARD_TAG_NAMESPACE_PRIORITY = [
  'female', 'male', 'mixed', 'other', 'character', 'parody', 'artist', 'group', 'series', 'cosplayer', 'language',
];

const HIDDEN_CARD_TAG_NAMESPACES = ['date_added', 'dateadded', 'timestamp', 'source', 'uploader', 'category'];

export function pickCardTags(tags: readonly string[] = [], limit = 6): string[] {
  const rank = (tag: string) => {
    const namespace = tag.split(':', 1)[0]!.trim().toLowerCase();
    const index = CARD_TAG_NAMESPACE_PRIORITY.indexOf(namespace);
    return index < 0 ? CARD_TAG_NAMESPACE_PRIORITY.length : index;
  };
  return tags
    .filter((tag) => !HIDDEN_CARD_TAG_NAMESPACES.includes(tag.split(':', 1)[0]!.trim().toLowerCase()))
    .map((tag, index) => ({ tag, index, rank: rank(tag) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.tag);
}

/** Uniform sample without replacement. `sort(() => Math.random() - 0.5)` is not
 * a shuffle: the comparator is intransitive, so the engine's sort keeps most of
 * the original order. */
export function pickRandomSample<T>(items: readonly T[], count: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const size = Math.max(0, Math.min(Math.floor(count), pool.length));
  for (let index = 0; index < size; index += 1) {
    const pick = index + Math.floor(random() * (pool.length - index));
    const swap = Math.min(pick, pool.length - 1);
    [pool[index], pool[swap]] = [pool[swap]!, pool[index]!];
  }
  return pool.slice(0, size);
}

export function formatArchiveDate(timestampSeconds: number | null | undefined): string {
  if (!timestampSeconds || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return '';
  const date = new Date(timestampSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatArchivePageMeta(pageCount: number, progressPage?: number | null): string {
  if (pageCount <= 0) return '';
  const current = progressPage != null && progressPage > 0 ? Math.min(progressPage, pageCount) : 0;
  return current > 0 ? `${current}/${pageCount} 页` : `${pageCount} 页`;
}

export function formatByteSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
