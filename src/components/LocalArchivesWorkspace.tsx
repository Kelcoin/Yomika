import { useVirtualizer } from '@tanstack/react-virtual';
import { ArchiveCardTags } from './CardTagRows';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, Download, FileArchive, FolderOpen, ListChecks, MoreVertical, Pause, Play, SquareCheckBig, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Layout } from 'react-resizable-panels';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ArchiveThumbMedia } from './ArchiveThumbnailCard';
import { LocalArchiveContextMenu, type LocalArchiveContextMenuTarget } from './ArchiveContextMenu';
import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, useArchiveCover, useDetailTagGroups, useSingleLineTitle } from './ArchiveDetailSections';
import { EmptyState } from './EmptyState';
import { SearchPresetField } from './SearchPresetField';
import { SelectField, type SelectOption } from './SelectField';
import { ArchiveListSkeleton } from './ArchiveListSkeleton';
import { useDelayedUnmount } from '../lib/useDelayedUnmount';
import { TextInputDialog } from './TextInputDialog';
import { useToast } from './Toast';
import { usePageActive } from '../app/RetainedPage';
import { panelLayout } from '../lib/panelLayout';
import { COMPACT_WIDTH_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { getPlatformCapabilities, revealInFileManager } from '../bridge/platform';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { longPressHandlers } from '../lib/longPressMenu';
import { UNTAGGED_FILTER_ID } from '../lib/tags';
import type { LocalArchiveRecord, TaskRecord } from '../domain/library';
import { CARD_TAG_LIMIT_WIDE, archiveCategoryKey, archiveCategoryLabel, archiveLanguageLabel, formatArchiveDate, formatByteSize } from '../lib/archiveCardPresentation';
import { ARCHIVE_LIST_ROW_STRIDE } from '../lib/archiveGridLayout';
import { NativeLibraryRepository, type SearchPreset } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

/** 跑着的任务看得紧（进度条要动），落定的列表看得松。 */
const RUNNING_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;

const SEARCH_PLACEHOLDER = '搜索本地档案…';

/** 检索预设按 scope 存。本地档案不属于任何一台服务器，所以给它一个自己的
 * scope：存在同一张表里，但不会和档案库那些按服务器分的预设混在一起。 */
const LOCAL_PRESET_SCOPE = 'local-archives';

/** 未完成的下载：还在这条路上跑的那些任务行。 */
function isActiveDownload(task: TaskRecord): boolean {
  return Boolean(task.localPath) && ['running', 'paused', 'queued', 'failed'].includes(task.status);
}

function downloadTitle(task: TaskRecord): string {
  return task.label.replace(/^下载\s*/, '') || task.label;
}

function taskStatusLabel(status: TaskRecord['status']): string {
  if (status === 'queued') return '等待中';
  if (status === 'running') return '下载中';
  if (status === 'paused') return '已暂停';
  if (status === 'failed') return '失败';
  if (status === 'completed') return '已完成';
  return '已取消';
}

function taskStatusClass(status: TaskRecord['status']): string {
  if (status === 'failed' || status === 'cancelled') return 'status-chip-danger';
  if (status === 'completed') return 'status-chip-success';
  if (status === 'running') return 'status-chip-active';
  if (status === 'paused') return 'status-chip-warning';
  return 'status-chip-neutral';
}

/** 「已收 / 总量 · 速度」：暂停和没报总长的任务各少一段，不摆空位。 */
function downloadStats(task: TaskRecord): string {
  const parts = [`${Math.round(task.progress * 100)}%`];
  const received = formatByteSize(task.receivedBytes);
  parts.push(task.totalBytes ? `${received} / ${formatByteSize(task.totalBytes)}` : received);
  if (task.status === 'running' && task.bytesPerSecond) parts.push(`${formatByteSize(task.bytesPerSecond)}/s`);
  return parts.join(' · ');
}

/** 页面被 `RetainedPage` 收起来时是 `display:none`：滚动容器量到的高度是 0，
 * 虚拟列表就连一行都不剩（真浏览器里也一样），整屏的行跟着卸载；切回来那一帧
 * 再从头建一遍行、封面、标签——这一下一上就是用户说的「固定闪烁」。
 *
 * 虚拟器量出来的窗口比上一次小掉两行以上、列表本身的行数又没变，就照上一次的
 * 窗口渲染：被收起来的这段时间里列表原样留在 DOM 上，回来时还是同一批节点，
 * 封面不用重取。真的空出一大截（筛掉了、删掉了）或者只是窗口拖小了零星一行，
 * 行数对不上或者差得不够多，照实渲染。
 *
 * 档案库（`src/components/LibraryWorkspace.tsx`）有同一份实现，但它没导出，
 * 这里不再为一个 5 行的兜底去动那个文件。 */
function useStableVirtualRows<T>(items: T[], totalSize: number, count: number): { items: T[]; totalSize: number } {
  const previous = useRef({ items, totalSize, count });
  if (items.length > 0) previous.current = { items, totalSize, count };
  const collapsed = previous.current.count === count && previous.current.items.length - items.length >= 2;
  return collapsed ? previous.current : { items, totalSize };
}

/** 这一页展示、也被分类筛选用的那一个维度：档案自己的分类，没有就退回语言。
 * 本地档案没有「分类」这张表可查——镜像里只有 tags——所以筛选的取值域就从
 * 读回来的档案里现推。行里写的和下拉框筛的必须是同一个函数算出来的值，不然
 * 选了某一项筛出来的和屏幕上看到的对不上。 */
function localCategoryLabel(archive: LocalArchiveRecord): string {
  return archiveCategoryLabel(archive) || archiveLanguageLabel(archive);
}

type LocalSortMode = 'title' | 'added';
type LocalSortOrder = 'asc' | 'desc';

/** 和档案库那两个下拉框同一套选项，顺序也一样。 */
const SORT_OPTIONS: SelectOption[] = [
  { value: 'title', label: '名称' },
  { value: 'added', label: '下载时间' },
];

/** 档案库的排序在原生那边做（`ORDER BY added_at DESC, path DESC`），这一页没有
 * 服务端查询，就在前端排。比较式和那边对齐：先按选中的字段，再按路径定序——
 * 默认的「添加时间 / 降序」于是和改之前列表的次序完全一致，谁也没动过控件时
 * 看不到任何变化。 */
function compareLocalArchives(left: LocalArchiveRecord, right: LocalArchiveRecord, mode: LocalSortMode, order: LocalSortOrder): number {
  const direction = order === 'asc' ? 1 : -1;
  if (mode === 'title') {
    const byTitle = left.title.localeCompare(right.title, 'zh-Hans-CN');
    if (byTitle !== 0) return direction * byTitle;
  } else {
    const byAdded = left.addedAt - right.addedAt;
    if (byAdded !== 0) return direction * byAdded;
  }
  return direction * left.path.localeCompare(right.path);
}

/** 列表的一行。下载任务和落地的档案混在同一条列表里，虚拟器按平铺的序号定位。 */
type LocalListRow =
  | { kind: 'task'; key: string; task: TaskRecord }
  | { kind: 'archive'; key: string; archive: LocalArchiveRecord };

function DownloadRow({ task, pending, onControl }: {
  task: TaskRecord;
  pending: boolean;
  onControl: (task: TaskRecord, action: 'pause' | 'resume' | 'cancel') => void;
}) {
  return (
    <article className="archive-row is-downloading">
      <div className="archive-thumb-card-media is-local-placeholder" aria-hidden="true"><Download /></div>
      <span className="archive-row-copy">
        <strong>{downloadTitle(task)}</strong>
        <progress aria-label={`${downloadTitle(task)}进度`} max="100" value={Math.round(task.progress * 100)} />
        <span className="archive-row-footer">
          <small className={`status-chip ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</small>
          {/* 失败那一条：右边这格本来写给进度，改成写原因——四行会撑破 142px
              的文案格，所以理由占进度的位置，完整文本留在 title 上。 */}
          <small className={`archive-row-stats${task.error ? ' is-error' : ''}`} title={task.error ?? undefined}>{task.error ?? downloadStats(task)}</small>
        </span>
      </span>
      <div className="local-row-actions">
        {task.status === 'running' && (
          <button type="button" className="icon-button" disabled={pending} aria-label={`暂停${downloadTitle(task)}`} title="暂停" onClick={() => onControl(task, 'pause')}><Pause aria-hidden="true" /></button>
        )}
        {(task.status === 'paused' || task.status === 'failed') && (
          <button type="button" className="icon-button" disabled={pending} aria-label={`${task.status === 'failed' ? '重试' : '恢复'}${downloadTitle(task)}`} title={task.status === 'failed' ? '重试' : '恢复'} onClick={() => onControl(task, 'resume')}><Play aria-hidden="true" /></button>
        )}
        <button type="button" className="icon-button" disabled={pending} aria-label={`中止${downloadTitle(task)}`} title="中止" onClick={() => onControl(task, 'cancel')}><X aria-hidden="true" /></button>
      </div>
    </article>
  );
}

function LocalArchiveRow({ archive, selectionMode, selected, active, onOpen, onToggle, onMenu }: {
  archive: LocalArchiveRecord;
  selectionMode: boolean;
  selected: boolean;
  active: boolean;
  onOpen: (archive: LocalArchiveRecord) => void;
  onToggle: (path: string) => void;
  onMenu: (archive: LocalArchiveRecord, at: { x: number; y: number }) => void;
}) {
  const category = localCategoryLabel(archive);
  return (
    <button
      type="button"
      className={`archive-row${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
      {...(selectionMode
        ? { role: 'checkbox', 'aria-checked': selected, 'aria-label': `选择 ${archive.title}` }
        : { 'aria-pressed': active })}
      onClick={() => { if (selectionMode) onToggle(archive.path); else onOpen(archive); }}
      // 右键（桌面的读法）和长按（触屏的读法，长按抬手那一下的 click 由
      // longPressHandlers 自己吃掉）走同一个菜单，和档案库卡片一样。
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMenu(archive, { x: event.clientX, y: event.clientY });
      }}
      {...longPressHandlers((at) => onMenu(archive, at))}
    >
      {archive.scopeId && archive.serverId && archive.archiveId
        ? <ArchiveThumbMedia scopeId={archive.scopeId} serverId={archive.serverId} archiveId={archive.archiveId} />
        : <div className="archive-thumb-card-media is-local-placeholder" aria-hidden="true"><FileArchive /></div>}
      {selectionMode && <span className="archive-card-check" aria-hidden="true" />}
      <span className="archive-row-copy">
        <strong>{archive.title}</strong>
        <ArchiveCardTags tags={archive.tags} limit={CARD_TAG_LIMIT_WIDE} rowCount={3} className="archive-row-tags" />
        <span className="archive-row-footer">
          <small className="archive-row-category" data-category={archiveCategoryKey(archive)}>{category || archive.path.split('.').pop()?.toUpperCase()}</small>
          <small className="archive-row-stats">
            {[formatByteSize(archive.fileSize), formatArchiveDate(Math.floor(archive.addedAt / 1000))].filter(Boolean).join(' · ')}
          </small>
        </span>
      </span>
    </button>
  );
}

export function LocalArchivesWorkspace() {
  const pageActive = usePageActive();
  const compact = useMediaQuery(COMPACT_WIDTH_QUERY);
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [archives, setArchives] = useState<LocalArchiveRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [presets, setPresets] = useState<SearchPreset[]>([]);
  const [loading, setLoading] = useState(true);
  /** 档案列表是否已经落地。任务列表先回来不能代表档案读完了：两者是并行的
   * 两笔 IPC，拿任务的「读完了」去放行空状态，就会先闪一下「还没有下载过档案」
   * 再变成有数据的样子。 */
  const [archivesLoaded, setArchivesLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [taskError, setTaskError] = useState<string>();
  const [taskReload, setTaskReload] = useState(0);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  /** 默认「添加时间 / 降序」就是原生那条查询本来的次序，也是档案库路由的默认：
   * 没人碰过这两个下拉框时，列表和加这一栏之前一模一样。 */
  const [sortMode, setSortMode] = useState<LocalSortMode>('added');
  const [sortOrder, setSortOrder] = useState<LocalSortOrder>('desc');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** 待确认的删除对象：多选栏给一批，右键/详情页给一份。留成路径而不是布尔，
   * 右键删的那一份才不会顺手动到多选的勾选。 */
  const [deletePaths, setDeletePaths] = useState<readonly string[]>();
  const [menuTarget, setMenuTarget] = useState<LocalArchiveContextMenuTarget>();
  // 返回手势先关确认框（规矩见 lib/overlayBackGuard）；忙的时候拒绝，守卫会自己补回去。
  useOverlayBackGuard(deletePaths !== undefined, () => { if (!busy) setDeletePaths(undefined); });
  const [busy, setBusy] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string>();
  const [presetDialog, setPresetDialog] = useState<{ preset?: SearchPreset } | undefined>();
  useLayoutEffect(() => {
    if (!pageActive) {
      setDeletePaths(undefined);
      setMenuTarget(undefined);
      setPresetDialog(undefined);
    }
  }, [pageActive]);

  const openPath = searchParams.get('path');
  const detailOwnerRef = useRef({ active: pageActive, path: openPath });
  detailOwnerRef.current = { active: pageActive, path: openPath };
  const unfinished = tasks.some((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused');

  const loadArchives = useCallback(async () => {
    const result = await repository.listLocalArchives();
    if (!result.ok) { setError(result.error.message); setArchivesLoaded(true); return; }
    setError(undefined);
    setArchives(result.value);
    setArchivesLoaded(true);
  }, []);

  // 本地档案是磁盘的镜像，下载跑完才会多一份：任务列表每次落地都重读一次。
  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    let pending = false;
    const read = () => {
      if (document.visibilityState === 'hidden' || pending) return;
      pending = true;
      void repository.listTasks().then((result) => {
        pending = false;
        if (!active) return;
        setLoading(false);
        if (result.ok) {
          setTasks(result.value);
          setTaskError(undefined);
        } else setTaskError(result.error.message);
      });
    };
    read();
    const timer = window.setInterval(read, unfinished ? RUNNING_POLL_MS : IDLE_POLL_MS);
    window.addEventListener('focus', read);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', read);
    };
  }, [pageActive, unfinished, taskReload]);

  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    void (async () => {
      const [presetResult] = await Promise.all([repository.listSearchPresets(LOCAL_PRESET_SCOPE), loadArchives()]);
      if (!active) return;
      if (presetResult.ok) setPresets(presetResult.value);
    })();
    return () => { active = false; };
  }, [pageActive, loadArchives]);

  // 没有下载在跑 = 上一次的落地已经写完了，档案列表可能多了一份。
  const wasUnfinished = useRef(unfinished);
  useEffect(() => {
    const completed = wasUnfinished.current && !unfinished;
    wasUnfinished.current = unfinished;
    if (pageActive && completed) void loadArchives();
  }, [pageActive, unfinished, loadArchives]);

  const activeDownloads = useMemo(
    () => tasks.filter(isActiveDownload).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [tasks],
  );

  /** 分类下拉的取值域：从读回来的档案里现推（见 `localCategoryLabel`），排序按
   * 显示名。选项的值就是显示名本身——筛选拿它和 `localCategoryLabel` 直接比，
   * 中间不再插一层 id，少一处能对不上的映射。 */
  const categoryOptions = useMemo<SelectOption[]>(() => {
    const labels = new Set<string>();
    for (const archive of archives) {
      const label = localCategoryLabel(archive);
      if (label) labels.add(label);
    }
    return [
      { value: '', label: '全部分类' },
      ...[...labels].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')).map((label) => ({ value: label, label })),
      // 和档案库同名的那个哨兵：两份档案都没有分类/语言标签时进这一档。
      { value: UNTAGGED_FILTER_ID, label: '无标签' },
    ];
  }, [archives]);

  const visibleArchives = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byCategory = categoryFilter
      ? archives.filter((archive) => {
        const label = localCategoryLabel(archive);
        return categoryFilter === UNTAGGED_FILTER_ID ? label === '' : label === categoryFilter;
      })
      : archives;
    const matched = needle
      ? byCategory.filter((archive) => `${archive.title} ${archive.path} ${archive.tags.join(' ')}`.toLowerCase().includes(needle))
      : byCategory;
    // `[...matched]`：`filter` 没筛掉东西时 returned 的就是 `archives` 本身，
    // 原地 sort 会改到 state 里的那个数组。
    return [...matched].sort((left, right) => compareLocalArchives(left, right, sortMode, sortOrder));
  }, [archives, categoryFilter, query, sortMode, sortOrder]);

  const openArchive = (archive: LocalArchiveRecord) => {
    const next = new URLSearchParams(searchParams);
    next.set('path', archive.path);
    setSearchParams(next, { replace: false });
  };
  const closeDetail = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('path');
    setSearchParams(next, { replace: false });
  };
  const detail = openPath ? archives.find((archive) => archive.path === openPath) : undefined;

  const selectAll = selected.size > 0 && selected.size === visibleArchives.length;
  const toggleAll = () => setSelected(selectAll ? new Set() : new Set(visibleArchives.map((archive) => archive.path)));
  const toggleOne = (path: string) => setSelected((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });

  async function remove(paths: readonly string[]) {
    if (paths.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await repository.deleteLocalArchives([...paths]);
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      showToast(`已从本地删除 ${result.value} 个档案`, 'success');
      setSelected(new Set());
      setDeletePaths(undefined);
      if (openPath && paths.includes(openPath) && detailOwnerRef.current.active && detailOwnerRef.current.path === openPath) closeDetail();
      await loadArchives();
    } finally {
      setBusy(false);
    }
  }

  async function control(task: TaskRecord, action: 'pause' | 'resume' | 'cancel') {
    setPendingTaskId(task.id);
    try {
      if (action === 'resume') {
        // 恢复会把剩下的字节收完，报的是和首次下载同一件事。
        const result = await repository.resumeDownload(task.id);
        if (!result.ok) { showToast(result.error.message, 'error'); return; }
        const completed = result.value.status === 'completed';
        showToast(completed ? '下载完成' : '已暂停', completed ? 'success' : 'info');
        if (completed) await loadArchives();
      } else {
        const result = action === 'pause'
          ? await repository.pauseDownload(task.id)
          : await repository.cancelDownload(task.id);
        if (!result.ok) { showToast(result.error.message, 'error'); return; }
        if (action === 'cancel') await loadArchives();
      }
      const refreshed = await repository.listTasks();
      if (refreshed.ok) setTasks(refreshed.value);
    } finally {
      setPendingTaskId(undefined);
    }
  }

  const layout = useDefaultLayout({
    id: 'local-archives-split',
    panelIds: ['local-archives-list', 'local-archives-detail'],
    storage: window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** 没存过布局时本地档案两栏的比例，与首页、档案库、书架同一份（58/42）。 */
  const splitLayout: Layout = { 'local-archives-list': 58, 'local-archives-detail': 42 };

  // 列表交给虚拟器：几百行全量渲染时，每一行的标签瀑布和封面都在滚动里重排，
  // 拖动就是一顿一顿的。行座的高度交给 measureElement 去量——下载行在窄屏上
  // 高度随内容长，不能像档案库那样按固定行距算死。
  const listRef = useRef<HTMLDivElement>(null);
  const listRows = useMemo<LocalListRow[]>(() => [
    ...activeDownloads.map((task) => ({ kind: 'task' as const, key: task.id, task })),
    ...visibleArchives.map((archive) => ({ kind: 'archive' as const, key: archive.path, archive })),
  ], [activeDownloads, visibleArchives]);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    const host = compact ? list?.closest<HTMLElement>('.workspace') : undefined;
    if (!pageActive || !list || !host) { setScrollMargin(0); return; }
    const measure = () => setScrollMargin(Math.max(0, list.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop + list.clientTop));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(host);
    if (list.parentElement) observer?.observe(list.parentElement);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [compact, pageActive, listRows.length]);
  const rowVirtualizer = useVirtualizer({
    count: listRows.length,
    // Compact lists grow in the page; observing the overflow-visible list
    // leaves the virtual window parked at page one and a blank tail below it.
    getScrollElement: () => compact ? listRef.current?.closest<HTMLElement>('.workspace') ?? listRef.current : listRef.current,
    scrollMargin,
    estimateSize: () => ARCHIVE_LIST_ROW_STRIDE,
    getItemKey: (index) => listRows[index]?.key ?? index,
    overscan: 6,
    initialRect: { width: 720, height: 560 },
  });
  const shownRows = useStableVirtualRows(rowVirtualizer.getVirtualItems(), rowVirtualizer.getTotalSize(), listRows.length);

  // Partial results can already render; a slower task read must not cover ready archives.
  const initialLoading = (loading || !archivesLoaded) && listRows.length === 0 && !error && !taskError;
  const skeleton = useDelayedUnmount(initialLoading, 180);

  const list = (
    <div className="local-archives">
      <h1 className="visually-hidden">本地档案</h1>
      <div className="library-controls local-archives-controls">
        <label className="search-label">
          <input
            aria-label={SEARCH_PLACEHOLDER}
            name="localArchiveQuery"
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={SEARCH_PLACEHOLDER}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); setQuery(event.target.value); }}
          />
        </label>
        <SearchPresetField
          presets={presets}
          onApply={(preset) => { setDraft(preset.query); setQuery(preset.query); }}
          onSave={() => setPresetDialog({})}
          onEdit={(preset) => setPresetDialog({ preset })}
          onDelete={(preset) => {
            void repository.deleteSearchPreset(LOCAL_PRESET_SCOPE, preset.presetId).then((result) => {
              if (!result.ok) { showToast(result.error.message, 'error'); return; }
              setPresets((current) => current.filter((item) => item.presetId !== preset.presetId));
            });
          }}
        />
      </div>
      {/* 顶部这一栏和档案库同一套：分类筛选、排序方式，多选紧跟在排序方式右边。
          行本身就是档案库的宽行，所以没有「显示模式」那一格可切，这里就不摆。 */}
      <div className="library-toolbar" role="toolbar" aria-label="档案库工具">
        {/* 分类是从档案里推出来的，要等它们读回来；读完之前立着档案库同款的那段
            骨架，下拉框才不会先短一截再长出来。 */}
        {archivesLoaded
          ? (
            <SelectField
              name="categoryFilter"
              aria-label="分类筛选"
              value={categoryFilter}
              options={categoryOptions}
              onChange={setCategoryFilter}
            />
          )
          : <span className="skeleton-line select-placeholder" role="status" aria-label="正在读取分类" />}
        <SelectField
          name="sortMode"
          aria-label="排序字段"
          value={sortMode}
          options={SORT_OPTIONS}
          onChange={(value) => {
            // 选中已经选着的那一项 = 换个方向，和档案库同一条规矩。
            if (value === sortMode) {
              setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'));
              return;
            }
            if (value === 'title' || value === 'added') setSortMode(value);
          }}
          trailing={<span className="select-trailing" aria-hidden="true">{sortOrder === 'asc' ? <ArrowUp /> : <ArrowDown />}</span>}
          optionTrailing={(option) => (option.value === sortMode
            ? <span className="select-option-trailing" aria-hidden="true">{sortOrder === 'asc' ? <ArrowUp /> : <ArrowDown />}</span>
            : null)}
        />
        <button
          className="secondary-action library-select-toggle"
          type="button"
          aria-pressed={selectionMode}
          aria-label={selectionMode ? '退出多选' : '多选'}
          title={selectionMode ? '退出多选' : '多选'}
          disabled={archives.length === 0}
          onClick={() => {
            setSelectionMode((current) => !current);
            setSelected(new Set());
          }}
        >
          <ListChecks aria-hidden="true" />
        </button>
      </div>
      {/* 槽位常驻并切换 is-open：展开与收起共用同一段过渡，收起时列表跟着合拢
          而不是瞬间弹回。收起态 visibility-hidden，内部的按钮不可聚焦。 */}
      <div className={`archive-selection-slot${selectionMode ? ' is-open' : ''}`}>
        <div className="archive-selection-bar" role="toolbar" aria-label="多选操作">
          <span className="archive-selection-count" role="status" aria-live="polite">已选 {selected.size} 个</span>
          {/* 与档案库那一条同形：纯图标 + 可访问名/提示，两个列表的多选栏是同一套。 */}
          <button className="secondary-action is-icon" type="button" aria-pressed={selectAll} aria-label={selectAll ? '取消全选' : '全选当前'} title={selectAll ? '取消全选' : '全选当前'} disabled={visibleArchives.length === 0} onClick={toggleAll}>
            <SquareCheckBig aria-hidden="true" />
          </button>
          <button className="secondary-action is-danger is-icon" type="button" aria-label="删除所选" title="删除所选" disabled={selected.size === 0 || busy} onClick={() => setDeletePaths([...selected])}>
            <Trash2 aria-hidden="true" />
          </button>
          <button className="secondary-action is-icon archive-selection-done" type="button" aria-label="完成" title="完成" onClick={() => { setSelectionMode(false); setSelected(new Set()); }}>
            <Check aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && <div className="form-error" role="alert">{error}<button className="secondary-action" type="button" onClick={() => void loadArchives()}>重试读取本地档案</button></div>}
      {taskError && <div className="form-error" role="alert">{taskError}<button className="secondary-action" type="button" disabled={loading} onClick={() => { setLoading(true); setTaskReload((current) => current + 1); }}>重试读取下载任务</button></div>}
      {(listRows.length > 0 || skeleton.mounted || (!loading && archivesLoaded && !error && !taskError)) && (
        /* `archive-list is-wide`：这一页的行就是档案库的宽行。行高、封面框、文案
           三格和标签瀑布全部由那一套规则给，本地档案只多写「行里写什么」。 */
        <div className="archive-list is-wide local-archives-list" data-scroll-region ref={listRef} role="list" aria-label="本地档案">
          {!loading && archivesLoaded && activeDownloads.length === 0 && visibleArchives.length === 0 && !error && !taskError && (
            <EmptyState
              icon={Download}
              title={query || categoryFilter ? '没有匹配的档案' : '还没有下载过档案'}
              description={query || categoryFilter ? '换个关键词或换个分类试试。' : '右键档案卡片选「下载档案」，进度和文件都会出现在这里。'}
            />
          )}
          {skeleton.mounted && <div className={`archive-list-skeleton-layer${initialLoading ? '' : ' is-exiting'}`}>
            <ArchiveListSkeleton mode="wide" label="正在读取本地档案" exiting={!initialLoading} />
          </div>}
          <div className="archive-list-inner" style={{ height: shownRows.totalSize }}>
            {shownRows.items.map((virtualRow) => {
              const row = listRows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={virtualRow.key}
                  className={`archive-row-wrap${row.kind === 'task' ? ' is-downloading' : ''}`}
                  role="listitem"
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
                >
                  {row.kind === 'task'
                    ? <DownloadRow task={row.task} pending={pendingTaskId === row.task.id} onControl={control} />
                    : (
                      <LocalArchiveRow
                        archive={row.archive}
                        selectionMode={selectionMode}
                        selected={selected.has(row.archive.path)}
                        active={openPath === row.archive.path}
                        onOpen={openArchive}
                        onToggle={toggleOne}
                        onMenu={(archive, at) => setMenuTarget({ path: archive.path, title: archive.title, ...at })}
                      />
                    )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <TextInputDialog
        open={presetDialog !== undefined}
        onOpenChange={(open) => { if (!open) setPresetDialog(undefined); }}
        title={presetDialog?.preset ? '重命名预设' : '存为预设'}
        description={presetDialog?.preset ? '只改名字，过滤词保持不变。' : '预设记下当前的过滤词，本地档案按名称匹配。'}
        label="预设名称"
        confirmLabel={presetDialog?.preset ? '保存名称' : '保存预设'}
        defaultValue={presetDialog?.preset?.name ?? (query || '全部本地档案')}
        validate={(value) => value.trim() ? undefined : '请填写预设名称'}
        onConfirm={async (name) => {
          const preset = presetDialog?.preset;
          const result = await repository.saveSearchPreset({
            scopeId: LOCAL_PRESET_SCOPE,
            presetId: preset?.presetId ?? `preset-${Date.now()}`,
            name,
            query: preset?.query ?? query,
            sortBy: 'title',
            sortOrder: 'asc',
            categoryId: null,
          });
          if (!result.ok) throw new Error(result.error.message);
          setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
          showToast(preset ? '预设已重命名' : '预设已保存', 'success');
        }}
      />
      {/* 右键/长按档案卡片、或详情页右上角的「更多操作」：菜单挂在同一棵树里，
          位置由指针/按钮坐标给。 */}
      <LocalArchiveContextMenu
        target={menuTarget}
        onClose={() => setMenuTarget(undefined)}
        onOpen={(target) => {
          const archive = archives.find((item) => item.path === target.path);
          if (archive) openArchive(archive);
        }}
        onDelete={(target) => setDeletePaths([target.path])}
      />
      {deletePaths && (
        <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setDeletePaths(undefined); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content local-delete-dialog">
              <Dialog.Title>删除本地档案</Dialog.Title>
              <Dialog.Description>
                将从磁盘删除{deletePaths.length > 1 ? `选中的 ${deletePaths.length} 个文件` : '这个本地文件'}，服务器上的档案不受影响。此操作不可撤销。
              </Dialog.Description>
              <div className="dialog-actions">
                <button className="secondary-action" type="button" disabled={busy} onClick={() => setDeletePaths(undefined)}><X aria-hidden="true" />取消</button>
                <button className="primary-action" type="button" disabled={busy} onClick={() => void remove(deletePaths)}><Trash2 aria-hidden="true" />{busy ? '删除中…' : '确认删除'}</button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );

  // 档案库与各个书架的留白都来自 `.library-shell-list` 的 16px 内边距；这一页
  // 的路由同样吃 `is-library-workspace` 的零内边距，不包这层时内容直接怼到
  // 窗口边上。没开详情时也要包，四周才和别的页面一致。
  if (!detail) {
    return (
      <div className="library-shell">
        <section className="library-shell-list">{list}</section>
      </div>
    );
  }
  return (
    <Group className="library-shell has-detail" orientation="horizontal" defaultLayout={panelLayout(layout.defaultLayout, splitLayout)} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="local-archives-list" minSize="40">
        <section className="library-shell-list">{list}</section>
      </Panel>
      <Separator className="panel-separator" />
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="local-archives-detail" minSize="30">
        <section className="library-shell-detail" data-scroll-region>
          <LocalArchiveDetail
            archive={detail}
            onClose={closeDetail}
            onDelete={() => setDeletePaths([detail.path])}
            onMenu={(at) => setMenuTarget({ path: detail.path, title: detail.title, ...at })}
            onSelectTag={(query) => { setDraft(query); setQuery(query); }}
          />
        </section>
      </Panel>
    </Group>
  );
}

/** 右侧那一页：这份本地文件的实情。结构和档案详情页（/library/:id）同构——返回
 * 钮 + 两行自适应标题的头部、封面加事实网格的概览、一条动作工具栏、按命名空间
 * 分组的标签墙，事实的顺序也和档案详情页一致（页数/体积/分类/时间）。差别只有
 * 内容：这一页说的是磁盘上的事（大小、下载时间），阅读走下载来源那台服务器，
 * 动作只有资源管理器定位（Windows）和本地删除。 */
function LocalArchiveDetail({ archive, onClose, onDelete, onMenu, onSelectTag }: {
  archive: LocalArchiveRecord;
  onClose: () => void;
  onDelete: () => void;
  onMenu: (at: { x: number; y: number }) => void;
  onSelectTag: (query: string) => void;
}) {
  const { showToast } = useToast();
  const [platform, setPlatform] = useState<string>();
  useEffect(() => {
    void getPlatformCapabilities().then((result) => {
      if (result.ok) setPlatform(result.value.platform);
    });
  }, []);
  const { groups, colorFor } = useDetailTagGroups(archive.tags);
  // 认得出下载来源时才能去阅读：阅读器按服务器档案出页，本地文件没有自己的
  // 出页管道。侧放进来、认不出来源的文件不给这个按钮。
  const serverCopy = archive.scopeId && archive.serverId && archive.archiveId
    ? { scopeId: archive.scopeId, serverId: archive.serverId, archiveId: archive.archiveId }
    : undefined;
  const { cover, loading: coverLoading } = useArchiveCover({
    scopeId: serverCopy?.scopeId,
    serverId: serverCopy?.serverId,
    archiveId: serverCopy?.archiveId,
    enabled: Boolean(serverCopy),
  });
  const titleRef = useSingleLineTitle(archive.title);
  const facts = [
    { kind: 'pages' as const, label: '页数', value: archive.pageCount ? `${archive.pageCount} 页` : '未知' },
    { kind: 'size' as const, label: '体积', value: formatByteSize(archive.fileSize) },
    { kind: 'category' as const, label: '分类', value: archiveCategoryLabel(archive) || '未知' },
    { kind: 'added' as const, label: '下载时间', value: formatArchiveDate(Math.floor(archive.addedAt / 1000)) || '未知' },
  ];

  return (
    <main className="archive-detail-route" aria-labelledby="local-archive-title">
      <header className="archive-detail-route-header">
        <button type="button" className="reader-icon-button" aria-label="返回列表" title="返回" onClick={onClose}><ArrowLeft aria-hidden="true" /></button>
        <h1 id="local-archive-title" className="archive-detail-route-title" ref={titleRef}>{archive.title}</h1>
        {/* 和档案详情页的头部同形：返回钮在左、标题占中、图标钮贴右。 */}
        <button
          type="button"
          className="reader-icon-button"
          aria-label="更多操作"
          aria-haspopup="menu"
          title="更多操作"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onMenu({ x: bounds.right, y: bounds.bottom });
          }}
        ><MoreVertical aria-hidden="true" /></button>
      </header>
      <div className="archive-detail-overview">
        <ArchiveDetailCover title={archive.title} cover={cover} loading={coverLoading} />
        <div className="archive-detail-overview-copy">
          <ArchiveDetailFacts facts={facts} />
        </div>
      </div>
      <div className="archive-detail-route-actions" role="toolbar" aria-label="本地档案操作">
        {serverCopy && (
          <Link
            className="primary-action"
            to={`/reader/${serverCopy.archiveId}?server=${encodeURIComponent(serverCopy.serverId)}`}
            aria-label="阅读"
            title="阅读"
          ><BookOpen aria-hidden="true" /><span className="archive-action-label">阅读</span></Link>
        )}
        {platform === 'windows' && (
          <button
            type="button"
            className="secondary-action"
            aria-label="在资源管理器中打开"
            title="在资源管理器中打开"
            onClick={() => void revealInFileManager(archive.path).then(
              () => {},
              () => showToast('无法打开资源管理器', 'error'),
            )}
          >
            <FolderOpen aria-hidden="true" /><span className="archive-action-label">在资源管理器中打开</span>
          </button>
        )}
        <button type="button" className="secondary-action" onClick={onDelete}>
          <Trash2 aria-hidden="true" /><span className="archive-action-label">本地删除</span>
        </button>
      </div>
      {/* 标签芯片照存档详情那一套排（My Tags 优先、按命名空间分组），点下去筛的是这一页
          的列表：本地档案的标签来自下载时抓下的元数据，不去档案库搜。 */}
      <ArchiveDetailTagSection groups={groups} colorFor={colorFor} onSelect={(tag) => onSelectTag(tag.query.replace(/\$$/, ''))} />
    </main>
  );
}
