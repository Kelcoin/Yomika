import { expect, it } from 'vitest';
import { advanceNavigationSpring } from '../../src/lib/navigationSpring';

it('settles with visible but bounded overshoot, independent of refresh rate', () => {
  for (const hz of [60, 90, 120]) {
    let state = { position: 0, velocity: 0 };
    let peak = 0;
    for (let i = 0; i < hz; i++) {
      state = advanceNavigationSpring(state, 100, 1 / hz, false);
      peak = Math.max(peak, state.position);
    }
    expect(peak).toBeGreaterThan(108);
    expect(peak).toBeLessThan(130);
    expect(state.position).toBeCloseTo(100, 0);
    expect(Math.abs(state.velocity)).toBeLessThan(1);
  }
});

it('follows the finger quickly and remains stable after a stalled frame', () => {
  let state = { position: 0, velocity: 0 };
  for (let i = 0; i < 6; i++) state = advanceNavigationSpring(state, 100, 1 / 60, true);
  expect(state.position).toBeGreaterThan(90);
  state = advanceNavigationSpring(state, 0, 2, true);
  expect(Number.isFinite(state.position)).toBe(true);
  expect(Math.abs(state.position)).toBeLessThan(150);
});
