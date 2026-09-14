export const DEDUPE_DEFAULT_START_DATE = '2000-01-01';

export interface DedupeArchive {
  arcid?: string | number;
  id?: string | number;
  title?: string;
  tags?: string | readonly string[] | undefined;
  size?: number | string | undefined;
  filesize?: number | string | undefined;
  file_size?: number | string | undefined;
  pagecount?: number | string | undefined;
  total?: number | string | undefined;
  date_added?: number | string | undefined;
}

export interface DedupeSignature {
  width: number;
  height: number;
  ratio: number;
  pixels: Uint8Array | Uint8ClampedArray;
  filename?: string;
  title?: string;
  pageCount?: number;
  fileSize?: number;
}

export interface DuplicatePair {
  left: string;
  right: string;
}

export type DuplicateSource = 'image' | 'filename';

export function toPairKey(left: unknown, right: unknown): string {
  const leftId = String(left ?? '').trim();
  const rightId = String(right ?? '').trim();
  return !leftId || !rightId || leftId === rightId ? '' : [leftId, rightId].sort().join('|');
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

function dateToDayString(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

/** Local calendar day, the same basis `normalizeDedupeDateRange` uses for its
 * default upper bound. Using a UTC day here would drop archives added today. */
export function toDedupeDayString(date: Date = new Date()): string {
  return dateToDayString(date);
}

function parseArchiveDateValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number') return dateToDayString(new Date((value > 1e12 ? value : value * 1000)));
  const text = String(value).trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    const numericValue = Number(text);
    return Number.isFinite(numericValue) ? dateToDayString(new Date((numericValue > 1e12 ? numericValue : numericValue * 1000))) : '';
  }
  return dateToDayString(new Date(text));
}

function explicitArchiveDateDay(archive: DedupeArchive): string {
  const direct = parseArchiveDateValue(archive.date_added);
  if (direct) return direct;
  const tagMatch = String(archive.tags ?? '').match(/(?:^|,\s*)date_added:(\d+)/);
  return tagMatch?.[1] ? parseArchiveDateValue(tagMatch[1]) : '';
}

export function normalizeDedupeDateRange(start: unknown, end: unknown, today = dateToDayString(new Date())): { start: string; end: string } {
  let normalizedStart = /^\d{4}-\d{2}-\d{2}$/.test(String(start ?? '')) ? String(start) : DEDUPE_DEFAULT_START_DATE;
  let normalizedEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(end ?? '')) ? String(end) : today;
  if (normalizedStart > normalizedEnd) [normalizedStart, normalizedEnd] = [normalizedEnd, normalizedStart];
  return { start: normalizedStart, end: normalizedEnd };
}

export function filterArchivesByDateRange<T extends DedupeArchive>(archives: readonly T[] | undefined, start: unknown, end: unknown): readonly T[] {
  const range = normalizeDedupeDateRange(start, end);
  if (range.start <= DEDUPE_DEFAULT_START_DATE) return archives ?? [];
  return (archives ?? []).filter((archive) => {
    const day = explicitArchiveDateDay(archive);
    return !day || (day >= range.start && day <= range.end);
  });
}

