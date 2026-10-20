/** Similar-archive recommendation rules.
 *
 * A tag shared with the source archive scores its weight; namespaces that say
 * nothing about taste (language, uploader, source, timestamps) score zero, and
 * broad namespaces (artist, group, category) score almost nothing so they cannot
 * dominate a match. Finished archives are down-weighted. Taste tags that are not
 * in the hand-written table score a baseline, scaled by how rare the tag is on
 * the whole site (the frequency table `tagCountService` keeps) and nudged by a
 * per-search jitter so the rail is not identical on every visit.
 */
import { getTagFrequency } from './tagCountService';

export const RECOMMENDATION_LIMIT = 15;

const PRIMARY_NAMESPACES = ['female', 'male', 'others', 'other'];
const FALLBACK_NAMESPACES = ['character', 'parody'];

/** 没写进表的取向类标签按这个基准分参与打分：全站频次表才是「这个标签有多说明
 *  问题」的主要依据，手写表只负责把少数强信号抬高（`female:futanari` 这类）。 */
export const TASTE_NAMESPACE_WEIGHT = 1;

/** 频次按对数折算成稀有度倍率，跨度 0.8：全站最常见（一百万上下）≈ ×1.0，
 *  最罕见（只剩个位数）≈ ×1.8。整表没装时倍率恒为 1，打分与从前一字不差。 */
const RARITY_REFERENCE = 1_000_000;
const RARITY_SPAN = 0.8;
const RARITY_DECADES = 6;

/** 抖动幅度 ±12%：足以让「分数差不多」的候选换个位次，又翻不动真正的强匹配。 */
const JITTER_SPAN = 0.12;

export const TAG_WEIGHTS: Readonly<Record<string, number>> = {
  'female:ahegao': 1.5, 'female:anal intercourse': 2, 'female:anal': 2,
  'female:bbw': 4, 'female:beauty mark': 1.5, 'female:big ass': 1.5,
  'female:big breast': 2, 'female:bikini': 1.5, 'female:blowjob': 1.5,
  'female:bondage': 2, 'female:cheating': 2, 'female:corruption': 2,
  'female:dark skin': 2, 'female:defloration': 2, 'female:dickgirl on female': 3,
  'female:double penetration': 2, 'female:exhibitionism': 1.5, 'female:femdom': 3,
  'female:fingering': 1.5, 'female:futanari': 5, 'female:glasses': 1.5,
  'female:gloves': 1.5, 'female:gyaru': 3, 'female:hairy': 2, 'female:handjob': 1.5,
  'female:harem': 3, 'female:huge breasts': 2, 'female:impregnation': 2,
  'female:kemonomimi': 2, 'female:kissing': 1.5, 'female:lactation': 2,
  'female:lingerie': 2, 'female:lolicon': 5, 'female:masturbation': 1.5,
  'female:milf': 3, 'female:mind control': 3, 'female:mother': 3,
  'female:nakadashi': 2, 'female:netorare': 3, 'female:paizuri': 1.5,
  'female:pantyhose': 2, 'female:ponytail': 1.5, 'female:public use': 3,
  'female:rape': 3, 'female:schoolgirl uniform': 1.5, 'female:sex toys': 1.5,
  'female:shemale': 4, 'female:sister': 2, 'female:squirting': 1.5,
  'female:stockings': 2, 'female:sweating': 1.5, 'female:swimsuit': 1.5,
  'female:tomboy': 4, 'female:yuri': 3,
  'male:anal': 3, 'male:bbm': 3, 'male:big penis': 1.5, 'male:condom': 1.5,
  'male:crossdressing': 3, 'male:dark skin': 3, 'male:dilf': 3,
  'male:gender change': 4, 'male:harem': 3, 'male:netorare': 3,
  'male:shotacon': 3, 'male:tomgirl': 5, 'male:virginity': 3, 'male:yaoi': 4,
  'mixed:ffm threesome': 2, 'mixed:group': 2, 'mixed:incest': 3,
  'mixed:mmf threesome': 2,
  'other:3d': 3, 'other:ai 超分': 0, 'other:mosaic censorship': 0, 'other:uncensored': 0,
  // Namespace-level fallbacks (matched by the `namespace:` prefix).
  'parody:': 2, 'character:': 2, 'cosplayer:': 3,
  'group:': 0.1, 'artist:': 0.1, 'category:': 0.1,
  'female:': TASTE_NAMESPACE_WEIGHT, 'male:': TASTE_NAMESPACE_WEIGHT,
  'other:': TASTE_NAMESPACE_WEIGHT, 'others:': TASTE_NAMESPACE_WEIGHT,
  'mixed:': TASTE_NAMESPACE_WEIGHT,
  'language:': 0, 'uploader:': 0, 'timestamp:': 0, 'source:': 0,
  'date_added:': 0, 'dateadded:': 0,
};

