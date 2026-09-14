import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CopyCheck, Play, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ArchiveRecord, ServerRecord } from '../domain/library';
import { countDuplicateGroupsWithLargePageGap, getDedupeGroupFilterData, getDedupeSmartSignals, mergeSmartDuplicateSelection, normalizeDuplicateSelection, toDedupeDayString, toPairKey, type DedupeArchive, type DuplicateSource } from '../domain/deduplication';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeDedupRepository, type DedupLoadResult, type DedupNonDuplicateRecord, type DedupScanProgress } from '../repositories/nativeDedupRepository';
import { SelectField } from './SelectField';
import { useToast } from './Toast';
import { ArchiveDeletionConfirmation } from './ArchiveDeleteDialog';
import { invalidateRouteCache } from '../lib/routeCache';
import { DatePicker } from './DatePicker';

const library = new NativeLibraryRepository();
const dedup = new NativeDedupRepository();
// v3：块级证据 + Wilson 聚合（imsearch 的「多特征匹配 → 按图聚合 → Wilson 下
// 界」思想）+ dhash 预筛 + 平移搜索；比较层对齐 imsearch 的评分思想。
const ALGORITHM_VERSION = 'readoshi-v3';

type DedupMember = DedupeArchive & { archiveId: string };

function dedupeArchiveOf(archive: ArchiveRecord): DedupeArchive {
  return {
    id: archive.archiveId,
    title: archive.title,
    tags: archive.tags,
    size: archive.fileSize,
    pagecount: archive.pageCount,
  };
}

function groupKeyOf(group: readonly { archiveId: string }[]): string {
  return group.map((item) => item.archiveId).sort().join('|');
}

