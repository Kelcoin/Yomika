import { describe, expect, it } from 'vitest';
import {
  areSignaturesDuplicate,
  buildDuplicateGroups,
  countDuplicateGroupsWithLargePageGap,
  filterArchivesByDateRange,
  findDuplicatePairs,
  getDedupeGroupFilterData,
  getDedupeSmartSignals,
  getDuplicateSelectionDisabledIds,
  groupDuplicatePairsByChain,
  mergeSmartDuplicateSelection,
  normalizeDedupeDateRange,
  normalizeDedupeFilename,
  normalizeDuplicateSelection,
  selectDuplicateDeletionIds,
  toPairKey,
} from '../../src/domain/deduplication';

function texturedSignature(patch = false) {
  const pixels = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
    const offset = (y * 8 + x) * 4;
    const value = patch && x >= 6 && y >= 4 ? 255 - ((x * 23 + y * 17) % 256) : (x * 23 + y * 17) % 256;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return { width: 8, height: 8, ratio: 1, pixels };
}

function exactFilenameWatermarkSignature(patch = false) {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const offset = (y * 16 + x) * 4;
    let value = (x * 19 + y * 11) % 256;
    if (patch && x >= 10 && y >= 1) value = 255 - value;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  }
  return { width: 16, height: 16, ratio: 1, filename: '[Circle] Longer Work [DL版]', pixels };
}

