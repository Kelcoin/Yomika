import { useEffect, useMemo, useState } from 'react';
import { Check, CopyCheck, Download, Play, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { ArchiveRecord, ServerRecord } from '../domain/library';
import { mergeSmartDuplicateSelection, getDedupeGroupFilterData, type DuplicateSource } from '../domain/deduplication';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeDedupRepository, type DedupLoadResult, type DedupScanProgress } from '../repositories/nativeDedupRepository';
import { parseReadoshiNonDuplicateExport } from '../lib/readoShiDedupeImport';
import { useToast } from './Toast';

const library = new NativeLibraryRepository();
const dedup = new NativeDedupRepository();
const ALGORITHM_VERSION = 'readoshi-v1';

export function DeduplicationWorkspace() {
  const { showToast } = useToast();
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [server, setServer] = useState<ServerRecord>();
  const [archives, setArchives] = useState<ArchiveRecord[]>([]);
  const [progress, setProgress] = useState<DedupScanProgress>();
  const [result, setResult] = useState<DedupLoadResult>();
  const [sessionId, setSessionId] = useState<string>();
  const [startDate, setStartDate] = useState('2000-01-01');
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sourceFilter, setSourceFilter] = useState<'all' | DuplicateSource>('all');
  const [view, setView] = useState<'groups' | 'chains'>('groups');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);

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
    setBusy(true);
    const id = resume && sessionId ? sessionId : `dedup-${Date.now()}`;
    setSessionId(id);
    const response = await dedup.scan({ sessionId: id, scopeId: server.scopeId, algorithmVersion: ALGORITHM_VERSION, startDate, endDate, chunkSize: 32 });
    if (!response.ok) showToast(response.error.message, 'error');
    else {
      setProgress(response.value);
      const loaded = await dedup.loadResult(id);
      if (loaded.ok) setResult(loaded.value);
      else showToast(loaded.error.message, 'error');
    }
    setBusy(false);
  }

  async function cancelScan() {
    if (!sessionId) return;
    const response = await dedup.cancelScan(sessionId);
    if (!response.ok) showToast(response.error.message, 'error');
    else { setProgress((current) => current ? { ...current, status: 'cancelled', stage: 'cancelled' } : current); setBusy(false); }
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
    if (response.ok) { const loaded = await dedup.loadResult(result.session.sessionId); if (loaded.ok) setResult(loaded.value); }
  }

  async function deleteSelected() {
    if (!result || selected.size === 0 || !window.confirm('确认删除已选择的重复档案？')) return;
    const response = await dedup.deleteSelected({ sessionId: result.session.sessionId });
    if (!response.ok) showToast(response.error.message, 'error');
    else { if (response.value.rejectedArchiveIds.length) showToast('为保护重复组，部分档案未删除', 'error'); else showToast('删除任务已完成', 'success'); setResult((current) => current ? { ...current, outcomes: response.value.outcomes } : current); }
  }

  async function importReadoshi() {
    if (!server || !importText.trim()) return;
    try {
      const parsed = parseReadoshiNonDuplicateExport(importText, server.scopeId);
      const response = await dedup.importReadoshi({ scopeId: server.scopeId, pairs: parsed.pairs });
      if (!response.ok) showToast(response.error.message, 'error');
      else { setImportText(''); showToast(`已导入 ${parsed.pairs.length} 条不重复关系`, 'success'); }
    } catch (error) { showToast(error instanceof Error ? error.message : '导入失败', 'error'); }
  }

  return <div className="workspace-stack dedup-workspace">
    <header className="workspace-heading"><div><span className="eyebrow">重复管理</span><h1>查重工作区</h1></div><CopyCheck aria-hidden="true" /></header>
    <section className="toolbar-row" aria-label="查重设置">
      <label>服务器<select value={server?.id ?? ''} onChange={(event) => setServer(servers.find((item) => item.id === event.target.value))}>{servers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>起始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
      <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
      <button className="primary-action" type="button" disabled={!server || busy} onClick={() => void runScan()}><Play aria-hidden="true" />{busy ? '扫描中…' : '开始扫描'}</button>
      {busy && <button className="secondary-action" type="button" onClick={() => void cancelScan()}><X aria-hidden="true" />取消</button>}
      {progress?.status === 'cancelled' && <button className="secondary-action" type="button" onClick={() => void runScan(true)}><RefreshCw aria-hidden="true" />恢复</button>}
    </section>
    {progress && <div className="progress-line" role="status">{progress.stage} · {progress.processed}/{progress.total} · 命中 {progress.pairCount}{progress.degraded ? ' · 结果不完整' : ''}</div>}
    <section className="dedup-import panel"><div className="section-heading"><h2>导入 Readoshi 不重复关系</h2><Download aria-hidden="true" /></div><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴 JSON 导出内容" rows={3} /><button className="secondary-action" type="button" disabled={!server || !importText.trim()} onClick={() => void importReadoshi()}><Download aria-hidden="true" />导入</button></section>
    {result && <>
      <section className="toolbar-row dedup-filters"><label>来源<select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}><option value="all">全部来源</option><option value="image">封面相似</option><option value="filename">文件名</option></select></label><label>视图<select value={view} onChange={(event) => setView(event.target.value as typeof view)}><option value="groups">重复组</option><option value="chains">重复链</option></select></label><button className="secondary-action" type="button" onClick={() => void smartSelect()}><ShieldCheck aria-hidden="true" />智能选择</button><button className="danger-action" type="button" disabled={!selected.size} onClick={() => void deleteSelected()}><Trash2 aria-hidden="true" />删除所选</button></section>
      <ul className="dedup-groups" aria-label="重复结果">{visibleGroups.map((group, index) => <li className="dedup-group" key={`${index}-${group.map((item) => item.archiveId).join('-')}`}><div className="dedup-group-heading"><strong>重复组 {index + 1}</strong><span>{group.length} 项</span></div><ul>{group.map((archive) => <li key={archive.archiveId}><label><input type="checkbox" checked={selected.has(archive.archiveId)} onChange={(event) => void toggleSelected(archive.archiveId, event.target.checked)} /><span>{archive.title || archive.archiveId}</span><small>{archive.archiveId}</small></label>{selected.has(archive.archiveId) && <Check aria-hidden="true" />}</li>)}</ul>{group.length > 1 && <button className="icon-button" type="button" title="标记为不重复" aria-label="标记为不重复" onClick={() => server && void dedup.saveNonDuplicate({ scopeId: server.scopeId, leftArchiveId: group[0]!.archiveId, rightArchiveId: group[1]!.archiveId })}><X aria-hidden="true" /></button>}</li>)}</ul>
    </>}
    {!result && !busy && <p className="empty-state">尚未运行查重扫描。</p>}
  </div>;
}