/** 全站频次折算出的稀有度倍率：越少见的标签越能区分口味。表没装、或该标签不在
 *  表里（低于入库门槛的长尾）时返回 1，打分与没有这张表时完全一致。 */
export function tagRarity(tag: string): number {
  const frequency = getTagFrequency(tag.trim().toLowerCase());
  if (!frequency || !Number.isFinite(frequency)) return 1;
  const decades = Math.log10(RARITY_REFERENCE / Math.max(frequency, 1)) / RARITY_DECADES;
  const clamped = Math.min(Math.max(decades, 0), 1);
  return 1 + RARITY_SPAN * clamped;
}

/** 抖动因子：同一个（标签, 种子）永远得到同一个倍率，所以一次运行内部稳定、可复现，
 *  换个种子才换答案。种子为 undefined 时不抖动。 */
export function tagJitter(tag: string, seed: number): number {
  let hash = 2166136261 ^ (seed | 0);
  const text = tag.trim().toLowerCase();
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // FNV-1a 的雪崩够不到最后一个字符：只差一位的两个标签，差值要穿过一次乘法才进
  // 结果，而乘数只有 2^32 的 0.4%，实测倍率只差 0.003 —— 等于没抖。补一轮终结混合。
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  const unit = (hash >>> 0) / 0xffffffff;
  return 1 + JITTER_SPAN * (unit * 2 - 1);
}

export function createRecommendationSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** 按种子洗牌：推荐栏问哪几个标签也要每次不一样，但同一种子必须给出同一结果。 */
export function createSeededShuffle(seed: number): <T>(items: T[]) => T[] {
  return <T,>(items: T[]): T[] => {
    let state = (seed | 0) || 1;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(next() * (index + 1));
      const held = copy[index] as T;
      copy[index] = copy[swap] as T;
      copy[swap] = held;
    }
    return copy;
  };
}

export function tagWeight(tag: string): number {
  const normalized = tag.trim().toLowerCase();
  const exact = TAG_WEIGHTS[normalized];
  if (exact !== undefined) return exact;
  const separator = normalized.indexOf(':');
  if (separator > 0) return TAG_WEIGHTS[normalized.slice(0, separator + 1)] ?? 0;
  return 0;
}

function namespaceOf(tag: string): string {
  const separator = tag.indexOf(':');
  return separator > 0 ? tag.slice(0, separator).trim().toLowerCase() : '';
}

/** Tags worth querying LANraragi with. Taste namespaces first; character/parody
 * only when the archive carries no taste tags at all. */
export function pickSeedTags(tags: readonly string[], limit?: number, shuffle: <T>(items: T[]) => T[] = identity): string[] {
  const primary: string[] = [];
  const fallback: string[] = [];
  for (const tag of tags) {
    const namespace = namespaceOf(tag);
    if (!namespace) continue;
    if (PRIMARY_NAMESPACES.includes(namespace)) primary.push(tag);
    else if (FALLBACK_NAMESPACES.includes(namespace)) fallback.push(tag);
  }
  const base = primary.length > 0 ? primary : fallback;
  if (base.length === 0) return [];
  const budget = limit ?? (tags.length > 40 ? 7 : tags.length > 20 ? 5 : 3);
  return shuffle([...base]).slice(0, Math.min(budget, base.length));
}

function identity<T>(items: T[]): T[] {
  return items;
}

export interface RecommendationCandidate {
  archiveId: string;
  title?: string | undefined;
  tags?: readonly string[] | undefined;
  pageCount?: number | undefined;
  readPages?: number | undefined;
}

