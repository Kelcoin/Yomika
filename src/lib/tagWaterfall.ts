export interface DistributeTagRowsOptions {
  /** Greedy top-down fill: fill row 1 until the next chip no longer fits the
   * measured container width, then row 2, and drop the rest. Without it the
   * shortest-row waterfall spreads chips evenly and leaves both rows half
   * empty whenever the tag count does not happen to match the row count. */
  containerWidth?: number;
}

/** Horizontal waterfall: each next chip occupies the shortest physical row.
 * With `containerWidth` the rows fill top-down instead and overflow is dropped,
 * which is what a card wants — its rows are the visible area, not a layout
 * suggestion. */
export function distributeTagRows(widths: readonly number[], rowCount: number, options?: DistributeTagRowsOptions): number[][] {
  const containerWidth = options?.containerWidth;
  if (containerWidth != null && Number.isFinite(containerWidth) && containerWidth > 0) {
    const rows: number[][] = Array.from({ length: rowCount }, () => []);
    const used = Array<number>(rowCount).fill(0);
    let row = 0;
    for (let index = 0; index < widths.length && row < rowCount; index += 1) {
      const step = Math.max(1, widths[index]!) + 4;
      // The row's first chip always lands, however long it is: overflow hidden
      // clips it, and an empty row would waste the slot entirely.
      if (used[row]! > 0 && used[row]! + step > containerWidth) {
        row += 1;
        if (row >= rowCount) break;
      }
      rows[row]!.push(index);
      used[row]! += step;
    }
    // Trailing empty rows only add stray gap below a short tag set.
    let last = rows.length - 1;
    while (last > 0 && rows[last]!.length === 0) last -= 1;
    return rows.slice(0, last + 1);
  }
  const rows: number[][] = Array.from({ length: rowCount }, () => []);
  const used = Array<number>(rowCount).fill(0);
  widths.forEach((width, index) => {
    const row = used.indexOf(Math.min(...used));
    rows[row]!.push(index);
    used[row] = used[row]! + Math.max(1, width) + 4;
  });
  return rows;
}