export function buildDuplicateGroups(pairs: Iterable<Partial<DuplicatePair>> | undefined, ignoredPairKeys: ReadonlySet<string> = new Set()): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const pair of pairs ?? []) {
    const key = toPairKey(pair.left, pair.right);
    if (!key || ignoredPairKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    groups.push(key.split('|'));
  }
  return groups.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

function archiveId(item: unknown): string {
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  if (!item || typeof item !== 'object') return '';
  const archive = item as DedupeArchive;
  return String(archive.arcid || archive.id || '').trim();
}

function duplicateGroupIds(group: readonly unknown[]): string[] {
  return group.map(archiveId).filter(Boolean);
}

interface SelectionModel {
  groupsById: Map<string, string[][]>;
  componentById: Map<string, Set<string>>;
  ids: string[];
}

function buildDuplicateSelectionModel(groups: readonly (readonly unknown[])[]): SelectionModel {
  const groupsById = new Map<string, string[][]>();
  const neighbors = new Map<string, Set<string>>();
  for (const group of groups) {
    const ids = [...new Set(duplicateGroupIds(group))];
    if (ids.length < 2) continue;
    for (const id of ids) {
      if (!groupsById.has(id)) groupsById.set(id, []);
      groupsById.get(id)!.push(ids);
      if (!neighbors.has(id)) neighbors.set(id, new Set());
      for (const otherId of ids) if (otherId !== id) neighbors.get(id)!.add(otherId);
    }
  }
  const componentById = new Map<string, Set<string>>();
  for (const startId of neighbors.keys()) {
    if (componentById.has(startId)) continue;
    const component = new Set<string>();
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift()!;
      if (component.has(id)) continue;
      component.add(id);
      for (const neighbor of neighbors.get(id) ?? []) if (!component.has(neighbor)) queue.push(neighbor);
    }
    for (const id of component) componentById.set(id, component);
  }
  return { groupsById, componentById, ids: [...neighbors.keys()] };
}

function canAddDuplicateSelection(model: SelectionModel, selected: ReadonlySet<string>, id: string): boolean {
  if (!id || selected.has(id) || !model.groupsById.has(id)) return false;
  const component = model.componentById.get(id);
  return !component || [...component].filter((componentId) => selected.has(componentId)).length < component.size - 1;
}

export function groupDuplicatePairsByChain<T>(groups: readonly (readonly T[])[]): T[][][] {
  const model = buildDuplicateSelectionModel(groups);
  const chains = new Map<Set<string>, T[][]>();
  for (const group of groups) {
    const ids = duplicateGroupIds(group);
    if (ids.length < 2) continue;
    const component = model.componentById.get(ids[0]!);
    if (!component) continue;
    if (!chains.has(component)) chains.set(component, []);
    chains.get(component)!.push([...group]);
  }
  return [...chains.values()];
}

export function getDedupeGroupFilterData<T>(groups: readonly (readonly T[])[], duplicateSourceByGroupKey: Readonly<Record<string, DuplicateSource>> = {}) {
  const allGroups = groups.map((group) => [...group]);
  const sourceOf = (group: readonly T[]): DuplicateSource => duplicateSourceByGroupKey[[...duplicateGroupIds(group)].sort().join('|')] === 'image' ? 'image' : 'filename';
  const imageGroups = allGroups.filter((group) => sourceOf(group) === 'image');
  const filenameGroups = allGroups.filter((group) => sourceOf(group) === 'filename');
  const allChains = groupDuplicatePairsByChain(allGroups);
  return { allGroups, imageGroups, filenameGroups, allChains, chains: allChains.filter((chain) => chain.length > 1) };
}

export function normalizeDuplicateSelection(groups: readonly (readonly unknown[])[], requestedIds: Iterable<unknown> | undefined): string[] {
  const model = buildDuplicateSelectionModel(groups);
  const selected = new Set<string>();
  const accepted: string[] = [];
  for (const value of requestedIds ?? []) {
    const id = String(value ?? '').trim();
    if (!canAddDuplicateSelection(model, selected, id)) continue;
    selected.add(id);
    accepted.push(id);
  }
  return accepted;
}

export function getDuplicateSelectionDisabledIds(groups: readonly (readonly unknown[])[], selectedIds: Iterable<unknown> | undefined): Set<string> {
  const model = buildDuplicateSelectionModel(groups);
  const selected = new Set(normalizeDuplicateSelection(groups, selectedIds));
  return new Set(model.ids.filter((id) => !selected.has(id) && !canAddDuplicateSelection(model, selected, id)));
}

export interface DedupeSmartSignals {
  roughTranslation: boolean;
  extraneousAds: boolean;
  uncensored: boolean;
  noChinese: boolean;
}

