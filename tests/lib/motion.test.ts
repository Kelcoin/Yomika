import { expect, it } from 'vitest';
import { rubberBand } from '../../src/lib/motion';

it('offers progressive resistance without a discontinuity or a hard cap', () => {
  expect(rubberBand(0)).toBe(0);
  const steps = [0, 20, 40, 60, 80, 100].map((distance) => rubberBand(distance));
  const slopes = steps.slice(1).map((offset, index) => offset - steps[index]!);
  for (let index = 1; index < slopes.length; index += 1) {
    expect(slopes[index]).toBeGreaterThan(0);
    expect(slopes[index]).toBeLessThan(slopes[index - 1]!);
  }
  expect(rubberBand(10_000)).toBeLessThan(80);
  expect(rubberBand(-100)).toBe(-rubberBand(100));
  expect(rubberBand(101)).toBeGreaterThan(rubberBand(100));
});
