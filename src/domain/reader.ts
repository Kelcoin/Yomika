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

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const DOUBLE_TAP_ZOOM = 2;
/** Gestures may overshoot the limits and spring back, the way native viewers
 * behave; only `settleZoom` enforces the hard bounds. */
export const ZOOM_RUBBER_MIN = 0.88;
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

/** Coordinates are relative to the viewport centre; pan is in unscaled pixels. */
export function zoomAtPoint(zoom: ZoomState, scale: number, x: number, y: number): ZoomState {
  if (scale <= 1) return { scale, panX: 0, panY: 0 };
  return { scale, panX: zoom.panX + x / scale - x / zoom.scale, panY: zoom.panY + y / scale - y / zoom.scale };
}

export function panZoom(zoom: ZoomState, dx: number, dy: number, width: number, height: number): ZoomState {
  if (zoom.scale <= 1) return zoom;
  const maxX = width * (1 - 1 / zoom.scale) / 2;
  const maxY = height * (1 - 1 / zoom.scale) / 2;
  return { ...zoom, panX: Math.max(-maxX, Math.min(maxX, zoom.panX + dx / zoom.scale)), panY: Math.max(-maxY, Math.min(maxY, zoom.panY + dy / zoom.scale)) };
}

/** Multiplicative wheel zoom keeps wheel steps proportional to the current scale. */
export function zoomByWheel(zoom: ZoomState, deltaY: number): ZoomState {
  if (!Number.isFinite(deltaY) || deltaY === 0) return zoom;
  if (zoom.scale < 1 && deltaY < 0) return createZoomState();
  const resistance = zoom.scale <= 1 && deltaY > 0 ? 0.22 : 1;
  const scaled = zoom.scale * Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY * resistance);
  const snapped = zoom.scale > 1 && Math.abs(scaled - 1) <= ZOOM_SNAP_TOLERANCE ? 1 : scaled;
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

/** Double click/tap: enlarge from 1, otherwise go back to 1 — **around the point
 * the gesture landed on**, the same way the wheel does (`zoomAtPoint`).
 *
 * The old rule only reset once the scale had reached the double-tap target, so
 * anything the wheel had left in between — 1.4, say — was enlarged further and
 * getting back to 100% took two more gestures. Resetting from *any* scale other
 * than 1 makes the gesture a reliable escape hatch, which is what it is for.
 *
 * The anchor is the second half of the same complaint: the old version flipped
 * the scale and dropped the pan to zero, so a double click on a face at the top
 * left threw it to the middle of the screen. Passing the point through
 * `zoomAtPoint` gives the two gestures one piece of arithmetic instead of two —
 * enlarging keeps what was under the pointer under the pointer, and going back
 * to 1 zeroes the pan by construction (`scale <= 1` inside `zoomAtPoint`). */
export function doubleTapZoomAt(zoom: ZoomState, x: number, y: number): ZoomState {
  const target = zoom.scale === 1 ? DOUBLE_TAP_ZOOM : 1;
  return settleZoom(zoomAtPoint(zoom, target, x, y));
}

export function toggleDoubleTapZoom(zoom: ZoomState): ZoomState {
  return doubleTapZoomAt(zoom, 0, 0);
}

/** Whether a page is narrow enough to sit beside another one.
 *
 * The threshold is half of a 16:9 viewport (`1920 / 2 / 1080`): anything wider than the slot it would
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
 * A wide page takes a
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
 * Viewport-relative distance,
 * or a directional flick. A fixed pixel threshold —
 * what this used before — is wrong at both ends: 50px is a twitch on a desktop
 * monitor and half the screen on a phone, and it ignored speed entirely, so a
 * fast short flick did nothing.
 */
export const PAGE_TURN_FLICK_VELOCITY = 0.4;
/** Below this a gesture is a twitch, whatever its velocity says. Without a floor
 * an instantaneous six-pixel jitter reads as an infinitely fast flick. */
export const MIN_PAGE_TURN_DISTANCE = 30;
/** Slow drags travel 20% of the reading area, capped at 180px on desktop.
 * Recent release velocity distinguishes a flick from a drag held stationary. */

