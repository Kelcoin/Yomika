/** Fixed-width thumbnail grid geometry.
 *
 * Cards have one of two widths, and a wide card is exactly two narrow cards plus
 * the gap. That keeps the column count deterministic, which is what makes the
 * grid virtualizable: with `auto-fill` + `1fr` columns the width of a column was
 * unknown to JS, so an index could not be mapped to a row.
 */
export const ARCHIVE_GRID_CARD_WIDTH = 180;
export const ARCHIVE_GRID_GAP = 8;
/** Card geometry is fixed so the row height is exact. A `minmax()` row plus a
 * `min-height` let a card grow past the row it was placed in, and neighbouring
 * rows then overlapped it. Keep these in step with `.archive-list.is-thumbnail`
 * in shell.css. */
export const ARCHIVE_GRID_COVER_HEIGHT = 220;
/** The copy block is three fixed slots, not a flexible column: a two-line title,
 * two rows of tag chips, and one footer row. Sizing it by content let the tag
 * rows spill past `overflow: hidden`, which cut the second row in half. */
export const ARCHIVE_GRID_TITLE_HEIGHT = 36;
/** Two chip rows, exactly. A chip is 20px tall including its 1px border, so at
 * 42px the second row was clipped by a pixel and read as cut off — the slot has
 * to hold 20 + 4 + 20 with a little slack, not 18 + 3 + 18. */
export const ARCHIVE_GRID_TAGS_HEIGHT = 48;
export const ARCHIVE_GRID_FOOTER_HEIGHT = 18;
export const ARCHIVE_GRID_COPY_GAP = 4;
export const ARCHIVE_GRID_COPY_HEIGHT =
  ARCHIVE_GRID_TITLE_HEIGHT + ARCHIVE_GRID_TAGS_HEIGHT + ARCHIVE_GRID_FOOTER_HEIGHT + ARCHIVE_GRID_COPY_GAP * 2;
export const ARCHIVE_GRID_CARD_PADDING = 8;
/** The fixed body includes its padding and remaining bottom clearance.
 * Enlarging an inner slot must not enlarge the virtualizer's row stride. */
export const ARCHIVE_GRID_BODY_HEIGHT = 130;
export const ARCHIVE_GRID_ROW_HEIGHT =
  ARCHIVE_GRID_COVER_HEIGHT + ARCHIVE_GRID_BODY_HEIGHT;

/** Wide/list rows use one geometry for every shelf: a 158px card inside a 166px
 * stride, so neighbouring cards keep a visible 8px gap instead of sharing an
 * edge. Keep in step with `.archive-list.is-wide .archive-row-wrap` in shell.css
 * — the virtualizer positions rows absolutely, so a mismatch overlaps them. */
export const ARCHIVE_LIST_ROW_HEIGHT = 158;
export const ARCHIVE_LIST_ROW_GAP = 8;
export const ARCHIVE_LIST_ROW_STRIDE = ARCHIVE_LIST_ROW_HEIGHT + ARCHIVE_LIST_ROW_GAP;

/** Compact history replaces the right-hand rail with a dated section bar above
 * each day's first card. Keep in step with `.archive-day-divider` in shell.css. */
export const ARCHIVE_DAY_DIVIDER_HEIGHT = 28;

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