describe('deduplication domain', () => {
  it('refuses to call a pair duplicate when a pixel buffer is truncated', () => {
    const complete = texturedSignature();
    // Same image, buffer cut short: the missing channels used to read as
    // `undefined`, making every difference NaN and the pair "identical".
    const truncated = { ...complete, pixels: complete.pixels.slice(0, 8 * 8 * 4 - 6) };

    expect(areSignaturesDuplicate(complete, truncated)).toBe(false);
    expect(areSignaturesDuplicate(truncated, complete)).toBe(false);
    expect(areSignaturesDuplicate({ ...complete, width: 0, height: 0 }, complete)).toBe(false);
  });

  it('creates a stable key only for a non-empty, non-self pair', () => {
    expect(toPairKey('B', 'A')).toBe('A|B');
    expect(toPairKey('', 'A')).toBe('');
    expect(toPairKey('A', 'A')).toBe('');
  });

  it('normalizes and swaps invalid date range bounds deterministically', () => {
    expect(normalizeDedupeDateRange('2026-06-01', '2026-01-01', '2026-09-01')).toEqual({ start: '2026-01-01', end: '2026-06-01' });
    expect(normalizeDedupeDateRange('nope', '', '2026-09-01')).toEqual({ start: '2000-01-01', end: '2026-09-01' });
  });

  it('filters explicit archive dates while retaining unknown dates', () => {
    expect(filterArchivesByDateRange([
      { arcid: 'old', date_added: 1_704_067_200 },
      { arcid: 'inside', date_added: 1_709_251_200 },
      { arcid: 'unknown' },
    ], '2024-03-01', '2024-03-31')).toEqual([
      { arcid: 'inside', date_added: 1_709_251_200 },
      { arcid: 'unknown' },
    ]);
  });

  it('builds sorted, unique valid duplicate pair groups', () => {
    expect(buildDuplicateGroups([
      { left: 'B', right: 'A' }, { left: 'A', right: 'B' }, { left: 'A', right: 'A' }, { left: '', right: 'D' }, { left: 'D', right: 'C' },
    ])).toEqual([['A', 'B'], ['C', 'D']]);
  });

  it('keeps pairs as pairs and places connected pairs into encounter-ordered chains', () => {
    expect(groupDuplicatePairsByChain([['D', 'E'], ['A', 'B'], ['X', 'Y'], ['A', 'C'], ['E', 'F']])).toEqual([
      [['D', 'E'], ['E', 'F']], [['A', 'B'], ['A', 'C']], [['X', 'Y']],
    ]);
  });

  it('separates image and filename group filters while exposing only multi-pair chains', () => {
    const image = [{ arcid: 'A' }, { arcid: 'B' }];
    const filename = [{ arcid: 'B' }, { arcid: 'C' }];
    const standalone = [{ arcid: 'D' }, { arcid: 'E' }];
    const result = getDedupeGroupFilterData([image, filename, standalone], { 'A|B': 'image', 'B|C': 'filename', 'D|E': 'image' });
    expect(result.imageGroups).toEqual([image, standalone]);
    expect(result.filenameGroups).toEqual([filename]);
    expect(result.chains).toEqual([[image, filename]]);
  });

  it('never selects every archive in a connected duplicate component', () => {
    const groups = [['A', 'B'], ['A', 'C'], ['B', 'C']];
    expect(normalizeDuplicateSelection(groups, ['A', 'B', 'C'])).toEqual(['A', 'B']);
    expect([...getDuplicateSelectionDisabledIds(groups, new Set(['A', 'B']))]).toEqual(['C']);
  });

  it('uses id when arcid is present but empty', () => {
    expect(normalizeDuplicateSelection([[{ arcid: '', id: 'B' }, { arcid: 'C' }]], ['B'])).toEqual(['B']);
  });

  it('chooses deletion candidates using the predefined quality ordering', () => {
    expect(selectDuplicateDeletionIds([
      { arcid: 'no-chinese', tags: '', size: 100 },
      { arcid: 'chinese-rough', tags: 'language:chinese, other:rough translation', size: 1 },
      { arcid: 'clean', tags: 'language:chinese, other:uncensored', size: 10 },
    ])).toEqual(['no-chinese', 'chinese-rough']);
  });

  it('does not let a lower-priority quality signal override Chinese-language preference', () => {
    expect(selectDuplicateDeletionIds([
      { arcid: 'chinese-with-ads', tags: 'language:chinese, other:extraneous ads', size: 1 },
      { arcid: 'no-chinese-clean', tags: '', size: 100 },
    ])).toEqual(['no-chinese-clean']);
  });

  it('preserves protected selections and skips filename-only groups by default', () => {
    const groups = [
      [{ arcid: 'manual-a' }, { arcid: 'manual-b' }],
      [{ arcid: 'image-a', tags: '' }, { arcid: 'image-b', tags: 'language:chinese' }],
      [{ arcid: 'filename-a' }, { arcid: 'filename-b' }],
    ];
    expect(mergeSmartDuplicateSelection(groups, new Set(['manual-a|manual-b']), ['manual-a'], ['manual-a|manual-b'], {
      'image-a|image-b': 'image', 'filename-a|filename-b': 'filename',
    })).toEqual({ archiveIds: ['manual-a', 'image-a'], groupKeys: ['manual-a|manual-b'], skippedFilenameOnlyCount: 1 });
  });

  it('counts each group whose page gap exceeds ten pages once', () => {
    expect(countDuplicateGroupsWithLargePageGap([
      [{ pagecount: 20 }, { total: 31 }], [{ pagecount: 12 }, { total: 18 }], [{ pagecount: 1 }, { total: 15 }, { total: 4 }],
    ])).toBe(2);
  });

  it('normalizes release markers without dropping author text', () => {
    expect(normalizeDedupeFilename('[Circle] Work [中国翻訳] [DL版] [無修正]')).toBe('circlework');
    expect(normalizeDedupeFilename('Sora Aoi')).toBe('soraaoi');
  });

  it('accepts a small aligned watermark but rejects low-information covers', () => {
    expect(areSignaturesDuplicate(texturedSignature(), texturedSignature(true))).toBe(true);
    const solid = { width: 8, height: 8, ratio: 1, pixels: new Uint8ClampedArray(8 * 8 * 4).fill(245) };
    expect(areSignaturesDuplicate(solid, solid)).toBe(false);
  });

  it('rejects matching covers whose archive shapes diverge without filename evidence', () => {
    const signature = texturedSignature();
    expect(findDuplicatePairs(new Map([
      ['A', { ...signature, pageCount: 32, fileSize: 16_700_000 }],
      ['B', { ...signature, pageCount: 16, fileSize: 7_900_000 }],
    ]))).toEqual([]);
  });

  it('keeps exact normalized filename pairs despite image divergence', () => {
    const dark = { width: 8, height: 8, ratio: 1, filename: '[Circle] Longer Work [DL版]', pixels: new Uint8ClampedArray(8 * 8 * 4) };
    const light = { ...dark, filename: '[Circle] Longer Work [中国翻訳]', pixels: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
    expect(findDuplicatePairs(new Map([['A', dark], ['B', light]]))).toEqual([{ left: 'A', right: 'B' }]);
  });

  it('flags the censorship state from either side, so a card never reads as information-free', () => {
    const archive = (tags: string[]) => ({ id: 'a', tags });
    // 有码档案此前没有任何提示：无修正只认 other:uncensored，而库里最常见的是
    // mosaic censorship。两者互斥，有码的那条只在没有无修正标记时点亮。
    expect(getDedupeSmartSignals(archive(['other:mosaic censorship'])).censored).toBe(true);
    expect(getDedupeSmartSignals(archive(['other:full censorship'])).censored).toBe(true);
    expect(getDedupeSmartSignals(archive(['other:mosaic censorship'])).uncensored).toBe(false);
    expect(getDedupeSmartSignals(archive(['other:uncensored'])).censored).toBe(false);
    expect(getDedupeSmartSignals(archive(['other:uncensored'])).uncensored).toBe(true);
    // 中文档案不算「无汉语」。
    expect(getDedupeSmartSignals(archive(['language:chinese'])).noChinese).toBe(false);
    expect(getDedupeSmartSignals(archive([])).noChinese).toBe(true);
  });

  it('reports filename provenance for an exact normalized filename-only match', () => {
    const sources: string[] = [];
    const dark = { width: 8, height: 8, ratio: 1, filename: '[Circle] Longer Work [DL版]', pixels: new Uint8ClampedArray(8 * 8 * 4) };
    const light = { ...dark, filename: '[Circle] Longer Work [中国翻訳]', pixels: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
    findDuplicatePairs(new Map([['A', dark], ['B', light]]), new Set(), { onPair: (pair) => sources.push(pair.source) });
    expect(sources).toEqual(['filename']);
  });

  it('reports image provenance when an exact filename pair matches through a large aligned watermark', () => {
    const sources: string[] = [];
    const original = exactFilenameWatermarkSignature();
    const watermarked = { ...exactFilenameWatermarkSignature(true), filename: '[Circle] Longer Work [中国翻訳]' };
    expect(findDuplicatePairs(new Map([['A', original], ['B', watermarked]]), new Set(), {
      onPair: (pair) => sources.push(pair.source),
    })).toEqual([{ left: 'A', right: 'B' }]);
    expect(sources).toEqual(['image']);
  });
});
