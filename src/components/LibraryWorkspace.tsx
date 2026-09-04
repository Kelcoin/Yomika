import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderHeart, ArrowDown, ArrowUp, BookmarkPlus, BookOpen, RefreshCw, Star, Grid2X2, Rows3 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';

import type { ArchiveRecord } from '../domain/library';
import type { ArchiveMetadata, Category, SearchPreset } from '../repositories/nativeLibraryRepository';
import { EmptyState } from './EmptyState';
import { SelectField } from './SelectField';
import { FAVORITES_CATEGORY_NAME, categorizeTags, getCategoryDisplayName, sortCategoriesForDisplay, translateRawTag } from '../lib/tags';
import { useTagTranslations } from '../lib/tagTranslationService';
import { TagSuggest } from './TagSuggest';
import type { ImageHandle } from '../lib/unifiedImageCache';
import { formatArchiveDate, formatArchivePageMeta, isWideCoverRatio, pickCardTags } from '../lib/archiveCardPresentation';
import { ARCHIVE_GRID_GAP, ARCHIVE_GRID_ROW_HEIGHT, getArchiveGridColumns, packArchiveGridRows } from '../lib/archiveGridLayout';
import { isCommittableSearchQuery } from '../lib/searchQuery';

interface LibraryWorkspaceProps {
  archives: ArchiveRecord[];
  metadata?: ArchiveMetadata | undefined;
  metadataLoading?: boolean | undefined;
  onSelect?: ((archive: ArchiveRecord) => void) | undefined;
  onDelete?: ((archive: ArchiveRecord) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean | undefined;
  categories?: Category[] | undefined;
  onAddCategory?: ((categoryId: string) => void) | undefined;
  onUpdateMetadata?: ((metadata: { title: string; tags: string; summary: string }) => Promise<{ ok: boolean; error?: { message: string } }>) | undefined;
  thumbnail?: string | undefined;
  onLoadThumbnail?: ((archive: ArchiveRecord, signal?: AbortSignal) => Promise<ImageHandle | undefined>) | undefined;
  onReleaseThumbnail?: ((handle: ImageHandle) => void) | undefined;
  totalCount?: number | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
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
}

export function LibraryWorkspace({ archives, metadata, metadataLoading, onSelect, onDelete, onRefresh, refreshing, categories, onAddCategory, onUpdateMetadata, thumbnail, onLoadThumbnail, onReleaseThumbnail, totalCount, hasMore, loadingMore, onLoadMore, isFavorite, onToggleFavorite, searchQuery: controlledSearchQuery, onSearchQueryChange, sortMode: controlledSortMode, onSortModeChange, sortOrder: controlledSortOrder, onSortOrderChange, categoryFilter: controlledCategoryFilter, onCategoryFilterChange, readingProgressByArchiveId, showDetail = true, heading = '档案库', showSearch = true, selectedArchiveIds, onToggleSelected, onArchiveContextMenu, presets, onApplyPreset, onSavePreset, onDeletePreset }: LibraryWorkspaceProps) {
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [localSortOrder, setLocalSortOrder] = useState<'asc' | 'desc'>('asc');
  const [localSortMode, setLocalSortMode] = useState<'title' | 'added'>('title');
  const [displayMode, setDisplayMode] = useState<'thumbnail' | 'wide'>('wide');
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
  const displayCategories = useMemo(() => sortCategoriesForDisplay((categories ?? []).filter((category) => category.name !== FAVORITES_CATEGORY_NAME)), [categories]);
  const filteredArchives = archives;
  const updateSearchQuery = (value: string) => { setLocalSearchQuery(value); onSearchQueryChange?.(value); };
  // The draft is what the user sees; only committed values reach the server.
  useEffect(() => { setSearchDraft(searchQuery); }, [searchQuery]);
  const editSearchDraft = (value: string) => {
    setSearchDraft(value);
    if (isCommittableSearchQuery(value)) updateSearchQuery(value);
  };
  const updateSortMode = (value: 'title' | 'added') => { setLocalSortMode(value); onSortModeChange?.(value); };
  const updateSortOrder = (value: 'asc' | 'desc') => { setLocalSortOrder(value); onSortOrderChange?.(value); };
  const updateCategoryFilter = (value: string) => { setLocalCategoryFilter(value); onCategoryFilterChange?.(value); };

  const archiveCategories = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const category of categories ?? []) {
      for (const archiveId of category.archives) {
        result.set(archiveId, [...(result.get(archiveId) ?? []), category.name]);
      }
    }
    return result;
  }, [categories]);

  const selected = filteredArchives.find((archive) => archive.archiveId === selectedId) ?? filteredArchives[0];
  const rows = useVirtualizer({
    count: filteredArchives.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => displayMode === 'wide' ? 132 : 66,
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
        <span className="archive-row-tags">{pickCardTags(archive.tags, displayMode === 'thumbnail' ? 8 : 12).map((tag) => <small className="metadata-chip" key={tag}>{translateRawTag(tag)}</small>)}</span>
        <span className="archive-row-footer">
          <small className="archive-row-category" data-category={archive.category || ''}>{archive.category || archiveCategories.get(archive.archiveId)?.[0] || archive.language || ''}</small>
          <small className="archive-row-stats">{[formatArchivePageMeta(archive.pageCount, readingProgressByArchiveId?.get(archive.archiveId)), formatArchiveDate(archive.addedAt)].filter(Boolean).join(' · ')}</small>
        </span>
      </span>
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
            aria-label="搜索档案"
            name="archiveQuery"
            type="search"
            autoComplete="off"
            placeholder="搜索档案，回车提交…"
            value={searchDraft}
            onChange={(e) => editSearchDraft(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              updateSearchQuery(searchDraft);
            }}
          />
          <TagSuggest inputValue={searchDraft} anchorRef={searchInputRef} onSelect={(tag) => updateSearchQuery(`${searchDraft.slice(0, searchDraft.lastIndexOf(',') + 1)}${searchDraft.includes(',') ? ' ' : ''}${tag}, `)} />
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
          <button type="button" className="secondary-action search-preset-save" onClick={() => onSavePreset()}>
            <BookmarkPlus aria-hidden="true" />存为预设
          </button>
        )}
      </div>}
      <div className="library-toolbar" role="toolbar" aria-label="档案库工具">
        <button
          className="secondary-action library-display-cycle"
          type="button"
          aria-label={`显示模式：${displayMode === 'wide' ? '缩略图列表' : '缩略图卡片'}，点击切换`}
          onClick={() => setDisplayMode((mode) => (mode === 'wide' ? 'thumbnail' : 'wide'))}
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
        {showSearch && displayCategories.length > 0 && <SelectField name="categoryFilter" aria-label="分类筛选" value={categoryFilter} options={[{ value: '', label: '全部分类' }, ...displayCategories.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name) }))]} onChange={updateCategoryFilter} />}
      </div>
      <Group className={`library-panels ${showDetail ? '' : 'library-panels-list-only'}`} orientation="horizontal">
        <Panel defaultSize={showDetail ? '64' : '100'} minSize="40">
          <div className={`archive-list ${displayMode === 'thumbnail' ? 'is-thumbnail' : ''} ${displayMode === 'wide' ? 'is-wide' : ''}`} data-scroll-region ref={scrollRef} role="list" aria-label="档案" onScroll={(event) => {
            const target = event.currentTarget;
            if (target.scrollTop + target.clientHeight >= target.scrollHeight - 320) onLoadMore?.();
          }}>
            {filteredArchives.length === 0 && <EmptyState icon={FolderHeart} title={searchQuery || categoryFilter ? '没有匹配的档案' : '暂无档案库'} description={searchQuery || categoryFilter ? '调整搜索或分类条件后重试。' : '连接服务器后，档案会显示在这里。'} />}
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
                {(selected.category || archiveCategories.get(selected.archiveId)?.[0]) && <span className="metadata-chip" data-category={selected.category || ''}>{selected.category || archiveCategories.get(selected.archiveId)?.[0]}</span>}
                {selected.language && <span className="metadata-chip">{selected.language}</span>}
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
      {hasMore && loadingMore && <p className="server-list-message" role="status">正在加载更多档案…</p>}
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
            className="secondary-action"
            type="button"
            disabled={refreshing}
            aria-busy={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
            {refreshing ? '刷新中…' : '刷新档案库'}
          </button>
        )}
      </span>
    </header>
  );
}
