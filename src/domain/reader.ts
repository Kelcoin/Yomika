export type ReaderLayoutPreference = 'auto' | 'single' | 'double' | 'webtoon';

export type SortOrder = 'asc' | 'desc';

export function filterArchivesByQuery<T extends { title: string }>(archives: T[], query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return archives;
  return archives.filter((archive) => archive.title.toLowerCase().includes(trimmed));
}

export function sortArchivesByTitle<T extends { title: string }>(archives: T[], order: SortOrder): T[] {
  return [...archives].sort((a, b) => {
    const cmp = a.title.localeCompare(b.title);
    return order === 'asc' ? cmp : -cmp;
  });
}
export type ReaderLayout = Exclude<ReaderLayoutPreference, 'auto'>;
export type ReadingDirection = 'ltr' | 'rtl';
export type ReaderPhase = 'booting' | 'loading-page' | 'ready' | 'chrome-visible' | 'prefetching' | 'enhancing' | 'error-recoverable' | 'closing';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const DOUBLE_TAP_ZOOM = 2;
/** Gestures may overshoot the limits and spring back, the way native viewers
 * behave; only `settleZoom` enforces the hard bounds. */
export const ZOOM_RUBBER_MIN = 0.35;
export const ZOOM_RUBBER_MAX = 4;
/** Wheel steps land on 100% instead of sliding past it. */
const ZOOM_SNAP_TOLERANCE = 0.05;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

export interface ZoomState {
  scale: number;
  panX: number;
  panY: number;
}

export function createZoomState(): ZoomState {
  return { scale: 1, panX: 0, panY: 0 };
}

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** Multiplicative wheel zoom: a fixed additive step feels violent at 50% and
 * sluggish at 300%, which is why the old linear curve never settled on 100%. */
export function zoomByWheel(zoom: ZoomState, deltaY: number): ZoomState {
  if (!Number.isFinite(deltaY) || deltaY === 0) return zoom;
  const scaled = zoom.scale * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
  const snapped = Math.abs(scaled - 1) <= ZOOM_SNAP_TOLERANCE ? 1 : scaled;
  const scale = Math.min(ZOOM_RUBBER_MAX, Math.max(ZOOM_RUBBER_MIN, snapped));
  return scale === 1 ? { scale: 1, panX: 0, panY: 0 } : { ...zoom, scale };
}

/** Applied when a gesture ends: pulls an overshoot back inside the limits and
 * drops the pan once the page fits again. */
export function settleZoom(zoom: ZoomState): ZoomState {
  const scale = clampZoom(zoom.scale);
  if (scale === zoom.scale) return scale <= 1 ? { scale, panX: 0, panY: 0 } : zoom;
  return scale <= 1 ? { scale, panX: 0, panY: 0 } : { ...zoom, scale };
}

/** Button and double-click zoom share one ratio so repeated presses feel even. */
export function zoomByStep(zoom: ZoomState, direction: 1 | -1): ZoomState {
  const scale = clampZoom(zoom.scale * (direction > 0 ? 1.25 : 1 / 1.25));
  const snapped = Math.abs(scale - 1) <= ZOOM_SNAP_TOLERANCE ? 1 : scale;
  return snapped <= 1 ? { scale: snapped, panX: 0, panY: 0 } : { ...zoom, scale: snapped };
}

export function toggleDoubleTapZoom(zoom: ZoomState): ZoomState {
  const target = zoom.scale >= DOUBLE_TAP_ZOOM ? 1 : DOUBLE_TAP_ZOOM;
  return { scale: target, panX: 0, panY: 0 };
}

export function resetZoom(_zoom: ZoomState): ZoomState {
  return { scale: 1, panX: 0, panY: 0 };
}

export function applyZoom(_current: ZoomState, scale: number, panX: number, panY: number): ZoomState {
  return { scale: clampZoom(scale), panX, panY };
}

