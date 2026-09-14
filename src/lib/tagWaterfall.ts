/** Horizontal waterfall: each next chip occupies the shortest physical row. */
export function distributeTagRows(widths: readonly number[], rowCount: number): number[][] {
  const rows: number[][] = Array.from({ length: rowCount }, () => []);
  const used = Array<number>(rowCount).fill(0);
  widths.forEach((width, index) => {
    const row = used.indexOf(Math.min(...used));
    rows[row]!.push(index);
    used[row] = used[row]! + Math.max(1, width) + 4;
  });
  return rows;
}