export interface RecommendationOptions {
  /** 抖动种子：给了就按它给每个标签加同幅度的抖动，同种子结果可复现。 */
  seed?: number | undefined;
}

export function scoreCandidate(
  sourceTags: ReadonlySet<string>,
  candidate: RecommendationCandidate,
  options: RecommendationOptions = {},
): number {
  let score = 0;
  let relevant = 0;
  let matched = 0;
  for (const normalized of normalizeSourceTags(candidate.tags ?? [])) {
    if (tagWeight(normalized) <= 0) continue;
    relevant++;
    if (!sourceTags.has(normalized)) continue;
    // 手写权重 × 全站稀有度 × 本次抖动的乘积：稀有标签更能说明口味，抖动只挪动
    // 「差不多相等」的那一档。
    const influence = tagWeight(normalized) * tagRarity(normalized);
    if (influence === 0) continue;
    matched++;
    score += options.seed === undefined ? influence : influence * tagJitter(normalized, options.seed);
  }
  if (score === 0) return 0;
  // A broad tag catalogue should not win just by offering more chances to hit.
  // Keep strong individual signals, but discount unrelated tag volume and low
  // coverage. Zero-weight bookkeeping tags do not dilute a recommendation.
  score *= Math.sqrt(matched / relevant) / Math.sqrt(1 + Math.max(0, relevant - 20) / 20);
  // A finished archive is a weaker suggestion than an unread one.
  if (candidate.pageCount && candidate.readPages && candidate.readPages >= candidate.pageCount) score *= 0.5;
  return score;
}

export function normalizeSourceTags(tags: readonly string[]): Set<string> {
  return new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
}

/** Ranks candidates by weighted tag overlap, preferring the source's own
 * category before filling the remainder from other categories. */
export function rankRecommendations<T extends RecommendationCandidate>(
  sourceTags: readonly string[],
  candidates: readonly T[],
  limit = RECOMMENDATION_LIMIT,
  options: RecommendationOptions = {},
): T[] {
  const normalized = normalizeSourceTags(sourceTags);
  const sourceCategories = new Set([...normalized].filter((tag) => namespaceOf(tag) === 'category'));
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(normalized, candidate, options) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.archiveId.localeCompare(right.candidate.archiveId));
  if (sourceCategories.size === 0) return scored.slice(0, limit).map((entry) => entry.candidate);

  const sameCategory = scored.filter(({ candidate }) => (candidate.tags ?? []).some((tag) => sourceCategories.has(tag.trim().toLowerCase())));
  const otherCategory = scored.filter(({ candidate }) => !(candidate.tags ?? []).some((tag) => sourceCategories.has(tag.trim().toLowerCase())));
  return [...sameCategory, ...otherCategory].slice(0, limit).map((entry) => entry.candidate);
}

/** Cosplay sets are grouped by cosplayer; everything else by artist/group. */
export function sameCreatorTags(tags: readonly string[]): { namespace: 'cosplayer' | 'artist'; tags: string[] } {
  const hasCosplayCategory = tags.some((tag) => tag.trim().toLowerCase() === 'category:cosplay');
  const hasCosplayer = hasCosplayCategory && tags.some((tag) => namespaceOf(tag) === 'cosplayer');
  if (hasCosplayer) {
    return { namespace: 'cosplayer', tags: tags.filter((tag) => namespaceOf(tag) === 'cosplayer') };
  }
  return { namespace: 'artist', tags: tags.filter((tag) => ['artist', 'group'].includes(namespaceOf(tag))) };
}

/** Creator matches stay easy to scan: unfinished work first, then
 * completed work, with archive title as the only user-facing ordering key. */
export function sortSameCreatorRecommendations<T extends RecommendationCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) => {
    const leftFinished = Boolean(left.pageCount && left.readPages !== undefined && left.readPages >= left.pageCount);
    const rightFinished = Boolean(right.pageCount && right.readPages !== undefined && right.readPages >= right.pageCount);
    if (leftFinished !== rightFinished) return leftFinished ? 1 : -1;
    return (left.title ?? '').localeCompare(right.title ?? '', undefined, { sensitivity: 'base' })
      || left.archiveId.localeCompare(right.archiveId);
  });
}
