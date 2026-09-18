import { CardTagRows } from './CardTagRows';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderHeart, ArrowDown, ArrowUp, BookmarkPlus, BookOpen, ListChecks, Pencil, Plus, RefreshCw, Star, Grid2X2, Rows3, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import type { ArchiveRecord } from '../domain/library';
import type { ArchiveMetadata, Category, SearchPreset } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';
import { longPressHandlers } from '../lib/longPressMenu';
import { StatusLine } from './StatusLine';
import { SelectField } from './SelectField';
import { FAVORITES_CATEGORY_NAME, UNTAGGED_FILTER_ID, categorizeSearchableTags, getCategoryDisplayName, sortCategoriesForDisplay, translateRawTag } from '../lib/tags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { TagSuggest } from './TagSuggest';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { archiveCategoryKey, archiveCategoryLabel, archiveLanguageLabel, formatArchiveDate, formatArchivePageMeta, isWideCoverRatio, pickCardTags } from '../lib/archiveCardPresentation';
import { ARCHIVE_DAY_DIVIDER_HEIGHT, ARCHIVE_GRID_GAP, ARCHIVE_GRID_ROW_HEIGHT, ARCHIVE_LIST_ROW_STRIDE, getArchiveGridColumns, packArchiveGridRows } from '../lib/archiveGridLayout';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { isCommittableSearchQuery } from '../lib/searchQuery';
import { normalizeMyTagKey, readableInkOnHex } from '../lib/ehMyTags';
import { TagSearchLink } from './TagSearchLink';
import { ArchiveThumbCardBody, ArchiveThumbnailCardSkeleton } from './ArchiveThumbnailCard';
import { useEhMyTags } from './useEhMyTags';

/** Chips a thumbnail card offers. Generous on purpose: the fill waterfall drops
 * whatever the two visible rows cannot hold, so the limit only has to exceed
 * what the widest card can show — the measured rows decide, not a fixed count
 * per standard or wide card. */
/** One search hint for every page that has a search box. */
const SEARCH_PLACEHOLDER = '搜索档案…';

const CARD_TAG_LIMIT_THUMBNAIL = 24;
const CARD_TAG_LIMIT_WIDE = 36;

/* Overscroll. Beyond the top the list can be pulled down to refresh, beyond the
   bottom it bounces; both are damped, so the numbers are on-screen pixels and
   the gesture has to travel twice as far. */
const PULL_THRESHOLD = 64;
const PULL_MAX = 104;
const BOUNCE_MAX = 72;
const PULL_DAMPING = 0.5;
/** A wheel has no release event, so the gesture is over once it stops. */
const PULL_SETTLE_MS = 140;

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

/** One shared empty set, so the uncontrolled case does not allocate per render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/** One row's timeline facts: the day it belongs to, the label for that day, and
 * the clock time shown on the rail. */
