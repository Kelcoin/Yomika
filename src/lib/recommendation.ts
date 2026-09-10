/** Similar-archive recommendation rules, ported from Readoshi's
 * `src/components/Recommendations.jsx`.
 *
 * A tag shared with the source archive scores its weight; namespaces that say
 * nothing about taste (language, uploader, source, timestamps) score zero, and
 * broad namespaces (artist, group, category) score almost nothing so they cannot
 * dominate a match. Finished archives are down-weighted.
 */
export const RECOMMENDATION_LIMIT = 15;

const PRIMARY_NAMESPACES = ['female', 'male', 'others', 'other'];
const FALLBACK_NAMESPACES = ['character', 'parody'];

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
  'language:': 0, 'uploader:': 0, 'timestamp:': 0, 'source:': 0,
  'date_added:': 0, 'dateadded:': 0,
};

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

export function scoreCandidate(sourceTags: ReadonlySet<string>, candidate: RecommendationCandidate): number {
  let score = 0;
  for (const tag of candidate.tags ?? []) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || !sourceTags.has(normalized)) continue;
    score += tagWeight(normalized);
  }
  if (score === 0) return 0;
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
): T[] {
  const normalized = normalizeSourceTags(sourceTags);
  const sourceCategories = new Set([...normalized].filter((tag) => namespaceOf(tag) === 'category'));
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(normalized, candidate) }))
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

/** Readoshi keeps creator matches easy to scan: unfinished work first, then
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
