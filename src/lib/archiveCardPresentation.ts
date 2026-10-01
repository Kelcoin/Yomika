import { TAG_NAMESPACE_LABELS, categoryTagLabel } from './tags';
import { normalizeMyTagKey } from './ehMyTags';

export function isWideCoverRatio(ratio: number | null | undefined): boolean {
  return ratio != null && Number.isFinite(ratio) && ratio > 1.0;
}

/** 一张卡片记住多少条宽封面标记。每条就是一个档案键，不设上限的话这个集合会随着
 * 工作区一直挂着而无限增长（每个划过去的宽封面留一条）。 */
export const WIDE_COVER_MARK_LIMIT = 4096;

/** 记住某一张档案的封面是宽的（或者不再记得）。和组件分开是为了让淘汰顺序能被测试
 * 钉住：`Set` 按插入顺序迭代，所以最先掉出去的就是最久以前划过去的那些。什么都没动
 * 的时候原样返回传进来的那个集合——每张封面都换一个新集合会让整张列表重渲染。 */
export function withWideCoverMark(
  current: Set<string>,
  archiveId: string,
  wide: boolean,
  limit: number = WIDE_COVER_MARK_LIMIT,
): Set<string> {
  if (current.has(archiveId) === wide) return current;
  const next = new Set(current);
  if (!wide) {
    next.delete(archiveId);
    return next;
  }
  next.add(archiveId);
  while (next.size > limit) {
    const oldest = next.values().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

/** 宽封面标记的键。带上 serverId：切页时服务器的 query 会变、服务器本身也可能换，
 * 只用 archiveId 当键会让另一台服务器上同名的档案套用错上一次的形状。 */
export function wideCoverMarkKey(serverId: string, archiveId: string): string {
  return `${serverId}\u0000${archiveId}`;
}

/** 跨路由记住的宽封面形状。
 *
 * 档案库的工作区在离开时不会卸载，但会被 `RetainedPage` 挂上 `hidden`（`display:none`），
 * 虚拟列表因此量到 0 高度、把整屏的行卸掉——行里的封面句柄一起放手。重新进来时组件态
 * 里那份「哪些封面是宽的」已经没了，于是所有卡片先按窄卡排版，等封面 load 出自然宽高比
 * 再翻成宽卡，一屏集体重排就是那一下闪动。放在模块级、由这个文件承载（卡片和档案库网格
 * 都 import 它，放进任何一个组件都要循环依赖），重新进来的第一帧就是对的形状。
 *
 * 取舍：进程内、按 session 存活的一张纯字符串小表，不落盘也不与服务器同步；它只是
 * 「这张封面长什么样」的提示，猜错最多是排版先按窄卡、封面到手后自己纠正，不会显示
 * 错内容。上限沿用 `WIDE_COVER_MARK_LIMIT` 的 FIFO，所以它不会无限增长。 */
let wideCoverMarks = new Set<string>();

export function rememberWideCoverMark(serverId: string, archiveId: string, wide: boolean): Set<string> {
  wideCoverMarks = withWideCoverMark(wideCoverMarks, wideCoverMarkKey(serverId, archiveId), wide);
  return wideCoverMarks;
}

export function isWideCoverMarked(serverId: string, archiveId: string): boolean {
  return wideCoverMarks.has(wideCoverMarkKey(serverId, archiveId));
}

/** 挂载时播种工作区用的一份快照；返回的是活的那一份，调用方不要改它。 */
export function readWideCoverMarkKeys(): ReadonlySet<string> {
  return wideCoverMarks;
}

export function resetWideCoverMarksForTests(): void {
  wideCoverMarks = new Set();
}

/** Namespaces that tell a reader what an archive is, most telling first. A card
 * has room for a handful of chips, so the choice matters more than the count:
 * `female:`/`male:` content tags and `character:`/`parody:` beat bookkeeping
 * namespaces like language or date_added. */
export const CARD_TAG_NAMESPACE_PRIORITY = [
  'female', 'male', 'mixed', 'other', 'character', 'parody', 'artist', 'group', 'series', 'cosplayer', 'language',
];

const HIDDEN_CARD_TAG_NAMESPACES = ['date_added', 'dateadded', 'timestamp', 'source', 'uploader', 'category'];

/** 一张卡片能摆下的标签数。挑的时候给得宽：缩略卡片的两行瀑布会丢掉装不下的，
 * 宽行有三行——上限只负责「别把整份标签表交给比较器」。 */
export const CARD_TAG_LIMIT_THUMBNAIL = 24;
export const CARD_TAG_LIMIT_WIDE = 36;

/** Watched tags take the leftmost waterfall slots across all namespaces. */
export function pickCardTags(tags: readonly string[] = [], limit = 10, priority?: ReadonlySet<string> | undefined): string[] {
  const rank = (tag: string) => {
    const namespace = tag.split(':', 1)[0]!.trim().toLowerCase();
    const index = CARD_TAG_NAMESPACE_PRIORITY.indexOf(namespace);
    return index < 0 ? CARD_TAG_NAMESPACE_PRIORITY.length : index;
  };
  const watched = (tag: string) => Boolean(priority && priority.size > 0 && priority.has(normalizeMyTagKey(tag)));
  const candidates = tags.filter((tag) => !HIDDEN_CARD_TAG_NAMESPACES.includes(tag.split(':', 1)[0]!.trim().toLowerCase()));
  // 席位：watched 先占（保持原相对次序），其余按命名空间次序补足；截断
  // 发生在排列之前——排列只重排显示次序，不得改写谁被选中。
  const reserved: string[] = [];
  const rest: string[] = [];
  for (const tag of candidates) (watched(tag) ? reserved : rest).push(tag);
  const fill = rest
    .map((tag, index) => ({ tag, index, rank: rank(tag) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.tag);
  return [...reserved, ...fill]
    .slice(0, Math.max(0, limit))
    .map((tag, index) => ({ tag, index, rank: rank(tag), preferred: watched(tag) ? 0 : 1 }))
    .sort((left, right) => left.preferred - right.preferred || left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.tag);
}

export interface CardTagGroup {
  namespace: string;
  label: string;
  tags: string[];
}

/** Splits the ranked tag line into contiguous namespace groups for the wide
 * card's JHenTai-style rows: one group per row, the namespace label leading
 * it, watched tags already first within the group by the rank above. */
export function groupCardTagLines(tags: readonly string[] = []): CardTagGroup[] {
  const groups: CardTagGroup[] = [];
  for (const tag of tags) {
    const separator = tag.indexOf(':');
    const namespace = separator > 0 ? tag.slice(0, separator).trim().toLowerCase() : 'general';
    const last = groups[groups.length - 1];
    if (last && last.namespace === namespace) last.tags.push(tag);
    else groups.push({ namespace, label: TAG_NAMESPACE_LABELS[namespace] ?? namespace, tags: [tag] });
  }
  return groups;
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

/** The accent key for a raw category/reclass tag value, e.g. `manga` → `Manga`.
 * The detail overview chips share the card chips' colours by carrying this as
 * their data-category attribute. */
export function categoryAccentKey(value: string): string {
  return CATEGORY_ACCENT_KEYS[value.trim().toLowerCase()] ?? '';
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
