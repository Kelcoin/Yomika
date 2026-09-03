/** Fixed-width thumbnail grid geometry, ported from Readoshi's ArchiveGrid.
 *
 * Cards have one of two widths, and a wide card is exactly two narrow cards plus
 * the gap. That keeps the column count deterministic, which is what makes the
 * grid virtualizable: with `auto-fill` + `1fr` columns the width of a column was
 * unknown to JS, so an index could not be mapped to a row.
 */
export const ARCHIVE_GRID_CARD_WIDTH = 180;
export const ARCHIVE_GRID_GAP = 12;
/** Card geometry is fixed so the row height is exact. A `minmax()` row plus a
 * `min-height` let a card grow past the row it was placed in, and neighbouring
 * rows then overlapped it. Keep these in step with `.archive-list.is-thumbnail`
 * in shell.css. */
export const ARCHIVE_GRID_COVER_HEIGHT = 220;
export const ARCHIVE_GRID_COPY_HEIGHT = 92;
export const ARCHIVE_GRID_CARD_PADDING = 8;
export const ARCHIVE_GRID_CARD_GAP = 8;
export const ARCHIVE_GRID_ROW_HEIGHT =
  ARCHIVE_GRID_COVER_HEIGHT + ARCHIVE_GRID_CARD_GAP + ARCHIVE_GRID_COPY_HEIGHT + ARCHIVE_GRID_CARD_PADDING * 2;

export function getWideArchiveCardWidth(gap = ARCHIVE_GRID_GAP): number {
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : ARCHIVE_GRID_GAP;
  return ARCHIVE_GRID_CARD_WIDTH * 2 + safeGap;
}

export function getArchiveGridColumns(containerWidth: number, gap = ARCHIVE_GRID_GAP): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : ARCHIVE_GRID_GAP;
  return Math.max(1, Math.floor((containerWidth + safeGap) / (ARCHIVE_GRID_CARD_WIDTH + safeGap)));
}

/** First-fit packing so a wide card never leaves a hole: a later narrow card
 * backfills the leftover column instead of the row ending short. Order is only
 * relaxed within the window a wide card opens, so the sequence stays readable.
 *
 * Two cursors are enough for a linear pass: a row's free columns only ever
 * shrink, so once a row cannot hold a cost it never can again.
 */
export function packArchiveGridRows<T>(items: readonly T[], columns: number, isWide: (item: T) => boolean): T[][] {
  const columnCount = Math.max(1, Math.floor(columns));
  const rows: Array<{ remaining: number; items: T[] }> = [];
  const cursor = [0, 0];

  for (const item of items) {
    const cost = Math.min(columnCount, isWide(item) ? 2 : 1);
    let index = cursor[cost - 1]!;
    while (index < rows.length && rows[index]!.remaining < cost) index += 1;
    cursor[cost - 1] = index;
    if (index === rows.length) rows.push({ remaining: columnCount, items: [] });
    const row = rows[index]!;
    row.remaining -= cost;
    row.items.push(item);
  }

  return rows.map((row) => row.items);
}