/** Whether a page is narrow enough to sit beside another one.
 *
 * The threshold is half of a 16:9 viewport (`1920 / 2 / 1080`), taken from
 * ComicReadScript's `imageType.ts:13-22`: anything wider than the slot it would
 * occupy in a spread is a full-width page. It draws a further distinction
 * between `wide` and `long` (past 16:9) that only affects its own scroll
 * heuristics — for pairing both mean the same thing, so this collapses them.
 */
const SPREAD_SLOT_RATIO = 1920 / 2 / 1080;

export type PageShape = 'normal' | 'wide';

export function classifyPageShape(width: number, height: number): PageShape {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'normal';
  return width / height > SPREAD_SLOT_RATIO ? 'wide' : 'normal';
}

/** Groups page indexes into the slots a double-page layout renders.
 *
 * Pairing used to be fixed parity — cover alone, then (1,2), (3,4) — which
 * breaks on any archive containing a double-page scan: that page gets squeezed
 * into half a slot beside an unrelated one, and every pair after it is off by
 * one for the rest of the archive.
 *
 * Following ComicReadScript's `handleComicData.ts:80-125`, a wide page takes a
 * slot of its own and delimits the runs around it; each run is then paired from
 * its own start, so the mistake cannot propagate past the spread that caused it.
 */
export function planPageSpreads(shapes: readonly PageShape[], coverAlone = true): number[][] {
  const slots: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    for (let index = 0; index < run.length; index += 2) {
      slots.push(run.slice(index, index + 2));
    }
    run = [];
  };
  for (let index = 0; index < shapes.length; index += 1) {
    // The cover opens alone, the way a physical book does.
    if (index === 0 && coverAlone) {
      slots.push([0]);
      continue;
    }
    if (shapes[index] === 'wide') {
      flush();
      slots.push([index]);
      continue;
    }
    run.push(index);
  }
  flush();
  return slots;
}

/** Index into `planPageSpreads`'s result holding `pageIndex`. */
function findSlot(slots: number[][], pageIndex: number): number {
  const found = slots.findIndex((slot) => slot.includes(pageIndex));
  return found < 0 ? 0 : found;
}

export interface ReaderState {
  archiveId: string;
  pageCount: number;
  pageIndex: number;
  direction: ReadingDirection;
  /** What the reader was *asked* for, including `auto`. */
  layout: ReaderLayoutPreference;
  /** What `auto` resolved to once a page's dimensions were known.
   *
   * Kept apart from `layout` because overwriting the preference made `auto`
   * impossible to hold: the first image to load replaced it with `single` or
   * `double`, so selecting it read as an immediate jump to something else. */
  resolvedLayout?: ReaderLayout | undefined;
  /** Shape per page index, filled in as images load. A page nobody has measured
   * yet counts as normal: assuming a spread and being wrong splits a page across
   * two slots, while assuming normal only costs a re-pair once it loads. */
  shapes?: readonly PageShape[] | undefined;
  phase: ReaderPhase;
}

/** The layout to actually render. `auto` before any page has loaded reads as
 * single: one page is never the wrong answer, whereas guessing a spread and
 * being wrong shows two half-width pages. */
export function effectiveReaderLayout(state: Pick<ReaderState, 'layout' | 'resolvedLayout'>): ReaderLayout {
  return state.layout === 'auto' ? state.resolvedLayout ?? 'single' : state.layout;
}

type SpreadInput = Pick<ReaderState, 'pageCount' | 'shapes'>;

function spreadsFor(state: SpreadInput): number[][] {
  const shapes = state.shapes ?? [];
  const filled: PageShape[] = Array.from({ length: state.pageCount }, (_, index) => shapes[index] ?? 'normal');
  return planPageSpreads(filled);
}

/** Returns the page indexes rendered for the current spread.
 * In double-page mode the cover (index 0) is always a standalone page;
 * body pages are paired as (1,2), (3,4), ... .
 */