/** 智能选择信号（Readoshi 的 getDedupeSmartSelectionSignals）：渣翻/外部广告/
 * 无修正/无汉语——工作区把它们作为卡片标签显示，保留评分使用同一套判定。 */
export function getDedupeSmartSignals(archive: DedupeArchive): DedupeSmartSignals {
  const tags = tagSet(archive);
  return {
    roughTranslation: tags.has('other:rough translation'),
    extraneousAds: tags.has('other:extraneous ads'),
    uncensored: tags.has('other:uncensored'),
    noChinese: !tags.has('language:chinese'),
  };
}

function tagSet(archive: DedupeArchive): Set<string> {
  const raw = Array.isArray(archive.tags) ? archive.tags.join(',') : archive.tags;
  return new Set(String(raw ?? '').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean));
}

function archiveSize(archive: DedupeArchive): number {
  const size = Number(archive.size ?? archive.filesize ?? archive.file_size ?? 0);
  return Number.isFinite(size) ? size : 0;
}

function keepScore(archive: DedupeArchive, index: number): readonly number[] {
  const tags = tagSet(archive);
  return [tags.has('language:chinese') ? 1 : 0, tags.has('other:rough translation') ? 0 : 1, tags.has('other:uncensored') ? 1 : 0, tags.has('other:extraneous ads') ? 0 : 1, archiveSize(archive), -index];
}

function isScoreGreater(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    return left[index]! > right[index]!;
  }
  return false;
}

export function selectDuplicateDeletionIds<T extends DedupeArchive>(archives: readonly T[] | undefined): string[] {
  const items = (archives ?? []).filter((archive) => archiveId(archive));
  if (items.length < 2) return [];
  let keepIndex = 0;
  let best = keepScore(items[0]!, 0);
  for (let index = 1; index < items.length; index += 1) {
    const score = keepScore(items[index]!, index);
    if (isScoreGreater(score, best)) { keepIndex = index; best = score; }
  }
  return items.filter((_, index) => index !== keepIndex).map(archiveId);
}

export function mergeSmartDuplicateSelection<T extends DedupeArchive>(groups: readonly (readonly T[])[], protectedGroupKeys: Iterable<unknown> | undefined, selectedArchiveIds: Iterable<unknown> = [], selectedGroupKeys: Iterable<unknown> = [], duplicateSourceByGroupKey: Readonly<Record<string, DuplicateSource>> = {}, options: { includeFilenameOnly?: boolean } = {}) {
  const protectedKeys = new Set([...protectedGroupKeys ?? []].map((key) => String(key)));
  const groupKey = (group: readonly T[]) => duplicateGroupIds(group).sort().join('|');
  const protectedGroups = groups.filter((group) => protectedKeys.has(groupKey(group)));
  const protectedArchiveIds = new Set(protectedGroups.flatMap(duplicateGroupIds));
  const retainedArchiveIds = [...selectedArchiveIds].map((id) => String(id)).filter((id) => protectedArchiveIds.has(id));
  const retainedGroupKeys = [...selectedGroupKeys].map((key) => String(key)).filter((key) => protectedKeys.has(key));
  const generatedGroups = groups.filter((group) => !protectedKeys.has(groupKey(group)));
  const includesSource = (group: readonly T[]) => duplicateSourceByGroupKey[groupKey(group)] === 'image' || (options.includeFilenameOnly && duplicateSourceByGroupKey[groupKey(group)] === 'filename');
  const generatedArchiveIds = generatedGroups.filter(includesSource).flatMap((group) => selectDuplicateDeletionIds(group).slice(0, 1));
  return {
    archiveIds: normalizeDuplicateSelection(groups, [...retainedArchiveIds, ...generatedArchiveIds]),
    groupKeys: retainedGroupKeys,
    skippedFilenameOnlyCount: generatedGroups.filter((group) => !includesSource(group)).length,
  };
}

