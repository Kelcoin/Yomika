/** Android-style midpoint inclusion: jumping across an unused dot selects it. */
export function appendPatternPoint(points: number[], next: number): number[] {
  if (points.includes(next) || next < 0 || next > 8) return points;
  const previous = points.at(-1);
  if (previous === undefined) return [next];
  const dx = next % 3 - previous % 3;
  const dy = Math.floor(next / 3) - Math.floor(previous / 3);
  const middle = (previous + next) / 2;
  const crossesMiddle = (Math.abs(dx) === 2 && dy === 0) || (Math.abs(dy) === 2 && dx === 0) || (Math.abs(dx) === 2 && Math.abs(dy) === 2);
  return crossesMiddle && !points.includes(middle) ? [...points, middle, next] : [...points, next];
}
