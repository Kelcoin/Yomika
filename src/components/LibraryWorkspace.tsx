import { AutoTextarea } from './AutoTextarea';
import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { ArchiveCardTags, CardTagRows } from './CardTagRows';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderHeart, ArrowDown, ArrowUp, BookmarkPlus, BookOpen, Check, ListChecks, ListTodo, Pencil, Plus, Save, SquareCheckBig, Star, Grid2X2, Rows3, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate, useLocation, matchPath } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { useDefaultLayout } from 'react-resizable-panels';
import { Group, Panel, Separator } from './AdaptivePanels';
import { usePageActive } from '../app/RetainedPage';
import { EDGE_CLAIM_PX, EDGE_SETTLE_MS, rubberBand } from '../lib/motion';

import type { ArchiveRecord } from '../domain/library';
import type { ArchiveMetadata, Category, SearchPreset } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';
import { longPressHandlers } from '../lib/longPressMenu';
import { StatusLine } from './StatusLine';
import { SearchPresetField } from './SearchPresetField';
import { SelectField } from './SelectField';
import { FAVORITES_CATEGORY_NAME, UNTAGGED_FILTER_ID, categorizeSearchableTags, getCategoryDisplayName, sortCategoriesForDisplay, translateRawTag } from '../lib/tags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { TagSuggest } from './TagSuggest';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { archiveCategoryKey, archiveCategoryLabel, archiveLanguageLabel, formatArchiveDate, formatArchivePageMeta, isWideCoverMarked, isWideCoverRatio, rememberWideCoverMark, CARD_TAG_LIMIT_THUMBNAIL, CARD_TAG_LIMIT_WIDE } from '../lib/archiveCardPresentation';
import { ARCHIVE_DAY_DIVIDER_HEIGHT, ARCHIVE_GRID_GAP, ARCHIVE_GRID_ROW_HEIGHT, ARCHIVE_LIST_ROW_STRIDE, getArchiveGridColumns, packArchiveGridRows } from '../lib/archiveGridLayout';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { isCommittableSearchQuery } from '../lib/searchQuery';
import { normalizeMyTagKey, readableInkOnHex } from '../lib/ehMyTags';
import { TagSearchLink } from './TagSearchLink';
import { ArchiveProgressBar, ArchiveThumbCardBody, ArchiveThumbnailCardSkeleton } from './ArchiveThumbnailCard';
import { useEhMyTags } from './useEhMyTags';
import { panelLayout } from '../lib/panelLayout';
import '../styles/library-loading.css';

/** Chips a thumbnail card offers. Generous on purpose: the fill waterfall drops
 * whatever the two visible rows cannot hold, so the limit only has to exceed
 * what the widest card can show — the measured rows decide, not a fixed count
 * per standard or wide card. */
/** One search hint for every page that has a search box. */
const SEARCH_PLACEHOLDER = '搜索档案…';

/** How many wide-cover marks the workspace keeps. Each mark is one archive key,
 * so without a cap the set grows for as long as the workspace stays mounted
 * (one entry per wide archive ever scrolled past). */
export const WIDE_COVER_MARK_LIMIT = 4096;

/** Remember that one archive's cover is wide (or stop remembering it). Kept
 * separate from the component so the eviction order can be pinned by a test:
 * `Set` iterates in insertion order, so the marks that fall out first are the
 * ones scrolled past longest ago. Returns the set it was given unchanged when
 * nothing moves — a fresh set per cover load would re-render the whole list. */
