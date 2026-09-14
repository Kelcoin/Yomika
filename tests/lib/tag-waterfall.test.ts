import { describe, expect, it } from 'vitest';
import { distributeTagRows } from '../../src/lib/tagWaterfall';
import { pickCardTags } from '../../src/lib/archiveCardPresentation';

describe('watched tag waterfall', () => {
  it('puts watched tags from different namespaces before ordinary tags', () => {
    expect(pickCardTags(['female:ordinary', 'artist:watched', 'male:watched'], 6,
      new Set(['artist:watched', 'male:watched']))).toEqual(['male:watched', 'artist:watched', 'female:ordinary']);
  });
  it('starts all three rows with watched tags and fills the shortest row', () => {
    expect(distributeTagRows([100, 30, 50, 20, 10, 40], 3)).toEqual([[0], [1, 3, 5], [2, 4]]);
  });
  it('keeps every tag exactly once and supports two-row cards', () => {
    expect(distributeTagRows([40, 40, 40, 40], 2)).toEqual([[0, 2], [1, 3]]);
    expect(distributeTagRows([], 3)).toEqual([[], [], []]);
  });
});
