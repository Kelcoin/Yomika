import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_GRID_CARD_WIDTH,
  ARCHIVE_GRID_GAP,
  getArchiveGridColumns,
  getWideArchiveCardWidth,
  packArchiveGridRows,
} from '../../src/lib/archiveGridLayout';

const wide = (item: string) => item.startsWith('W');

describe('archive grid layout', () => {
  it('keeps a wide card exactly two columns plus the gap', () => {
    expect(getWideArchiveCardWidth()).toBe(ARCHIVE_GRID_CARD_WIDTH * 2 + ARCHIVE_GRID_GAP);
    expect(getWideArchiveCardWidth(20)).toBe(ARCHIVE_GRID_CARD_WIDTH * 2 + 20);
  });

  it('derives the column count from the measured container width', () => {
    expect(getArchiveGridColumns(800)).toBe(4);
    expect(getArchiveGridColumns(ARCHIVE_GRID_CARD_WIDTH)).toBe(1);
    expect(getArchiveGridColumns(0)).toBe(1);
    expect(getArchiveGridColumns(Number.NaN)).toBe(1);
  });

  it('fills every column of a row before opening the next one', () => {
    const rows = packArchiveGridRows(['a', 'b', 'c', 'd', 'e'], 3, wide);
    expect(rows).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('backfills the column a wide card would have left empty', () => {
    // Columns = 3, so W1 (2 columns) + a leaves 0 free; without backfilling, b
    // would start a new row and the first row would end one column short.
    const rows = packArchiveGridRows(['a', 'W1', 'b', 'c'], 3, wide);
    expect(rows).toEqual([['a', 'W1'], ['b', 'c']]);

    const backfilled = packArchiveGridRows(['W1', 'W2', 'a'], 3, wide);
    expect(backfilled).toEqual([['W1', 'a'], ['W2']]);
  });

  it('never drops or duplicates an item', () => {
    const items = Array.from({ length: 97 }, (_, index) => (index % 7 === 0 ? `W${index}` : `n${index}`));
    const rows = packArchiveGridRows(items, 5, wide);
    const flattened = rows.flat();

    expect(flattened).toHaveLength(items.length);
    expect(new Set(flattened).size).toBe(items.length);
    for (const row of rows) {
      expect(row.reduce((total, item) => total + (wide(item) ? 2 : 1), 0)).toBeLessThanOrEqual(5);
    }
  });

  it('places a wide card alone when the grid is a single column', () => {
    expect(packArchiveGridRows(['W1', 'a'], 1, wide)).toEqual([['W1'], ['a']]);
  });

  it('returns no rows for an empty library', () => {
    expect(packArchiveGridRows([], 4, wide)).toEqual([]);
  });
});