export function countDuplicateGroupsWithLargePageGap(groups: readonly (readonly DedupeArchive[])[], threshold = 10): number {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit < 0) return 0;
  return groups.filter((group) => {
    const counts = group.map((archive) => Number(archive.pagecount) || Number(archive.total)).filter((count) => Number.isFinite(count) && count > 0);
    return counts.length >= 2 && Math.max(...counts) - Math.min(...counts) > limit;
  }).length;
}

const FILENAME_RELEASE_MARKER = /\[(?:中国翻訳|中国翻译|中国語|chinese|中文|dl版|dl|digital|無修正|无修正|uncensored|翻訳|翻译)\]/giu;

export function normalizeDedupeFilename(value: unknown): string {
  return String(value ?? '').replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&').normalize('NFKC').toLowerCase().replace(/\.(?:zip|rar|7z|cbz|cbr)$/i, '').replace(FILENAME_RELEASE_MARKER, '').replace(/\((?:chinese|english|japanese|korean)\)/gi, '').replace(/_g\d+$/i, '').replace(/[^\p{L}\p{N}]+/gu, '').trim();
}

export function filenameSimilarity(left: string, right: string): number {
  if (!left || !right || left.length < 16 || right.length < 16) return 0;
  const maxLength = Math.max(left.length, right.length);
  if (Math.abs(left.length - right.length) / maxLength > 0.2 || maxLength > 180 || (left.slice(0, 4) !== right.slice(0, 4) && left.slice(-4) !== right.slice(-4))) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]!;
      previous[rightIndex] = Math.min(above + 1, previous[rightIndex - 1]! + 1, diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - previous[right.length]! / maxLength;
}

interface FilenameEvidence { leftName: string; exact: boolean; similar: boolean; }

function filenameEvidence(left: DedupeSignature, right: DedupeSignature): FilenameEvidence {
  const leftName = normalizeDedupeFilename(left.filename ?? left.title);
  const rightName = normalizeDedupeFilename(right.filename ?? right.title);
  return leftName && leftName === rightName ? { leftName, exact: leftName.length >= 12, similar: false } : { leftName, exact: false, similar: filenameSimilarity(leftName, rightName) >= 0.92 };
}

interface Texture { standardDeviation: number; mean: number; dominantFraction: number; layout: number[]; isUniform: boolean; }

function signatureTexture(signature: DedupeSignature): Texture {
  const pixelCount = Math.min(Math.floor(signature.pixels.length / 4), Math.max(1, signature.width * signature.height));
  if (!pixelCount) return { standardDeviation: 0, mean: 0, dominantFraction: 0, layout: [], isUniform: true };
  const layout: number[] = [];
  let sum = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const luminance = signature.pixels[offset]! * 0.299 + signature.pixels[offset + 1]! * 0.587 + signature.pixels[offset + 2]! * 0.114;
    layout.push(luminance); sum += luminance;
  }
  const mean = sum / pixelCount;
  const standardDeviation = Math.sqrt(layout.reduce((total, value) => total + (value - mean) ** 2, 0) / pixelCount);
  const bins = new Map<number, number>();
  for (const value of layout) {
    const bin = Math.min(15, Math.floor(value / 16));
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const dominantFraction = Math.max(...bins.values()) / pixelCount;
  return { standardDeviation, mean, dominantFraction, layout, isUniform: dominantFraction >= 0.98 && standardDeviation <= 4 };
}

function shapeMismatch(left: DedupeSignature, right: DedupeSignature, pageCountRatioLimit = 1.65, minimumPageCountDelta = 8, fileSizeRatioLimit = 2.25, minimumFileSizeDelta = 1_000_000): boolean {
  const leftPages = Number(left.pageCount); const rightPages = Number(right.pageCount);
  if (Number.isFinite(leftPages) && Number.isFinite(rightPages) && leftPages > 0 && rightPages > 0 && Math.max(leftPages, rightPages) - Math.min(leftPages, rightPages) >= minimumPageCountDelta && Math.max(leftPages, rightPages) / Math.min(leftPages, rightPages) > pageCountRatioLimit) return true;
  const leftSize = Number(left.fileSize); const rightSize = Number(right.fileSize);
  return Number.isFinite(leftSize) && Number.isFinite(rightSize) && leftSize > 0 && rightSize > 0 && Math.max(leftSize, rightSize) - Math.min(leftSize, rightSize) >= minimumFileSizeDelta && Math.max(leftSize, rightSize) / Math.min(leftSize, rightSize) > fileSizeRatioLimit;
}