export function getVisiblePageIndexes(state: Pick<ReaderState, 'pageIndex' | 'pageCount' | 'layout' | 'resolvedLayout' | 'shapes'>): number[] {
  if (state.pageCount <= 0) return [];
  const start = Math.min(Math.max(0, Math.floor(state.pageIndex)), state.pageCount - 1);
  if (effectiveReaderLayout(state) !== 'double') return [start];
  const slots = spreadsFor(state);
  return slots[findSlot(slots, start)] ?? [start];
}

interface LayoutContext {
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
}

export function resolveReaderLayout(preference: ReaderLayoutPreference, context: LayoutContext): ReaderLayout {
  if (preference !== 'auto') return preference;
  const viewportIsWide = context.viewportWidth >= 900 && context.viewportWidth / context.viewportHeight >= 1.2;
  const pageIsPortrait = context.pageHeight > context.pageWidth;
  return viewportIsWide && pageIsPortrait ? 'double' : 'single';
}

/** Cycle order for the reader's single layout control. `auto` is part of the
 * cycle: with one button per layout there was no way back to it. */
export const READER_LAYOUT_CYCLE: readonly ReaderLayoutPreference[] = ['auto', 'single', 'double', 'webtoon'];

export const READER_LAYOUT_LABELS: Record<ReaderLayoutPreference, string> = {
  auto: '自动',
  single: '单页',
  double: '双页',
  webtoon: '连续滚动',
};

export function nextReaderLayout(current: ReaderLayoutPreference): ReaderLayoutPreference {
  const index = READER_LAYOUT_CYCLE.indexOf(current);
  return READER_LAYOUT_CYCLE[(index + 1) % READER_LAYOUT_CYCLE.length]!;
}

export function createReaderState(input: {
  archiveId: string;
  pageCount: number;
  pageIndex?: number;
  direction?: ReadingDirection;
  layout?: ReaderLayoutPreference;
}): ReaderState {
  const pageCount = Math.max(0, Math.floor(input.pageCount));
  return {
    archiveId: input.archiveId,
    pageCount,
    pageIndex: clampPage(input.pageIndex ?? 0, pageCount),
    direction: input.direction ?? 'ltr',
    layout: input.layout ?? 'auto',
    phase: 'ready',
  };
}

export function advanceReader(state: ReaderState, intent: 'next' | 'previous'): ReaderState {
  const forward = intent === 'next' ? 1 : -1;
  const direction = state.direction === 'rtl' ? -forward : forward;
  if (effectiveReaderLayout(state) !== 'double') {
    return { ...state, pageIndex: clampPage(state.pageIndex + direction, state.pageCount), phase: 'ready' };
  }

  // Step by slot, not by a fixed number of pages: a spread that occupies a whole
  // slot advances by one page, a pair by two, and the arithmetic no longer has to
  // know which it is looking at.
  const slots = spreadsFor(state);
  const current = findSlot(slots, clampPage(state.pageIndex, state.pageCount));
  const target = slots[Math.min(slots.length - 1, Math.max(0, current + direction))];
  const nextIndex = target?.[0] ?? state.pageIndex;
  return { ...state, pageIndex: clampPage(nextIndex, state.pageCount), phase: 'ready' };
}

export function toggleReaderChrome(state: ReaderState): ReaderState {
  return { ...state, phase: state.phase === 'chrome-visible' ? 'ready' : 'chrome-visible' };
}

/** Pages to warm around the current one.
 *
 * Asymmetric on purpose, following ComicReadScript's split of the same budget
 * (`memo/img.ts:44-47`): reading runs forward, so pages behind are worth half as
 * many slots as pages ahead. A symmetric window spent half the budget on pages
 * the reader has already passed.
 */
export function getPrefetchPages(pageIndex: number, pageCount: number, distance = 1): number[] {
  const ahead = Math.max(0, Math.floor(distance));
  const behind = Math.floor(ahead / 2);
  const pages: number[] = [];
  for (let offset = -behind; offset <= ahead; offset += 1) {
    const candidate = pageIndex + offset;
    if (offset !== 0 && candidate >= 0 && candidate < pageCount) pages.push(candidate);
  }
  return pages;
}

function clampPage(pageIndex: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.floor(pageIndex)));
}
