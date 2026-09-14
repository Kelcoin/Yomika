import { categoryTagLabel } from './tags';
import { normalizeMyTagKey } from './ehMyTags';

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

/** `priority` carries the E-Hentai account's watched tags ("My Tags"). 优先
 * 显示 = 优先保留席位（watched 先占位，保证出现在卡片上）+ 组内靠左：
 * 显示次序仍以命名空间为主键，watched 只在自己的命名空间里排到最前——不跨
 * 命名空间抢占第一排。 */
export function pickCardTags(tags: readonly string[] = [], limit = 6, priority?: ReadonlySet<string> | undefined): string[] {
  const rank = (tag: string) => {
    const namespace = tag.split(':', 1)[0]!.trim().toLowerCase();
    const index = CARD_TAG_NAMESPACE_PRIORITY.indexOf(namespace);
    return index < 0 ? CARD_TAG_NAMESPACE_PRIORITY.length : index;
  };
  const watched = (tag: string) => Boolean(priority && priority.size > 0 && priority.has(normalizeMyTagKey(tag)));
  const candidates = tags.filter((tag) => !HIDDEN_CARD_TAG_NAMESPACES.includes(tag.split(':', 1)[0]!.trim().toLowerCase()));
  // 席位：watched 先占（保持原相对次序），其余按命名空间次序补足。
  const reserved: string[] = [];
  const rest: string[] = [];
  for (const tag of candidates) (watched(tag) ? reserved : rest).push(tag);
  const fill = rest
    .map((tag, index) => ({ tag, index, rank: rank(tag) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.tag);
  return [...reserved, ...fill]
    .slice(0, Math.max(0, limit))
    // 显示次序：命名空间为主键，watched 在同命名空间内靠左。
    .map((tag, index) => ({ tag, index, rank: rank(tag), preferred: watched(tag) ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.preferred - right.preferred || left.index - right.index)
    .map((entry) => entry.tag);
}

/** Splits chosen tags into contiguous, balanced rows. */
export function distributeCardTags(tags: readonly string[], rowCount: number): string[][] {
  const rows = Math.max(0, Math.min(Math.floor(rowCount), tags.length));
  if (rows === 0) return [];
  const baseSize = Math.floor(tags.length / rows);
  const remainder = tags.length % rows;
  const result: string[][] = [];
  let offset = 0;
  for (let row = 0; row < rows; row += 1) {
    const size = baseSize + (row < remainder ? 1 : 0);
    result.push(tags.slice(offset, offset + size));
    offset += size;
  }
  return result;
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

/** First value under a namespace, e.g. `category:Manga` → `Manga`. */
function firstTagValue(tags: readonly string[], namespace: string): string {
  const prefix = `${namespace}:`;
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return '';
}

/** Canonical English category name for the accent rules.
 *
 * Two maps look like duplication and are not: `.metadata-chip[data-category=…]`
 * in shell.css keys on the English name because that is what E-Hentai itself
 * sends and what its own chips carry, while the text a card prints is
 * translated. Deriving the attribute from the translated label would have
 * dropped every accent colour the moment the label became Chinese. */
const CATEGORY_ACCENT_KEYS: Record<string, string> = {
  manga: 'Manga',
  doujinshi: 'Doujinshi',
  artistcg: 'Artist CG',
  'artist cg': 'Artist CG',
  gamecg: 'Game CG',
  'game cg': 'Game CG',
  imageset: 'Image Set',
  'image set': 'Image Set',
  western: 'Western',
  'non-h': 'Non-H',
  cosplay: 'Cosplay',
  asianporn: 'Asian Porn',
  misc: 'Misc',
};

export function archiveCategoryKey(archive: { tags?: readonly string[] | undefined }): string {
  const value = firstTagValue(archive.tags ?? [], 'category').trim().toLowerCase();
  return CATEGORY_ACCENT_KEYS[value] ?? '';
}

/** The category a card shows.
 *
 * LANraragi's own categories come first, because that is what the user actually
 * organised — the `category:` tag is metadata the uploader happened to set, and
 * showing it while calling it "分类" conflated two different things. Falls back to
 * the tag when the archive is in no category, translated through the one shared
 * map so a card and the detail pane cannot disagree about the same value.
 *
 * The local `archives.category` column used to be consulted first "for
 * compatibility"; nothing has ever written it, so the branch only made the source
 * order harder to read.
 */
export function archiveCategoryLabel(
  archive: { tags?: readonly string[] | undefined },
  lanraragiCategories?: readonly string[] | undefined,
): string {
  const own = lanraragiCategories?.[0];
  if (own) return own;
  return categoryTagLabel(firstTagValue(archive.tags ?? [], 'category'));
}

/** Same story as the category: `language:chinese` lives in the tags, not in the
 * column the card used to read. */
export function archiveLanguageLabel(archive: { language?: string | null | undefined; tags?: readonly string[] | undefined }): string {
  return archive.language?.trim() || firstTagValue(archive.tags ?? [], 'language');
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

/** "Read to the end" as the continue-reading rail draws the line: past 95% of
 * the pages there is nothing meaningfully left to continue. 95% rather than
 * 100% so a record saved one page short of the last still counts as finished —
 * a double-page spread can lose the closing save. */
export function isArchiveFinished(pageCount: number, progressPage?: number | null): boolean {
  if (!(pageCount > 0) || progressPage == null || progressPage <= 0) return false;
  return progressPage / pageCount > 0.95;
}

export function formatByteSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