export function withWideCoverMark(
  current: Set<string>,
  archiveId: string,
  wide: boolean,
  limit: number = WIDE_COVER_MARK_LIMIT,
): Set<string> {
  if (current.has(archiveId) === wide) return current;
  const next = new Set(current);
  if (!wide) {
    next.delete(archiveId);
    return next;
  }
  next.add(archiveId);
  while (next.size > limit) {
    const oldest = next.values().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

/* Overscroll. Beyond the top the list can be pulled down to refresh, beyond the
   bottom it bounces. Keep the existing 128px refresh gesture while displaying
   it through the progressive resistance curve. */
const PULL_THRESHOLD = rubberBand(128, 104);
/** 手指要往端点外走这么远才认领这次手势（4px，早于原生滚动的常见锁定距离）。在那之前一个
 * preventDefault 都不发：手机上起手那几像素常常先往下抖一下，一抖就被冒领的话
 * 接下来整段手势都滚不动页面——用户看到的就是「只能触发过滚刷新」。 */
const PULL_CLAIM_PX = EDGE_CLAIM_PX;
const PULL_MAX = 104;
const BOUNCE_MAX = 72;
/** A wheel has no release event, so the gesture is over once it stops. */
const PULL_SETTLE_MS = 140;
/** 滚轮是**有刻度**的：一格一格之间隔着几十毫秒，按触摸那条 140ms 的收势窗口算，
 * 每格都会先被拉出去、再被收势弹回原位，然后下一格又拉一次——用户看到的是过滚内容
 * 疯狂颤动。滚轮的窗口按「这一串刻度结束了」来定：连滚时只在停手之后收一次势。 */
export const WHEEL_IDLE_MS = 280;

/** 刻度数上限：再多每个刻度就窄到点不准了。超了就把每一行的桶级整体升一级重建
 * （最大到「年」），到顶还超上限就等距抽稀。
 * 真实上限还要跟列表可视高度挂钩：一格 18px、最多占面板的 70%（见下），不然短窗口
 * 里 20 个刻度会挤成一把密齿梯子。 */
export const RAIL_MAX_TICKS = 20;

/** 一格刻度的高度（`--rail-pitch`，与 shell.css 里那条轨道一致）与它能占的面板高度
 * 比例。刻度数是 `min(RAIL_MAX_TICKS, floor(0.7 * 面板高 / 18))`：轨道挂在这一层的
 * 中线上，永远不超过可视高度的七成。高度还没量到时（首帧、jsdom）用常量上限。 */
const RAIL_TICK_PITCH = 18;
const RAIL_TICK_SPAN = 0.7;

function railTickCapFor(height: number): number {
  if (height <= 0) return RAIL_MAX_TICKS;
  return Math.max(2, Math.min(RAIL_MAX_TICKS, Math.floor((height * RAIL_TICK_SPAN) / RAIL_TICK_PITCH)));
}

/** 桶级，越靠近现在越小：小时 → 天 → 周 → 月 → 年。 */
const RAIL_BUCKET_LEVELS = ['hour', 'day', 'week', 'month', 'year'] as const;
type RailBucketLevel = (typeof RAIL_BUCKET_LEVELS)[number];

const DAY_MS = 86_400_000;

/** 一行「多久以前」决定它从哪一级起算：一天内按小时、一周内按天、两个月内按周、
 * 两年内按月，再往前按年。越近的行，一个刻度代表的时间跨度越小。 */
function railBaseLevel(ageMs: number): RailBucketLevel {
  if (ageMs <= DAY_MS) return 'hour';
  if (ageMs <= 7 * DAY_MS) return 'day';
  if (ageMs <= 60 * DAY_MS) return 'week';
  if (ageMs <= 730 * DAY_MS) return 'month';
  return 'year';
}

/** 一周的键取那一周的周一，写成 `YYYY-MM-DD`：同一周里每一行都得算出同一个键。 */
function railWeekKey(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
  if (Number.isNaN(at.getTime())) return date;
  // getDay() 里周日是 0，而它是 ISO 一周的最后一天，不是第一天。
  at.setDate(at.getDate() - ((at.getDay() + 6) % 7));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 一个桶的键：键相同且相邻的行只留一个刻度。 */
function railBucketKey(level: RailBucketLevel, date: string, at: number | undefined): string {
  switch (level) {
    case 'hour': return at === undefined ? date : `${date}T${String(new Date(at).getHours()).padStart(2, '0')}`;
    case 'week': return railWeekKey(date);
    case 'month': return date.slice(0, 7);
    case 'year': return date.slice(0, 4);
    default: return date;
  }
}

const scrollsVertically = (element: HTMLElement) => {
  const { overflowY } = getComputedStyle(element);
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
};
/** CSS may allow scrolling without there being anything to scroll yet. */
const overflows = (element: HTMLElement) => element.scrollHeight > element.clientHeight + 1;

/** The element a gesture actually scrolls.
 *
 * The pull used to assume this was the archive list, which holds only inside the
 * library's own panels on a wide window. On compact, and behind the shelves, the
 * list is full-content height and the page scrolls instead — so the gesture
 * resolved to an element that could not move, and the pull silently did nothing
 * on exactly the layouts that have no other way to ask for a refresh.
 *
 * The list is checked first because it is a child of the root, not an ancestor:
 * the walk up from the root can never reach it. Then the nearest scrollable
 * ancestor, which is the page on compact. The list is the last resort, so a
 * layout where nothing around it scrolls still drags what the user can see.
 */
function scrollHost(list: HTMLElement | null, root: HTMLElement): HTMLElement | undefined {
  if (list && scrollsVertically(list) && overflows(list)) return list;
  let fallback: HTMLElement | undefined;
  for (let current: HTMLElement | null = root; current; current = current.parentElement) {
    if (!scrollsVertically(current)) continue;
    // Preferred: something with content to scroll behind the gesture.
    if (overflows(current)) return current;
    fallback ??= current;
  }
  return fallback ?? list ?? undefined;
}

/** The element that will actually move for a gesture that starts on `target`:
 * the nearest scrollable ancestor with content left to scroll.
 *
 * The ends cannot be judged by whatever the pull is bound to. On compact — and
 * behind the shelves — the list is exactly as tall as its content, so its
 * scrollTop is 0 for good while the page outside it scrolls. Read there, every
 * notch looked like it had gone past the top: the list bounced on every wheel
 * and asked for a refresh from the middle of the list. The gesture's own target
 * is the one element that knows which scroller it is about to move.
 *
 * Undefined means nothing under the cursor can scroll — then the list is its own
 * top and bottom at once, and only the top has anything to ask for. The host is
 * still consulted as a fallback: the panel gutters forward their wheel to the
 * list, and that list is the scroller those notches belong to. */
function gestureScroller(target: EventTarget | null, fallback: HTMLElement): HTMLElement | undefined {
  for (let current = target instanceof Element ? target as HTMLElement : null; current; current = current.parentElement) {
    if (scrollsVertically(current) && overflows(current)) return current;
  }
  return scrollsVertically(fallback) && overflows(fallback) ? fallback : undefined;
}

/** One shared empty set, so the uncontrolled case does not allocate per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** One row's timeline facts: the day it belongs to, the label for that day, and
 * the clock time shown on the rail. */
export interface ShelfTimelineEntry {
  date: string;
  dayLabel: string;
  time: string;
  /** 该行的时间戳（epoch 毫秒）。快速跳转条靠它按「距最新一行多久」选时间粒度；
   * 没有它的旧调用点按 `date` 退化成「天」这一级。 */
  at?: number | undefined;
}

interface LibraryWorkspaceProps {
  archives: ArchiveRecord[];
  metadata?: ArchiveMetadata | undefined;
  metadataLoading?: boolean | undefined;
  onSelect?: ((archive: ArchiveRecord) => void) | undefined;
  onDelete?: ((archive: ArchiveRecord) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  categories?: Category[] | undefined;
  /** Categories arrive after the list does, so the filter has to hold its place
   * rather than pop into the toolbar and shift everything beside it. */
  categoriesLoading?: boolean | undefined;
  onUpdateMetadata?: ((metadata: { title: string; tags: string; summary: string }) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  thumbnail?: string | undefined;
  onLoadThumbnail?: ((archive: ArchiveRecord, signal?: AbortSignal) => Promise<ImageHandle | undefined>) | undefined;
  onReleaseThumbnail?: ((handle: ImageHandle) => void) | undefined;
  /** 暖缓存里已经有这张封面时，重挂载的行第一帧就直接画它，不再先闪一下骨架。 */
  peekThumbnail?: ((archive: ArchiveRecord) => string | undefined) | undefined;
  totalCount?: number | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
  /** True while the first page is still in flight. Without it an empty list is
   * indistinguishable from a library that genuinely has nothing in it. */
  listLoading?: boolean | undefined;
  emptyContent?: ReactNode;
  onLoadMore?: (() => void) | undefined;
  isFavorite?: boolean | undefined;
  onToggleFavorite?: (() => Promise<void>) | undefined;
  searchQuery?: string | undefined;
  onSearchQueryChange?: ((value: string) => void) | undefined;
  sortTimeLabel?: string | undefined;
  archiveDateById?: ReadonlyMap<string, number> | undefined;
  sortMode?: 'title' | 'added' | undefined;
  onSortModeChange?: ((value: 'title' | 'added') => void) | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  onSortOrderChange?: ((value: 'asc' | 'desc') => void) | undefined;
  categoryFilter?: string | undefined;
  onCategoryFilterChange?: ((value: string) => void) | undefined;
  readingProgressByArchiveId?: ReadonlyMap<string, number> | undefined;
  /** 进度条的位置口径：`history` 只给历史记录页面（首页那一排由它自己的 rail 传），
   *  别的书架/档案库一律 `elsewhere`——「仅历史记录」档只在那两处画条。 */
  progressScope?: 'history' | 'elsewhere' | undefined;
  showDetail?: boolean | undefined;
  /** 列表里没有详情栏时（书架、档案库 Shell 的左栏），点卡片就是一次导航：
   * 落到哪个前缀由调用方决定——书架要留在书架上（`/history/:id`），而不是把
   * 左边那一栏换成档案库。 */
  detailBasePath?: string | undefined;
  /** `null` renders no heading; watchlist/history supply their own. */
  heading?: string | null | undefined;
  /** Watchlist/history filter their own records, so the tag search is hidden. */
  showSearch?: boolean | undefined;
  /** Supplying a toggle turns each card into a selectable row. */
  selectedArchiveIds?: ReadonlySet<string> | undefined;
  /** Multi-select. The workspace reads the gesture — a shift range needs the row
   * order, which only it has — and hands back the whole next selection, so the
   * page that owns the ids never has to know about anchors. */
  selectionMode?: boolean | undefined;
  onSelectionModeChange?: ((next: boolean) => void) | undefined;
  onSelectionChange?: ((next: ReadonlySet<string>) => void) | undefined;
  /** What the selection bar can do, drawn by the page that can actually do it. */
  selectionActions?: ReactNode;
  /** The archive ids the page considers read to the end, e.g. the history's
   * finished records. Supplied only where "finished" is meaningful; the button
   * toggles exactly these, the way 全选当前 toggles the whole list. */
  finishedArchiveIds?: ReadonlySet<string> | undefined;
  /** 后台刷新这一轮才第一次出现的档案 id：它们的行播一段入场动画。放在这里而不是
   *  让列表自己比上一轮，是因为「哪一批是新来的」只有发起请求的那一层知道——列表
   *  拿到的永远是一个全新的数组。 */
  freshArchiveIds?: ReadonlySet<string> | undefined;
  /** Opens the card context menu at the pointer; cards are the only elements
   * that answer a right click. */
  onArchiveContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined;
  /** Saved searches; absent for workspaces that have no preset store. */
  presets?: SearchPreset[] | undefined;
  onApplyPreset?: ((preset: SearchPreset) => void) | undefined;
  onSavePreset?: (() => void) | undefined;
  /** Renames an existing preset; the menu offers it per row. */
  onEditPreset?: ((preset: SearchPreset) => void) | undefined;
  onDeletePreset?: ((preset: SearchPreset) => void) | undefined;
  /** Names what the search bar filters. The shelves reuse the library's bar but
   * filter their own records in the browser, so their query commits on every
   * keystroke rather than waiting for Enter, and tag suggestions — which come
   * from the whole library — would be the wrong scope there. */
  searchScope?: { label: string; placeholder: string } | undefined;
  /** The sort and display controls. The shelves decide their own order and follow
   * the library's card style, so the bar there was three inert controls. */
  showToolbar?: boolean | undefined;
  /** Right-hand timeline entry per archive, e.g. when it was last read. The day
   * key groups rows so a shelf can be split by day on compact layouts. */
  timelineByArchiveId?: ReadonlyMap<string, ShelfTimelineEntry> | undefined;
  /** How cards are drawn. Controlled by the route from preferences, because the
   * shelves and the library have to agree and as component state it reset to the
   * default on every navigation. */
  cardStyle?: 'thumbnail' | 'wide' | undefined;
  onCardStyleChange?: ((value: 'thumbnail' | 'wide') => void) | undefined;
}

/** 页面被 `RetainedPage` 收起来时是 `display:none`：滚动容器量到的高度是 0，虚拟列表
 * 只剩最前面一两行（有时一行不剩），整屏的行跟着卸载——封面句柄一放手、URL 就被
 * 撤销，回到前台重新挂载只能从骨架开始。一整屏封面同时闪一下，就是用户报的那条。
 * 所以「同一个列表的行数没变、窗口里的行却突然塌了一大截」时不跟着塌：沿用上一次
 * 非空的那批行（藏起来时也不画，没有额外开销）。真空了（换了筛选、库里没有东西）
 * 或者只是窗口拖小了零星一行，就照实渲染，免得留着一批已经没有数据的卡片。 */
function useStableVirtualRows<T>(items: T[], totalSize: number, count: number): { items: T[]; totalSize: number } {
  const previous = useRef({ items, totalSize, count });
  if (items.length > 0) previous.current = { items, totalSize, count };
  const collapsed = previous.current.count === count && previous.current.items.length - items.length >= 2;
  return collapsed ? previous.current : { items, totalSize };
}

export function LibraryWorkspace({ archives, metadata, metadataLoading, onSelect, onDelete, onRefresh, refreshing, categories, categoriesLoading, onUpdateMetadata, thumbnail, onLoadThumbnail, onReleaseThumbnail, peekThumbnail, totalCount, hasMore, loadingMore, listLoading, emptyContent, onLoadMore, isFavorite, onToggleFavorite, searchQuery: controlledSearchQuery, onSearchQueryChange, sortTimeLabel = '添加时间', archiveDateById, sortMode: controlledSortMode, onSortModeChange, sortOrder: controlledSortOrder, onSortOrderChange, categoryFilter: controlledCategoryFilter, onCategoryFilterChange, readingProgressByArchiveId, progressScope, showDetail = true, detailBasePath = '/library', heading = '档案库', showSearch = true, selectedArchiveIds, selectionMode = false, onSelectionModeChange, onSelectionChange, selectionActions, finishedArchiveIds, freshArchiveIds, onArchiveContextMenu, presets, onApplyPreset, onSavePreset, onDeletePreset, onEditPreset, searchScope, showToolbar = true, timelineByArchiveId, cardStyle: controlledCardStyle, onCardStyleChange }: LibraryWorkspaceProps) {
  const [skeletonVisible, setSkeletonVisible] = useState(Boolean(listLoading && archives.length === 0));
  useEffect(() => {
    if (listLoading && archives.length === 0) {
      setSkeletonVisible(true);
      return;
    }
    if (!skeletonVisible) return;
    const timer = window.setTimeout(() => setSkeletonVisible(false), 180);
    return () => window.clearTimeout(timer);
  }, [archives.length, listLoading, skeletonVisible]);
  const [editingMetadata, setEditingMetadata] = useState(false);
  /** Which tick of the quick-jump rail the reader is looking at, as an index
   * into `railSegments`. Only written when the tick changes. */
  const [railActive, setRailActive] = useState(0);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataError, setMetadataError] = useState<string>();
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [localSortOrder, setLocalSortOrder] = useState<'asc' | 'desc'>('asc');
  const [localSortMode, setLocalSortMode] = useState<'title' | 'added'>('title');
  const [localCardStyle, setLocalCardStyle] = useState<'thumbnail' | 'wide'>('wide');
  const [localCategoryFilter, setLocalCategoryFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const pageActive = usePageActive();
  /** The element the pull is bound to: see scrollHost for how it is chosen. */
  const [scrollHostElement, setScrollHostElement] = useState<HTMLElement>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 鼠标悬在面板的左右留白（.library-shell-list 的 16px padding）或行间空隙上
  // 时，滚轮的目标链不经过 .archive-list——桌面端页面级 overflow:hidden，链条
  // 上没有任何可滚祖先，滚轮就整个作废。把这份手势转发给同面板的滚动区域。
  useEffect(() => {
    const region = scrollRef.current;
    if (!pageActive || compact || !region) return undefined;
    const host = region.closest('.library-shell-list') ?? region.parentElement;
    if (!host) return undefined;
    const forward = (event: Event) => {
      const wheel = event as WheelEvent;
      const target = wheel.target;
      if (target instanceof Element && target.closest('[data-scroll-region]')) return;
      const scale = wheel.deltaMode === 1 ? 40 : wheel.deltaMode === 2 ? region.clientHeight : 1;
      region.scrollTop += wheel.deltaY * scale;
      region.scrollLeft += wheel.deltaX * scale;
    };
    host.addEventListener('wheel', forward, { passive: true });
    return () => host.removeEventListener('wheel', forward);
  }, [compact, pageActive]);
  /** Undefined until something is actually chosen. Seeding it with the first
   * archive made the top row render as pressed on every visit — including on the
   * shelves, which show no detail pane for it to be the subject of. */
  const [selectedId, setSelectedId] = useState<string>();
  /** Archives whose cover is wider than tall, so their row packs differently.
   * Keyed per archive, so it would otherwise grow for as long as this workspace
   * stays mounted; the cap only ever drops a hint (the class falls back until
   * that cover reports its ratio again). */
  const [wideCoverIds, setWideCoverIds] = useState<Set<string>>(() => new Set());
  /** 上面这份组件态一到路由切换（这个工作区被重新挂载）就没了：回到档案库先按窄卡
   * 排一遍，等封面 load 出比例才翻成宽卡——整屏重排就是用户看到的那一下闪烁。
   * `archiveCardPresentation` 里那份按 (服务器, archiveId) 记的模块级记录跨路由活着
   * （有 4096 条上限，见那里的取舍），所以宽窄取「本次量到的」或「上次记下的」：
   * 同一个 archiveId 换台服务器不会串味，因为键里带着 serverId。 */
  const isWideCover = useCallback((archive: ArchiveRecord) => (
    wideCoverIds.has(archive.archiveId) || isWideCoverMarked(archive.serverId, archive.archiveId)
  ), [wideCoverIds]);
  const [searchDraft, setSearchDraft] = useState(controlledSearchQuery ?? '');
  const [gridWidth, setGridWidth] = useState(0);
  /** How far the list is dragged past its ends, in on-screen pixels: positive
   * below the top, negative past the bottom.
   *
   * 这个值只在本档过滚从静止跨进来时记一次、抬手时归零：手势期间每一像素的位置
   * 由 applyOverscroll 直接写进 DOM。以前每个触点都走一次 setState，整棵虚拟化
   * 列表每帧重渲染一遍，真机上就是「过滚刷新非常非常卡」。 */
  const [overscroll, setOverscroll] = useState(0);
  /** Which gesture is driving it: touch follows the finger exactly, a wheel
   * eases between notches, and null is the spring back after a release. */
  const [overscrollGesture, setOverscrollGesture] = useState<'touch' | 'wheel' | null>(null);
  /** 松手后那一趟回弹：只有 `data-overscroll='settle'` 那一档带过渡（见 shell.css）。
   * 手势期间不过渡是刻意的——每格滚轮都拖一条 100ms 的尾巴，就是用户 2026-10-17 报的
   * 「过滚效果还是非常卡」；而回弹那一档不打开，写回 0 就是瞬移。 */
  const [overscrollSettle, setOverscrollSettle] = useState(false);
  useEffect(() => {
    if (!overscrollSettle) return;
    const timer = window.setTimeout(() => setOverscrollSettle(false), EDGE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [overscrollSettle]);
  const overscrollRef = useRef(0);
  /** Gesture travel before damping, signed like the offset. */
  const overscrollTravel = useRef(0);
  /** 1 beyond the top, -1 beyond the bottom; undefined between gestures. */
  const overscrollDirection = useRef<1 | -1 | undefined>(undefined);
  /** The end a touch started on, so the finger may not pull the other way. */
  const overscrollEdge = useRef<'top' | 'bottom' | undefined>(undefined);
  const overscrollStartX = useRef<number | undefined>(undefined);
  const overscrollStartY = useRef<number | undefined>(undefined);
  /** 起手那一刻**真正会滚**的那一层，以及它的滚动位置。认定距离里那几像素是浏览器的，
   * 真机上这段里页面已经滚了一点点；认领时要把这一段放回去（见 touchMove），否则那点
   * 真实滚动就留在页面上——用户 2026-10-15 报的「顶部搜索框滚出视口」正是它。 */
  const overscrollScroller = useRef<HTMLElement | undefined>(undefined);
  const overscrollStartScrollTop = useRef<number | undefined>(undefined);
  /** 认领那一刻记下的滚动位置：之后它要是变了，说明浏览器在这段里自己滚了（真机上
   * preventDefault 有时已经拦不住），那这次过滚就让位，不能两套滚动叠着走。 */
  const overscrollClaimedScrollTop = useRef<number | undefined>(undefined);
  /** 这一次触摸有没有越过认定距离。没越过之前一个 preventDefault 都不发，手势还
   * 是浏览器的（见 touchMove）。 */
  const overscrollClaimed = useRef(false);
  const overscrollSettleTimer = useRef<number | undefined>(undefined);
  /** 被手指拖着走的那层列表，与它里面那枚箭头：手势期间直接写它们。 */
  const pullRef = useRef<HTMLDivElement | null>(null);
  const pullArrowRef = useRef<HTMLSpanElement | null>(null);
  const onRefreshRef = useRef(onRefresh);
  const refreshingRef = useRef(refreshing);

  /** 把位置画到 DOM 上。React 只管 state 里那一份静止值，所以手势里被直接改掉的
   * 属性要自己收回：否则抬手之后 React 认为「还是 0，不用动」，屏上留着拖到一半
   * 的那一帧。 */
  const pullFrame = useRef<number | undefined>(undefined);
  const pullQueued = useRef(false);
  const pendingPull = useRef(0);
  const paintPull = useCallback((offset: number) => {
    const pull = pullRef.current;
    if (pull) pull.style.transform = `translateY(${offset}px)`;
    const arrow = pullArrowRef.current;
    if (arrow) {
      arrow.style.transform = `rotate(${Math.round(Math.min(1, Math.max(0, offset) / PULL_THRESHOLD) * 180)}deg)`;
    }
  }, []);

  const resetOverscroll = useCallback(() => {
    const displaced = overscrollRef.current !== 0;
    if (pullFrame.current !== undefined) window.cancelAnimationFrame(pullFrame.current);
    pullFrame.current = undefined;
    pullQueued.current = false;
    overscrollTravel.current = 0;
    overscrollRef.current = 0;
    overscrollDirection.current = undefined;
    overscrollClaimed.current = false;
    overscrollEdge.current = undefined;
    overscrollStartY.current = undefined;
    overscrollStartX.current = undefined;
    overscrollScroller.current = undefined;
    overscrollStartScrollTop.current = undefined;
    overscrollClaimedScrollTop.current = undefined;
    paintPull(0);
    setOverscroll(0);
    // 先把回弹那一档打开，再让位置归零：顺序反了就没有动画（见 shell.css）。
    // Ordinary scroll/long-press releases must not promote the entire tall
    // virtual list to a persistent compositor layer behind the menu.
    setOverscrollSettle(displaced);
    setOverscrollGesture(null);
  }, [paintPull]);

  const cancelOverscroll = useCallback(() => {
    if (overscrollSettleTimer.current !== undefined) {
      window.clearTimeout(overscrollSettleTimer.current);
      overscrollSettleTimer.current = undefined;
    }
    resetOverscroll();
  }, [resetOverscroll]);

  /** Damped so the list cannot run away from the gesture: resistance increases with distance; the list moves
   * toward its limit continuously instead of hitting a hard stop.
   *
   * 位置写 DOM，state 只在「从静止跨进这一档」时变一次——下拉指示器靠它露出来。 */
  const applyOverscroll = useCallback((travel: number) => {
    // 手一搭上就把回弹那一档收掉：跟手期间不许有过渡。
    setOverscrollSettle(false);
    overscrollTravel.current = travel;
    const offset = rubberBand(travel, travel < 0 ? BOUNCE_MAX : PULL_MAX);
    const previous = overscrollRef.current;
    overscrollRef.current = offset;
    pendingPull.current = offset;
    if (!pullQueued.current) {
      pullQueued.current = true;
      pullFrame.current = window.requestAnimationFrame(() => {
        pullQueued.current = false;
        pullFrame.current = undefined;
        paintPull(pendingPull.current);
      });
    }
    if (Math.sign(previous) !== Math.sign(offset)) setOverscroll(Math.sign(offset));
  }, [paintPull]);

  /** The gesture is over: the list springs back either way, and a release past
   * the top's threshold asks for the refresh the disc is waiting to show. */
  const releaseOverscroll = useCallback(() => {
    const offset = overscrollRef.current;
    cancelOverscroll();
    // A second pull while the first request still runs has nothing to ask for.
    if (offset < PULL_THRESHOLD || !onRefreshRef.current || refreshingRef.current) return;
    onRefreshRef.current();
  }, [cancelOverscroll]);

  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);
  useEffect(() => { refreshingRef.current = refreshing; }, [refreshing]);

  /** 刷新中箭头翻到 180°（并靠 disc 上的 is-spinning 转起来）；结束后收回 0°。 */
  useEffect(() => {
    const arrow = pullArrowRef.current;
    if (arrow) arrow.style.transform = refreshing ? 'rotate(180deg)' : 'rotate(0deg)';
  }, [refreshing]);

  useEffect(() => () => {
    if (overscrollSettleTimer.current !== undefined) window.clearTimeout(overscrollSettleTimer.current);
  }, []);

  // The pull is bound natively, for two reasons. React's touchmove listener is
  // passive, so it cannot stop the browser's own overscroll from fighting the
  // gesture — and the gesture belongs to whichever element actually scrolls
  // (see scrollHost), which may be an ancestor of everything this component
  // renders, and so cannot be reached by React props.
  //
  // It is resolved into state rather than looked up per event: the host changes
  // with the layout and not with the gesture, and reading computed styles on
  // every wheel notch is work the compositor thread does not need. The host only
  // decides who listens — which end a notch is past is asked per gesture, from
  // the event's own target (see gestureScroller).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const resolve = () => {
      const next = scrollHost(scrollRef.current, root);
      setScrollHostElement((current) => current === next ? current : next);
    };
    resolve();
    window.addEventListener('resize', resolve);
    return () => window.removeEventListener('resize', resolve);
  }, [compact, pageActive]);

  useEffect(() => {
    const host = scrollHostElement;
    if (!pageActive || !host) return undefined;
    const owns = (target: EventTarget | null) => target instanceof Node && rootRef.current?.contains(target);

    const wheel = (event: WheelEvent) => {
      if (!owns(event.target)) return;
      // Deltas arrive in pixels, lines or pages; a line is about 16px.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      // 每次手势重新问一次「这一格滚轮会滚谁」：绑定的宿主只决定谁收到事件，
      // 而档位一换（例如转成紧凑档）列表就可能不再是那个会动的元素。
      const scroller = gestureScroller(event.target, host);
      const position = scroller ?? host;
      const beyondTop = delta < 0 && position.scrollTop <= 0;
      // 没有东西可滚时列表自己既是顶又是底：只有顶能要刷新，向下的那一格没有
      //「底部」可越——先前把它当底部拖，用户看到的就是每次滚轮都回弹一下。
      const beyondBottom = delta > 0 && scroller !== undefined
        && position.scrollTop + position.clientHeight >= position.scrollHeight - 1;
      if (!beyondTop && !beyondBottom) {
        // Ordinary scrolling: a gesture in flight is abandoned, not fired.
        if (overscrollRef.current !== 0 || overscrollSettleTimer.current !== undefined) cancelOverscroll();
        return;
      }
      const direction = beyondTop ? 1 : -1;
      // Reversing mid-gesture hands the scroller back before the other end takes it.
      if (overscrollDirection.current !== undefined && overscrollDirection.current !== direction) cancelOverscroll();
      overscrollDirection.current = direction;
      setOverscrollGesture('wheel');
      applyOverscroll(overscrollTravel.current + direction * Math.abs(delta));
      if (overscrollSettleTimer.current !== undefined) window.clearTimeout(overscrollSettleTimer.current);
      overscrollSettleTimer.current = window.setTimeout(() => {
        overscrollSettleTimer.current = undefined;
        releaseOverscroll();
      }, WHEEL_IDLE_MS);
    };

    const touchStart = (event: TouchEvent) => {
      if (overscrollRef.current !== 0 || overscrollSettleTimer.current !== undefined || overscrollClaimed.current) cancelOverscroll();
      if (!owns(event.target) || event.touches.length !== 1) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, [contenteditable], [role="slider"]')) return;
      for (let node = target as HTMLElement | null; node && node !== host && node !== scrollRef.current; node = node.parentElement) {
        const style = getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1 && !node.matches('.archive-rail-grid, [data-horizontal-scroll]')) return;
      }
      // The end the finger lands on is the only one it may pull past; anywhere
      // else the scroller needs the finger for its own scrolling.
      const position = gestureScroller(event.target, host) ?? host;
      const edge = position.scrollTop <= 0
        ? 'top'
        : position.scrollTop + position.clientHeight >= position.scrollHeight - 1 ? 'bottom' : undefined;
      overscrollEdge.current = edge;
      overscrollStartX.current = event.touches[0]?.clientX ?? 0;
      overscrollStartY.current = edge ? (event.touches[0]?.clientY ?? 0) : undefined;
      // 记住起手那一刻真正会滚的那一层与它的位置：认定距离里那几像素是浏览器的，
      // 真机上这段里页面已经滚了一点点（见 touchMove 的认领分支）。
      overscrollScroller.current = position;
      overscrollStartScrollTop.current = position.scrollTop;
    };

    const touchMove = (event: TouchEvent) => {
      const edge = overscrollEdge.current;
      const start = overscrollStartY.current;
      if (!edge || start === undefined) return;
      if (event.touches.length !== 1) { cancelOverscroll(); return; }
      const y = event.touches[0]?.clientY ?? start;
      const dx = (event.touches[0]?.clientX ?? 0) - (overscrollStartX.current ?? 0);
      if (!overscrollClaimed.current && Math.max(Math.abs(dx), Math.abs(y - start)) < PULL_CLAIM_PX) return;
      if (!overscrollClaimed.current && Math.abs(dx) > Math.abs(y - start)) { cancelOverscroll(); return; }
      const direction = edge === 'top' ? 1 : -1;
      const travel = (y - start) * direction;
      if (overscrollClaimed.current) {
        // 认领之后那一层要是还在动，说明浏览器并没有真把这次手势交出来（真机上
        // preventDefault 有时已经拦不住已经在跑的那次滚动）。两套滚动不能叠着走：
        // 列表一边被 translate 顶下去、页面一边在滚，用户看到的就是「顶栏滚出视口 +
        // 卡片与顶栏之间一大段空隙」（2026-10-15 报的档案库那一处）。这一刻让位，
        // 把列表放回原位，剩下的交给浏览器。
        const scroller = overscrollScroller.current;
        if (scroller && overscrollClaimedScrollTop.current !== undefined && scroller.scrollTop !== overscrollClaimedScrollTop.current) {
          cancelOverscroll();
          return;
        }
        // 已经认领过：手指往回走就把列表送回原位，但这一档仍归下拉——浏览器那次
        // 手势已经在 preventDefault 里交出来了，中途还回去只会两套滚动打架。
        event.preventDefault();
        applyOverscroll(direction * Math.max(0, travel));
        return;
      }
      if (travel < 0) {
        // 手指先走的是「滚动页面」那一侧（向上推离顶部）。这一次手势就交给浏览器，
        // 之后不再认领：先前的实现在这里只是清了端点，而下一次带向下分量的 move
        // 又会 preventDefault，浏览器早已开始滚，于是内容从手指底下滑走。
        overscrollEdge.current = undefined;
        overscrollStartY.current = undefined;
        return;
      }
      // 还没到认定距离：什么都不做，也不 preventDefault。这一次手势仍然是浏览器
      // 的，页面照滚；等手指真的往外走够认定距离再认领，那时它还没开始自己的滚动。
      if (travel < PULL_CLAIM_PX) return;
      overscrollClaimed.current = true;
      // 认定距离那几像素是**浏览器的**：真机上这段里页面已经滚了一点点。认领的这一刻
      // 把滚动位置放回起手时那一个，否则这一小段真实滚动就留在页面上——「顶部搜索框
      // 滚出视口」的一半原因在这里（另一半是列表被顶下去，看起来像一段空隙）。
      const scroller = overscrollScroller.current;
      const startScrollTop = overscrollStartScrollTop.current;
      if (scroller && startScrollTop !== undefined && scroller.scrollTop !== startScrollTop) {
        scroller.scrollTop = startScrollTop;
      }
      overscrollClaimedScrollTop.current = scroller ? scroller.scrollTop : undefined;
      // The pull owns the gesture from here, and it has to say so on the move
      // that starts it: once a touch browser has begun its own scroll it stops
      // honouring preventDefault for the rest of the gesture, and the content
      // would slide out from under the drag.
      event.preventDefault();
      overscrollDirection.current = direction;
      setOverscrollGesture('touch');
      applyOverscroll(direction * travel);
    };

    const touchEnd = () => {
      overscrollEdge.current = undefined;
      overscrollStartY.current = undefined;
      overscrollClaimed.current = false;
      if (overscrollRef.current !== 0) releaseOverscroll();
      else cancelOverscroll();
    };

    const visibility = () => { if (document.visibilityState !== 'visible') cancelOverscroll(); };
    document.addEventListener('visibilitychange', visibility);
    host.addEventListener('wheel', wheel, { passive: true });
    host.addEventListener('touchstart', touchStart, { passive: true });
    host.addEventListener('touchmove', touchMove, { passive: false });
    host.addEventListener('touchend', touchEnd, { passive: true });
    host.addEventListener('touchcancel', cancelOverscroll, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      host.removeEventListener('wheel', wheel);
      host.removeEventListener('touchstart', touchStart);
      host.removeEventListener('touchmove', touchMove);
      host.removeEventListener('touchend', touchEnd);
      host.removeEventListener('touchcancel', cancelOverscroll);
      cancelOverscroll();
    };
  }, [scrollHostElement, pageActive, compact, applyOverscroll, cancelOverscroll, releaseOverscroll]);
  const savedPanelLayout = useDefaultLayout({
    id: 'library-detail-layout',
    panelIds: showDetail ? ['library-list', 'library-detail'] : ['library-list'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** 没存过布局时档案库列表与详情那一栏的比例（64/36；只有一个面板时按满宽算）。 */
  const listPanelLayout: Layout = showDetail ? { 'library-list': 64, 'library-detail': 36 } : { 'library-list': 100 };
  const navigate = useNavigate();
  const location = useLocation();
  const detailArchiveId = showDetail ? selectedId : matchPath(`${detailBasePath}/:archiveId`, location.pathname)?.params.archiveId;
  useTagTranslations();

  const searchQuery = controlledSearchQuery ?? localSearchQuery;
  const sortOrder = controlledSortOrder ?? localSortOrder;
  const sortMode = controlledSortMode ?? localSortMode;
  const categoryFilter = controlledCategoryFilter ?? localCategoryFilter;
  const displayMode = controlledCardStyle ?? localCardStyle;
  // Compact history folds the right-hand rail into a horizontal day divider.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const list = scrollRef.current;
    const host = scrollHostElement;
    if (!pageActive) return;
    if (!compact || !list || !host || host === list) { setScrollMargin(0); return; }
    const measure = () => setScrollMargin(Math.max(0, list.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop + list.clientTop));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(rootRef.current!);
    observer?.observe(host);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [compact, scrollHostElement, pageActive]);
  useEffect(() => {
    if (!pageActive || !compact || !scrollHostElement || !hasMore || loadingMore || !onLoadMore) return;
    const host = scrollHostElement;
    const more = () => { if (host.scrollTop + host.clientHeight >= host.scrollHeight - 320) onLoadMore(); };
    host.addEventListener('scroll', more, { passive: true });
    return () => host.removeEventListener('scroll', more);
  }, [compact, scrollHostElement, hasMore, loadingMore, onLoadMore, pageActive]);
  const displayCategories = useMemo(() => sortCategoriesForDisplay((categories ?? []).filter((category) => category.name !== FAVORITES_CATEGORY_NAME)), [categories]);
  const filteredArchives = archives;
  /** Row index -> the day label to print above it. A day's first row starts a
   * group; everything else inherits it. */
  const dayStarts = useMemo(() => {
    const starts = new Map<number, string>();
    if (!timelineByArchiveId) return starts;
    let previous = '';
    filteredArchives.forEach((archive, index) => {
      const entry = timelineByArchiveId.get(archive.archiveId);
      if (!entry?.date || entry.date === previous) return;
      previous = entry.date;
      starts.set(index, entry.dayLabel || entry.date);
    });
    return starts;
  }, [filteredArchives, timelineByArchiveId]);
  /** 面板量出来的高度，用来算这一刻放得下几个刻度（见 `railTickCapFor`）。0 表示还
   * 没量到（jsdom 里也一样），那时先用常量上限。 */
  const [railPanelHeight, setRailPanelHeight] = useState(0);
  const railTickCap = railTickCapFor(railPanelHeight);
  /** 轨道的刻度：越靠近当前时间，一个刻度代表的时间跨度越小。
   *
   * 刻度不是按行等分的。按行等分时，「读得多的一天」会独占十几个刻度（同一天里每
   * `step` 行一个），而空白的几个月只有一个——疏密正好反了：最需要精确跳转的最近
   * 几天被摊薄，几年前的密集记录反而把轨道占满。
   *
   * 现在每一行先按「距最新一行多久」落进一个桶级（≤24 小时按小时、≤7 天按天、
   * ≤60 天按周、≤730 天按月、更早按年），相邻两行落在同一个桶键上就只发一个刻度，
   * 刻度落在这个桶最新的那一行（列表是倒序的，第一行最新）。桶键分别是
   * `date + 'T' + 两位小时`、`date`、那一周周一的 `YYYY-MM-DD`、`date.slice(0, 7)`、
   * `date.slice(0, 4)`。
   *
   * 总刻度数超过 `RAIL_MAX_TICKS` 时，把所有行的桶级整体升一级重建，一直到「年」；
   * 那时还超上限就等距抽稀。 */
  const railSegments = useMemo(() => {
    if (!timelineByArchiveId) return [];
    if (filteredArchives.length === 0) return [];
    const rowData: Array<{ index: number; date: string; dayLabel: string; time: string; at: number | undefined }> =
      filteredArchives.map((archive, index) => {
        const entry = timelineByArchiveId.get(archive.archiveId);
        return { index, date: entry?.date ?? '', dayLabel: entry?.dayLabel ?? '', time: entry?.time ?? '', at: entry?.at };
      });
    const labelFor = (row: { index: number; date: string; dayLabel: string; time: string }) =>
      [row.dayLabel || row.date, row.time].filter(Boolean).join(' ').trim() || `第 ${row.index + 1} 行`;

    // 锚点是能取到的时间戳里的最大值，不是本次渲染的「现在」：轨道只描述这本历史
    // 自己的疏密，也不该随系统时钟漂移。
    let anchorAt = Number.NEGATIVE_INFINITY;
    for (const row of rowData) {
      const at = row.at ?? Date.parse(row.date);
      if (!Number.isNaN(at) && at > anchorAt) anchorAt = at;
    }
    // 一条可信时间都取不到（旧调用点只剩下空的或坏的 `date`）：按「每行一个」兜底，
    // 也就是这条规则之前的粒度——总好过把一堆行凭空合并成一个刻度。
    if (anchorAt === Number.NEGATIVE_INFINITY) return rowData.map((row) => ({ index: row.index, label: labelFor(row) }));

    const baseLevels = rowData.map((row) => (row.at === undefined ? 'day' : railBaseLevel(anchorAt - row.at)));
    const build = (offset: number) => {
      const ticks: Array<{ index: number; label: string }> = [];
      let previousKey: string | undefined;
      rowData.forEach((row, position) => {
        const base = Math.max(0, RAIL_BUCKET_LEVELS.indexOf(baseLevels[position] ?? 'day'));
        const level = RAIL_BUCKET_LEVELS[Math.min(RAIL_BUCKET_LEVELS.length - 1, base + offset)] ?? 'year';
        const key = railBucketKey(level, row.date, row.at);
        if (key === previousKey) return;
        previousKey = key;
        ticks.push({ index: row.index, label: labelFor(row) });
      });
      return ticks;
    };

    let ticks = build(0);
    for (let offset = 1; ticks.length > railTickCap && offset < RAIL_BUCKET_LEVELS.length; offset += 1) ticks = build(offset);
    if (ticks.length > railTickCap) {
      const step = Math.ceil(ticks.length / railTickCap);
      ticks = ticks.filter((_, position) => position % step === 0);
    }
    return ticks;
  }, [filteredArchives, timelineByArchiveId, railTickCap]);
  /** The tick for the row the reader is looking at: the last segment that starts
   * at or above it. */
  const railSegmentFor = useCallback((rowIndex: number) => {
    let active = 0;
    railSegments.forEach((segment, position) => {
      if (segment.index <= rowIndex) active = position;
    });
    return active;
  }, [railSegments]);
  const updateSearchQuery = (value: string) => { setLocalSearchQuery(value); onSearchQueryChange?.(value); };
  // The draft is what the user sees; only committed values reach the server.
  useEffect(() => { setSearchDraft(searchQuery); }, [searchQuery]);
  const editSearchDraft = (value: string) => {
    setSearchDraft(value);
    // A shelf filters in the browser, so every keystroke can apply. The library
    // sends the query to the server, which is why it waits for a complete term.
    if (searchScope || isCommittableSearchQuery(value)) updateSearchQuery(value);
  };
  const updateSortMode = (value: 'title' | 'added') => { setLocalSortMode(value); onSortModeChange?.(value); };
  const updateSortOrder = (value: 'asc' | 'desc') => { setLocalSortOrder(value); onSortOrderChange?.(value); };
  const updateCategoryFilter = (value: string) => { setLocalCategoryFilter(value); onCategoryFilterChange?.(value); };
  const updateCardStyle = (value: 'thumbnail' | 'wide') => { setLocalCardStyle(value); onCardStyleChange?.(value); };

  const archiveCategories = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const category of categories ?? []) {
      for (const archiveId of category.archives) {
        // Display names: 🔖 Favorites reads as 收藏夹, and the rest are whatever
        // the user named them on the server.
        result.set(archiveId, [...(result.get(archiveId) ?? []), getCategoryDisplayName(category.name)]);
      }
    }
    return result;
  }, [categories]);

  /** LANraragi's own categories win over the `category:` tag. The card used to
   * show the tag and call it 分类, which conflated the uploader's metadata with
   * the shelves the user actually made. */
  const cardCategoryLabel = useCallback(
    (archive: ArchiveRecord) => archiveCategoryLabel(archive, archiveCategories.get(archive.archiveId)),
    [archiveCategories],
  );

  // The detail pane still needs a subject, and the first archive is the sensible
  // one; the *row* is only marked pressed when the choice was made.
  const selected = filteredArchives.find((archive) => archive.archiveId === selectedId) ?? filteredArchives[0];
  const editorIdentity = JSON.stringify([selected?.serverId, selected?.archiveId]);
  const editorOwner = useRef({ identity: editorIdentity, busy: false, active: true });
  if (editorOwner.current.identity !== editorIdentity) editorOwner.current = { identity: editorIdentity, busy: false, active: true };
  const currentEditor = editorOwner.current;
  useLayoutEffect(() => {
    currentEditor.active = true;
    setEditingMetadata(false);
    setSavingMetadata(false);
    setMetadataError(undefined);
    return () => { currentEditor.active = false; };
  }, [currentEditor]);
  const rows = useVirtualizer({
    count: filteredArchives.length,
    getScrollElement: () => compact ? scrollHostElement ?? null : scrollRef.current,
    scrollMargin,
    // Keep in step with `.archive-list.is-wide .archive-row-wrap` in shell.css:
    // the virtualizer positions rows, so a mismatch overlaps them. Each row is a
    // 158px card inside a 166px stride, which is where the 8px gap comes from;
    // on compact a day divider adds its own height to the day's first row.
    estimateSize: (index) => ARCHIVE_LIST_ROW_STRIDE + (compact && dayStarts.has(index) ? ARCHIVE_DAY_DIVIDER_HEIGHT : 0),
    getItemKey: (index) => filteredArchives[index]?.archiveId ?? index,
    overscan: 6,
    initialRect: { width: 720, height: 560 },
  });

  // Thumbnail mode is a fixed-width grid, so the column count is measurable and
  // rows can be virtualized like the list modes. Without this the mode rendered
  // every loaded archive at once.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? element.clientWidth;
      const measuredHeight = entries[0]?.contentRect.height ?? element.clientHeight;
      if (measured > 0) {
        setGridWidth((current) => getArchiveGridColumns(current || 720) === getArchiveGridColumns(measured)
          ? current : measured);
      }
      // 高度只在「刻度上限会因此改变」时才写：每次缩放都写一次会重算整条轨道。
      setRailPanelHeight((current) => (railTickCapFor(current) === railTickCapFor(measuredHeight) ? current : measuredHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, pageActive]);
  const gridColumns = getArchiveGridColumns(gridWidth || 720);
  const gridRows = useMemo(
    () => (displayMode === 'thumbnail'
      ? packArchiveGridRows(filteredArchives, gridColumns, isWideCover)
      : []),
    [displayMode, filteredArchives, gridColumns, isWideCover],
  );
  const thumbnailRows = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => compact ? scrollHostElement ?? null : scrollRef.current,
    scrollMargin,
    estimateSize: () => ARCHIVE_GRID_ROW_HEIGHT + ARCHIVE_GRID_GAP,
    overscan: 2,
    initialRect: { width: 720, height: 560 },
  });
  // 藏起来时别把整屏的行塌掉（见 `useStableVirtualRows`）。两个虚拟列表各调一次，
  // 永远按同一个顺序调用，钩子位置是稳的。
  const shownListRows = useStableVirtualRows(rows.getVirtualItems(), rows.getTotalSize(), filteredArchives.length);
  const shownThumbnailRows = useStableVirtualRows(thumbnailRows.getVirtualItems(), thumbnailRows.getTotalSize(), gridRows.length);

  /** What a shift click extends from: the last row the user touched. */
  const selectionAnchor = useRef<string>();
  const selectedIds = selectedArchiveIds ?? EMPTY_SELECTION;
  const allVisibleSelected = archives.length > 0 && archives.every((archive) => selectedIds.has(archive.archiveId));

  /** The ordinary conventions: a plain click toggles, shift takes the range
   * back to the anchor, and ctrl (or shift) on a card outside the mode moves
   * into it with that card held — the same as any file list. */
  const selectArchive = (archive: ArchiveRecord, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    const next = new Set(selectedIds);
    const index = archives.findIndex((item) => item.archiveId === archive.archiveId);
    const anchor = selectionAnchor.current === undefined ? -1 : archives.findIndex((item) => item.archiveId === selectionAnchor.current);
    if (modifiers.shiftKey && anchor >= 0 && index >= 0) {
      const [start, end] = anchor < index ? [anchor, index] : [index, anchor];
      for (const item of archives.slice(start, end + 1)) next.add(item.archiveId);
    } else if (next.has(archive.archiveId)) {
      next.delete(archive.archiveId);
    } else {
      next.add(archive.archiveId);
    }
    selectionAnchor.current = archive.archiveId;
    onSelectionChange?.(next);
  };

  const toggleAllVisible = () => {
    const next = new Set(selectedIds);
    for (const archive of archives) {
      if (allVisibleSelected) next.delete(archive.archiveId);
      else next.add(archive.archiveId);
    }
    selectionAnchor.current = archives[0]?.archiveId;
    onSelectionChange?.(next);
  };

  /** 已读完的那些：与「全选当前」一样是一次开关——再点一次就把这一组取消掉。 */
  const finishedVisible = useMemo(
    () => (finishedArchiveIds ? archives.filter((archive) => finishedArchiveIds.has(archive.archiveId)) : []),
    [archives, finishedArchiveIds],
  );
  const allFinishedSelected = finishedVisible.length > 0 && finishedVisible.every((archive) => selectedIds.has(archive.archiveId));
  const toggleAllFinished = () => {
    const next = new Set(selectedIds);
    for (const archive of finishedVisible) {
      if (allFinishedSelected) next.delete(archive.archiveId);
      else next.add(archive.archiveId);
    }
    selectionAnchor.current = finishedVisible[0]?.archiveId;
    onSelectionChange?.(next);
  };

  const renderArchiveButton = (archive: ArchiveRecord, eager: boolean, dayLabel?: string) => {
    const isSelected = selectedIds.has(archive.archiveId);
    const openArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (selectionMode && onSelectionChange) {
        selectArchive(archive, event);
        return;
      }
      // Ctrl or shift on a card is a selection gesture even before the mode is
      // on, so the two ways into it do not disagree.
      if (onSelectionChange && onSelectionModeChange && (event.shiftKey || event.ctrlKey || event.metaKey)) {
        onSelectionModeChange(true);
        onSelectionChange(new Set([archive.archiveId]));
        selectionAnchor.current = archive.archiveId;
        return;
      }
      setSelectedId(archive.archiveId);
      onSelect?.(archive);
      if (!showDetail) navigate(`${detailBasePath}/${archive.archiveId}?server=${encodeURIComponent(archive.serverId)}`);
    };
    const openMenu = onArchiveContextMenu ? (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }) => {
      // Cards are the only elements with a menu; everything else keeps the
      // platform default for a right click (text fields keep their own, which is
      // where 粘贴 lives).
      event.preventDefault();
      event.stopPropagation();
      onArchiveContextMenu(archive, { x: event.clientX, y: event.clientY });
    } : undefined;
    // A right click where there is one, a finger held still where there is not.
    const press = onArchiveContextMenu
      ? longPressHandlers((at) => onArchiveContextMenu(archive, at))
      : {};
    const cover = <LazyThumbnail archive={archive} onLoad={onLoadThumbnail} onRelease={onReleaseThumbnail} peek={peekThumbnail} onAspectRatio={(ratio) => {
      // 量到的比例既留在本次会话（组件态，立刻重排），也记进跨路由的那份记录。
      rememberWideCoverMark(archive.serverId, archive.archiveId, isWideCoverRatio(ratio));
      setWideCoverIds((current) => withWideCoverMark(current, archive.archiveId, isWideCoverRatio(ratio)));
    }} eager={eager} />;
    /* 紧凑档不画「详情已打开」那条高亮：手机上详情本来就是整屏盖住的，列表上留着的那圈
       primary 边框只剩「失焦也不消失」这一种读法（用户 2026-10-18 报的卡片高亮边框）。 */
    const pressed = !compact && archive.archiveId === detailArchiveId;
    return (
    <>
    {dayLabel && (
      /* Compact history: the right-hand rail is replaced by a dated section bar
         above the day's first card. */
      <div className="archive-day-divider"><span>{dayLabel}</span></div>
    )}
    {displayMode === 'thumbnail' ? (
      /* The grid card is the recommendation rail's card: same classes, same
         media/body/title/tags/meta structure, only the root element differs
         (a button here because the row is the click target). In selection mode
         the card is a checkbox, which is what it behaves as. */
      <button
        {...(selectionMode && onSelectionChange
          ? { role: 'checkbox', 'aria-checked': isSelected, 'aria-label': `选择 ${archive.title}` }
          : { 'aria-pressed': pressed })}
        className={`archive-thumb-card${isSelected ? ' is-selected' : ''}`}
        onClick={openArchive}
        onContextMenu={openMenu}
        {...press}
        type="button"
      >
        <div className="archive-thumb-card-media">
          {cover}
          {selectionMode && <span className="archive-card-check" aria-hidden="true" />}
        </div>
        <ArchiveThumbCardBody
          title={archive.title}
          tags={archive.tags}
          progressPage={readingProgressByArchiveId?.get(archive.archiveId)}
          progressScope={progressScope}
          pageCount={archive.pageCount}
          meta={<><span>{formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId))}</span><span>{formatArchiveDate(archiveDateById?.get(archive.archiveId) ?? archive.addedAt)}</span></>}
        />
      </button>
    ) : (
      <button
        {...(selectionMode && onSelectionChange
          ? { role: 'checkbox', 'aria-checked': isSelected, 'aria-label': `选择 ${archive.title}` }
          : { 'aria-pressed': pressed })}
        className={`archive-row${isSelected ? ' is-selected' : ''}`}
        onClick={openArchive}
        onContextMenu={openMenu}
        {...press}
        type="button"
      >
        {cover}
        {selectionMode && <span className="archive-card-check" aria-hidden="true" />}
        <span className="archive-row-copy">
          <strong>{archive.title}</strong>
          <ArchiveCardTags tags={archive.tags} limit={CARD_TAG_LIMIT_WIDE} rowCount={3} className="archive-row-tags" />
          <span className="archive-row-footer">
            <small className="archive-row-category" data-category={archiveCategoryKey(archive)}>{cardCategoryLabel(archive) || archiveLanguageLabel(archive)}</small>
            <small className="archive-row-stats">{[formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId)), formatArchiveDate(archiveDateById?.get(archive.archiveId) ?? archive.addedAt)].filter(Boolean).join(' · ')}</small>
          </span>
        </span>
        {/* 进度条贴的是卡片自己的底边，所以它是卡片的直接子元素、排在文案之后：
            卡片自己的 overflow: hidden + border-radius 把横条两端削成与卡片下缘
            一致的圆角，而这只有横条横跨整张卡时才成立（放在 .archive-row-copy 里
            它只能贴到文案栏的底边，两端是直角，右侧还差一个卡片内边距）。 */}
        <ArchiveProgressBar page={readingProgressByArchiveId?.get(archive.archiveId)} pageCount={archive.pageCount} scope={progressScope} cornerAware />
      </button>
    )}
    {/* The timeline belongs to the list rail, so it sits outside the clickable
        card and connects continuously between neighbouring cards. */}
    {timelineByArchiveId?.get(archive.archiveId) && (
      <span className="archive-row-timeline" aria-hidden="true">
        {dayLabel && <span className="archive-row-timeline-day">{dayLabel}</span>}
        <span className="archive-row-timeline-time">{timelineByArchiveId.get(archive.archiveId)?.time}</span>
      </span>
    )}
    </>
    );
  };

  return (
    <div className="library-workspace" ref={rootRef}>
      {heading !== null && <h1 className="visually-hidden">{heading}</h1>}
      {/* Pull to refresh is a gesture, so its state is announced, not drawn: the
          list sliding down and the disc on its top edge are what the eye gets. */}
      <span className="visually-hidden" role="status">{refreshing ? '正在刷新档案库…' : ''}</span>
      {showSearch && <div className="library-controls">
        <label className="search-label">
          <input
            ref={searchInputRef}
            aria-label={searchScope?.label ?? '搜索档案'}
            name="archiveQuery"
            type="search"
            autoComplete="off"
            /* A tag query is not prose: no capitals, no autocorrect, no red
               squiggles — and the keyboard's action key says 搜索, not 换行. */
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={SEARCH_PLACEHOLDER}
            value={searchDraft}
            onChange={(e) => editSearchDraft(e.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key !== 'Enter') return;
              event.preventDefault();
              /* 移动端：被 preventDefault 掉的 Enter，输入法不会自己落下
                 （用户 2026-10-18 报的「回车后软键盘不隐藏」），得把焦点从输入框上拿走。 */
              event.currentTarget.blur();
              updateSearchQuery(searchDraft);
            }}
          />
          {!searchScope && <TagSuggest inputValue={searchDraft} anchorRef={searchInputRef} onSelect={(tag) => updateSearchQuery(`${searchDraft.slice(0, searchDraft.lastIndexOf(',') + 1)}${searchDraft.includes(',') ? ' ' : ''}${tag}, `)} />}
        </label>
        {onSavePreset && (
          /* Every preset action lives in one menu: the button no longer grows a
             row of chips beside itself, and each preset row carries its own
             rename and delete actions. */
          <SearchPresetField
            presets={presets}
            onApply={(preset) => onApplyPreset?.(preset)}
            onSave={onSavePreset}
            {...(onEditPreset ? { onEdit: onEditPreset } : {})}
            {...(onDeletePreset ? { onDelete: onDeletePreset } : {})}
          />
        )}
        {!showToolbar && onSelectionModeChange && (
          /* The shelves have no toolbar, so the toggle sits beside the preset
             button in the search row — the same control, one row up. It is the
             disc shape there, because that is what the preset button is. */
          <button
            className="icon-action library-select-toggle"
            type="button"
            aria-pressed={selectionMode}
            aria-label={selectionMode ? '退出多选' : '多选'}
            title={selectionMode ? '退出多选' : '多选'}
            disabled={archives.length === 0}
            onClick={() => onSelectionModeChange(!selectionMode)}
          >
            <ListChecks aria-hidden="true" />
          </button>
        )}
      </div>}
      {showToolbar && <div className="library-toolbar" role="toolbar" aria-label="档案库工具">
        {showSearch && (!categoriesLoading || displayCategories.length > 0) && <SelectField name="categoryFilter" aria-label="分类筛选" value={categoryFilter} options={[{ value: '', label: '全部分类' }, ...displayCategories.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name) })), { value: UNTAGGED_FILTER_ID, label: '无标签' }]} onChange={updateCategoryFilter} />}
        {showSearch && displayCategories.length === 0 && categoriesLoading && <span className="skeleton-line select-placeholder" role="status" aria-label="正在读取分类" />}
        {/* The direction lives in the field itself: it shows which way the list
            is sorted, and choosing the mode already selected flips it — a
            separate button for two states was one control too many. */}
        <SelectField
          name="sortMode"
          aria-label="排序字段"
          value={sortMode}
          options={[{ value: 'title', label: '名称' }, { value: 'added', label: sortTimeLabel }]}
          onChange={(value) => {
            if (value === sortMode) updateSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
            else updateSortMode(value as 'title' | 'added');
          }}
          trailing={<span className="select-trailing" aria-hidden="true">{sortOrder === 'asc' ? <ArrowUp /> : <ArrowDown />}</span>}
          optionTrailing={(option) => option.value === sortMode
            ? <span className="select-option-trailing" aria-hidden="true">{sortOrder === 'asc' ? <ArrowUp /> : <ArrowDown />}</span>
            : null}
        />
        {onSelectionModeChange && (
          <button
            className="secondary-action library-select-toggle"
            type="button"
            aria-pressed={selectionMode}
            aria-label={selectionMode ? '退出多选' : '多选'}
            title={selectionMode ? '退出多选' : '多选'}
            disabled={archives.length === 0}
            onClick={() => onSelectionModeChange(!selectionMode)}
          >
            <ListChecks aria-hidden="true" />
          </button>
        )}
        <button
          className="secondary-action library-display-cycle"
          type="button"
          aria-label={`显示模式：${displayMode === 'wide' ? '缩略图列表' : '缩略图卡片'}，点击切换`}
          onClick={() => updateCardStyle(displayMode === 'wide' ? 'thumbnail' : 'wide')}
        >
          {displayMode === 'wide' ? <Rows3 aria-hidden="true" /> : <Grid2X2 aria-hidden="true" />}
        </button>
      </div>}
      {onSelectionChange && (
        /* The slot stays mounted and swaps `is-open`, so collapsing animates
           with the same motion that grew it in. While closed it is
           visibility-hidden: nothing inside is tabbable or announced. */
        <div className={`archive-selection-slot${selectionMode ? ' is-open' : ''}`}>
          <div className="archive-selection-bar" role="toolbar" aria-label="多选操作">
            <span className="archive-selection-count" role="status" aria-live="polite">已选 {selectedIds.size} 个</span>
            {/* Icon-only, like the reader's toolbar: the words live in the
                accessible name and the tooltip, so a row of actions reads as one
                row of symbols whatever the language. */}
            <button className="secondary-action is-icon" type="button" aria-pressed={allVisibleSelected} aria-label={allVisibleSelected ? '取消全选' : '全选当前'} title={allVisibleSelected ? '取消全选' : '全选当前'} onClick={toggleAllVisible} disabled={archives.length === 0}>
              <SquareCheckBig aria-hidden="true" />
            </button>
            {finishedArchiveIds && (
              <button className="secondary-action is-icon" type="button" aria-pressed={allFinishedSelected} aria-label={allFinishedSelected ? '取消全选已读完' : '全选已读完'} title={allFinishedSelected ? '取消全选已读完' : '全选已读完'} onClick={toggleAllFinished} disabled={finishedVisible.length === 0}>
                <ListTodo aria-hidden="true" />
              </button>
            )}
            {selectionActions}
            <button className="secondary-action is-icon archive-selection-done" type="button" aria-label="完成" title="完成" onClick={() => onSelectionModeChange?.(false)}><Check aria-hidden="true" /></button>
          </div>
        </div>
      )}
      <Group className={`library-panels ${showDetail ? '' : 'library-panels-list-only'}`} orientation="horizontal" defaultLayout={panelLayout(savedPanelLayout.defaultLayout, listPanelLayout)} onLayoutChanged={savedPanelLayout.onLayoutChanged}>
        <Panel className="library-list-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-list" minSize="40">
          {/* 刻度条挂在列表外面（面板这一层）。绝对定位的子元素如果留在滚动容器里，
              会跟着内容一起滚，居中就随滚动漂走——它得站在「看得见的那一段」的
              中线上，那正是这一层的高度。 */}
          {!compact && displayMode === 'wide' && railSegments.length > 1 && (
            <div className="archive-quick-rail" role="group" aria-label="历史快速跳转">
              <div className="archive-quick-rail-track" style={{ '--rail-ticks': railSegments.length } as CSSProperties}>
                {railSegments.map((segment, position) => (
                  <button
                    key={`${segment.index}-${segment.label}`}
                    className={`archive-quick-rail-tick${position === railActive ? ' is-active' : ''}`}
                    type="button"
                    title={segment.label}
                    aria-label={`跳转到 ${segment.label}`}
                    aria-current={position === railActive ? 'true' : undefined}
                    onClick={() => { rows.scrollToIndex(segment.index, { align: 'start', behavior: 'smooth' }); setRailActive(position); }}
                  >
                    <span className="archive-quick-rail-label" aria-hidden="true">{segment.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            className={`archive-list ${displayMode === 'thumbnail' ? 'is-thumbnail' : ''} ${displayMode === 'wide' ? 'is-wide' : ''} ${timelineByArchiveId ? 'has-timeline' : ''}`}
            data-scroll-region
            ref={scrollRef}
            role="list"
            aria-label="档案"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (target.scrollTop + target.clientHeight >= target.scrollHeight - 320) onLoadMore?.();
              // The rail's filled tick follows the row at the top of the viewport.
              // Written only when the tick changes: this list is virtualized, and a
              // state write per row would re-render every card on every scroll.
              if (displayMode !== 'wide' || railSegments.length < 2) return;
              const items = rows.getVirtualItems();
              const visible = items.find((item) => item.end > target.scrollTop) ?? items[0];
              if (!visible) return;
              const active = railSegmentFor(visible.index);
              setRailActive((current) => (current === active ? current : active));
            }}
            /* Overscroll: past either end the list is dragged by hand and
               springs back. Past the top it can also refresh — there is no
               refresh button any more — so the wheel and the finger are the only
               way to ask for it. */
          >
            {/* The refresh's feedback, pinned over the list rather than carried
                by it: the list springs back on release and this stays on top,
                spinning, until the request ends. Sticky inside the panel, so it
                holds the list's top edge in every layout. */}
            {onRefresh && (
              <span
                className={`library-pull-indicator${refreshing || overscroll > 0 ? ' is-visible' : ''}`}
                aria-hidden="true"
              >
                {/* The class is spelled out rather than appended: `? ' x' :
                    undefined` inside a template is the string "undefined", which
                    matches nothing and left the icon drawn raw in the corner. */}
                <span className={refreshing ? 'library-pull-disc is-spinning' : 'library-pull-disc'}>
                  {/* 角度由 paintPull 直接写：它要跟着手指走，而每一像素走一次
                      setState 正是这一档卡住的来源。刷新中的 180° 由下面那个
                      effect 写。 */}
                  <span className="library-pull-arrow" ref={pullArrowRef}>
                    <RefreshCw />
                  </span>
                </span>
              </span>
            )}
            <div
              className="archive-list-pull"
              ref={pullRef}
              data-overscroll={overscrollSettle ? 'settle' : (overscrollGesture ?? undefined)}
              style={{ transform: 'translateY(0px)' }}
            >
              {/* An in-flight request is not an empty library. These shared one
                  branch, so arriving at the library flashed 暂无档案库 before the
                  first page landed. */}
              {filteredArchives.length === 0 && !listLoading && (emptyContent && !searchQuery && !categoryFilter ? emptyContent : <EmptyState icon={FolderHeart} title={searchQuery || categoryFilter ? '没有匹配的档案' : '暂无档案库'} description={searchQuery || categoryFilter ? '调整搜索或分类条件后重试。' : '连接服务器后，档案会显示在这里。'} />)}
              {skeletonVisible && <div className={`archive-list-skeleton-layer${listLoading ? '' : ' is-exiting'}`}><ArchiveListSkeleton mode={displayMode} timeline={Boolean(timelineByArchiveId)} exiting={!listLoading} /></div>}
              {displayMode === 'thumbnail' ? (
                <div className="archive-list-inner" style={{ height: shownThumbnailRows.totalSize }}>
                  {shownThumbnailRows.items.map((virtualRow) => (
                    <div
                      className="archive-thumb-grid-row"
                      key={virtualRow.key}
                      style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                    >
                      {(gridRows[virtualRow.index] ?? []).map((archive) => (
                        <div
                          className={`archive-row-wrap${isWideCover(archive) ? ' is-cover-wide' : ''}${freshArchiveIds?.has(archive.archiveId) ? ' is-fresh' : ''}`}
                          key={archive.archiveId}
                          role="listitem"
                        >
                          {renderArchiveButton(archive, virtualRow.index < 2)}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
              <div className="archive-list-inner" style={{ height: shownListRows.totalSize }}>
                {shownListRows.items.map((row) => {
                  const archive = filteredArchives[row.index];
                  if (!archive) return null;
                  return (
                    <div
                      className={`archive-row-wrap ${displayMode === 'wide' ? 'is-wide' : ''} ${isWideCover(archive) ? 'is-cover-wide' : ''}${freshArchiveIds?.has(archive.archiveId) ? ' is-fresh' : ''}`}
                      key={archive.archiveId}
                      role="listitem"
                      // Every row is its own card; the wrap only carries the 8px
                      // gap between rows, so no first/last rounding is needed.
                      style={{ height: row.size, transform: `translateY(${row.start - scrollMargin}px)` }}
                    >
                      {renderArchiveButton(archive, row.index < 8, dayStarts.get(row.index))}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </div>
        </Panel>
        {showDetail && <><Separator className="panel-separator" />
        <Panel id="library-detail" minSize="30">
          {selected && (
            <section className="archive-detail" aria-labelledby="archive-detail-title">
              <h2 id="archive-detail-title">{selected.title}</h2>
              <div className="archive-detail-meta" aria-label="档案摘要">
                <span className="metadata-chip metadata-chip-page">{selected.pageCount} 页</span>
                {cardCategoryLabel(selected) && <span className="metadata-chip" data-category={archiveCategoryKey(selected)}>{cardCategoryLabel(selected)}</span>}
                {archiveLanguageLabel(selected) && <span className="metadata-chip">{archiveLanguageLabel(selected)}</span>}
              </div>
              {thumbnail && <div className="archive-detail-media"><img className="archive-cover" src={thumbnail} alt={`${selected.title} 封面`} width="320" height="450" loading="lazy" decoding="async" /></div>}
              {(selected.tags ?? []).length > 0 && <div className="archive-detail-tags" aria-label="档案标签">{categorizeSearchableTags(selected.tags ?? []).map((group) => <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}><h3>{group.label}</h3><div>{group.values.map((tag, index) => <TagSearchLink label={tag.label} query={tag.query} key={`${group.namespace}-${tag.query}-${index}`} />)}</div></section>)}</div>}
              <div className="archive-detail-actions">
                <Link className="primary-action" to={`/reader/${selected.archiveId}?server=${encodeURIComponent(selected.serverId)}`} aria-label={`阅读 ${selected.title}`}>
                  <BookOpen aria-hidden="true" />
                  阅读
                </Link>
              </div>
              {metadata && metadata.archiveId === selected.archiveId && onUpdateMetadata && !editingMetadata && (
                <button className="secondary-action" type="button" onClick={() => {
                  setEditingMetadata(true);
                }}><Pencil aria-hidden="true" />编辑元数据</button>
              )}
              {onToggleFavorite && <button className="secondary-action" type="button" aria-pressed={isFavorite} onClick={() => void onToggleFavorite()}><Star aria-hidden="true" fill={isFavorite ? 'currentColor' : 'none'} />{isFavorite ? '已收藏' : '加入收藏'}</button>}
              {metadata && metadata.archiveId === selected.archiveId && onUpdateMetadata && editingMetadata && (
                <form key={editorIdentity} className="metadata-form" aria-busy={savingMetadata} onSubmit={(event) => {
                  event.preventDefault();
                  if (currentEditor.busy || !currentEditor.active) return;
                  currentEditor.busy = true;
                  const controls = event.currentTarget.elements;
                  setSavingMetadata(true);
                  setMetadataError(undefined);
                  void onUpdateMetadata({
                    title: (controls.namedItem('title') as HTMLInputElement).value,
                    tags: (controls.namedItem('tags') as HTMLInputElement).value,
                    summary: (controls.namedItem('summary') as HTMLTextAreaElement).value,
                  }).then((result) => {
                    if (editorOwner.current !== currentEditor || !currentEditor.active) return;
                    if (result.ok) setEditingMetadata(false);
                    else setMetadataError(result.error?.message ?? '保存元数据失败');
                  }).catch((error: unknown) => {
                    if (editorOwner.current === currentEditor && currentEditor.active) setMetadataError(error instanceof Error ? error.message : '保存元数据失败');
                  }).finally(() => {
                    currentEditor.busy = false;
                    if (editorOwner.current === currentEditor && currentEditor.active) setSavingMetadata(false);
                  });
                }}>
                  <fieldset className="metadata-edit-fields" disabled={savingMetadata}>
                  <label>标题<input name="title" aria-label="标题" autoComplete="off" defaultValue={metadata.title || selected.title} /></label>
                  <label>标签<input name="tags" aria-label="标签" autoComplete="off" spellCheck={false} defaultValue={metadata.tags} /></label>
                  <label>简介<AutoTextarea name="summary" aria-label="简介" defaultValue={metadata.summary ?? ''} /></label>
                  <button className="primary-action" type="submit" disabled={savingMetadata} aria-busy={savingMetadata}><Save aria-hidden="true" />{savingMetadata ? '保存中…' : '保存元数据'}</button>
                  </fieldset>
                  {metadataError && <p role="alert">{metadataError}</p>}
                </form>
              )}
              {onDelete && (
                <button className="secondary-action" type="button" onClick={() => void onDelete(selected)}><Trash2 aria-hidden="true" />删除档案</button>
              )}
              <dl>
                <div><dt>页数</dt><dd>{selected.pageCount}</dd></div>
                <div><dt>服务器</dt><dd>{selected.serverId}</dd></div>
                {metadataLoading && <div><dt>元数据</dt><dd>加载中…</dd></div>}
                {metadata && metadata.archiveId === selected.archiveId && (
                  <>
                    <div><dt>文件名</dt><dd>{metadata.filename}</dd></div>
                    <div><dt>格式</dt><dd>{metadata.extension}</dd></div>
                    {metadata.summary && <div><dt>简介</dt><dd>{metadata.summary}</dd></div>}
                  </>
                )}
              </dl>
            </section>
          )}
        </Panel></>}
      </Group>
      {hasMore && loadingMore && <div className="archive-load-more-skeleton" role="status" aria-label="正在加载更多档案"><span className="skeleton-line" /><span className="skeleton-line" /></div>}
    </div>
  );
}

function ArchiveListSkeleton({ mode, timeline = false, exiting = false }: { mode: 'thumbnail' | 'wide'; timeline?: boolean; exiting?: boolean }) {
  /* A fixed count left tall windows with a strip of bare canvas under the last
     card. Count from the viewport instead: row heights mirror the CSS (158px
     wide rows, 350px thumbnail cards, plus one gap), and the old counts stay
     as the floor so short windows look exactly as before. */
  const count = (() => {
    const minimum = mode === 'thumbnail' ? 8 : 5;
    if (typeof window === 'undefined') return minimum;
    const available = window.innerHeight - 240;
    const rowHeight = mode === 'thumbnail' ? 350 + 12 : 158 + 12;
    if (available <= 0) return minimum;
    return Math.max(minimum, Math.ceil(available / rowHeight));
  })();
  return (
    <div className={`archive-list-skeleton is-${mode}${timeline ? ' has-timeline' : ''}${exiting ? ' is-exiting' : ''}`} role={exiting ? undefined : 'status'} aria-label={exiting ? undefined : '正在读取档案'} aria-hidden={exiting || undefined}>
      {mode === 'thumbnail'
        ? Array.from({ length: count }, (_, index) => <ArchiveThumbnailCardSkeleton key={index} />)
        : Array.from({ length: count }, (_, index) => (
          <div className="archive-row-skeleton" key={index}>
            <span className="skeleton-block archive-row-skeleton-cover" />
            <span className="archive-row-skeleton-copy"><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></span>
            {timeline && <span className="archive-timeline-skeleton"><span className="skeleton-line" /></span>}
          </div>
        ))}
    </div>
  );
}

function LazyThumbnail({ archive, onLoad, onRelease, onAspectRatio, eager = false, peek }: {
  archive: ArchiveRecord;
  onLoad?: ((archive: ArchiveRecord, signal?: AbortSignal) => Promise<ImageHandle | undefined>) | undefined;
  onRelease?: ((handle: ImageHandle) => void) | undefined;
  onAspectRatio?: ((ratio: number) => void) | undefined;
  eager?: boolean;
  /** 只在这一行第一次挂载时读一次：暖缓存命中就直接出图，不先画骨架那一帧。 */
  peek?: ((archive: ArchiveRecord) => string | undefined) | undefined;
}) {
  const [src, setSrc] = useState<string | undefined>(() => peek?.(archive));
  const [retry, setRetry] = useState(0);
  /** 重试用尽之后它就不是「还在加载」了。占位块照旧占着位置，但不该再闪：
   * `skeleton-shimmer` 动的是 background-position，是主线程每帧重画——一屏几十张
   * 取不回来的封面，就是几十个元素永远在画，而这正是窗口拖动/缩放之外的常驻开销。 */
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ImageHandle>();
  /** 放手时要用**当时**那个回调：`onRelease` 换了新的，旧句柄还是旧回调领回来的。 */
  const releaseRef = useRef(onRelease);
  useEffect(() => { releaseRef.current = onRelease; }, [onRelease]);
  /** 手上那个句柄放手的地方。同一张封面要重新取图时新旧句柄在下面交接，交给新句柄
   * 之后再放手旧的——中间这几帧里 URL 不会被撤销，图不会先黑一下再回来。 */
  const releaseHandle = useRef(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = undefined;
    releaseRef.current?.(handle);
  });
  // 卸载时放手最后一次。effect 重跑（返回新对象的那次后台重读）不放手：URL 一被撤销，
  // 这一帧的图就没了——那正是回到档案库时封面先闪一下骨架的来源。
  useEffect(() => () => releaseHandle.current(), []);
  useEffect(() => {
    if (!onLoad || !ref.current) return undefined;
    let active = true;
    let retryTimer: number | undefined;
    let observer: IntersectionObserver | undefined;
    const controller = new AbortController();
    // 不在这里 `setSrc(undefined)`：这张卡片从挂载起就只对着一条档案（调用点按
    // archiveId 给 key），effect 重跑只可能是重试或同一条档案换了对象，把已经画出来
    // 的图撤掉就等于自己闪自己一下。

    const start = () => {
      void onLoad(archive, controller.signal).then((handle) => {
        if (!active) {
          if (handle) onRelease?.(handle);
          return;
        }
        if (handle) {
          const previous = handleRef.current;
          handleRef.current = handle;
          if (previous) onRelease?.(previous);
          setSrc(handle.url);
        } else if (retry < 2) {
          retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 1200 * (retry + 1));
        } else {
          setFailed(true);
        }
      });
    };

    if (eager || typeof IntersectionObserver === 'undefined') {
      start();
    } else {
      const scrollRoot = ref.current.closest('[data-scroll-region]');
      observer = new IntersectionObserver(([entry]) => {
        if (!entry?.isIntersecting) return;
        observer?.disconnect();
        start();
      }, { root: scrollRoot, rootMargin: '240px' });
      observer.observe(ref.current);
    }

    return () => {
      active = false;
      controller.abort();
      observer?.disconnect();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [archive, eager, onLoad, onRelease, retry]);
  return <div ref={ref} className={`archive-row-thumb${src ? '' : ` is-skeleton${failed ? ' is-failed' : ''}`}`}>{src ? <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
  }} /> : <span aria-hidden="true" />}</div>;
}