export interface ShelfTimelineEntry {
  date: string;
  dayLabel: string;
  time: string;
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
  totalCount?: number | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
  /** True while the first page is still in flight. Without it an empty list is
   * indistinguishable from a library that genuinely has nothing in it. */
  listLoading?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  isFavorite?: boolean | undefined;
  onToggleFavorite?: (() => Promise<void>) | undefined;
  searchQuery?: string | undefined;
  onSearchQueryChange?: ((value: string) => void) | undefined;
  sortMode?: 'title' | 'added' | undefined;
  onSortModeChange?: ((value: 'title' | 'added') => void) | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  onSortOrderChange?: ((value: 'asc' | 'desc') => void) | undefined;
  categoryFilter?: string | undefined;
  onCategoryFilterChange?: ((value: string) => void) | undefined;
  readingProgressByArchiveId?: ReadonlyMap<string, number> | undefined;
  showDetail?: boolean | undefined;
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
  /** Selects the archive ids the page considers read to the end, e.g. the
   * history's finished records. Supplied only where "finished" is meaningful;
   * the count gates the button. */
  onSelectAllFinished?: (() => void) | undefined;
  finishedSelectableCount?: number | undefined;
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

export function LibraryWorkspace({ archives, metadata, metadataLoading, onSelect, onDelete, onRefresh, refreshing, categories, categoriesLoading, onUpdateMetadata, thumbnail, onLoadThumbnail, onReleaseThumbnail, totalCount, hasMore, loadingMore, listLoading, onLoadMore, isFavorite, onToggleFavorite, searchQuery: controlledSearchQuery, onSearchQueryChange, sortMode: controlledSortMode, onSortModeChange, sortOrder: controlledSortOrder, onSortOrderChange, categoryFilter: controlledCategoryFilter, onCategoryFilterChange, readingProgressByArchiveId, showDetail = true, heading = '档案库', showSearch = true, selectedArchiveIds, selectionMode = false, onSelectionModeChange, onSelectionChange, selectionActions, onSelectAllFinished, finishedSelectableCount, onArchiveContextMenu, presets, onApplyPreset, onSavePreset, onDeletePreset, onEditPreset, searchScope, showToolbar = true, timelineByArchiveId, cardStyle: controlledCardStyle, onCardStyleChange }: LibraryWorkspaceProps) {
  const myTags = useEhMyTags();
  const myTagKeys = useMemo(() => new Set(myTags.priority), [myTags.priority]);
  const myTagColorFor = useCallback((tag: string) => myTags.colors.get(normalizeMyTagKey(tag)), [myTags.colors]);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [localSortOrder, setLocalSortOrder] = useState<'asc' | 'desc'>('asc');
  const [localSortMode, setLocalSortMode] = useState<'title' | 'added'>('title');
  const [localCardStyle, setLocalCardStyle] = useState<'thumbnail' | 'wide'>('wide');
  const [localCategoryFilter, setLocalCategoryFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The element the pull is bound to: see scrollHost for how it is chosen. */
  const [scrollHostElement, setScrollHostElement] = useState<HTMLElement>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 鼠标悬在面板的左右留白（.library-shell-list 的 16px padding）或行间空隙上
  // 时，滚轮的目标链不经过 .archive-list——桌面端页面级 overflow:hidden，链条
  // 上没有任何可滚祖先，滚轮就整个作废。把这份手势转发给同面板的滚动区域。
  useEffect(() => {
    const region = scrollRef.current;
    if (!region) return undefined;
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
  }, []);
  /** Undefined until something is actually chosen. Seeding it with the first
   * archive made the top row render as pressed on every visit — including on the
   * shelves, which show no detail pane for it to be the subject of. */
  const [selectedId, setSelectedId] = useState<string>();
  const [wideCoverIds, setWideCoverIds] = useState<Set<string>>(() => new Set());
  const [searchDraft, setSearchDraft] = useState(controlledSearchQuery ?? '');
  const [gridWidth, setGridWidth] = useState(0);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  /** How far the list is dragged past its ends, in on-screen pixels: positive
   * below the top, negative past the bottom. */
  const [overscroll, setOverscroll] = useState(0);
  /** Which gesture is driving it: touch follows the finger exactly, a wheel
   * eases between notches, and null is the spring back after a release. */
  const [overscrollGesture, setOverscrollGesture] = useState<'touch' | 'wheel' | null>(null);
  const overscrollRef = useRef(0);
  /** Gesture travel before damping, signed like the offset. */
  const overscrollTravel = useRef(0);
  /** 1 beyond the top, -1 beyond the bottom; undefined between gestures. */
  const overscrollDirection = useRef<1 | -1 | undefined>(undefined);
  /** The end a touch started on, so the finger may not pull the other way. */
  const overscrollEdge = useRef<'top' | 'bottom' | undefined>(undefined);
  const overscrollStartY = useRef<number | undefined>(undefined);
  const overscrollSettleTimer = useRef<number | undefined>(undefined);
  const onRefreshRef = useRef(onRefresh);
  const refreshingRef = useRef(refreshing);

  const resetOverscroll = useCallback(() => {
    overscrollTravel.current = 0;
    overscrollRef.current = 0;
    overscrollDirection.current = undefined;
    setOverscroll(0);
    setOverscrollGesture(null);
  }, []);

  const cancelOverscroll = useCallback(() => {
    if (overscrollSettleTimer.current !== undefined) {
      window.clearTimeout(overscrollSettleTimer.current);
      overscrollSettleTimer.current = undefined;
    }
    resetOverscroll();
  }, [resetOverscroll]);

  /** Damped so the list cannot run away from the gesture: 100px of travel moves
   * it 50px, and it stops at the cap however much more arrives. */
  const applyOverscroll = useCallback((travel: number) => {
    overscrollTravel.current = travel;
    const offset = Math.max(-BOUNCE_MAX, Math.min(PULL_MAX, travel * PULL_DAMPING));
    overscrollRef.current = offset;
    setOverscroll(offset);
  }, []);

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
  // every wheel notch is work the compositor thread does not need.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const resolve = () => setScrollHostElement(scrollHost(scrollRef.current, root));
    resolve();
    window.addEventListener('resize', resolve);
    return () => window.removeEventListener('resize', resolve);
  }, []);

