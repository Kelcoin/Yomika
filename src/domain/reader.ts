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

/** Double click/tap: enlarge from 1, otherwise go back to 1.
 *
 * The old rule only reset once the scale had reached the double-tap target, so
 * anything the wheel had left in between — 1.4, say — was enlarged further and
 * getting back to 100% took two more gestures. Resetting from *any* scale other
 * than 1 makes the gesture a reliable escape hatch, which is what it is for. */
export function toggleDoubleTapZoom(zoom: ZoomState): ZoomState {
  const target = zoom.scale === 1 ? DOUBLE_TAP_ZOOM : 1;
  return { scale: target, panX: 0, panY: 0 };
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
 * slot of its own and delimits the runs around it, so a mistake cannot propagate
 * past the spread that caused it. That is the whole rule now: a wide page falls
 * back to a single page and the pairing resumes after it.
 *
 * The cover always opens alone, the way a physical book does. This used to be a
 * toggle (a "pairing start"), together with a rule that re-aligned the run in
 * front of a spread on the theory that a spread can only begin where a pair
 * would. Both are gone: they existed to repair a pairing whose origin might be
 * wrong, and with the origin fixed the re-alignment had nothing to key off
 * except a guess that could shuffle an entire chapter.
 */
export function planPageSpreads(shapes: readonly PageShape[]): number[][] {
  const slots: number[][] = [];
  let run: number[] = [];
  const flush = () => {
    for (let index = 0; index < run.length; index += 2) {
      slots.push(run.slice(index, index + 2));
    }
    run = [];
  };
  for (let index = 0; index < shapes.length; index += 1) {
    if (index === 0) {
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

/** Whether a horizontal drag has earned a page turn.
 *
 * Ported from ComicReadScript's `turnPage.ts:18-41`: a third of the viewport, or
 * a flick fast enough that distance stops mattering. A fixed pixel threshold —
 * what this used before — is wrong at both ends: 50px is a twitch on a desktop
 * monitor and half the screen on a phone, and it ignored speed entirely, so a
 * fast short flick did nothing.
 */
export const PAGE_TURN_FLICK_VELOCITY = 0.4;
/** Below this a gesture is a twitch, whatever its velocity says. Without a floor
 * an instantaneous six-pixel jitter reads as an infinitely fast flick. */
export const MIN_PAGE_TURN_DISTANCE = 30;
/** Fraction of the viewport a slow drag has to cover to turn the page.
 *
 * A third of the viewport — what this was — is over 500px on a desktop window, so
 * a deliberate drag that was plainly a page turn kept springing back. A sixth is
 * still far past the tap slop and past what a scroll gesture drifts sideways, and
 * it is the distance at which the next page is already visibly coming in. */
const PAGE_TURN_DISTANCE_FRACTION = 1 / 6;

export function shouldCommitPageTurn(dx: number, elapsedMs: number, viewportWidth: number): boolean {
  const distance = Math.abs(dx);
  if (!Number.isFinite(distance) || distance <= MIN_PAGE_TURN_DISTANCE) return false;
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const reach = width * PAGE_TURN_DISTANCE_FRACTION;
  // A duration we cannot use is not the same as a fast one: with no way to judge
  // velocity, ask for more distance instead of guessing.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return distance > reach * 2;
  // Zero elapsed time is the fastest flick there is, not an unknown one.
  if (elapsedMs === 0) return true;
  return distance > reach || distance / elapsedMs > PAGE_TURN_FLICK_VELOCITY;
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

/** Returns the page indexes rendered for the current spread: a wide page alone,
 * otherwise the pair it belongs to. */
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

/** Height assumed for a page nobody has measured yet, as a multiple of the
 * viewport height. Manga pages are portrait, so a full viewport height plus a
 * bit is closer than a square guess; being wrong only costs a stale scrollbar
 * length, because a measured height replaces it and is never given up again. */
export const WEBTOON_ESTIMATED_PAGE_RATIO = 1.4;

/** Which pages a continuous scroll actually needs mounted.
 *
 * Continuous mode used to treat *every* page of the archive as visible, so
 * opening it fired one decode per page at once — the whole archive, at full
 * size, and with an enhancement enabled one ONNX run each. That is the freeze.
 *
 * The window is computed from the scroll offset and a height per page rather
 * than from the DOM: the renderer gives every page a slot of exactly
 * `heights[index]`, so the arithmetic here and the geometry on screen are the
 * same numbers and neither has to measure the other. `overscan` is how many
 * pages beyond the viewport stay mounted, which is what keeps a fast scroll from
 * showing holes.
 */
export function webtoonWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  heights: readonly number[];
  overscan?: number;
}): { first: number; last: number } {
  const count = input.heights.length;
  if (count <= 0) return { first: 0, last: -1 };
  const overscan = Math.max(0, Math.floor(input.overscan ?? 1));
  const scrollTop = Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0;
  const viewportHeight = Number.isFinite(input.viewportHeight) && input.viewportHeight > 0 ? input.viewportHeight : 1;
  const viewportBottom = scrollTop + viewportHeight;

  let firstVisible = -1;
  let lastVisible = -1;
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const height = Math.max(1, Number.isFinite(input.heights[index]) ? (input.heights[index] as number) : 1);
    const pageBottom = offset + height;
    if (pageBottom > scrollTop && offset < viewportBottom) {
      if (firstVisible < 0) firstVisible = index;
      lastVisible = index;
    }
    offset = pageBottom;
  }
  // Scrolled past the end — which happens when measured heights turn out shorter
  // than the estimates that sized the scroller. Hold the last page rather than
  // reporting an empty window, or the reader would unmount everything and lose
  // the measurements that would have corrected it.
  if (firstVisible < 0) {
    firstVisible = count - 1;
    lastVisible = count - 1;
  }
  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(count - 1, lastVisible + overscan),
  };
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
