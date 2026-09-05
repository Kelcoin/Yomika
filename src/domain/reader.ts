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
  phase: ReaderPhase;
}

/** The layout to actually render. `auto` before any page has loaded reads as
 * single: one page is never the wrong answer, whereas guessing a spread and
 * being wrong shows two half-width pages. */
export function effectiveReaderLayout(state: Pick<ReaderState, 'layout' | 'resolvedLayout'>): ReaderLayout {
  return state.layout === 'auto' ? state.resolvedLayout ?? 'single' : state.layout;
}

/** Returns the page indexes rendered for the current spread.
 * In double-page mode the cover (index 0) is always a standalone page;
 * body pages are paired as (1,2), (3,4), ... .
 */
export function getVisiblePageIndexes(state: Pick<ReaderState, 'pageIndex' | 'pageCount' | 'layout' | 'resolvedLayout'>): number[] {
  if (state.pageCount <= 0) return [];
  const start = Math.min(Math.max(0, Math.floor(state.pageIndex)), state.pageCount - 1);
  if (effectiveReaderLayout(state) !== 'double' || start === 0) return [start];
  const pairStart = start % 2 === 0 ? start - 1 : start;
  return [pairStart, pairStart + 1].filter((index) => index < state.pageCount);
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

  const visible = getVisiblePageIndexes(state);
  const first = visible[0] ?? 0;
  const last = visible[visible.length - 1] ?? first;
  const nextIndex = direction > 0
    ? (state.pageIndex === 0 ? 1 : last + 1)
    : (state.pageIndex <= 1 ? 0 : first - 2);
  return { ...state, pageIndex: clampPage(nextIndex, state.pageCount), phase: 'ready' };
}

export function toggleReaderChrome(state: ReaderState): ReaderState {
  return { ...state, phase: state.phase === 'chrome-visible' ? 'ready' : 'chrome-visible' };
}

export function getPrefetchPages(pageIndex: number, pageCount: number, distance = 1): number[] {
  const pages: number[] = [];
  for (let offset = -distance; offset <= distance; offset += 1) {
    const candidate = pageIndex + offset;
    if (offset !== 0 && candidate >= 0 && candidate < pageCount) pages.push(candidate);
  }
  return pages;
}

function clampPage(pageIndex: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.floor(pageIndex)));
}
