import { describe, expect, it } from 'vitest';
import { dHashFromRgba, hammingDistance, findDHashCandidates } from '../../src/domain/dedup';

describe('dedup feature hashing', () => {
  it('creates a 64-bit horizontal dHash from grayscale samples', () => {
    const rgba = new Uint8Array(9 * 8 * 4);
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 9; x += 1) {
      const value = x * 10;
      const index = (y * 9 + x) * 4;
      rgba[index] = value; rgba[index + 1] = value; rgba[index + 2] = value; rgba[index + 3] = 255;
    }
    expect(dHashFromRgba(rgba, 9, 8)).toBe('ffffffffffffffff');
  });

  it('computes bounded Hamming distance and returns threshold matches', () => {
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(findDHashCandidates('0000000000000000', [
      { id: 'near', hash: '0000000000000001' },
      { id: 'far', hash: 'ffffffffffffffff' },
    ], 1)).toEqual([{ id: 'near', hash: '0000000000000001', distance: 1 }]);
  });
});