export function shouldCommitPageTurn(dx: number, elapsedMs: number, viewportWidth: number, releaseVelocity?: number): boolean {
  const distance = Math.abs(dx);
  if (!Number.isFinite(distance) || distance <= MIN_PAGE_TURN_DISTANCE) return false;
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const reach = Math.min(180, width * 0.2);
  if (releaseVelocity !== undefined) return distance > reach || (Number.isFinite(releaseVelocity) && Math.sign(releaseVelocity) === Math.sign(dx) && Math.abs(releaseVelocity) > PAGE_TURN_FLICK_VELOCITY);
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

/** 排布表的单槽缓存（按「页数 + 形状表引用」认）。
 *
 * 翻一页会问 5~6 次同一份排布：可见页、相邻页（前一/后一）、`advanceReader` 各问
 * 一次，而每一次都要按页数分配一个数组、再走一遍 O(页数) 的分组与 `findIndex`。
 * 双页模式下页数上千的档案里，这就是「快速连续翻页会卡顿」里属于这一层的那部分：
 * 形状表只在量到新页高时才换引用（ReaderScreen 每次测量都新造一份），翻页本身不
 * 动它，所以翻页期间必然命中。 */
let cachedSpreads: { pageCount: number; shapes: readonly PageShape[] | undefined; slots: number[][] } | undefined;

function spreadsFor(state: SpreadInput): number[][] {
  const cached = cachedSpreads;
  if (cached && cached.pageCount === state.pageCount && cached.shapes === state.shapes) return cached.slots;
  const shapes = state.shapes ?? [];
  const filled: PageShape[] = Array.from({ length: state.pageCount }, (_, index) => shapes[index] ?? 'normal');
  const slots = planPageSpreads(filled);
  cachedSpreads = { pageCount: state.pageCount, shapes: state.shapes, slots };
  return slots;
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
}

/** Whether the viewport has room for two pages side by side. */
export function viewportHoldsSpread(context: LayoutContext): boolean {
  return context.viewportWidth >= 900 && context.viewportWidth / context.viewportHeight >= 1.2;
}

/** What `auto` resolves to, which is a question about the *viewport* only.
 *
 * It used to take the page on screen as well, and refuse a spread when that page
 * was landscape. That made the answer depend on where the reader happened to be:
 * the frame a swipe reveals is built from the state *before* the turn, so leaving
 * a landscape page towards a pair rendered the incoming frame as a single page and
 * only re-rendered it as a spread once the turn had committed — the spread
 * appeared to arrive after the swipe rather than during it. A landscape page does
 * not need this rule anyway: `planPageSpreads` already gives it a slot of its own,
 * so resolving from the viewport alone renders it alone and pairs everything else.
 */
export function resolveReaderLayout(preference: ReaderLayoutPreference, context: LayoutContext): ReaderLayout {
  if (preference !== 'auto') return preference;
  return viewportHoldsSpread(context) ? 'double' : 'single';
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
  /** What `auto` resolves to on the current viewport, so the very first paint is
   * already the right shape rather than flipping a frame later. */
  resolvedLayout?: ReaderLayout;
}): ReaderState {
  const pageCount = Math.max(0, Math.floor(input.pageCount));
  return {
    archiveId: input.archiveId,
    pageCount,
    pageIndex: clampPage(input.pageIndex ?? 0, pageCount),
    direction: input.direction ?? 'ltr',
    layout: input.layout ?? 'auto',
    ...(input.resolvedLayout ? { resolvedLayout: input.resolvedLayout } : {}),
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
 * Asymmetric on purpose: reading runs forward, so pages behind are worth half as
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

/** 一页在给定的格子里按 contain 缩放后的尺寸（比例不变）。
 *
 * 阅读器要的是「贴合视口」：小图放大到贴住高度或宽度，大图缩到贴住另一条边。
 * 单靠 CSS 做不到——`max-width`/`max-height` 只会**缩小**，一张 300×400 的图在
 * 1280×900 的视口里仍然画成 300×400，四周全是黑边。所以尺寸在这里算好、写进元素
 * 自己的宽高（元素的盒子因此就是画出来的矩形，页码胶囊靠这一点量位置）。
 *
 * 比例取自**第一次**量到的自然尺寸：超分那一版是同一张图的多倍像素，按它自己的
 * 像素算会让放大倍数在推理完成的那一刻跳一下。
 *
 * 返回 `undefined` 表示这一页的自然尺寸还不知道（图还没到）——那一刻不该写死尺寸，
 * 让它先按原本大小上屏，量到之后再换成贴合尺寸。
 */
export function fitPageSize(
  natural: { width: number; height: number } | undefined,
  box: { width: number; height: number },
): { width: number; height: number } | undefined {
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) return undefined;
  if (!(box.width > 0)) return undefined;
  const byWidth = { width: box.width, height: (box.width * natural.height) / natural.width };
  // 高度不限（连续滚动的格子）时只有宽度在起作用。
  const fit = Number.isFinite(box.height) && box.height > 0 && byWidth.height > box.height
    ? { width: (box.height * natural.width) / natural.height, height: box.height }
    : byWidth;
  return { width: Math.max(1, Math.round(fit.width)), height: Math.max(1, Math.round(fit.height)) };
}

/** 整本预处理的顺序：从当前这一页起往前，再往回。
 *
 * `getPrefetchPages` 管的是「窗口里那几页要不要先取进来」，这一条管的是「整本档案
 * 按什么次序处理完」——阅读器里开着超分 / DLSSNR 时，只有窗口里那几页有结果
 * 是不够的：翻到下一页仍然要现算。读漫画是一条直线，所以「接下来会读到哪儿」是唯一
 * 值得提前算的方向，前面那些页从近到远排，往回的那一段只是补课、排在最后。
 *
 * 已经算过的页由调用方在取件时跳过（它们可能在重排之间已经被处理过），所以这里不必
 * 先去重，也不必知道哪些页做过。 */
export function sweepOrder(anchor: number, pageCount: number): number[] {
  const count = Math.max(0, Math.floor(pageCount));
  const start = Math.min(Math.max(0, Math.floor(anchor)), Math.max(0, count - 1));
  const order: number[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const ahead = start + offset;
    if (ahead < count) order.push(ahead);
  }
  for (let offset = 1; offset < count; offset += 1) {
    const behind = start - offset;
    if (behind >= 0) order.push(behind);
  }
  return order;
}

/** 会话预算不够时，先从内存里放掉哪一页派生结果。
 *
 * 这一条按「离正在读的那一页多远」挑，不按「谁先算出来」挑。预扫是按
 * `sweepOrder` 灌进来的，也就是**从当前页往后由近到远**，所以「最早进来的那一页」
 * 恰恰是用户马上要翻到的那一页：DLSSNR 一页成品 3–6MB，64MB 的会话预算只装得下十
 * 来页，于是旧规则每翻一页都先丢掉下一批要读的，用户翻过去的时候只能现算——表现
 * 出来就是「必须翻到那一页才开始处理」。
 *
 * 距离相同时丢身后的那一页：读漫画是一条直线，翻回去是例外。（整本预扫本身不动，
 * 它仍在把结果写进盘上的缓存，见 `docs/39`。）
 *
 * 可见页永远不参与；调用方还要保证持有表里至少留一页。 */
export function pickDerivedEvictionVictim(
  held: readonly number[],
  visible: ReadonlySet<number>,
  anchor: number,
): number | undefined {
  let victim: number | undefined;
  let victimDistance = -1;
  let victimBehind = false;
  for (const index of held) {
    if (visible.has(index)) continue;
    const distance = Math.abs(index - anchor);
    const behind = index < anchor;
    const further = distance > victimDistance || (distance === victimDistance && behind && !victimBehind);
    if (victim === undefined || further) {
      victim = index;
      victimDistance = distance;
      victimBehind = behind;
    }
  }
  return victim;
}

function clampPage(pageIndex: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.floor(pageIndex)));
}
