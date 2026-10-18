import * as Dialog from '@radix-ui/react-dialog';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { usePageActive } from '../app/RetainedPage';
import { Ban, Check, CirclePlay, CircleStop, FileText, FolderOpen, History, Image as ImageIcon, Link2, Link2Off, Play, RotateCcw, SquareCheckBig, Trash2, Undo2, WandSparkles, X } from 'lucide-react';
import type { ArchiveIdentity, ArchiveRecord, ServerRecord } from '../domain/library';
import { countDuplicateGroupsWithLargePageGap, getDedupeGroupFilterData, getDedupeSmartSignals, mergeSmartDuplicateSelection, normalizeDuplicateSelection, toDedupeDayString, toPairKey, type DedupeArchive, type DuplicateSource } from '../domain/deduplication';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeDedupRepository, type DedupLoadResult, type DedupNonDuplicateRecord, type DedupScanProgress, type DedupSessionSummary } from '../repositories/nativeDedupRepository';
import { ArchiveOverviewDialog } from './ArchiveOverviewDialog';
import { ArchiveThumbMedia } from './ArchiveThumbnailCard';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';
import { observeOnceInScroll } from '../lib/sharedIntersectionObserver';
import { CardTagRows } from './CardTagRows';
import { SelectField } from './SelectField';
import { useToast } from './Toast';
import { EmptyState } from './EmptyState';
import { LoadingIndicator } from './LoadingIndicator';
import { StatusLine } from './StatusLine';
import { ArchiveDeletionConfirmation } from './ArchiveDeleteDialog';
import { pickCardTags } from '../lib/archiveCardPresentation';
import { pickServer } from '../domain/server';
import { parseArchiveTagString } from '../lib/tags';
import { invalidateRouteCache } from '../lib/routeCache';
import { DatePicker } from './DatePicker';

const library = new NativeLibraryRepository();
const dedup = new NativeDedupRepository();
// v3：块级证据 + Wilson 聚合（imsearch 的「多特征匹配 → 按图聚合 → Wilson 下
// 界」思想）+ dhash 预筛 + 平移搜索；比较层对齐 imsearch 的评分思想。
const ALGORITHM_VERSION = 'readoshi-v3';
/** 结果列表渐进挂载：首批行数与每次追加的行数。 */
const DEMOUNT_ROW_CHUNK = 60;

type DedupMember = DedupeArchive & { archiveId: string };

function dedupeArchiveOf(archive: ArchiveIdentity): DedupeArchive {
  return {
    id: archive.archiveId,
    title: archive.title,
    tags: archive.tags,
    size: archive.fileSize ?? undefined,
    pagecount: archive.pageCount ?? undefined,
  };
}

function groupKeyOf(group: readonly { archiveId: string }[]): string {
  return group.map((item) => item.archiveId).sort().join('|');
}

/** 页数差超过这个数的组，成员卡自己的页数会被标出来。 */
const PAGE_GAP_THRESHOLD = 10;

/** 该在卡片上标页数的档案：页数最大和最小的那几本。
 *
 * 「页数差大」原来是组标题右上角的一行小字，要人工核对的是卡片本身，所以提示
 * 挪到页数上——一组的页数都对得上时它什么都不做。 */
function pageGapArchiveIds(group: readonly DedupMember[]): ReadonlySet<string> {
  const counted = group.filter((member) => Number(member.pagecount) > 0);
  if (counted.length < 2) return new Set();
  const counts = counted.map((member) => Number(member.pagecount));
  const smallest = Math.min(...counts);
  const largest = Math.max(...counts);
  if (largest - smallest <= PAGE_GAP_THRESHOLD) return new Set();
  return new Set(counted
    .filter((member) => Number(member.pagecount) === smallest || Number(member.pagecount) === largest)
    .map((member) => member.archiveId));
}

/** 组卡片的行布局：一行能放几列由实测宽度决定（与 --space-4 的间距保持一致），
 * 放不满的那一行整行居中。 */
const GROUP_MIN_WIDTH = 340;
const GROUP_GAP = 16;
function groupColumnsFor(width: number): number {
  if (width <= 0) return 3;
  return Math.max(1, Math.floor((width + GROUP_GAP) / (GROUP_MIN_WIDTH + GROUP_GAP)));
}
function chunkRows<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

/** 进度条上的阶段名：与后端的 stage 一一对应。 */
const STAGE_LABELS: Record<DedupScanProgress['stage'], string> = {
  enumerating: '正在枚举档案',
  covers: '正在读取封面',
  comparing: '正在比较封面',
  completed: '扫描完成',
  cancelled: '扫描已取消',
};

/** SQLite 的 CURRENT_TIMESTAMP 是 UTC 的「YYYY-MM-DD HH:MM:SS」，这里补上时区
 * 标记再按本地时间显示，免得结果列表比实际早八小时。 */
function formatSessionTime(value: string): string {
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '0';
}

