import type { EhMyTag } from '../domain/eh';

/** Normalised form a "namespace:key" pair is matched in: the mytags page, the
 * LANraragi tag store and the EH gallery pages disagree about underscores and
 * case, so both sides fold to lowercase space-separated before lookup. */
export function normalizeMyTagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export interface EhMyTagPresentation {
  /** Watched tags, in the order they should be offered first (weight
   * descending, then the site's own order). Keys are normalised. */
  readonly priority: readonly string[];
  /** Watched tag → the account's preset chip colour. */
  readonly colors: ReadonlyMap<string, string>;
}

const EMPTY_PRESENTATION: EhMyTagPresentation = { priority: [], colors: new Map() };

/* Feature flag, applied imperatively the way coverConcurrency is: preferences
   flow through one applyPreferences step, and leaf components should not need
   the whole preferences context to know whether the feature is on. */
let priorityEnabled = false;
const flagListeners = new Set<() => void>();

export function setEhMyTagsPriorityEnabled(enabled: boolean): void {
  if (priorityEnabled === enabled) return;
  priorityEnabled = enabled;
  for (const listener of flagListeners) listener();
}

export function isEhMyTagsPriorityEnabled(): boolean {
  return priorityEnabled;
}

export function subscribeEhMyTagsPriority(listener: () => void): () => void {
  flagListeners.add(listener);
  return () => { flagListeners.delete(listener); };
}

/** Builds the lookup the card and detail renderers consume. Hidden tags are
 * parsed and stored but not acted on: hiding gallery tags is the site's own
 * browsing feature and the shelves are not that list. Heavier tags are the
 * ones the account cares about more, so they go first regardless of which
 * path (stored read or fresh fetch) produced the input. */
export function buildMyTagPresentation(tags: readonly EhMyTag[]): EhMyTagPresentation {
  const watched = tags.filter((tag) => tag.watched);
  if (watched.length === 0) return EMPTY_PRESENTATION;
  const priority: string[] = [];
  const colors = new Map<string, string>();
  for (const tag of [...watched].sort((left, right) => right.weight - left.weight || left.tagId - right.tagId)) {
    const key = normalizeMyTagKey(tag.namespace === 'general' ? tag.tagKey : `${tag.namespace}:${tag.tagKey}`);
    if (!key || priority.includes(key)) continue;
    priority.push(key);
    if (tag.color) colors.set(key, tag.color);
  }
  return { priority, colors };
}

/** Watched tags lean left: they move ahead of the unwatched ones while keeping
 * their own relative order — and, because grouping happens downstream, they
 * stay inside their namespace's group instead of jumping to the front row. */
export function prioritizeByMyTags(tags: readonly string[], presentation: EhMyTagPresentation): string[] {
  if (presentation.priority.length === 0) return [...tags];
  const watched = new Set(presentation.priority);
  const head: string[] = [];
  const tail: string[] = [];
  for (const tag of tags) (watched.has(normalizeMyTagKey(tag)) ? head : tail).push(tag);
  return [...head, ...tail];
}

/** Ink that stays readable on an arbitrary preset colour: the mytags page
 * stores plain hex, so the chip recolours exactly like the site does and the
 * text follows the fill's luminance instead of the theme. */
/** WCAG 相对亮度（sRGB 线性化）。入参为 0–255 通道值。 */
function relativeLuminance(rgb: readonly [number, number, number]): number {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const pair = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  const la = pair[0]!;
  const lb = pair[1]!;
  return (la + 0.05) / (lb + 0.05);
}

/** 标签 chip 的墨色：在三个候选里选对底色对比度最高的一个。
 *
 * 旧实现按亮度阈值（0.35）二选一，中明度底色（L≈0.25–0.40）会被配上白墨，
 * 对比度掉到 2.8–4.5:1（WCAG 小字要求 4.5:1）——可读性差的根源。三候选择优后
 * 全亮度带 ≥ 4.5:1；纯黑 (#000000) 在中明度底色上比 #1c1c1e 高出 3–4 个点。 */
const INK_CANDIDATES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [28, 28, 30],
  [255, 255, 255],
];
const INK_CANDIDATE_HEX = ['#000000', '#1c1c1e', '#ffffff'];

export function readableInkOnHex(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6 || /[^0-9a-fA-F]/.test(value)) return '';
  const background = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
  let bestIndex = 0;
  let bestContrast = -1;
  INK_CANDIDATES.forEach((candidate, index) => {
    const ratio = contrastRatio(background, candidate);
    if (ratio > bestContrast) { bestContrast = ratio; bestIndex = index; }
  });
  return INK_CANDIDATE_HEX[bestIndex]!;
}
