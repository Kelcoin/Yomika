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
  layout: ReaderLayoutPreference;
  phase: ReaderPhase;
}

/** Returns the page indexes rendered for the current spread.
 * In double-page mode the cover (index 0) is always a standalone page;
 * body pages are paired as (1,2), (3,4), ... .
 */
export function getVisiblePageIndexes(state: Pick<ReaderState, 'pageIndex' | 'pageCount' | 'layout'>): number[] {
  if (state.pageCount <= 0) return [];
  const start = Math.min(Math.max(0, Math.floor(state.pageIndex)), state.pageCount - 1);
  if (state.layout !== 'double' || start === 0) return [start];
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
  if (state.layout !== 'double') {
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
