import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderHeart, ArrowDown, ArrowUp, BookmarkPlus, BookOpen, RefreshCw, Star, Grid2X2, Rows3 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';

import type { ArchiveRecord } from '../domain/library';
import type { ArchiveMetadata, Category, SearchPreset } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';
import { LoadingIndicator } from './LoadingIndicator';
import { SelectField } from './SelectField';
import { FAVORITES_CATEGORY_NAME, UNTAGGED_FILTER_ID, categorizeTags, getCategoryDisplayName, sortCategoriesForDisplay, translateRawTag } from '../lib/tags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { TagSuggest } from './TagSuggest';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { archiveCategoryKey, archiveCategoryLabel, archiveLanguageLabel, formatArchiveDate, formatArchivePageMeta, isWideCoverRatio, pickCardTags } from '../lib/archiveCardPresentation';
import { ARCHIVE_GRID_GAP, ARCHIVE_GRID_ROW_HEIGHT, getArchiveGridColumns, packArchiveGridRows } from '../lib/archiveGridLayout';
import { isCommittableSearchQuery } from '../lib/searchQuery';

/** Chips a card offers. These were 8 and 12, low enough that the cap — not the
 * space — was what limited the list: the CSS slot clips the overflow anyway, so a
 * generous number costs a few unrendered nodes and lets a wide card fill its
 * rows. */
const CARD_TAG_LIMIT_THUMBNAIL = 14;
const CARD_TAG_LIMIT_WIDE = 24;

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
  onToggleSelected?: ((archiveId: string, checked: boolean) => void) | undefined;
  /** Opens the card context menu at the pointer; cards are the only elements
   * that answer a right click. */
  onArchiveContextMenu?: ((archive: ArchiveRecord, at: { x: number; y: number }) => void) | undefined;
  /** Saved searches; absent for workspaces that have no preset store. */
  presets?: SearchPreset[] | undefined;
  onApplyPreset?: ((preset: SearchPreset) => void) | undefined;
  onSavePreset?: (() => void) | undefined;
  onDeletePreset?: ((preset: SearchPreset) => void) | undefined;
  /** Names what the search bar filters. The shelves reuse the library's bar but
   * filter their own records in the browser, so their query commits on every
   * keystroke rather than waiting for Enter, and tag suggestions — which come
   * from the whole library — would be the wrong scope there. */
  searchScope?: { label: string; placeholder: string } | undefined;
  /** The sort and display controls. The shelves decide their own order and follow
   * the library's card style, so the bar there was three inert controls. */
  showToolbar?: boolean | undefined;
  /** Right-hand timeline entry per archive, e.g. when it was last read. */
  timelineByArchiveId?: ReadonlyMap<string, string> | undefined;
  /** How cards are drawn. Controlled by the route from preferences, because the
   * shelves and the library have to agree and as component state it reset to the
   * default on every navigation. */
  cardStyle?: 'thumbnail' | 'wide' | undefined;
  onCardStyleChange?: ((value: 'thumbnail' | 'wide') => void) | undefined;
}