function formatBytes(value: number | string | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '体积未知';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 判定胶囊：渣翻 / 外部广告 / 无修正 / 有码 / 无汉语。这些是与翻译库无关的
 * 硬判定，所以即使标签翻译没下载也一定显示——它们排进标签行最前面并保持
 * 各自颜色，既优先可见，又不额外占一行。 */
function selectionSignals(archive: DedupeArchive): Array<{ label: string; tone: string }> {
  const signals = getDedupeSmartSignals(archive);
  return [
    signals.roughTranslation && { label: '渣翻', tone: 'is-warning' },
    signals.extraneousAds && { label: '外部广告', tone: 'is-warning' },
    signals.uncensored && { label: '无修正', tone: 'is-positive' },
    signals.censored && { label: '有码', tone: 'is-warning' },
    signals.noChinese && { label: '无汉语', tone: 'is-warning' },
  ].filter(Boolean) as Array<{ label: string; tone: string }>;
}

/** 一个待处理档案：封面 + 标题 + 标签胶囊 + 体积/页数 + 判定徽标。整张卡就是
 * 勾选框（与档案库多选一致的 role/aria-checked），角上的圆盘标记也用同一个
 * `.archive-card-check`——之前这里渲染的是裸 checkbox，被全局 input 样式拉成
 * 一整行宽的 44px 方块，卡片布局就是这样被撑坏的。 */
const DedupMemberCard = memo(function DedupMemberCard({ member, scopeId, serverId, selected, pageGap, onToggle }: {
  member: DedupMember;
  scopeId?: string | undefined;
  serverId?: string | undefined;
  selected: boolean;
  /** 与同组档案页数差过大：页数本身被标出来，代替组标题上的提醒。 */
  pageGap: boolean;
  onToggle: (archiveId: string) => void;
}) {
  // DedupeArchive 的 tags 既可能是数组也可能是 LANraragi 的逗号串。
  const tags = useMemo(() => {
    const raw = member.tags;
    const list = Array.isArray(raw) ? [...raw] : typeof raw === 'string' ? parseArchiveTagString(raw) : [];
    return pickCardTags(list, 18);
  }, [member.tags]);
  const leading = useMemo(() => selectionSignals(member), [member]);
  const pageCount = Number(member.pagecount) > 0 ? Number(member.pagecount) : 0;
  return <button
    type="button"
    role="checkbox"
    aria-checked={selected}
    aria-label={`选择 ${member.title || member.archiveId}`}
    title={member.archiveId}
    className={`dedup-member${selected ? ' is-selected' : ''}`}
    onClick={() => onToggle(member.archiveId)}
  >
    <span className="dedup-member-cover">
      {scopeId && serverId
        ? <ArchiveThumbMedia scopeId={scopeId} serverId={serverId} archiveId={member.archiveId} />
        : <span className="archive-thumb-card-skeleton" aria-hidden="true" />}
      <span className="archive-card-check" aria-hidden="true" />
    </span>
    <span className="dedup-member-copy">
      <strong className="dedup-member-title">{member.title || member.archiveId}</strong>
      <CardTagRows tags={tags} leading={leading} rowCount={3} fill className="dedup-member-tags archive-thumb-card-tags" />
      {/* 体积与页数钉在标签区下方两端：标签有几行都不影响它们的位置。 */}
      <span className="dedup-member-meta">
        <span>{formatBytes(member.size)}</span>
        <span className={`dedup-member-pages${pageGap ? ' is-flagged' : ''}`} {...(pageGap ? { title: '与同组档案页数差异较大，删除前请确认' } : {})}>
          {pageCount > 0 ? `${pageCount}页` : '页数未知'}
        </span>
      </span>
    </span>
  </button>;
});

/** 去重工作区，操作模型与 Readoshi 对齐：
 * 选中整组（或整条关联链）= 执行时把组内全部两两组合标记为不重复；
 * 勾选组内档案 = 执行时删除；手动触碰过的组受智能选择保护；
 * 已标记的对立刻从视图移除，下次扫描也不再命中。 */
export function DeduplicationWorkspace() {
  const pageActive = usePageActive();
  const { showToast } = useToast();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [server, setServer] = useState<ServerRecord>();
  const [archives, setArchives] = useState<ArchiveIdentity[]>([]);
  const [progress, setProgress] = useState<DedupScanProgress>();
  const [result, setResult] = useState<DedupLoadResult>();
  const [sessionId, setSessionId] = useState<string>();
  const [startDate, setStartDate] = useState('2000-01-01');
  const [endDate, setEndDate] = useState(() => toDedupeDayString());
  const [sourceFilter, setSourceFilter] = useState<'all' | DuplicateSource>('all');
  const [selectionFilter, setSelectionFilter] = useState<'all' | 'selected' | 'pending'>('all');
  const [view, setView] = useState<'groups' | 'chains'>('groups');
  const [busy, setBusy] = useState(false);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set());
  const [manuallyTouchedGroupKeys, setManuallyTouchedGroupKeys] = useState<Set<string>>(new Set());
  const [processedNonDuplicatePairKeys, setProcessedNonDuplicatePairKeys] = useState<Set<string>>(new Set());
  const [processedDeletedArchiveIds, setProcessedDeletedArchiveIds] = useState<Set<string>>(new Set());
  const [smartSelectPending, setSmartSelectPending] = useState(false);
  // 这个文件里的三处浮层都先吃返回手势（规矩见 lib/overlayBackGuard）：智能选择确认、
  // 不重复关系面板、扫描结果历史。
  useOverlayBackGuard(smartSelectPending, () => setSmartSelectPending(false));
  const [includeFilenameOnly, setIncludeFilenameOnly] = useState(false);
  const [pageGapWarningCount, setPageGapWarningCount] = useState(0);
  const [deleteSession, setDeleteSession] = useState<{ count: number }>();
  // 不重复关系面板：持久化的对（含历史墓碑）直接列出，可搜索、可撤销标记。
  const [relationsOpen, setRelationsOpen] = useState(false);
  useOverlayBackGuard(relationsOpen, () => setRelationsOpen(false));
  const [relations, setRelations] = useState<DedupNonDuplicateRecord[]>([]);
  /** 从关系行打开的档案概览：就地看一眼，不离开查重页（筛选与选择都留着）。 */
  const [overviewArchiveId, setOverviewArchiveId] = useState<string>();
  /** 身份列表里没有概览弹窗要的全字段：打开时按 id 现取一条。 */
  const [overviewArchive, setOverviewArchive] = useState<ArchiveRecord>();
  const [relationsQuery, setRelationsQuery] = useState('');
  // 扫描结果：会话本来就会落库，这个对话框把它们列出来供随时载入。
  const [historyOpen, setHistoryOpen] = useState(false);
  useOverlayBackGuard(historyOpen, () => setHistoryOpen(false));
  const [sessions, setSessions] = useState<DedupSessionSummary[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  useLayoutEffect(() => {
    if (!pageActive) {
      setRelationsOpen(false);
      setHistoryOpen(false);
      setSmartSelectPending(false);
      setDeleteSession(undefined);
      setOverviewArchiveId(undefined);
      setOverviewArchive(undefined);
    }
  }, [pageActive]);
  /** 有效不重复关系的条数（含导入的），显示在统计栏。 */
  const [relationCount, setRelationCount] = useState(0);
  const scanGeneration = useRef(0);
  useEffect(() => () => { scanGeneration.current += 1; }, []);
  const selectionWrites = useRef<Promise<void>>(Promise.resolve());
  const selectionRevision = useRef(0);
  const confirmedSelection = useRef<{ sessionId: string; ids: string[] }>();
  /** 结果区宽度：列数与「不满行居中」的卡片宽度都按它算。 */
  const groupsRef = useRef<HTMLDivElement>(null);
  const [groupsWidth, setGroupsWidth] = useState(0);

  useEffect(() => {
    void library.listServers().then((response) => {
      if (!response.ok) { showToast(response.error.message, 'error'); return; }
      setServers(response.value);
      // 不再让用户挑服务器：当前启用的那台就是默认目标（pickServer 的既有语义）。
      const active = pickServer(response.value, undefined);
      if (active) setServer(active);
    });
  }, [showToast]);

  useEffect(() => {
    if (!server) return;
    void library.listArchiveIdentities(server.id).then((response) => {
      if (response.ok) setArchives(response.value);
      else showToast(response.error.message, 'error');
    });
  }, [server, showToast]);

  // 统计栏里的「已排除关系」：跟着服务器与结果变化刷新（结果变化意味着执行过
  // 标记，条数会跟着涨）。
  useEffect(() => {
    if (!server) return;
    let active = true;
    void dedup.listNonDuplicates(server.scopeId).then((response) => {
      if (!active || !response.ok) return;
      setRelationCount(response.value.filter((record) => !record.tombstoned).length);
    });
    return () => { active = false; };
  }, [server, result]);

  const archiveById = useMemo(() => {
    const byId = new Map<string, ArchiveIdentity>();
    archives.forEach((archive) => byId.set(archive.archiveId, archive));
    return byId;
  }, [archives]);

  const groups = useMemo<DedupMember[][]>(() => {
    const resolve = (archiveId: string): DedupMember => {
      const record = archiveById.get(archiveId);
      // 兜底也要带 id：域里的 archiveId() 读的是 arcid/id，缺了它这条档案在
      // 分链（buildDuplicateSelectionModel）时会被当成无效项整组丢掉。
      return record ? { ...dedupeArchiveOf(record), archiveId: record.archiveId } : { id: archiveId, archiveId, title: archiveId };
    };
    // 已删除的档案（processedDeletedArchiveIds）与已标记的对一起从视图移除，
    // 与 Readoshi 的 filterGroupsByProcessedState 一致。
    return (result?.pairs ?? [])
      .map((pair) => [pair.leftArchiveId, pair.rightArchiveId] as const)
      .filter((ids) => !processedNonDuplicatePairKeys.has(toPairKey(ids[0], ids[1])))
      .filter((ids) => ids.every((id) => !processedDeletedArchiveIds.has(id)))
      .map(([left, right]) => [resolve(left), resolve(right)]);
  }, [archiveById, result?.pairs, processedNonDuplicatePairKeys, processedDeletedArchiveIds]);

  const sourceByGroupKey = useMemo(() => Object.fromEntries((result?.pairs ?? []).map((pair) => [[pair.leftArchiveId, pair.rightArchiveId].sort().join('|'), pair.source as DuplicateSource])), [result?.pairs]);
  const filtered = useMemo(() => getDedupeGroupFilterData(groups, sourceByGroupKey), [groups, sourceByGroupKey]);
  const selected = useMemo(() => new Set(result?.selectedArchiveIds ?? []), [result?.selectedArchiveIds]);
  /** 这一组是否已经有选择：整组标记过，或组内有档案被勾选。 */
  const groupHasSelection = useCallback((group: readonly DedupMember[]) => selectedGroupKeys.has(groupKeyOf(group)) || group.some((member) => selected.has(member.archiveId)), [selected, selectedGroupKeys]);
  // 关联链要按「全部组」算连通性：先过滤再分链会把同一串重复关系拆散。用
  // allChains（含单组链）而不是 chains，才能保证每个组都有归属——默认视图
  // 就是把多组链划成区块、单组链平铺，和 Readoshi 的 renderChain 一致。
  // 链序号跟着完整列表编号，和组序号一样：筛掉几条剩下的也不跳号。
  const chainSections = useMemo(() => {
    let number = 0;
    return filtered.allChains.flatMap((chain) => {
      if (chain.length > 1) number += 1;
      const visible = sourceFilter === 'all' ? chain : chain.filter((group) => sourceByGroupKey[groupKeyOf(group)] === sourceFilter);
      return visible.length ? [{ key: chain.map(groupKeyOf).join('#'), number, groups: visible }] : [];
    });
  }, [filtered.allChains, sourceByGroupKey, sourceFilter]);
  /** 已选择 / 待选择视图：按组筛，链里留下的组仍连在原来的链区块里。 */
  const visibleSections = useMemo(() => {
    if (selectionFilter === 'all') return chainSections;
    const wanted = selectionFilter === 'selected';
    return chainSections
      .map((section) => ({ ...section, groups: section.groups.filter((group) => groupHasSelection(group) === wanted) }))
      .filter((section) => section.groups.length > 0);
  }, [chainSections, selectionFilter, groupHasSelection]);
  const visibleGroups = useMemo(() => visibleSections.flatMap((section) => section.groups), [visibleSections]);
  // 每条链独占一整行；零散组按列数分行，行内放不满时由 CSS 居中。
  const groupColumns = groupColumnsFor(groupsWidth);
  const chainColumns = groupColumnsFor(groupsWidth - 2 * 16 - 2);
  const resultRows = useMemo(() => {
    type Row = { kind: 'groups'; key: string; groups: DedupMember[][] } | { kind: 'chain'; key: string; number: number; chain: DedupMember[][] };
    const rows: Row[] = [];
    let pending: DedupMember[][] = [];
    const flush = () => {
      if (!pending.length) return;
      rows.push({ kind: 'groups', key: `row-${rows.length}`, groups: pending });
      pending = [];
    };
    visibleSections.forEach((section) => {
      if (section.groups.length > 1) { flush(); rows.push({ kind: 'chain', key: section.key, number: section.number, chain: section.groups }); return; }
      pending.push(section.groups[0]!);
      if (pending.length >= groupColumns) flush();
    });
    flush();
    return rows;
  }, [visibleSections, groupColumns]);
  /** 结果行渐进挂载：1.5 万对快照能铺出几千行卡片，一进页面就全部挂上
   * 会让首屏卡一下。先挂一小段，滚动哨兵再追加；布局与交互不变。 */
  const [mountedRowCount, setMountedRowCount] = useState(DEMOUNT_ROW_CHUNK);
  useEffect(() => { setMountedRowCount(DEMOUNT_ROW_CHUNK); }, [sourceFilter, selectionFilter, view, result?.session.sessionId]);
  const mountedRows = useMemo(() => resultRows.slice(0, mountedRowCount), [resultRows, mountedRowCount]);
  const mountedSections = useMemo(() => visibleSections.slice(0, mountedRowCount), [visibleSections, mountedRowCount]);
  const moreRowsMounted = view === 'groups' ? mountedRows.length < resultRows.length : mountedSections.length < visibleSections.length;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreRowsMounted) return undefined;
    const node = sentinelRef.current;
    if (!node) return undefined;
    return observeOnceInScroll(node, () => setMountedRowCount((current) => current + DEMOUNT_ROW_CHUNK), '600px');
  }, [moreRowsMounted, mountedRowCount]);
  /** 组序号按完整列表（含被筛掉的）编号，筛选时也不会跳号。 */
  const groupNumberByKey = useMemo(() => new Map(groups.map((group, index) => [groupKeyOf(group), index + 1])), [groups]);

  /** 落库并就地更新选择：不再整份 load_result（那会重新解析 15k 条快照并重建
   * 全部卡片，勾一个格子要几百毫秒）。pairs 数组保持同一个引用，因此分组成员
   * 与卡片都不会因为改选择而重建。 */
  async function applySelection(nextSelected: string[]) {
    if (!result) return;
    const targetSession = result.session.sessionId;
    const revision = ++selectionRevision.current;
    if (confirmedSelection.current?.sessionId !== targetSession) {
      confirmedSelection.current = { sessionId: targetSession, ids: result.selectedArchiveIds };
    }
    const confirmed = confirmedSelection.current;
    // 先呈现手势结果，按顺序落库。IPC 延迟不能吞掉第二次点击或倒序覆盖选择。
    selectedRef.current = new Set(nextSelected);
    setResult((current) => current?.session.sessionId === targetSession ? { ...current, selectedArchiveIds: nextSelected } : current);
    const write = selectionWrites.current.then(async () => {
      const response = await dedup.saveSelection(targetSession, nextSelected);
      if (response.ok) {
        confirmed.ids = nextSelected;
      } else {
        showToast(response.error.message, 'error');
        if (revision === selectionRevision.current) {
          setResult((current) => current?.session.sessionId === targetSession ? { ...current, selectedArchiveIds: confirmed.ids } : current);
        }
      }
    });
    selectionWrites.current = write.catch(() => undefined);
    await write;
  }

  useEffect(() => {
    const element = groupsRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setGroupsWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [result]);

  async function persistSelection(nextSelected: string[]) {
    await applySelection(nextSelected);
  }

  // 卡片是记忆化的，回调必须稳定：内部通过 ref 读最新的选择集合。
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const toggleSelectedRef = useRef(toggleSelected);
  toggleSelectedRef.current = toggleSelected;
  const handleMemberToggle = useCallback((archiveId: string) => {
    void toggleSelectedRef.current(archiveId, !selectedRef.current.has(archiveId));
  }, []);

  // 扫描是一次长命令，后端把最新进度放进登记表：这里轮询它画进度条。没有
  // 这一步，界面上除了按钮变成「扫描中…」什么都看不到——这正是「点了没反应」。
  useEffect(() => {
    if (!busy || !sessionId || progress?.status !== 'running') return;
    let active = true;
    const timer = window.setInterval(() => {
      void dedup.scanProgress(sessionId).then((response) => {
        if (!active || !response.ok || !response.value) return;
        setProgress(response.value);
        // 状态一旦离开 running 就收工：页面重挂载后接管的会话没有本组件的
        // promise 可等，不收工就会把「取消扫描」永久留在界面上。
        if (response.value.status !== 'running') {
          const generation = scanGeneration.current;
          setBusy(false);
          void dedup.loadResult(sessionId).then((loaded) => {
            // 停止轮询会清理本 effect；结果读取属于扫描本身，不能被这次清理丢掉。
            if (generation !== scanGeneration.current) return;
            if (loaded.ok) setResult((current) => current?.session.sessionId === sessionId ? current : loaded.value);
            else showToast(loaded.error.message, 'error');
          });
        }
      });
    }, 400);
    return () => { active = false; window.clearInterval(timer); };
  }, [busy, sessionId, progress?.status]);

  // 页面重挂载时接管仍在跑的会话：扫描在后端继续，进度条与取消按钮不能丢。
  useEffect(() => {
    if (!server || busy || sessionId) return;
    let active = true;
    void dedup.listSessions(server.scopeId).then((response) => {
      if (!active || !response.ok) return;
      const running = response.value.find((item) => item.status === 'running');
      if (!running) return;
      void dedup.scanProgress(running.sessionId).then((progress) => {
        if (!active || !progress.ok || !progress.value || progress.value.status !== 'running') return;
        setSessionId(running.sessionId);
        setProgress(progress.value);
        setBusy(true);
      });
    });
    return () => { active = false; };
  }, [server, busy, sessionId]);

  function runScan(resume = false) {
    if (!server) return;
    const generation = ++scanGeneration.current;
    setBusy(true);
    setSelectedGroupKeys(new Set());
    setManuallyTouchedGroupKeys(new Set());
    setProcessedNonDuplicatePairKeys(new Set());
    setProcessedDeletedArchiveIds(new Set());
    setPageGapWarningCount(0);
    const id = resume && sessionId ? sessionId : `dedup-${Date.now()}`;
    setSessionId(id);
    // 立刻画出进度条：枚举与第一个分块的封面下载都要时间，空等会让人以为卡死。
    setProgress({
      sessionId: id, scopeId: server.scopeId, status: 'running', stage: 'enumerating',
      processed: 0, total: archives.length, cacheHits: 0, downloads: 0, missingCovers: 0,
      invalidCovers: 0, pairCount: 0, degraded: false, checkpoint: 0, diagnostics: [], pairs: [],
    });
    void dedup.scan({ sessionId: id, scopeId: server.scopeId, algorithmVersion: ALGORITHM_VERSION, startDate, endDate, chunkSize: 32 }).then((response) => {
      // A cancel bumps the generation; a late scan result must not resurrect
      // the "scanning" state or overwrite the cancelled progress line.
      if (generation !== scanGeneration.current) return;
      if (!response.ok) showToast(response.error.message, 'error');
      else {
        setProgress(response.value);
        void dedup.loadResult(id).then((loaded) => {
          if (generation !== scanGeneration.current) return;
          if (loaded.ok) setResult(loaded.value);
          else showToast(loaded.error.message, 'error');
        });
      }
    }).finally(() => {
      if (generation === scanGeneration.current) setBusy(false);
    });
  }

  async function cancelScan() {
    if (!sessionId) return;
    const response = await dedup.cancelScan(sessionId);
    if (!response.ok) showToast(response.error.message, 'error');
    else { scanGeneration.current += 1; setProgress((current) => current ? { ...current, status: 'cancelled', stage: 'cancelled' } : current); setBusy(false); }
  }

  async function toggleSelected(archiveId: string, checked: boolean) {
    if (!result) return;
    // 手动触碰的组受智能选择保护；选择经不变式归一化（每条链至少保留一个）。
    const ownerGroupKeys = new Set(groups.filter((group) => group.some((item) => item.archiveId === archiveId)).map(groupKeyOf));
    setManuallyTouchedGroupKeys((current) => new Set([...current, ...ownerGroupKeys]));
    setSelectedGroupKeys((current) => {
      const next = new Set(current);
      ownerGroupKeys.forEach((key) => next.delete(key));
      return next;
    });
    const next = new Set(selectedRef.current);
    if (checked) next.add(archiveId); else next.delete(archiveId);
    await applySelection(normalizeDuplicateSelection(groups, [...next]));
  }

  async function toggleGroupSelection(group: readonly { archiveId: string }[]) {
    const key = groupKeyOf(group);
    setManuallyTouchedGroupKeys((current) => new Set([...current, key]));
    const nextGroupKeys = new Set(selectedGroupKeys);
    if (nextGroupKeys.has(key)) nextGroupKeys.delete(key);
    else nextGroupKeys.add(key);
    setSelectedGroupKeys(nextGroupKeys);
    // 整组选择与单档案删除勾选互斥。
    const nextSelected = new Set(selectedRef.current);
    group.forEach((item) => nextSelected.delete(item.archiveId));
    await applySelection([...nextSelected]);
  }

  /** 全选 / 取消全选所有组：Readoshi 的「全选分组」，一次把每组都标记为
   * 待标记（组内两两标记为不重复），比逐组点省事。 */
  async function toggleAllGroups() {
    if (!result) return;
    const keys = groups.map(groupKeyOf);
    const allSelected = keys.length > 0 && keys.every((key) => selectedGroupKeys.has(key));
    const nextKeys = allSelected ? new Set<string>() : new Set(keys);
    setManuallyTouchedGroupKeys((current) => new Set([...current, ...keys]));
    setSelectedGroupKeys(nextKeys);
    const nextSelected = new Set(selectedRef.current);
    groups.flat().forEach((item) => nextSelected.delete(item.archiveId));
    await applySelection([...nextSelected]);
  }

  async function toggleChainSelection(chain: readonly (readonly { archiveId: string }[])[]) {
    const keys = chain.map(groupKeyOf);
    setManuallyTouchedGroupKeys((current) => new Set([...current, ...keys]));
    const nextGroupKeys = new Set(selectedGroupKeys);
    if (keys.every((key) => selectedGroupKeys.has(key))) keys.forEach((key) => nextGroupKeys.delete(key));
    else keys.forEach((key) => nextGroupKeys.add(key));
    setSelectedGroupKeys(nextGroupKeys);
    const nextSelected = new Set(selectedRef.current);
    chain.flat().forEach((item) => nextSelected.delete(item.archiveId));
    await applySelection([...nextSelected]);
  }

  function requestSmartSelect() {
    if (!result) return;
    const hasFilenameOnlyGroups = groups.some((group) => sourceByGroupKey[groupKeyOf(group)] === 'filename');
    if (!hasFilenameOnlyGroups) {
      void smartSelect(false);
      return;
    }
    setIncludeFilenameOnly(false);
    setSmartSelectPending(true);
  }

  async function smartSelect(includeFilenameOnlySelection: boolean) {
    if (!result) return;
    setSmartSelectPending(false);
    // 与 Readoshi 相同：手动触碰过的组保留手动选择；封面来源总是纳入，
    // 文件名来源仅在确认时纳入；每组只选一个待删除档案。
    const selection = mergeSmartDuplicateSelection(groups, manuallyTouchedGroupKeys, result.selectedArchiveIds, selectedGroupKeys, sourceByGroupKey, { includeFilenameOnly: includeFilenameOnlySelection });
    await applySelection(selection.archiveIds);
    setPageGapWarningCount(countDuplicateGroupsWithLargePageGap(groups));
  }

  function requestExecuteSelected() {
    if (selectedGroupKeys.size === 0 && selected.size === 0) return;
    setDeleteSession({ count: selected.size });
  }

  async function executeSelected(syncFavorite: boolean) {
    if (!result || !server) return;
    setBusy(true);
    setDeleteSession(undefined);
    await selectionWrites.current;
    // 整组选择 → 组内全部两两组合标记为不重复。
    const markedGroups = groups.filter((group) => selectedGroupKeys.has(groupKeyOf(group)));
    // 一批一次 IPC：原先按 C(m,2) 逐对串行往返，一组五人就是十次。
    const pairEntries = markedGroups.flatMap((group) => {
      const entries = [];
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          entries.push({ scopeId: server.scopeId, leftArchiveId: group[i]!.archiveId, rightArchiveId: group[j]!.archiveId });
        }
      }
      return entries;
    });
    const markedPairKeys = new Set<string>();
    let markCount = 0;
    if (pairEntries.length > 0) {
      const response = await dedup.saveNonDuplicates(pairEntries);
      if (response.ok) {
        pairEntries.forEach((entry, index) => {
          // 批命令按输入顺序回每条成败：只有真落库的对才算已处理，
          // 部分失败不能把没标记的组从视图里误删。
          if (response.value[index]) markedPairKeys.add(toPairKey(entry.leftArchiveId, entry.rightArchiveId));
        });
      }
      const markFailures = pairEntries.length - markedPairKeys.size;
      if (markFailures > 0) showToast(`${markFailures} 组标记失败，请重试`, 'error');
      setProcessedNonDuplicatePairKeys((current) => new Set([...current, ...markedPairKeys]));
      // 提示语按组计数：组内所有对都落库才算这一组标记完成。
      markCount = markedGroups.filter((group) => {
        for (let i = 0; i < group.length; i += 1) {
          for (let j = i + 1; j < group.length; j += 1) {
            if (!markedPairKeys.has(toPairKey(group[i]!.archiveId, group[j]!.archiveId))) return false;
          }
        }
        return true;
      }).length;
    }
    const deletedIds = [...selected];
    const actuallyDeleted = new Set<string>();
    if (deletedIds.length > 0) {
      const response = await dedup.deleteSelected({ sessionId: result.session.sessionId }, syncFavorite);
      if (!response.ok) throw new Error(response.error.message);
      // 只有确实删除的档案才从视图移除；未删除的留在原地等待重试。
      response.value.outcomes.filter((outcome) => outcome.deleted).forEach((outcome) => actuallyDeleted.add(outcome.archiveId));
      if (response.value.rejectedArchiveIds.length) showToast('为保护重复组，部分档案未删除', 'error');
      else {
        const failed = response.value.outcomes.filter((outcome) => !outcome.deleted);
        // 执行结果不再挂在列表下方一行小字里：标记与删除的条数并进这条播报。
        const done = `${markCount > 0 ? `标记 ${markCount} 组为不重复，` : ''}删除 ${actuallyDeleted.size} 个档案`;
        showToast(failed.length ? `${failed.length} 个档案未删除：${failed[0]?.message ?? '请重试'}` : done, failed.length ? 'error' : 'success');
      }
      if (actuallyDeleted.size > 0) invalidateRouteCache();
    } else if (markCount > 0) {
      showToast(`已标记 ${markCount} 组为不重复`, 'success');
    }
    setProcessedDeletedArchiveIds((current) => new Set([...current, ...actuallyDeleted]));
    setSelectedGroupKeys(new Set());
    setManuallyTouchedGroupKeys(new Set());
    const reloaded = await dedup.loadResult(result.session.sessionId);
    if (reloaded.ok) setResult(reloaded.value);
    else setResult((current) => current ? { ...current, selectedArchiveIds: [] } : current);
    if (actuallyDeleted.size > 0) {
      const refreshed = await library.listArchiveIdentities(server.id);
      if (refreshed.ok) setArchives(refreshed.value);
    }
    setBusy(false);
  }

  /** 不重复关系：读取持久化对；标记/撤销都走既有命令并同步 journal。 */
  async function loadRelations() {
    if (!server) return;
    const response = await dedup.listNonDuplicates(server.scopeId);
    if (response.ok) setRelations(response.value);
    else showToast(response.error.message, 'error');
  }

  /** 入口固定在检测范围卡里，打开的是对话框：不再把面板塞进结果列表中间，
   * 位置永远一样，也不会因为列表变化而跳走。 */
  function openRelations() {
    const next = !relationsOpen;
    setRelationsOpen(next);
    if (next) void loadRelations();
  }


  /** 关系行按档案 ID 展示可读信息：标题取自当前服务器的档案表，取不到就退回
   * ID 前缀（关系可能指向已删除的档案）。 */
  function relationLabel(archiveId: string): string {
    const record = archiveById.get(archiveId);
    return record?.title?.trim() || `未知档案 ${archiveId.slice(0, 8)}`;
  }

  async function changeRelationTombstone(record: DedupNonDuplicateRecord) {
    if (!server) return;
    const response = record.tombstoned
      ? await dedup.saveNonDuplicate({ scopeId: server.scopeId, leftArchiveId: record.leftArchiveId, rightArchiveId: record.rightArchiveId })
      : await dedup.removeNonDuplicate({ scopeId: server.scopeId, leftArchiveId: record.leftArchiveId, rightArchiveId: record.rightArchiveId });
    if (!response.ok) { showToast(response.error.message, 'error'); return; }
    invalidateRouteCache();
    await loadRelations();
  }

  /** 扫描结果：列出本服务器落库过的会话，可载入或删除。 */
  async function loadSessions() {
    if (!server) return;
    setHistoryBusy(true);
    const response = await dedup.listSessions(server.scopeId);
    setHistoryBusy(false);
    if (response.ok) setSessions(response.value);
    else showToast(response.error.message, 'error');
  }

  function openHistory() {
    setHistoryOpen(true);
    void loadSessions();
  }

  /** 载入既有结果：命中对、选择与删除结果都在会话里，直接整体换上来。 */
  async function loadSession(summary: DedupSessionSummary) {
    if (historyBusy) return;
    setHistoryBusy(true);
    const response = await dedup.loadResult(summary.sessionId);
    setHistoryBusy(false);
    if (!response.ok) { showToast(response.error.message, 'error'); return; }
    scanGeneration.current += 1;
    setResult(response.value);
    setSessionId(summary.sessionId);
    setProgress({
      sessionId: summary.sessionId, scopeId: summary.scopeId, status: 'completed', stage: 'completed',
      processed: summary.archiveCount, total: summary.archiveCount, cacheHits: 0, downloads: 0,
      missingCovers: 0, invalidCovers: 0, pairCount: summary.pairCount, degraded: false,
      checkpoint: summary.archiveCount, diagnostics: [], pairs: [],
    });
    setSelectedGroupKeys(new Set());
    setManuallyTouchedGroupKeys(new Set());
    setProcessedNonDuplicatePairKeys(new Set());
    setProcessedDeletedArchiveIds(new Set());
    setHistoryOpen(false);
    showToast(`已载入扫描结果：${summary.pairCount} 组疑似重复`, 'success');
  }

  async function removeSession(summary: DedupSessionSummary) {
    if (historyBusy) return;
    setHistoryBusy(true);
    const response = await dedup.deleteSession(summary.sessionId);
    if (!response.ok) showToast(response.error.message, 'error');
    else if (summary.sessionId === sessionId) {
      // 删掉的正是当前结果：视图回到未扫描状态，免得继续对着幽灵档案操作。
      setResult(undefined);
      setProgress(undefined);
      setSessionId(undefined);
    }
    setHistoryBusy(false);
    await loadSessions();
  }

  useEffect(() => {
    if (!pageActive || !overviewArchiveId || !server) { setOverviewArchive(undefined); return; }
    let active = true;
    setOverviewArchive(undefined);
    void library.listArchivesByIds(server.id, [overviewArchiveId]).then((response) => {
      if (active) setOverviewArchive(response.ok ? response.value[0] : undefined);
    });
    return () => { active = false; };
  }, [overviewArchiveId, server, pageActive]);

  const visibleRelations = useMemo(() => {
    const query = relationsQuery.trim().toLowerCase();
    if (!query) return relations;
    return relations.filter((record) => record.pairKey.toLowerCase().includes(query)
      || record.leftArchiveId.toLowerCase().includes(query)
      || record.rightArchiveId.toLowerCase().includes(query)
      || relationLabel(record.leftArchiveId).toLowerCase().includes(query)
      || relationLabel(record.rightArchiveId).toLowerCase().includes(query));
  }, [relations, relationsQuery, archiveById]);

  function renderGroup(group: DedupMember[], rowKey: string) {
    const key = groupKeyOf(group);
    const isSelected = selectedGroupKeys.has(key);
    const pageGapIds = pageGapArchiveIds(group);
    const sourceLabel = sourceByGroupKey[key] === 'filename' ? '文件名' : '封面相似';
    return <li className={`dedup-group${isSelected ? ' is-selected' : ''}`} key={`${rowKey}#${key}`}>
      {/* 标题就是整组的选择按钮：一组永远「两两成对」，所以不报条数，只留可定位
          的序号；来源改成序号后面的图标（文件名 / 封面相似），页数差这类提醒挪到
          出了问题的页数上。 */}
      <button className="dedup-group-heading" type="button" aria-pressed={isSelected} onClick={() => void toggleGroupSelection(group)}>
        <strong>{isSelected ? `已选 · 第 ${groupNumberByKey.get(key) ?? '-'} 组` : `疑似重复 ${groupNumberByKey.get(key) ?? '-'}`}</strong>
        <span className="dedup-group-source" role="img" aria-label={`来源：${sourceLabel}`} title={`来源：${sourceLabel}`}>
          {sourceByGroupKey[key] === 'filename' ? <FileText aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
        </span>
      </button>
      <ul className="dedup-members">{group.map((archive) => <li key={archive.archiveId}>
        <DedupMemberCard
          member={archive}
          scopeId={server?.scopeId}
          serverId={server?.id}
          selected={selected.has(archive.archiveId)}
          pageGap={pageGapIds.has(archive.archiveId)}
          onToggle={handleMemberToggle}
        />
      </li>)}</ul>
    </li>;
  }

  // 进度条：有总数就是确定性进度，否则（枚举阶段）走不定量扫光条。
  const progressTotal = progress?.total ?? 0;
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.floor((progress?.processed ?? 0) / progressTotal * 100)) : 0;
  const progressDeterminate = progressTotal > 0 && progress?.stage !== 'enumerating';
  const coverless = (progress?.missingCovers ?? 0) + (progress?.invalidCovers ?? 0);
  const progressDetail = !progress ? '' : [
    progressTotal > 0 ? `${formatCount(progress.processed)} / ${formatCount(progressTotal)}` : '正在统计范围内的档案',
    progress.status === 'running' && progress.stage === 'covers' ? `缓存 ${formatCount(progress.cacheHits)} · 下载 ${formatCount(progress.downloads)}` : '',
    coverless > 0 ? `缺失或无效封面 ${formatCount(coverless)}` : '',
    progress.pairCount > 0 ? `命中 ${formatCount(progress.pairCount)} 组疑似重复` : '',
    progress.degraded ? '结果不完整' : '',
  ].filter(Boolean).join(' · ');
  // 第三项为 false 的统计只在桌面端出现：移动端一行放三格，六格正好两行。
  const stats: Array<[string, number, boolean]> = [
    ['全部档案', archives.length, true],
    ['扫描范围', progressTotal, false],
    ['有效封面', Math.max(0, (progress?.processed ?? 0) - coverless), false],
    ['缺失封面', coverless, false],
    // 已排除的是被标记为不重复、因而不再参与比对的对（导入的关系也在内），
    // 之前这一格显示的是缺失封面数，才让人以为导入的关系没生效。
    ['已排除', relationCount, true],
    ['疑似重复', progress?.pairCount ?? 0, true],
    ['重复组', filtered.allGroups.length, true],
    ['重复链', filtered.allChains.filter((chain) => chain.length > 1).length, true],
    ['已选档案', selected.size, true],
  ];

  return <div className="workspace-stack dedup-workspace">
    <h1 className="visually-hidden">查重工作区</h1>
    <section className="dedup-section dedup-scope" aria-label="检测范围">
      <div className="dedup-section-heading">
        <div>
          <strong>检测范围</strong>
          <span>服务器：{server?.name ?? '未配置'}。按加入日期圈定参与比对的档案。</span>
        </div>
        <div className="dedup-section-actions">
          {/* 与阅读器的工具栏、档案库的多选栏同一种语言：动作一律是纯图标，词放在
              可访问名与提示里；只有「开始扫描」保留文字，它是这一页的主动作。 */}
          <button className="secondary-action is-icon" type="button" aria-label="不重复关系" title="不重复关系" disabled={!server} onClick={openRelations}><Link2Off aria-hidden="true" /></button>
          <button className="secondary-action is-icon" type="button" aria-label="重置" title="重置" disabled={busy} onClick={() => { setStartDate('2000-01-01'); setEndDate(toDedupeDayString()); }}><RotateCcw aria-hidden="true" /></button>
          <button className="secondary-action is-icon" type="button" aria-label="扫描结果" title="扫描结果" disabled={!server || busy} onClick={openHistory}><History aria-hidden="true" /></button>
          {progress?.status === 'cancelled' && !busy && <button className="secondary-action is-icon" type="button" aria-label="恢复扫描" title="恢复扫描" disabled={!server} onClick={() => void runScan(true)}><CirclePlay aria-hidden="true" /></button>}
          {busy
            ? <button className="secondary-action is-icon" type="button" aria-label="取消扫描" title="取消扫描" onClick={() => void cancelScan()}><CircleStop aria-hidden="true" /></button>
            : <button className="primary-action" type="button" disabled={!server} onClick={() => void runScan()}><Play aria-hidden="true" />开始扫描</button>}
        </div>
      </div>
      {/* 服务器不再让用户选：总是当前启用的那台（见 pickServer），名字放在说明里。 */}
      <div className="dedup-scope-grid">
        <DatePicker label="起始日期" value={startDate} onChange={setStartDate} />
        <DatePicker label="结束日期" value={endDate} onChange={setEndDate} />
      </div>
    </section>
    {/* 完成后再挂一条 100% 的进度条没有信息量，收起来；取消时留着，因为还要
        从这里恢复扫描。 */}
    {progress && progress.status !== 'completed' && <section className="dedup-section dedup-scan-progress" aria-label="扫描进度">
      <div className="dedup-progress-head">
        <div>
          <strong>{STAGE_LABELS[progress.stage]}</strong>
          <span>{progressDetail}</span>
        </div>
        <span className="dedup-progress-value">{progressDeterminate ? `${progressPercent}%` : (progress.status === 'running' ? '进行中' : '完成')}</span>
      </div>
      <div
        className="dedup-progress-track"
        role="progressbar"
        aria-label="扫描进度"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(progressDeterminate ? { 'aria-valuenow': progressPercent } : {})}
      >
        <div className={`dedup-progress-fill${progressDeterminate ? '' : ' is-indeterminate'}`} style={progressDeterminate ? { width: `${progressPercent}%` } : undefined} />
      </div>
    </section>}
    {result && <section className="dedup-section dedup-scan-summary" aria-label="本次扫描">
      <div className="dedup-section-heading">
        <div>
          <strong>本次扫描</strong>
          {/* 结果已经落库，条数就在下面这排统计里：不再重复一句「扫描完成」。 */}
          {progress?.stage === 'cancelled' && <span>扫描已取消，下面是已完成部分的结果。</span>}
        </div>
        <div className="dedup-section-actions">
          <button className="secondary-action is-icon" type="button" aria-label="智能选择" title="智能选择" onClick={requestSmartSelect}><WandSparkles aria-hidden="true" /></button>
          <button className="secondary-action is-icon" type="button" aria-pressed={groups.length > 0 && selectedGroupKeys.size === groups.length} aria-label={groups.length > 0 && selectedGroupKeys.size === groups.length ? '取消全选' : '全选分组'} title={groups.length > 0 && selectedGroupKeys.size === groups.length ? '取消全选' : '全选分组'} disabled={!groups.length} onClick={() => void toggleAllGroups()}><SquareCheckBig aria-hidden="true" /></button>
          {/* 主按钮样式与「开始扫描」一致：都是这一步的主动作，删除的危险性由确认
              弹窗承担，不靠按钮颜色提前喊。 */}
          <button className="primary-action is-icon" type="button" aria-label={busy ? '执行中' : '执行所选'} title={busy ? '执行中' : '执行所选'} disabled={(!selectedGroupKeys.size && !selected.size) || busy} aria-busy={busy} onClick={requestExecuteSelected}>{busy ? <LoadingIndicator inline /> : <Trash2 aria-hidden="true" />}</button>
        </div>
      </div>
      <dl className="dedup-stats">
        {stats.map(([label, value, onMobile]) => <div className={`dedup-stat${onMobile ? '' : ' is-desktop-only'}`} key={label}>
          <dt>{label}</dt>
          <dd>{formatCount(value)}</dd>
        </div>)}
      </dl>
      <div className="dedup-filters">
        <label>来源<SelectField name="dedupSource" aria-label="来源" value={sourceFilter} options={[{ value: 'all', label: '全部来源' }, { value: 'image', label: '封面相似' }, { value: 'filename', label: '文件名' }]} onChange={(value) => setSourceFilter(value as typeof sourceFilter)} /></label>
        <label>视图<SelectField name="dedupView" aria-label="视图" value={view} options={[{ value: 'groups', label: '重复组' }, { value: 'chains', label: '重复链' }]} onChange={(value) => setView(value as typeof view)} /></label>
        {/* 已选择 / 待选择：检查这批重复还有哪些没定，或复核已经定下的那些。
            和上面两个筛选用同一种控件，三格看起来是一排。 */}
        <label>选择<SelectField name="dedupSelection" aria-label="选择" value={selectionFilter} options={[{ value: 'all', label: '全部' }, { value: 'selected', label: '已选择' }, { value: 'pending', label: '待选择' }]} onChange={(value) => setSelectionFilter(value as typeof selectionFilter)} /></label>
      </div>
      {pageGapWarningCount > 0 && <div className="progress-line is-warning" role="status">{pageGapWarningCount} 组页数差超过 10 页，请人工确认后再执行。<button className="icon-button" type="button" aria-label="关闭页数差警告" onClick={() => setPageGapWarningCount(0)}><X aria-hidden="true" /></button></div>}
    </section>}
    {deleteSession && <ArchiveDeletionConfirmation description={`将标记 ${selectedGroupKeys.size} 组为不重复，并永久删除所选的 ${deleteSession.count} 个重复档案，此操作不可撤销。`} onClose={() => setDeleteSession(undefined)} onConfirm={executeSelected} />}
    {smartSelectPending && <div className="dedup-confirm" role="dialog" aria-label="智能选择确认">
      <p>只按文件名判定的组默认跳过。</p>
      <label><input type="checkbox" checked={includeFilenameOnly} onChange={(event) => setIncludeFilenameOnly(event.target.checked)} />把文件名来源的重复组一并纳入</label>
      <div className="dedup-confirm-actions">
        <button className="primary-action is-icon" type="button" aria-label="执行智能选择" title="执行智能选择" onClick={() => void smartSelect(includeFilenameOnly)}><Check aria-hidden="true" /></button>
        <button className="secondary-action is-icon" type="button" aria-label="取消" title="取消" onClick={() => setSmartSelectPending(false)}><X aria-hidden="true" /></button>
      </div>
    </div>}
    {result && <>
      {/* 默认视图也把关联链划出来（Readoshi 的 renderChain）：多个组属于同一条
          重复关系链时，它们围在一个带标题的区块里，而不是散落在网格中。 */}
      {view === 'groups' && <div className="dedup-group-rows" aria-label="重复结果" ref={groupsRef}>
        {mountedRows.map((row) => row.kind === 'chain'
          ? <ul className="dedup-group-row is-chain-row" key={row.key} style={{ '--group-columns': chainColumns } as CSSProperties}>
            <li className="dedup-chain">
              <div className="dedup-chain-heading">
                {/* 图标 + 链号：这枚按钮的身份就是那个号，号是数据不是标签，所以它留下。 */}
                <button className="secondary-action is-compact" type="button" aria-pressed={row.chain.every((group) => selectedGroupKeys.has(groupKeyOf(group)))} aria-label={`关联重复链 ${row.number}`} title={`关联重复链 ${row.number}`} onClick={() => void toggleChainSelection(row.chain)}><Link2 aria-hidden="true" />{row.number}</button>
              </div>
              <div className="dedup-group-rows">
                {chunkRows(row.chain, chainColumns).map((chainRow, chainRowIndex) => <ul className="dedup-group-row" key={`${row.key}-row-${chainRowIndex}`} style={{ '--group-columns': chainColumns } as CSSProperties}>
                  {chainRow.map((group) => renderGroup(group, row.key))}
                </ul>)}
              </div>
            </li>
          </ul>
          : <ul className="dedup-group-row" key={row.key} style={{ '--group-columns': groupColumns } as CSSProperties}>
            {row.groups.map((group) => renderGroup(group, row.key))}
          </ul>)}
      </div>}
      {view === 'chains' && <div className="dedup-chains" aria-label="重复链">
        {mountedSections.filter((section) => section.groups.length > 1).map((section) => <section className="dedup-chain" key={`chain-only-${section.key}`}>
          <div className="dedup-chain-heading">
            <button className="secondary-action is-compact" type="button" aria-pressed={section.groups.every((group) => selectedGroupKeys.has(groupKeyOf(group)))} aria-label={`关联重复链 ${section.number}`} title={`关联重复链 ${section.number}`} onClick={() => void toggleChainSelection(section.groups)}><Link2 aria-hidden="true" />{section.number}</button>
          </div>
          <div className="dedup-group-rows">
            {chunkRows(section.groups, chainColumns).map((chainRow, chainRowIndex) => <ul className="dedup-group-row" key={`chain-only-${section.key}-row-${chainRowIndex}`} style={{ '--group-columns': chainColumns } as CSSProperties}>
              {chainRow.map((group) => renderGroup(group, `chain-only-${section.key}`))}
            </ul>)}
          </div>
        </section>)}
      </div>}
      {moreRowsMounted && <div ref={sentinelRef} aria-hidden="true" className="dedup-list-sentinel" />}
      {!visibleGroups.length && !busy && <StatusLine>没有匹配当前筛选的重复组。</StatusLine>}
    </>}
    <Dialog.Root open={relationsOpen} onOpenChange={(open) => { if (!open) setRelationsOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dedup-relations-dialog">
          <Dialog.Title>不重复关系</Dialog.Title>
          <Dialog.Description>
            {`有效 ${relations.filter((record) => !record.tombstoned).length} 条，不再参与比对；已移除 ${relations.filter((record) => record.tombstoned).length} 条仍可恢复标记。`}
          </Dialog.Description>
          <input className="dedup-relations-search" aria-label="搜索不重复关系" value={relationsQuery} onChange={(event) => setRelationsQuery(event.target.value)} placeholder="搜索档案标题或 ID" spellCheck={false} autoComplete="off" />
          <ul className="dedup-relations-list">
            {visibleRelations.map((record) => <li key={record.pairKey} className={record.tombstoned ? 'is-tombstoned' : ''}>
              <div className="dedup-relation-pair">
                <span className="dedup-relation-cover">
                  {server && <ArchiveThumbMedia scopeId={server.scopeId} serverId={server.id} archiveId={record.leftArchiveId} />}
                </span>
                <span className="dedup-relation-cover">
                  {server && <ArchiveThumbMedia scopeId={server.scopeId} serverId={server.id} archiveId={record.rightArchiveId} />}
                </span>
                {/* 点标题就地打开档案概览：一眼看清这两个档案大概是什么，不必
                    跳到阅读器再回来。已经不在库里的档案（关系会指向被删掉的条目）
                    不给入口，免得点了只看到一个空面板。 */}
                <span className="dedup-relation-titles">
                  {[record.leftArchiveId, record.rightArchiveId].map((id) => archiveById.has(id)
                    ? <button key={id} className="dedup-relation-title" type="button" onClick={() => setOverviewArchiveId(id)}>{relationLabel(id)}</button>
                    : <span key={id} className="is-missing">{relationLabel(id)}</span>)}
                </span>
              </div>
              <button className="secondary-action is-icon" type="button" aria-label={record.tombstoned ? '恢复标记' : '取消标记'} title={record.tombstoned ? '恢复标记' : '取消标记'} onClick={() => void changeRelationTombstone(record)}>
                {record.tombstoned ? <Undo2 aria-hidden="true" /> : <Ban aria-hidden="true" />}
              </button>
            </li>)}
            {!visibleRelations.length && <StatusLine as="li">没有匹配的关系记录。</StatusLine>}
          </ul>
          <div className="dialog-actions">
            <button className="secondary-action is-icon" type="button" aria-label="关闭" title="关闭" onClick={() => setRelationsOpen(false)}><X aria-hidden="true" /></button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {/* 关系行标题打开的档案概览：就地看，查重页的筛选、滚动和选择都留着。 */}
    {overviewArchive && server && <ArchiveOverviewDialog archive={overviewArchive} scopeId={server.scopeId} serverId={server.id} onClose={() => setOverviewArchiveId(undefined)} />}
    <Dialog.Root open={historyOpen} onOpenChange={(open) => { if (!open) setHistoryOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dedup-history-dialog">
          <Dialog.Title>扫描结果</Dialog.Title>
          <Dialog.Description>每次扫描都会连同命中对、选择与删除结果一起保存在本机，可以重新载入继续处理；删除只清理该次扫描的记录。</Dialog.Description>
          {/* 空态不再伪装成一条记录：它以前是列表里的一个 <li>，于是套上了记录的
              描边、底色和两端对齐，读起来像"有一条叫这个名字的扫描结果"。 */}
          {sessions.length > 0 ? <ul className="dedup-history-list">
            {sessions.map((item) => <li key={item.sessionId} className={item.sessionId === sessionId ? 'is-current' : ''}>
              <div>
                <strong>{formatSessionTime(item.updatedAt)}</strong>
                <span>{item.status === 'completed' ? '已完成' : item.status === 'cancelled' ? '已取消' : '未完成'} · {formatCount(item.archiveCount)} 档案 · {formatCount(item.pairCount)} 组疑似重复{item.sessionId === sessionId ? ' · 当前结果' : ''}</span>
              </div>
              <div className="dedup-history-actions">
                <button className="secondary-action is-icon" type="button" aria-label={`载入 ${formatSessionTime(item.updatedAt)} 的扫描结果`} title="载入" disabled={historyBusy || item.sessionId === sessionId} onClick={() => void loadSession(item)}><FolderOpen aria-hidden="true" /></button>
                <button className="secondary-action is-danger is-icon" type="button" aria-label={`删除 ${formatSessionTime(item.updatedAt)} 的扫描结果`} title="删除" disabled={historyBusy} onClick={() => void removeSession(item)}><Trash2 aria-hidden="true" /></button>
              </div>
            </li>)}
          </ul> : historyBusy
            ? <StatusLine busy region>正在读取扫描结果…</StatusLine>
            : <EmptyState
              icon={History}
              title="还没有保存的扫描结果"
              description="扫描完成后会连同命中对、选择与删除结果一起保存在本机，回到这里可以重新载入继续处理。"
            />}
          <div className="dialog-actions">
            <button className="secondary-action is-icon" type="button" aria-label="关闭" title="关闭" onClick={() => setHistoryOpen(false)}><X aria-hidden="true" /></button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