function lowInformationPair(left: Texture, right: Texture, dominantColorFraction = 0.75, dominantLayoutDistance = 0.08, uniformColorFraction = 0.98, uniformLayoutDistance = 0.03, uniformStdDev = 4): boolean {
  if (left.dominantFraction < dominantColorFraction || right.dominantFraction < dominantColorFraction) return false;
  const size = Math.min(left.layout.length, right.layout.length);
  const distance = size ? left.layout.slice(0, size).reduce((total, value, index) => total + Math.abs(value - right.layout[index]!), 0) / size / 255 : 1;
  return distance > dominantLayoutDistance || (left.dominantFraction >= uniformColorFraction && right.dominantFraction >= uniformColorFraction && left.standardDeviation <= uniformStdDev && right.standardDeviation <= uniformStdDev && distance <= uniformLayoutDistance);
}

export interface SignatureComparisonOptions {
  pixelThreshold?: number; percentDifference?: number; aspectRatioLimit?: number; outlierPercent?: number; lowTextureStdDev?: number; highTextureStdDev?: number; dominantColorFraction?: number; dominantLayoutDistance?: number; uniformColorFraction?: number; uniformLayoutDistance?: number; uniformStdDev?: number; pageCountRatioLimit?: number; minimumPageCountDelta?: number; allowLowInformationMatch?: boolean;
}

/** A truncated pixel buffer used to read as `undefined` per channel, which made
 * every difference `NaN`; `NaN > threshold` is false, so the comparison reported
 * "identical" and the pair became a deletion candidate. Fail closed instead. */
function hasCompletePixels(signature: DedupeSignature): boolean {
  return signature.width > 0 && signature.height > 0 && signature.pixels.length >= signature.width * signature.height * 4;
}

export function areSignaturesDuplicate(left: DedupeSignature | undefined, right: DedupeSignature | undefined, options: SignatureComparisonOptions = {}): boolean {
  const { pixelThreshold = 30, percentDifference = 0.2, aspectRatioLimit = 0.1, outlierPercent = 0.15, lowTextureStdDev = 12, highTextureStdDev = 32, dominantColorFraction = 0.75, dominantLayoutDistance = 0.08, uniformColorFraction = 0.98, uniformLayoutDistance = 0.03, uniformStdDev = 4, pageCountRatioLimit = 1.65, minimumPageCountDelta = 8, allowLowInformationMatch = false } = options;
  if (!left || !right || !hasCompletePixels(left) || !hasCompletePixels(right) || Math.abs(left.ratio - right.ratio) > aspectRatioLimit || shapeMismatch(left, right, pageCountRatioLimit, minimumPageCountDelta)) return false;
  const leftTexture = signatureTexture(left); const rightTexture = signatureTexture(right);
  if ((leftTexture.standardDeviation <= lowTextureStdDev && rightTexture.standardDeviation >= highTextureStdDev) || (rightTexture.standardDeviation <= lowTextureStdDev && leftTexture.standardDeviation >= highTextureStdDev) || (!allowLowInformationMatch && leftTexture.dominantFraction >= dominantColorFraction && rightTexture.dominantFraction >= dominantColorFraction) || lowInformationPair(leftTexture, rightTexture, dominantColorFraction, dominantLayoutDistance, uniformColorFraction, uniformLayoutDistance, uniformStdDev)) return false;
  const width = Math.min(left.width, right.width); const height = Math.min(left.height, right.height);
  const differences: number[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const leftOffset = (y * left.width + x) * 4; const rightOffset = (y * right.width + x) * 4;
    differences.push(Math.abs(left.pixels[leftOffset]! - right.pixels[rightOffset]!) + Math.abs(left.pixels[leftOffset + 1]! - right.pixels[rightOffset + 1]!) + Math.abs(left.pixels[leftOffset + 2]! - right.pixels[rightOffset + 2]!));
  }
  const changedRatio = differences.filter((difference) => difference > pixelThreshold).length / differences.length;
  if (changedRatio < percentDifference) return true;
  if (changedRatio > 0.55 || outlierPercent <= 0) return false;
  differences.sort((a, b) => a - b);
  const retained = differences.slice(0, Math.max(1, Math.floor(differences.length * (1 - outlierPercent))));
  return retained.filter((difference) => difference > pixelThreshold).length / retained.length < percentDifference;
}