  useEffect(() => {
    const host = scrollHostElement;
    if (!host) return undefined;

    const wheel = (event: WheelEvent) => {
      // Deltas arrive in pixels, lines or pages; a line is about 16px.
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const beyondTop = delta < 0 && host.scrollTop <= 0;
      const beyondBottom = delta > 0 && host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
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
      }, PULL_SETTLE_MS);
    };

    const touchStart = (event: TouchEvent) => {
      // The end the finger lands on is the only one it may pull past; anywhere
      // else the scroller needs the finger for its own scrolling.
      const edge = host.scrollTop <= 0
        ? 'top'
        : host.scrollTop + host.clientHeight >= host.scrollHeight - 1 ? 'bottom' : undefined;
      overscrollEdge.current = edge;
      overscrollStartY.current = edge ? (event.touches[0]?.clientY ?? 0) : undefined;
    };

    const touchMove = (event: TouchEvent) => {
      const edge = overscrollEdge.current;
      const start = overscrollStartY.current;
      if (!edge || start === undefined) return;
      const y = event.touches[0]?.clientY ?? start;
      const direction = edge === 'top' ? 1 : -1;
      // Down past the top and up past the bottom are the two overscrolls; the
      // way back is ordinary scrolling, which the scroller keeps.
      if ((y - start) * direction <= 0) {
        overscrollEdge.current = undefined;
        overscrollStartY.current = undefined;
        if (overscrollRef.current !== 0) cancelOverscroll();
        return;
      }
      // The pull owns the gesture from here, and it has to say so on the move
      // that starts it: once a touch browser has begun its own scroll it stops
      // honouring preventDefault for the rest of the gesture, and the content
      // would slide out from under the drag.
      event.preventDefault();
      overscrollDirection.current = direction;
      setOverscrollGesture('touch');
      applyOverscroll(direction * Math.abs(y - start));
    };

    const touchEnd = () => {
      overscrollEdge.current = undefined;
      overscrollStartY.current = undefined;
      if (overscrollRef.current !== 0) releaseOverscroll();
    };