export function LibraryWorkspace({ archives, metadata, metadataLoading, onSelect, onDelete, onRefresh, refreshing, categories, categoriesLoading, onUpdateMetadata, thumbnail, onLoadThumbnail, onReleaseThumbnail, totalCount, hasMore, loadingMore, listLoading, onLoadMore, isFavorite, onToggleFavorite, searchQuery: controlledSearchQuery, onSearchQueryChange, sortMode: controlledSortMode, onSortModeChange, sortOrder: controlledSortOrder, onSortOrderChange, categoryFilter: controlledCategoryFilter, onCategoryFilterChange, readingProgressByArchiveId, showDetail = true, heading = '档案库', showSearch = true, selectedArchiveIds, onToggleSelected, onArchiveContextMenu, presets, onApplyPreset, onSavePreset, onDeletePreset, searchScope, showToolbar = true, timelineByArchiveId, cardStyle: controlledCardStyle, onCardStyleChange }: LibraryWorkspaceProps) {
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [localSortOrder, setLocalSortOrder] = useState<'asc' | 'desc'>('asc');
  const [localSortMode, setLocalSortMode] = useState<'title' | 'added'>('title');
  const [localCardStyle, setLocalCardStyle] = useState<'thumbnail' | 'wide'>('wide');
  const [localCategoryFilter, setLocalCategoryFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState(archives[0]?.archiveId);
  const [wideCoverIds, setWideCoverIds] = useState<Set<string>>(() => new Set());
  const [searchDraft, setSearchDraft] = useState(controlledSearchQuery ?? '');
  const [gridWidth, setGridWidth] = useState(0);
  const navigate = useNavigate();
  useTagTranslations();

  const searchQuery = controlledSearchQuery ?? localSearchQuery;
  const sortOrder = controlledSortOrder ?? localSortOrder;
  const sortMode = controlledSortMode ?? localSortMode;
  const categoryFilter = controlledCategoryFilter ?? localCategoryFilter;
  const displayMode = controlledCardStyle ?? localCardStyle;
  const displayCategories = useMemo(() => sortCategoriesForDisplay((categories ?? []).filter((category) => category.name !== FAVORITES_CATEGORY_NAME)), [categories]);
  const filteredArchives = archives;
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

  const selected = filteredArchives.find((archive) => archive.archiveId === selectedId) ?? filteredArchives[0];
  const rows = useVirtualizer({
    count: filteredArchives.length,
    getScrollElement: () => scrollRef.current,
    // Keep in step with `.archive-list.is-wide .archive-row` in shell.css: the
    // virtualizer positions rows, so a mismatch overlaps them.
    estimateSize: () => displayMode === 'wide' ? 158 : 66,
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

  const renderArchiveButton = (archive: ArchiveRecord, eager: boolean) => (
    <>
    {onToggleSelected && (
      <input
        className="archive-row-select"
        type="checkbox"
        aria-label={`选择 ${archive.title}`}
        checked={selectedArchiveIds?.has(archive.archiveId) ?? false}
        onChange={(event) => onToggleSelected(archive.archiveId, event.target.checked)}
      />
    )}
    <button
      aria-pressed={archive.archiveId === selected?.archiveId}
      className="archive-row"
      onClick={() => {
        setSelectedId(archive.archiveId);
        onSelect?.(archive);
        if (!showDetail) navigate(`/library/${archive.archiveId}`);
      }}
      onContextMenu={onArchiveContextMenu ? (event) => {
        // Cards are the only elements with a menu; everything else keeps the
        // platform default (which Tauri suppresses anyway).
        event.preventDefault();
        event.stopPropagation();
        onArchiveContextMenu(archive, { x: event.clientX, y: event.clientY });
      } : undefined}
      type="button"
    >
      {<LazyThumbnail archive={archive} onLoad={onLoadThumbnail} onRelease={onReleaseThumbnail} onAspectRatio={(ratio) => setWideCoverIds((current) => {
        // Returning a fresh Set on every cover load would re-render the whole
        // list once per thumbnail.
        if (current.has(archive.archiveId) === isWideCoverRatio(ratio)) return current;
        const next = new Set(current);
        if (isWideCoverRatio(ratio)) next.add(archive.archiveId);
        else next.delete(archive.archiveId);
        return next;
      })} eager={eager} />}
      <span className="archive-row-copy">
        <strong>{archive.title}</strong>
        <span className="archive-row-tags">{pickCardTags(archive.tags, displayMode === 'thumbnail' ? CARD_TAG_LIMIT_THUMBNAIL : CARD_TAG_LIMIT_WIDE).map((tag) => <small className="metadata-chip" key={tag}>{translateRawTag(tag)}</small>)}</span>
        <span className="archive-row-footer">
          <small className="archive-row-category" data-category={archiveCategoryKey(archive)}>{cardCategoryLabel(archive) || archiveLanguageLabel(archive)}</small>
          <small className="archive-row-stats">{[formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId)), formatArchiveDate(archive.addedAt)].filter(Boolean).join(' · ')}</small>
        </span>
      </span>
      {/* When the caller has a time for this archive, it goes on the right as a
          timeline entry rather than being folded into the stats line, so a run of
          rows reads as a sequence. */}
      {timelineByArchiveId?.get(archive.archiveId) && (
        <span className="archive-row-timeline" aria-hidden="true">{timelineByArchiveId.get(archive.archiveId)}</span>
      )}
    </button>
    </>
  );

  return (
    <div className="library-workspace">
      {heading !== null && <LibraryHeading heading={heading} count={totalCount ?? filteredArchives.length} onRefresh={onRefresh} refreshing={refreshing} />}
      {showSearch && <div className="library-controls">
        <label className="search-label">
          <input
            ref={searchInputRef}
            aria-label={searchScope?.label ?? '搜索档案'}
            name="archiveQuery"
            type="search"
            autoComplete="off"
            placeholder={searchScope?.placeholder ?? '搜索档案，回车提交…'}
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
        {presets && presets.length > 0 && (
          /* Saved searches restore the whole toolbar state, not just the query. */
          <div className="search-presets" role="group" aria-label="检索预设">
            {presets.map((preset) => (
              <span className="search-preset" key={preset.presetId}>
                <button type="button" className="search-preset-apply" onClick={() => onApplyPreset?.(preset)}>{preset.name}</button>
                {onDeletePreset && (
                  <button type="button" className="search-preset-remove" aria-label={`删除预设 ${preset.name}`} onClick={() => onDeletePreset(preset)}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
        {onSavePreset && (
          <button type="button" className="icon-action search-preset-save" onClick={() => onSavePreset()} aria-label="存为预设" title="存为预设">
            <BookmarkPlus aria-hidden="true" />
          </button>
        )}
      </div>}
      {showToolbar && <div className="library-toolbar" role="toolbar" aria-label="档案库工具">
        <button
          className="secondary-action library-display-cycle"
          type="button"
          aria-label={`显示模式：${displayMode === 'wide' ? '缩略图列表' : '缩略图卡片'}，点击切换`}
          onClick={() => updateCardStyle(displayMode === 'wide' ? 'thumbnail' : 'wide')}
        >
          {displayMode === 'wide' ? <Rows3 aria-hidden="true" /> : <Grid2X2 aria-hidden="true" />}
        </button>
        <button
          className="secondary-action library-sort-direction"
          type="button"
          aria-label={sortMode === 'title' ? (sortOrder === 'asc' ? '按标题降序' : '按标题升序') : (sortOrder === 'asc' ? '按添加时间降序' : '按添加时间升序')}
          onClick={() => updateSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
        >
          {sortOrder === 'asc' ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        </button>
        <SelectField name="sortMode" aria-label="排序字段" value={sortMode} options={[{ value: 'title', label: '名称' }, { value: 'added', label: '添加时间' }]} onChange={(value) => updateSortMode(value as 'title' | 'added')} />
        {showSearch && displayCategories.length > 0 && <SelectField name="categoryFilter" aria-label="分类筛选" value={categoryFilter} options={[{ value: '', label: '全部分类' }, ...displayCategories.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name) })), { value: UNTAGGED_FILTER_ID, label: '无标签' }]} onChange={updateCategoryFilter} />}
        {showSearch && displayCategories.length === 0 && categoriesLoading && <span className="skeleton-line select-placeholder" role="status" aria-label="正在读取分类" />}      </div>}
      <Group className={`library-panels ${showDetail ? '' : 'library-panels-list-only'}`} orientation="horizontal">
        <Panel defaultSize={showDetail ? '64' : '100'} minSize="40">
          <div className={`archive-list ${displayMode === 'thumbnail' ? 'is-thumbnail' : ''} ${displayMode === 'wide' ? 'is-wide' : ''}`} data-scroll-region ref={scrollRef} role="list" aria-label="档案" onScroll={(event) => {
            const target = event.currentTarget;
            if (target.scrollTop + target.clientHeight >= target.scrollHeight - 320) onLoadMore?.();
          }}>
            {/* An in-flight request is not an empty library. These shared one
                branch, so arriving at the library flashed 暂无档案库 before the
                first page landed. */}
            {filteredArchives.length === 0 && (listLoading
              ? <LoadingIndicator label="正在读取档案" size="lg" />
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
                    // Rows are absolutely positioned, so CSS cannot tell which is
                    // first or last; only the ends of the run get rounded corners.
                    data-first={row.index === 0}
                    data-last={row.index === filteredArchives.length - 1}
                    style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                  >
                    {renderArchiveButton(archive, row.index < 8)}
                  </div>
                );
              })}
            </div>
            )}
          </div>
        </Panel>
        {showDetail && <><Separator className="panel-separator" />
        <Panel defaultSize="36" minSize="24">
          {selected && (
            <section className="archive-detail" aria-labelledby="archive-detail-title">
              <h2 id="archive-detail-title">{selected.title}</h2>
              <div className="archive-detail-meta" aria-label="档案摘要">
                <span className="metadata-chip metadata-chip-page">{selected.pageCount} 页</span>
                {cardCategoryLabel(selected) && <span className="metadata-chip" data-category={archiveCategoryKey(selected)}>{cardCategoryLabel(selected)}</span>}
                {archiveLanguageLabel(selected) && <span className="metadata-chip">{archiveLanguageLabel(selected)}</span>}
              </div>
              {thumbnail && <div className="archive-detail-media"><img className="archive-cover" src={thumbnail} alt={`${selected.title} 封面`} width="320" height="450" loading="lazy" /></div>}
              {(selected.tags ?? []).length > 0 && <div className="archive-detail-tags" aria-label="档案标签">{categorizeTags(selected.tags ?? []).map((group) => <section className={`tag-group tag-group-${group.namespace}`} key={group.namespace}><h3>{group.label}</h3><div>{group.values.map((tag, index) => <span className="metadata-chip" key={`${group.namespace}-${tag}-${index}`}>{tag}</span>)}</div></section>)}</div>}
              <div className="archive-detail-actions">
                <Link className="primary-action" to={`/reader/${selected.archiveId}`} aria-label={`阅读 ${selected.title}`}>
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
                <Dialog.Root>
                  <Dialog.Trigger asChild><button className="secondary-action" type="button">删除档案</button></Dialog.Trigger>
                  <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                      <Dialog.Title>确认删除</Dialog.Title>
                      <Dialog.Description>将从 LANraragi 删除“{selected.title}”，此操作不可撤销。</Dialog.Description>
                      <div className="dialog-actions">
                        <Dialog.Close asChild><button className="secondary-action" type="button">取消</button></Dialog.Close>
                        <Dialog.Close asChild>
                          <button className="primary-action" type="button" onClick={() => void onDelete(selected)}>确认删除</button>
                        </Dialog.Close>
                      </div>
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>
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
      {hasMore && loadingMore && <LoadingIndicator label="正在加载更多档案" size="sm" />}
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

function LibraryHeading({ heading, count, onRefresh, refreshing }: { heading: string; count: number; onRefresh?: (() => void) | undefined; refreshing?: boolean | undefined }) {
  return (
    <header className="workspace-heading library-heading">
      <div>
        <h1>{heading}</h1>
      </div>
      <span className="library-heading-actions">
        <span>{count} 项</span>
        {onRefresh && (
          <button
            className="icon-action"
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            aria-label="刷新档案库"
            title="刷新档案库"
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" className={refreshing ? 'is-spinning' : undefined} />
          </button>
        )}
      </span>
    </header>
  );
}