function formatBytes(value: number | string | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '体积未知';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function SmartTags({ archive }: { archive: DedupeArchive }) {
  const signals = getDedupeSmartSignals(archive);
  return <div className="dedup-smart-tags">
    {signals.roughTranslation && <span className="dedup-smart-tag is-warning">渣翻</span>}
    {signals.extraneousAds && <span className="dedup-smart-tag is-warning">外部广告</span>}
    {signals.uncensored && <span className="dedup-smart-tag is-positive">无修正</span>}
    {signals.noChinese && <span className="dedup-smart-tag is-warning">无汉语</span>}
  </div>;
}

/** 去重工作区，操作模型与 Readoshi 对齐：
 * 选中整组（或整条关联链）= 执行时把组内全部两两组合标记为不重复；
 * 勾选组内档案 = 执行时删除；手动触碰过的组受智能选择保护；
 * 已标记的对立刻从视图移除，下次扫描也不再命中。 */
export function DeduplicationWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const { showToast } = useToast();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [server, setServer] = useState<ServerRecord>();
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [progress, setProgress] = useState<DedupScanProgress>();
  const [result, setResult] = useState<DedupLoadResult>();
  const [sessionId, setSessionId] = useState<string>();
  const [startDate, setStartDate] = useState('2000-01-01');
  const [endDate, setEndDate] = useState(() => toDedupeDayString());
  const [sourceFilter, setSourceFilter] = useState<'all' | DuplicateSource>('all');
  const [view, setView] = useState<'groups' | 'chains'>('groups');
  const [busy, setBusy] = useState(false);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set());
  const [manuallyTouchedGroupKeys, setManuallyTouchedGroupKeys] = useState<Set<string>>(new Set());
  const [processedNonDuplicatePairKeys, setProcessedNonDuplicatePairKeys] = useState<Set<string>>(new Set());
  const [processedDeletedArchiveIds, setProcessedDeletedArchiveIds] = useState<Set<string>>(new Set());
  const [smartSelectPending, setSmartSelectPending] = useState(false);
  const [includeFilenameOnly, setIncludeFilenameOnly] = useState(false);
  const [pageGapWarningCount, setPageGapWarningCount] = useState(0);
  const [execution, setExecution] = useState<{ marks: number; deletes: number }>();
  const [deleteSession, setDeleteSession] = useState<{ count: number }>();
  // 不重复关系面板：持久化的对（含历史墓碑）直接列出，可搜索、可撤销标记。
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [relations, setRelations] = useState<DedupNonDuplicateRecord[]>([]);
  const [relationsQuery, setRelationsQuery] = useState('');
  const scanGeneration = useRef(0);

  useEffect(() => {
    void library.listServers().then((response) => {
      if (!response.ok) { showToast(response.error.message, 'error'); return; }
      setServers(response.value);
      const first = response.value[0];
      if (first) setServer(first);
    });
  }, [showToast]);

  useEffect(() => {
    if (!server) return;
    void library.listArchives(server.id).then((response) => {
      if (response.ok) setArchives(response.value);
      else showToast(response.error.message, 'error');
    });
  }, [server, showToast]);

  const archiveById = useMemo(() => {
    const byId = new Map<string, ArchiveRecord>();
    archives.forEach((archive) => byId.set(archive.archiveId, archive));
    return byId;
  }, [archives]);

  const groups = useMemo<DedupMember[][]>(() => {
    const resolve = (archiveId: string): DedupMember => {
      const record = archiveById.get(archiveId);
      return record ? { ...dedupeArchiveOf(record), archiveId: record.archiveId } : { archiveId, title: archiveId };
    };
    // 已删除的档案（processedDeletedArchiveIds）与已标记的对一起从视图移除，
    // 与 Readoshi 的 filterGroupsByProcessedState 一致。
    return (result?.pairs ?? [])
      .map((pair) => [pair.leftArchiveId, pair.rightArchiveId] as const)
      .filter((ids) => !processedNonDuplicatePairKeys.has(toPairKey(ids[0], ids[1])))
      .filter((ids) => ids.every((id) => !processedDeletedArchiveIds.has(id)))
      .map(([left, right]) => [resolve(left), resolve(right)]);
  }, [archiveById, result, processedNonDuplicatePairKeys, processedDeletedArchiveIds]);

  const sourceByGroupKey = useMemo(() => Object.fromEntries((result?.pairs ?? []).map((pair) => [[pair.leftArchiveId, pair.rightArchiveId].sort().join('|'), pair.source as DuplicateSource])), [result]);
  const filtered = useMemo(() => getDedupeGroupFilterData(groups, sourceByGroupKey), [groups, sourceByGroupKey]);
  const chainSections = useMemo(() => {
    if (sourceFilter === 'all') return filtered.chains;
    return filtered.chains
      .map((chain) => chain.filter((group) => sourceByGroupKey[groupKeyOf(group)] === sourceFilter))
      .filter((chain) => chain.length > 0);
  }, [filtered.chains, sourceByGroupKey, sourceFilter]);
  const visibleGroups = useMemo(() => {
    if (view === 'chains') return chainSections.flat();
    if (sourceFilter === 'image') return filtered.imageGroups;
    if (sourceFilter === 'filename') return filtered.filenameGroups;
    return filtered.allGroups;
  }, [chainSections, filtered, sourceFilter, view]);
  const selected = useMemo(() => new Set(result?.selectedArchiveIds ?? []), [result]);

  async function persistSelection(nextSelected: string[]) {
    if (!result) return;
    const response = await dedup.scanChunk({ sessionId: result.session.sessionId, algorithmVersion: result.session.algorithmVersion, checkpoint: result.session.checkpoint, archives: [], pairs: [], selectedArchiveIds: nextSelected });
    if (!response.ok) showToast(response.error.message, 'error');
  }

  function runScan(resume = false) {
    if (!server) return;
    const generation = ++scanGeneration.current;
    setBusy(true);
    setSelectedGroupKeys(new Set());
    setManuallyTouchedGroupKeys(new Set());
    setProcessedNonDuplicatePairKeys(new Set());
    setProcessedDeletedArchiveIds(new Set());
    setPageGapWarningCount(0);
    setExecution(undefined);
    const id = resume && sessionId ? sessionId : `dedup-${Date.now()}`;
    setSessionId(id);
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
    const next = new Set(result.selectedArchiveIds);
    if (checked) next.add(archiveId); else next.delete(archiveId);
    await persistSelection(normalizeDuplicateSelection(groups, [...next]));
    const loaded = await dedup.loadResult(result.session.sessionId);
    if (loaded.ok) setResult(loaded.value);
  }

  async function toggleGroupSelection(group: readonly { archiveId: string }[]) {
    const key = groupKeyOf(group);
    setManuallyTouchedGroupKeys((current) => new Set([...current, key]));
    const nextGroupKeys = new Set(selectedGroupKeys);
    if (nextGroupKeys.has(key)) nextGroupKeys.delete(key);
    else nextGroupKeys.add(key);
    setSelectedGroupKeys(nextGroupKeys);
    // 整组选择与单档案删除勾选互斥。
    const nextSelected = new Set(selected);
    group.forEach((item) => nextSelected.delete(item.archiveId));
    await persistSelection([...nextSelected]);
    if (result) {
      const loaded = await dedup.loadResult(result.session.sessionId);
      if (loaded.ok) setResult(loaded.value);
    }
  }

  async function toggleChainSelection(chain: readonly (readonly { archiveId: string }[])[]) {
    const keys = chain.map(groupKeyOf);
    setManuallyTouchedGroupKeys((current) => new Set([...current, ...keys]));
    const nextGroupKeys = new Set(selectedGroupKeys);
    if (keys.every((key) => selectedGroupKeys.has(key))) keys.forEach((key) => nextGroupKeys.delete(key));
    else keys.forEach((key) => nextGroupKeys.add(key));
    setSelectedGroupKeys(nextGroupKeys);
    const nextSelected = new Set(selected);
    chain.flat().forEach((item) => nextSelected.delete(item.archiveId));
    await persistSelection([...nextSelected]);
    if (result) {
      const loaded = await dedup.loadResult(result.session.sessionId);
      if (loaded.ok) setResult(loaded.value);
    }
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
    await persistSelection(selection.archiveIds);
    setPageGapWarningCount(countDuplicateGroupsWithLargePageGap(groups));
    const loaded = await dedup.loadResult(result.session.sessionId);
    if (loaded.ok) setResult(loaded.value);
    else showToast(loaded.error.message, 'error');
  }

  function requestExecuteSelected() {
    if (selectedGroupKeys.size === 0 && selected.size === 0) return;
    setDeleteSession({ count: selected.size });
  }

  async function executeSelected(syncFavorite: boolean) {
    if (!result || !server) return;
    setBusy(true);
    setDeleteSession(undefined);
    // 整组选择 → 组内全部两两组合标记为不重复。
    const markedGroups = groups.filter((group) => selectedGroupKeys.has(groupKeyOf(group)));
    let markFailures = 0;
    for (const group of markedGroups) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const response = await dedup.saveNonDuplicate({ scopeId: server.scopeId, leftArchiveId: group[i]!.archiveId, rightArchiveId: group[j]!.archiveId });
          if (response.ok) {
            setProcessedNonDuplicatePairKeys((current) => new Set([...current, toPairKey(group[i]!.archiveId, group[j]!.archiveId)]));
          } else {
            markFailures += 1;
          }
        }
      }
    }
    if (markFailures > 0) showToast(`${markFailures} 组标记失败，请重试`, 'error');
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
        showToast(failed.length ? `${failed.length} 个档案未删除：${failed[0]?.message ?? '请重试'}` : '删除任务已完成', failed.length ? 'error' : 'success');
      }
      if (actuallyDeleted.size > 0) invalidateRouteCache();
    }
    setProcessedDeletedArchiveIds((current) => new Set([...current, ...actuallyDeleted]));
    setExecution({ marks: markedGroups.length - markFailures, deletes: actuallyDeleted.size });
    setSelectedGroupKeys(new Set());
    setManuallyTouchedGroupKeys(new Set());
    const reloaded = await dedup.loadResult(result.session.sessionId);
    if (reloaded.ok) setResult(reloaded.value);
    else setResult((current) => current ? { ...current, selectedArchiveIds: [] } : current);
    if (actuallyDeleted.size > 0) {
      const refreshed = await library.listArchives(server.id);
      if (refreshed.ok) setArchives(refreshed.value);
    }
    setBusy(false);
  }

  /** 不重复关系面板：读取持久化对；标记/撤销都走既有命令并同步 journal。 */
  async function loadRelations() {
    if (!server) return;
    const response = await dedup.listNonDuplicates(server.scopeId);
    if (response.ok) setRelations(response.value);
    else showToast(response.error.message, 'error');
  }

  function toggleRelations() {
    const next = !relationsOpen;
    setRelationsOpen(next);
    if (next) void loadRelations();
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

  const visibleRelations = useMemo(() => {
    const query = relationsQuery.trim().toLowerCase();
    if (!query) return relations;
    return relations.filter((record) => record.pairKey.toLowerCase().includes(query));
  }, [relations, relationsQuery]);

  function renderGroup(group: DedupMember[], chainIndex: number, groupIndex: number) {
    const key = groupKeyOf(group);
    const isSelected = selectedGroupKeys.has(key);
    const hasLargePageGap = countDuplicateGroupsWithLargePageGap([group]) > 0;
    return <li className={`dedup-group${isSelected ? ' is-selected' : ''}${hasLargePageGap ? ' is-page-gap-warning' : ''}`} key={`${chainIndex}-${groupIndex}-${key}`}>
      <button className="dedup-group-heading" type="button" aria-pressed={isSelected} onClick={() => void toggleGroupSelection(group)}>
        <strong>{isSelected ? '已选 · 执行时标记为不重复' : '疑似重复'}</strong><span>{group.length} 项{hasLargePageGap ? ' · 页数差大' : ''}</span>
      </button>
      <ul>{group.map((archive) => <li key={archive.archiveId}>
        <div className="dedup-card">
          <label><input type="checkbox" checked={selected.has(archive.archiveId)} onChange={(event) => void toggleSelected(archive.archiveId, event.target.checked)} /><span>{archive.title || archive.archiveId}</span><small>{archive.archiveId}</small></label>
          <div className="dedup-card-size-row">
            <div className="dedup-card-size">{formatBytes(archive.size)} · {Number(archive.pagecount) > 0 ? `${Number(archive.pagecount)}页` : '页数未知'}</div>
            <SmartTags archive={archive} />
          </div>
        </div>
      </li>)}</ul>
    </li>;
  }

  return <div className="workspace-stack dedup-workspace">
    {!embedded && <header className="workspace-heading"><div><span className="eyebrow">重复管理</span><h1 className="visually-hidden">查重工作区</h1></div><CopyCheck aria-hidden="true" /></header>}
    <section className="toolbar-row" aria-label="查重设置">
      <label>服务器<SelectField name="dedupServer" aria-label="服务器" value={server?.id ?? ''} options={servers.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setServer(servers.find((item) => item.id === value))} /></label>
      <DatePicker label="起始日期" value={startDate} onChange={setStartDate} />
      <DatePicker label="结束日期" value={endDate} onChange={setEndDate} />
      <button className="primary-action" type="button" disabled={!server || busy} onClick={() => void runScan()}><Play aria-hidden="true" />{busy ? '扫描中…' : '开始扫描'}</button>
      {busy && <button className="secondary-action" type="button" onClick={() => void cancelScan()}><X aria-hidden="true" />取消</button>}
      {progress?.status === 'cancelled' && <button className="secondary-action" type="button" onClick={() => void runScan(true)}><RefreshCw aria-hidden="true" />恢复</button>}
    </section>
    <section className="dedup-relations" aria-label="不重复关系">
      <button className="secondary-action" type="button" aria-pressed={relationsOpen} disabled={!server} onClick={toggleRelations}><CopyCheck aria-hidden="true" />不重复关系</button>
      {relationsOpen && <>
        <div className="progress-line" role="status">有效 {relations.filter((record) => !record.tombstoned).length} 条 · 已移除 {relations.filter((record) => record.tombstoned).length} 条（含扫描导入）</div>
        <label>搜索<input className="dedup-relations-search" aria-label="搜索不重复关系" value={relationsQuery} onChange={(event) => setRelationsQuery(event.target.value)} placeholder="档案 ID 或 a|b" spellCheck={false} autoComplete="off" /></label>
        <ul className="dedup-relations-list">
          {visibleRelations.map((record) => <li key={record.pairKey} className={record.tombstoned ? 'is-tombstoned' : ''}>
            <code>{record.pairKey}</code>
            <button className="secondary-action" type="button" onClick={() => void changeRelationTombstone(record)}>
              {record.tombstoned ? '恢复标记' : '取消标记'}
            </button>
          </li>)}
          {!visibleRelations.length && <li className="empty-state">没有匹配的关系记录。</li>}
        </ul>
      </>}
    </section>
    {progress && <div className="progress-line" role="status">{progress.stage} · {progress.processed}/{progress.total} · 命中 {progress.pairCount}{progress.missingCovers > 0 ? ` · 缺失封面 ${progress.missingCovers}` : ''}{progress.invalidCovers > 0 ? ` · 无效封面 ${progress.invalidCovers}` : ''}{progress.degraded ? ' · 结果不完整' : ''}</div>}
    {deleteSession && <ArchiveDeletionConfirmation description={`将标记 ${selectedGroupKeys.size} 组为不重复，并永久删除所选的 ${deleteSession.count} 个重复档案，此操作不可撤销。`} onClose={() => setDeleteSession(undefined)} onConfirm={executeSelected} />}
    {smartSelectPending && <div className="dedup-confirm" role="dialog" aria-label="智能选择确认">
      <p>仅由档案名判定的重复组默认跳过，不计入智能选择。</p>
      <label><input type="checkbox" checked={includeFilenameOnly} onChange={(event) => setIncludeFilenameOnly(event.target.checked)} />把文件名来源的重复组一并纳入</label>
      <div className="dedup-confirm-actions">
        <button className="primary-action" type="button" onClick={() => void smartSelect(includeFilenameOnly)}><ShieldCheck aria-hidden="true" />执行智能选择</button>
        <button className="secondary-action" type="button" onClick={() => setSmartSelectPending(false)}>取消</button>
      </div>
    </div>}
    {result && <>
      <section className="toolbar-row dedup-filters">
        <label>来源<SelectField name="dedupSource" aria-label="来源" value={sourceFilter} options={[{ value: 'all', label: '全部来源' }, { value: 'image', label: '封面相似' }, { value: 'filename', label: '文件名' }]} onChange={(value) => setSourceFilter(value as typeof sourceFilter)} /></label>
        <label>视图<SelectField name="dedupView" aria-label="视图" value={view} options={[{ value: 'groups', label: '重复组' }, { value: 'chains', label: '重复链' }]} onChange={(value) => setView(value as typeof view)} /></label>
        <button className="secondary-action" type="button" onClick={requestSmartSelect}><ShieldCheck aria-hidden="true" />智能选择</button>
        <button className="danger-action" type="button" disabled={(!selectedGroupKeys.size && !selected.size) || busy} onClick={requestExecuteSelected}>执行所选</button>
      </section>
      <div className="progress-line" role="status">已标记跳过 {processedNonDuplicatePairKeys.size} 对 · 删除已选 {selected.size} 个 · 待标记组 {selectedGroupKeys.size} 组{execution ? ` · 执行完成：标记 ${execution.marks} 组，删除 ${execution.deletes} 个` : ''}</div>
      {pageGapWarningCount > 0 && <div className="progress-line is-warning" role="status">{pageGapWarningCount} 组页数差超过 10 页，请人工确认后再执行。<button className="icon-button" type="button" aria-label="关闭页数差警告" onClick={() => setPageGapWarningCount(0)}><X aria-hidden="true" /></button></div>}
      {view === 'chains' && chainSections.map((chain, chainIndex) => <section className="dedup-chain" key={`chain-${chainIndex}`}>
        <button className="secondary-action" type="button" aria-pressed={chain.every((group) => selectedGroupKeys.has(groupKeyOf(group)))} onClick={() => void toggleChainSelection(chain)}>关联重复链</button>
        <ul className="dedup-groups">{chain.map((group, groupIndex) => renderGroup(group, chainIndex, groupIndex))}</ul>
      </section>)}
      {view === 'groups' && <ul className="dedup-groups" aria-label="重复结果">{visibleGroups.map((group, index) => renderGroup(group, index, 0))}</ul>}
      {!visibleGroups.length && !busy && <p className="empty-state">没有匹配当前筛选的重复组。</p>}
    </>}
    {!result && !busy && <p className="empty-state">尚未运行查重扫描。</p>}
  </div>;
}