    host.addEventListener('wheel', wheel, { passive: true });
    host.addEventListener('touchstart', touchStart, { passive: true });
    host.addEventListener('touchmove', touchMove, { passive: false });
    host.addEventListener('touchend', touchEnd, { passive: true });
    host.addEventListener('touchcancel', touchEnd, { passive: true });
    return () => {
      host.removeEventListener('wheel', wheel);
      host.removeEventListener('touchstart', touchStart);
      host.removeEventListener('touchmove', touchMove);
      host.removeEventListener('touchend', touchEnd);
      host.removeEventListener('touchcancel', touchEnd);
    };
  }, [scrollHostElement, applyOverscroll, cancelOverscroll, releaseOverscroll]);
  const savedPanelLayout = useDefaultLayout({
    id: 'library-detail-layout',
    panelIds: showDetail ? ['library-list', 'library-detail'] : ['library-list'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const navigate = useNavigate();
  useTagTranslations();

  // The preset popover closes the way the select fields do.
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!presetMenuRef.current?.contains(event.target as Node)) setPresetMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const searchQuery = controlledSearchQuery ?? localSearchQuery;
  const sortOrder = controlledSortOrder ?? localSortOrder;
  const sortMode = controlledSortMode ?? localSortMode;
  const categoryFilter = controlledCategoryFilter ?? localCategoryFilter;
  const displayMode = controlledCardStyle ?? localCardStyle;
  // Compact history folds the right-hand rail into a horizontal day divider.
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
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
  const rows = useVirtualizer({
    count: filteredArchives.length,
    getScrollElement: () => scrollRef.current,
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
      if (measured <= 0) return;
      setGridWidth((current) => (Math.abs(current - measured) < 1 ? current : measured));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gridColumns = getArchiveGridColumns(gridWidth || 720);
  const gridRows = useMemo(
    () => (displayMode === 'thumbnail'
      ? packArchiveGridRows(filteredArchives, gridColumns, (archive) => wideCoverIds.has(archive.archiveId))
      : []),
    [displayMode, filteredArchives, gridColumns, wideCoverIds],
  );
  const thumbnailRows = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ARCHIVE_GRID_ROW_HEIGHT + ARCHIVE_GRID_GAP,
    overscan: 2,
    initialRect: { width: 720, height: 560 },
  });

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

  const renderArchiveButton = (archive: ArchiveRecord, eager: boolean, dayLabel?: string) => {
    const cardTags = pickCardTags(archive.tags, displayMode === 'thumbnail' ? CARD_TAG_LIMIT_THUMBNAIL : CARD_TAG_LIMIT_WIDE, myTagKeys);
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
      if (!showDetail) navigate(`/library/${archive.archiveId}?server=${encodeURIComponent(archive.serverId)}`);
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
    const cover = <LazyThumbnail archive={archive} onLoad={onLoadThumbnail} onRelease={onReleaseThumbnail} onAspectRatio={(ratio) => setWideCoverIds((current) => {
      // Returning a fresh Set on every cover load would re-render the whole
      // list once per thumbnail.
      if (current.has(archive.archiveId) === isWideCoverRatio(ratio)) return current;
      const next = new Set(current);
      if (isWideCoverRatio(ratio)) next.add(archive.archiveId);
      else next.delete(archive.archiveId);
      return next;
    })} eager={eager} />;
    const pressed = selectedId !== undefined && archive.archiveId === selectedId;
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
          tags={cardTags}
          colorFor={myTagColorFor}
          meta={<><span>{formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId))}</span><span>{formatArchiveDate(archive.addedAt)}</span></>}
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
          <CardTagRows tags={cardTags} rowCount={3} className="archive-row-tags" colorFor={myTagColorFor} />
          <span className="archive-row-footer">
            <small className="archive-row-category" data-category={archiveCategoryKey(archive)}>{cardCategoryLabel(archive) || archiveLanguageLabel(archive)}</small>
            <small className="archive-row-stats">{[formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId)), formatArchiveDate(archive.addedAt)].filter(Boolean).join(' · ')}</small>
          </span>
        </span>
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
              if (event.key !== 'Enter') return;
              event.preventDefault();
              updateSearchQuery(searchDraft);
            }}
          />
          {!searchScope && <TagSuggest inputValue={searchDraft} anchorRef={searchInputRef} onSelect={(tag) => updateSearchQuery(`${searchDraft.slice(0, searchDraft.lastIndexOf(',') + 1)}${searchDraft.includes(',') ? ' ' : ''}${tag}, `)} />}
        </label>
        {onSavePreset && (
          /* Every preset action lives in one menu: the button no longer grows a
             row of chips beside itself, and each preset row carries its own
             rename and delete actions. Same hand-rolled popover as the select
             fields, so it closes on an outside pointer, Escape and scroll. */
          <div className="search-preset-field" ref={presetMenuRef}>
            <button
              type="button"
              className="icon-action search-preset-save"
              aria-haspopup="menu"
              aria-expanded={presetMenuOpen}
              aria-label="检索预设"
              title="检索预设"
              onClick={() => setPresetMenuOpen((current) => !current)}
              onKeyDown={(event) => { if (event.key === 'Escape') setPresetMenuOpen(false); }}
            >
              <BookmarkPlus aria-hidden="true" />
            </button>
            {presetMenuOpen && (
              <div className="search-preset-overlay" role="presentation" onClick={() => setPresetMenuOpen(false)}>
                <div
                  className="search-preset-panel"
                  role="menu"
                  aria-label="检索预设"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => { if (event.key === 'Escape') setPresetMenuOpen(false); }}
                >
                  <h2 className="search-preset-title">检索预设</h2>
                  {presets && presets.length > 0
                  ? presets.map((preset) => (
                    <div className="search-preset-row" role="none" key={preset.presetId}>
                      <button type="button" role="menuitem" className="search-preset-apply" onClick={() => { onApplyPreset?.(preset); setPresetMenuOpen(false); }}>
                        {preset.name}
                      </button>
                      {onEditPreset && (
                        <button type="button" className="search-preset-icon" aria-label={`重命名预设 ${preset.name}`} title="重命名预设" onClick={() => { onEditPreset(preset); setPresetMenuOpen(false); }}>
                          <Pencil aria-hidden="true" />
                        </button>
                      )}
                      {onDeletePreset && (
                        <button type="button" className="search-preset-icon is-danger" aria-label={`删除预设 ${preset.name}`} title="删除预设" onClick={() => onDeletePreset(preset)}>
                          <Trash2 aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))
                    : <p className="search-preset-empty">还没有预设</p>}
                  <div className="search-preset-separator" role="none" />
                  <button type="button" role="menuitem" className="search-preset-add" onClick={() => { setPresetMenuOpen(false); onSavePreset(); }}>
                    <Plus aria-hidden="true" />
                    <span>新增预设</span>
                  </button>
                </div>
              </div>
            )}
          </div>
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
        {showSearch && displayCategories.length > 0 && <SelectField name="categoryFilter" aria-label="分类筛选" value={categoryFilter} options={[{ value: '', label: '全部分类' }, ...displayCategories.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name) })), { value: UNTAGGED_FILTER_ID, label: '无标签' }]} onChange={updateCategoryFilter} />}
        {showSearch && displayCategories.length === 0 && categoriesLoading && <span className="skeleton-line select-placeholder" role="status" aria-label="正在读取分类" />}
        {/* The direction lives in the field itself: it shows which way the list
            is sorted, and choosing the mode already selected flips it — a
            separate button for two states was one control too many. */}
        <SelectField
          name="sortMode"
          aria-label="排序字段"
          value={sortMode}
          options={[{ value: 'title', label: '名称' }, { value: 'added', label: '添加时间' }]}
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
      {selectionMode && onSelectionChange && (
        /* The slot animates from zero height, so the bar grows in and the list
           below is pushed down by the same motion instead of teleporting. */
        <div className="archive-selection-slot">
          <div className="archive-selection-bar" role="toolbar" aria-label="多选操作">
            <span className="archive-selection-count" role="status" aria-live="polite">已选 {selectedIds.size} 个</span>
            <button className="secondary-action" type="button" onClick={toggleAllVisible} disabled={archives.length === 0}>
              {allVisibleSelected ? '取消全选' : '全选当前'}
            </button>
            {onSelectAllFinished && (
              <button className="secondary-action" type="button" onClick={onSelectAllFinished} disabled={(finishedSelectableCount ?? 0) === 0}>
                全选已读完
              </button>
            )}
            {selectionActions}
            <button className="secondary-action archive-selection-done" type="button" onClick={() => onSelectionModeChange?.(false)}>完成</button>
          </div>
        </div>
      )}
      <Group className={`library-panels ${showDetail ? '' : 'library-panels-list-only'}`} orientation="horizontal" defaultLayout={savedPanelLayout.defaultLayout} onLayoutChanged={savedPanelLayout.onLayoutChanged}>
        <Panel className="library-list-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="library-list" defaultSize={showDetail ? '64' : '100'} minSize="40">
          <div
            className={`archive-list ${displayMode === 'thumbnail' ? 'is-thumbnail' : ''} ${displayMode === 'wide' ? 'is-wide' : ''} ${timelineByArchiveId ? 'has-timeline' : ''}`}
            data-scroll-region
            ref={scrollRef}
            role="list"
            aria-label="档案"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (target.scrollTop + target.clientHeight >= target.scrollHeight - 320) onLoadMore?.();
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
                  <span
                    className="library-pull-arrow"
                    style={{ transform: `rotate(${refreshing ? 180 : Math.round(Math.min(1, Math.max(0, overscroll) / PULL_THRESHOLD) * 180)}deg)` }}
                  >
                    <RefreshCw />
                  </span>
                </span>
              </span>
            )}
            <div
              className="archive-list-pull"
              data-overscroll={overscrollGesture ?? undefined}
              style={{ transform: `translateY(${overscroll}px)` }}
            >
              {/* An in-flight request is not an empty library. These shared one
                  branch, so arriving at the library flashed 暂无档案库 before the
                  first page landed. */}
              {filteredArchives.length === 0 && (listLoading
                ? <ArchiveListSkeleton mode={displayMode} />
                : <EmptyState icon={FolderHeart} title={searchQuery || categoryFilter ? '没有匹配的档案' : '暂无档案库'} description={searchQuery || categoryFilter ? '调整搜索或分类条件后重试。' : '连接服务器后，档案会显示在这里。'} />)}
              {displayMode === 'thumbnail' ? (
                <div className="archive-list-inner" style={{ height: thumbnailRows.getTotalSize() }}>
                  {thumbnailRows.getVirtualItems().map((virtualRow) => (
                    <div
                      className="archive-thumb-grid-row"
                      key={virtualRow.key}
                      style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {(gridRows[virtualRow.index] ?? []).map((archive) => (
                        <div
                          className={`archive-row-wrap ${wideCoverIds.has(archive.archiveId) ? 'is-cover-wide' : ''}`}
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
              <div className="archive-list-inner" style={{ height: rows.getTotalSize() }}>
                {rows.getVirtualItems().map((row) => {
                  const archive = filteredArchives[row.index];
                  if (!archive) return null;
                  return (
                    <div
                      className={`archive-row-wrap ${displayMode === 'wide' ? 'is-wide' : ''} ${wideCoverIds.has(archive.archiveId) ? 'is-cover-wide' : ''}`}
                      key={archive.archiveId}
                      role="listitem"
                      // Every row is its own card; the wrap only carries the 8px
                      // gap between rows, so no first/last rounding is needed.
                      style={{ height: row.size, transform: `translateY(${row.start}px)` }}
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
        <Panel id="library-detail" defaultSize="36" minSize="30">
          {selected && (
            <section className="archive-detail" aria-labelledby="archive-detail-title">
              <h2 id="archive-detail-title">{selected.title}</h2>
              <div className="archive-detail-meta" aria-label="档案摘要">
                <span className="metadata-chip metadata-chip-page">{selected.pageCount} 页</span>
                {cardCategoryLabel(selected) && <span className="metadata-chip" data-category={archiveCategoryKey(selected)}>{cardCategoryLabel(selected)}</span>}
                {archiveLanguageLabel(selected) && <span className="metadata-chip">{archiveLanguageLabel(selected)}</span>}
              </div>
              {thumbnail && <div className="archive-detail-media"><img className="archive-cover" src={thumbnail} alt={`${selected.title} 封面`} width="320" height="450" loading="lazy" /></div>}
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
                }}>编辑元数据</button>
              )}
              {onToggleFavorite && <button className="secondary-action" type="button" aria-pressed={isFavorite} onClick={() => void onToggleFavorite()}><Star aria-hidden="true" fill={isFavorite ? 'currentColor' : 'none'} />{isFavorite ? '已收藏' : '加入收藏'}</button>}
              {metadata && metadata.archiveId === selected.archiveId && onUpdateMetadata && editingMetadata && (
                <form className="metadata-form" onSubmit={(event) => {
                  event.preventDefault();
                  const controls = event.currentTarget.elements;
                  setSavingMetadata(true);
                  void onUpdateMetadata({
                    title: (controls.namedItem('title') as HTMLInputElement).value,
                    tags: (controls.namedItem('tags') as HTMLInputElement).value,
                    summary: (controls.namedItem('summary') as HTMLTextAreaElement).value,
                  }).then((result) => {
                    setSavingMetadata(false);
                    if (result.ok) setEditingMetadata(false);
                  });
                }}>
                  <label>标题<input name="title" aria-label="标题" autoComplete="off" defaultValue={metadata.title || selected.title} /></label>
                  <label>标签<input name="tags" aria-label="标签" autoComplete="off" spellCheck={false} defaultValue={metadata.tags} /></label>
                  <label>简介<textarea name="summary" aria-label="简介" defaultValue={metadata.summary ?? ''} /></label>
                  <button className="primary-action" type="submit" disabled={savingMetadata} aria-busy={savingMetadata}>{savingMetadata ? '保存中…' : '保存元数据'}</button>
                </form>
              )}
              {onDelete && (
                <button className="secondary-action" type="button" onClick={() => void onDelete(selected)}>删除档案</button>
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

function ArchiveListSkeleton({ mode }: { mode: 'thumbnail' | 'wide' }) {
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
    <div className={`archive-list-skeleton is-${mode}`} role="status" aria-label="正在读取档案">
      {mode === 'thumbnail'
        ? Array.from({ length: count }, (_, index) => <ArchiveThumbnailCardSkeleton key={index} />)
        : Array.from({ length: count }, (_, index) => (
          <div className="archive-row-skeleton" key={index}>
            <span className="skeleton-block archive-row-skeleton-cover" />
            <span className="archive-row-skeleton-copy"><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></span>
          </div>
        ))}
    </div>
  );
}

function LazyThumbnail({ archive, onLoad, onRelease, onAspectRatio, eager = false }: {
  archive: ArchiveRecord;
  onLoad?: ((archive: ArchiveRecord, signal?: AbortSignal) => Promise<ImageHandle | undefined>) | undefined;
  onRelease?: ((handle: ImageHandle) => void) | undefined;
  onAspectRatio?: ((ratio: number) => void) | undefined;
  eager?: boolean;
}) {
  const [src, setSrc] = useState<string>();
  const [retry, setRetry] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ImageHandle>();
  useEffect(() => {
    if (!onLoad || !ref.current) return undefined;
    let active = true;
    let retryTimer: number | undefined;
    let observer: IntersectionObserver | undefined;
    const controller = new AbortController();
    setSrc(undefined);

    const start = () => {
      void onLoad(archive, controller.signal).then((handle) => {
        if (!active) {
          if (handle) onRelease?.(handle);
          return;
        }
        if (handle) {
          handleRef.current = handle;
          setSrc(handle.url);
        } else if (retry < 2) {
          retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 1200 * (retry + 1));
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
      if (handleRef.current) onRelease?.(handleRef.current);
      handleRef.current = undefined;
    };
  }, [archive, eager, onLoad, onRelease, retry]);
  return <div ref={ref} className={`archive-row-thumb${!src ? ' is-skeleton' : ''}`}>{src ? <img src={src} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={(event) => {
    const image = event.currentTarget;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) onAspectRatio?.(image.naturalWidth / image.naturalHeight);
  }} /> : <span aria-hidden="true" />}</div>;
}