export interface FindDuplicatePairOptions extends SignatureComparisonOptions { onPair?: (pair: DuplicatePair & { source: DuplicateSource }) => void; }

export function findDuplicatePairs(signatures: ReadonlyMap<string, DedupeSignature> | Iterable<readonly [string, DedupeSignature]>, ignoredPairKeys: ReadonlySet<string> = new Set(), options: FindDuplicatePairOptions = {}): DuplicatePair[] {
  const entries = [...signatures].filter((entry): entry is [string, DedupeSignature] => Boolean(entry[0]) && Boolean(entry[1]));
  // One texture pass per signature. Recomputing inside the O(n²) pair loop meant
  // up to five full-pixel scans per pair.
  const textures = entries.map(([, signature]) => signatureTexture(signature));
  const names = entries.map(([, signature]) => normalizeDedupeFilename(signature.filename ?? signature.title));
  const nameCounts = new Map<string, number>();
  for (const name of names) if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const pairs: DuplicatePair[] = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
    const [leftId, left] = entries[leftIndex]!; const [rightId, right] = entries[rightIndex]!;
    const key = toPairKey(leftId, rightId); const evidence = filenameEvidence(left, right);
    if (key && !ignoredPairKeys.has(key) && evidence.exact && nameCounts.get(evidence.leftName)! <= 2) pairs.push({ left: leftId, right: rightId });
  }
  const exactPairKeys = new Set(pairs.map((pair) => toPairKey(pair.left, pair.right)));
  const imageMatchedPairKeys = new Set<string>();
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
    const [leftId, left] = entries[leftIndex]!; const [rightId, right] = entries[rightIndex]!; const key = toPairKey(leftId, rightId);
    if (!key || ignoredPairKeys.has(key)) continue;
    const leftTexture = textures[leftIndex]!; const rightTexture = textures[rightIndex]!;
    const evidence = filenameEvidence(left, right);
    if (leftTexture.isUniform || rightTexture.isUniform) continue;
    if (!evidence.exact && !evidence.similar && (shapeMismatch(left, right, 1.15, 2) || Math.abs(leftTexture.mean - rightTexture.mean) > 96 || lowInformationPair(leftTexture, rightTexture))) continue;
    const imageOptions = evidence.exact && nameCounts.get(evidence.leftName)! <= 2
      ? { ...options, allowLowInformationMatch: true, outlierPercent: Math.max(options.outlierPercent ?? 0.15, 0.35) }
      : evidence.similar
        ? { ...options, allowLowInformationMatch: true, percentDifference: Math.max(options.percentDifference ?? 0.2, 0.28) }
        : options;
    if (areSignaturesDuplicate(left, right, imageOptions)) {
      if (exactPairKeys.has(key)) imageMatchedPairKeys.add(key);
      else { pairs.push({ left: leftId, right: rightId }); options.onPair?.({ left: leftId, right: rightId, source: 'image' }); }
    }
  }
  for (const pair of pairs) if (exactPairKeys.has(toPairKey(pair.left, pair.right))) options.onPair?.({ ...pair, source: imageMatchedPairKeys.has(toPairKey(pair.left, pair.right)) ? 'image' : 'filename' });
  return pairs;
}
