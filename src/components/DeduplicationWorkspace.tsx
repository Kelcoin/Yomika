import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CopyCheck, Play, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { ArchiveRecord, ServerRecord } from '../domain/library';
import { mergeSmartDuplicateSelection, getDedupeGroupFilterData, toDedupeDayString, type DuplicateSource } from '../domain/deduplication';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeDedupRepository, type DedupLoadResult, type DedupScanProgress } from '../repositories/nativeDedupRepository';
import { SelectField } from './SelectField';
import { useToast } from './Toast';
import { ArchiveDeletionConfirmation } from './ArchiveDeleteDialog';
import { invalidateRouteCache } from '../lib/routeCache';
import { DatePicker } from './DatePicker';

const library = new NativeLibraryRepository();
const dedup = new NativeDedupRepository();
const ALGORITHM_VERSION = 'readoshi-v1';

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
  const [deleteSession, setDeleteSession] = useState<{ id: string; count: number }>();
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

  const groups = useMemo<Array<Array<{ archiveId: string; title?: string }>>>(() => {
    const byId = new Map(archives.map((archive) => [archive.archiveId, archive]));
    return (result?.pairs ?? []).map((pair) => [byId.get(pair.leftArchiveId) ?? { archiveId: pair.leftArchiveId, title: pair.leftArchiveId }, byId.get(pair.rightArchiveId) ?? { archiveId: pair.rightArchiveId, title: pair.rightArchiveId }]);
  }, [archives, result]);
  const sourceByGroupKey = useMemo(() => Object.fromEntries((result?.pairs ?? []).map((pair) => [[pair.leftArchiveId, pair.rightArchiveId].sort().join('|'), pair.source as DuplicateSource])), [result]);
  const filtered = useMemo(() => getDedupeGroupFilterData(groups, sourceByGroupKey), [groups, sourceByGroupKey]);
  const visibleGroups = sourceFilter === 'image' ? filtered.imageGroups : sourceFilter === 'filename' ? filtered.filenameGroups : view === 'chains' ? filtered.chains.flat() : filtered.allGroups;
  const selected = new Set(result?.selectedArchiveIds ?? []);

  async function runScan(resume = false) {
    if (!server) return;
    const generation = ++scanGeneration.current;
    setBusy(true);
    const id = resume && sessionId ? sessionId : `dedup-${Date.now()}`;
    setSessionId(id);
    const response = await dedup.scan({ sessionId: id, scopeId: server.scopeId, algorithmVersion: ALGORITHM_VERSION, startDate, endDate, chunkSize: 32 });
    // A cancel bumps the generation; a late scan result must not resurrect the
    // "scanning" state or overwrite the cancelled progress line.
    if (generation !== scanGeneration.current) return;
    if (!response.ok) showToast(response.error.message, 'error');
    else {
      setProgress(response.value);
      const loaded = await dedup.loadResult(id);
      if (generation !== scanGeneration.current) return;
      if (loaded.ok) setResult(loaded.value);
      else showToast(loaded.error.message, 'error');
    }
    setBusy(false);
  }

  async function cancelScan() {
    if (!sessionId) return;
    const response = await dedup.cancelScan(sessionId);
    if (!response.ok) showToast(response.error.message, 'error');
    else { scanGeneration.current += 1; setProgress((current) => current ? { ...current, status: 'cancelled', stage: 'cancelled' } : current); setBusy(false); }
  }

  async function toggleSelected(archiveId: string, checked: boolean) {
    if (!result) return;
    const next = new Set(result.selectedArchiveIds);
    if (checked) next.add(archiveId); else next.delete(archiveId);
    const response = await dedup.scanChunk({ sessionId: result.session.sessionId, algorithmVersion: result.session.algorithmVersion, checkpoint: result.session.checkpoint, archives: [], pairs: [], selectedArchiveIds: [...next] });
    if (!response.ok) { showToast(response.error.message, 'error'); return; }
    const loaded = await dedup.loadResult(result.session.sessionId);
    if (loaded.ok) setResult(loaded.value);
  }

  async function smartSelect() {
    if (!result) return;
    const selection = mergeSmartDuplicateSelection(groups, [], result.selectedArchiveIds, [], sourceByGroupKey);
    const response = await dedup.scanChunk({ sessionId: result.session.sessionId, algorithmVersion: result.session.algorithmVersion, checkpoint: result.session.checkpoint, archives: [], pairs: [], selectedArchiveIds: selection.archiveIds });
    // A failure here left the checkboxes exactly as they were and said nothing, so
    // the button looked like it had done its job.
    if (!response.ok) { showToast(response.error.message, 'error'); return; }
    const loaded = await dedup.loadResult(result.session.sessionId);
    if (loaded.ok) setResult(loaded.value);
    else showToast(loaded.error.message, 'error');
  }

  async function deleteSelected(syncFavorite: boolean) {
    if (!deleteSession) return;
    const sessionId = deleteSession.id;
    const response = await dedup.deleteSelected({ sessionId }, syncFavorite);
    if (!response.ok) throw new Error(response.error.message);
    if (response.value.rejectedArchiveIds.length) showToast('为保护重复组，部分档案未删除', 'error');
    else {
      const failed = response.value.outcomes.filter((outcome) => !outcome.deleted);
      showToast(failed.length ? `${failed.length} 个档案未删除：${failed[0]?.message ?? '请重试'}` : '删除任务已完成', failed.length ? 'error' : 'success');
    }
    if (response.value.outcomes.some((outcome) => outcome.deleted)) invalidateRouteCache();
    // Reload from the backend: keeping the stale selection would let a second
    // click re-issue deletes for archives that are already gone.
    const reloaded = await dedup.loadResult(sessionId);
    if (reloaded.ok) setResult(reloaded.value);
    else setResult((current) => current ? { ...current, outcomes: response.value.outcomes, selectedArchiveIds: [] } : current);
    if (server) {
      const refreshed = await library.listArchives(server.id);
      if (refreshed.ok) setArchives(refreshed.value);
    }
  }

  return <div className="workspace-stack dedup-workspace">
    {!embedded && <header className="workspace-heading"><div><span className="eyebrow">重复管理</span><h1>查重工作区</h1></div><CopyCheck aria-hidden="true" /></header>}
    <section className="toolbar-row" aria-label="查重设置">
      <label>服务器<SelectField name="dedupServer" aria-label="服务器" value={server?.id ?? ''} options={servers.map((item) => ({ value: item.id, label: item.name }))} onChange={(value) => setServer(servers.find((item) => item.id === value))} /></label>
      <DatePicker label="起始日期" value={startDate} onChange={setStartDate} />
      <DatePicker label="结束日期" value={endDate} onChange={setEndDate} />
      <button className="primary-action" type="button" disabled={!server || busy} onClick={() => void runScan()}><Play aria-hidden="true" />{busy ? '扫描中…' : '开始扫描'}</button>
      {busy && <button className="secondary-action" type="button" onClick={() => void cancelScan()}><X aria-hidden="true" />取消</button>}
      {progress?.status === 'cancelled' && <button className="secondary-action" type="button" onClick={() => void runScan(true)}><RefreshCw aria-hidden="true" />恢复</button>}
    </section>
    {progress && <div className="progress-line" role="status">{progress.stage} · {progress.processed}/{progress.total} · 命中 {progress.pairCount}{progress.degraded ? ' · 结果不完整' : ''}</div>}
    {deleteSession && <ArchiveDeletionConfirmation description={`将永久删除所选的 ${deleteSession.count} 个重复档案，此操作不可撤销。`} onClose={() => setDeleteSession(undefined)} onConfirm={deleteSelected} />}
    {result && <>
      <section className="toolbar-row dedup-filters"><label>来源<SelectField name="dedupSource" aria-label="来源" value={sourceFilter} options={[{ value: 'all', label: '全部来源' }, { value: 'image', label: '封面相似' }, { value: 'filename', label: '文件名' }]} onChange={(value) => setSourceFilter(value as typeof sourceFilter)} /></label><label>视图<SelectField name="dedupView" aria-label="视图" value={view} options={[{ value: 'groups', label: '重复组' }, { value: 'chains', label: '重复链' }]} onChange={(value) => setView(value as typeof view)} /></label><button className="secondary-action" type="button" onClick={() => void smartSelect()}><ShieldCheck aria-hidden="true" />智能选择</button><button className="danger-action" type="button" disabled={!selected.size || busy} onClick={() => setDeleteSession({ id: result.session.sessionId, count: selected.size })}><Trash2 aria-hidden="true" />删除所选</button></section>
      <ul className="dedup-groups" aria-label="重复结果">{visibleGroups.map((group, index) => <li className="dedup-group" key={`${index}-${group.map((item) => item.archiveId).join('-')}`}><div className="dedup-group-heading"><strong>重复组 {index + 1}</strong><span>{group.length} 项</span></div><ul>{group.map((archive) => <li key={archive.archiveId}><label><input type="checkbox" checked={selected.has(archive.archiveId)} onChange={(event) => void toggleSelected(archive.archiveId, event.target.checked)} /><span>{archive.title || archive.archiveId}</span><small>{archive.archiveId}</small></label>{selected.has(archive.archiveId) && <Check aria-hidden="true" />}</li>)}</ul>{group.length > 1 && <button className="icon-button" type="button" title="标记为不重复" aria-label="标记为不重复" onClick={() => server && void dedup.saveNonDuplicate({ scopeId: server.scopeId, leftArchiveId: group[0]!.archiveId, rightArchiveId: group[1]!.archiveId })}><X aria-hidden="true" /></button>}</li>)}</ul>
    </>}
    {!result && !busy && <p className="empty-state">尚未运行查重扫描。</p>}
  </div>;
}
