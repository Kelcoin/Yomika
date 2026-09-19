import { ArchiveCardTags } from './CardTagRows';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, FileArchive, ListChecks, Pause, Play, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';

import { ArchiveThumbMedia } from './ArchiveThumbnailCard';
import { ArchiveDetailCover, ArchiveDetailFacts, ArchiveDetailTagSection, useArchiveCover, useDetailTagGroups, useTwoLineTitle } from './ArchiveDetailSections';
import { EmptyState } from './EmptyState';
import { SearchPresetField } from './SearchPresetField';
import { StatusLine } from './StatusLine';
import { TextInputDialog } from './TextInputDialog';
import { useToast } from './Toast';
import { usePageActive } from '../app/RetainedPage';
import { writeClipboardText } from '../bridge/clipboard';
import type { LocalArchiveRecord, TaskRecord } from '../domain/library';
import { CARD_TAG_LIMIT_WIDE, archiveCategoryKey, archiveCategoryLabel, archiveLanguageLabel, formatArchiveDate, formatByteSize } from '../lib/archiveCardPresentation';
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

export function LocalArchivesWorkspace() {
  const pageActive = usePageActive();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [archives, setArchives] = useState<LocalArchiveRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [presets, setPresets] = useState<SearchPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string>();
  const [presetDialog, setPresetDialog] = useState<{ preset?: SearchPreset } | undefined>();

  const openPath = searchParams.get('path');
  const unfinished = tasks.some((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused');

  const loadArchives = useCallback(async () => {
    const result = await repository.listLocalArchives();
    if (!result.ok) { setError(result.error.message); return; }
    setError(undefined);
    setArchives(result.value);
  }, []);

  // 本地档案是磁盘的镜像，下载跑完才会多一份：任务列表每次落地都重读一次。
  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      void repository.listTasks().then((result) => {
        if (!active || !result.ok) return;
        setTasks(result.value);
        setLoading(false);
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
  }, [pageActive, unfinished]);

  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    void (async () => {
      const [presetResult] = await Promise.all([repository.listSearchPresets(LOCAL_PRESET_SCOPE)]);
      if (!active) return;
      if (presetResult.ok) setPresets(presetResult.value);
      await loadArchives();
    })();
    return () => { active = false; };
  }, [pageActive, loadArchives]);

  // 没有下载在跑 = 上一次的落地已经写完了，档案列表可能多了一份。
  const settled = !unfinished;
  useEffect(() => {
    if (!pageActive || !settled) return;
    void loadArchives();
  }, [pageActive, settled, loadArchives]);

  const activeDownloads = useMemo(
    () => tasks.filter(isActiveDownload).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [tasks],
  );

  const visibleArchives = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return archives;
    return archives.filter((archive) => `${archive.title} ${archive.path} ${archive.tags.join(' ')}`.toLowerCase().includes(needle));
  }, [archives, query]);

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

  async function removeSelected() {
    const paths = [...selected];
    if (paths.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await repository.deleteLocalArchives(paths);
      if (!result.ok) { showToast(result.error.message, 'error'); return; }
      showToast(`已从本地删除 ${result.value} 个档案`, 'success');
      setSelected(new Set());
      setConfirmingDelete(false);
      if (openPath && paths.includes(openPath)) closeDetail();
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
        {/* 多选紧挨着预设按钮，和档案库的工具栏收起来时同一个位置。 */}
        <button
          className="icon-action library-select-toggle"
          type="button"
          aria-pressed={selectionMode}
          aria-label={selectionMode ? '退出多选' : '多选'}
          title={selectionMode ? '退出多选' : '多选'}
          onClick={() => {
            setSelectionMode((current) => !current);
            setSelected(new Set());
          }}
        >
          <ListChecks aria-hidden="true" />
        </button>
      </div>
      {selectionMode && (
        <div className="archive-selection-slot">
          <div className="archive-selection-bar" role="toolbar" aria-label="多选操作">
            <span className="archive-selection-count" role="status" aria-live="polite">已选 {selected.size} 个</span>
            <button className="secondary-action" type="button" disabled={visibleArchives.length === 0} onClick={toggleAll}>
              {selectAll ? '取消全选' : '全选当前'}
            </button>
            <button className="secondary-action is-danger" type="button" disabled={selected.size === 0 || busy} onClick={() => setConfirmingDelete(true)}>
              删除所选
            </button>
            <button className="secondary-action archive-selection-done" type="button" onClick={() => { setSelectionMode(false); setSelected(new Set()); }}>
              完成
            </button>
          </div>
        </div>
      )}
      {loading && <StatusLine busy>正在读取本地档案…</StatusLine>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && activeDownloads.length === 0 && visibleArchives.length === 0 && !error && (
        <EmptyState
          icon={Download}
          title={query ? '没有匹配的档案' : '还没有下载过档案'}
          description={query ? '换个关键词试试。' : '右键档案卡片选「下载档案」，进度和文件都会出现在这里。'}
        />
      )}
      {(activeDownloads.length > 0 || visibleArchives.length > 0) && (
        /* `archive-list is-wide`：这一页的行就是档案库的宽行。行高、封面框、文案
           三格和标签瀑布全部由那一套规则给，本地档案只多写「行里写什么」。 */
        <div className="archive-list is-wide local-archives-list">
          {activeDownloads.map((task) => (
            <article className="archive-row is-downloading" key={task.id}>
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
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-label={`暂停${downloadTitle(task)}`} title="暂停" onClick={() => void control(task, 'pause')}><Pause aria-hidden="true" /></button>
                )}
                {(task.status === 'paused' || task.status === 'failed') && (
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-label={`${task.status === 'failed' ? '重试' : '恢复'}${downloadTitle(task)}`} title={task.status === 'failed' ? '重试' : '恢复'} onClick={() => void control(task, 'resume')}><Play aria-hidden="true" /></button>
                )}
                <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-label={`中止${downloadTitle(task)}`} title="中止" onClick={() => void control(task, 'cancel')}><X aria-hidden="true" /></button>
              </div>
            </article>
          ))}
          {visibleArchives.map((archive) => {
            const isSelected = selected.has(archive.path);
            const category = archiveCategoryLabel(archive) || archiveLanguageLabel(archive);
            return (
              <button
                type="button"
                key={archive.path}
                className={`archive-row${isSelected ? ' is-selected' : ''}${openPath === archive.path ? ' is-active' : ''}`}
                {...(selectionMode
                  ? { role: 'checkbox', 'aria-checked': isSelected, 'aria-label': `选择 ${archive.title}` }
                  : { 'aria-pressed': openPath === archive.path })}
                onClick={() => { if (selectionMode) toggleOne(archive.path); else openArchive(archive); }}
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
          })}
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
        onConfirm={(name) => {
          const preset = presetDialog?.preset;
          void repository.saveSearchPreset({
            scopeId: LOCAL_PRESET_SCOPE,
            presetId: preset?.presetId ?? `preset-${Date.now()}`,
            name,
            query: preset?.query ?? query,
            sortBy: 'title',
            sortOrder: 'asc',
            categoryId: null,
          }).then((result) => {
            if (!result.ok) { showToast(result.error.message, 'error'); return; }
            setPresets((current) => [...current.filter((item) => item.presetId !== result.value.presetId), result.value]);
            showToast(preset ? '预设已重命名' : '预设已保存', 'success');
            setPresetDialog(undefined);
          });
        }}
      />
      {confirmingDelete && (
        <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) setConfirmingDelete(false); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog-content local-delete-dialog">
              <Dialog.Title>删除本地档案</Dialog.Title>
              <Dialog.Description>
                将从磁盘删除选中的 {selected.size} 个文件，服务器上的档案不受影响。此操作不可撤销。
              </Dialog.Description>
              <div className="dialog-actions">
                <button className="secondary-action" type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}>取消</button>
                <button className="primary-action" type="button" disabled={busy} onClick={() => void removeSelected()}><Trash2 aria-hidden="true" />{busy ? '删除中…' : '确认删除'}</button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );

  if (!detail) return list;
  return (
    <Group className="library-shell has-detail" orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="local-archives-list" defaultSize="58" minSize="40">
        <section className="library-shell-list">{list}</section>
      </Panel>
      <Separator className="panel-separator" />
      <Panel className="library-shell-panel-content" style={{ height: '100%', overflow: 'hidden' }} id="local-archives-detail" defaultSize="42" minSize="30">
        <section className="library-shell-detail" data-scroll-region>
          <LocalArchiveDetail
            archive={detail}
            onClose={closeDetail}
            onDelete={() => { setSelected(new Set([detail.path])); setConfirmingDelete(true); }}
            onSelectTag={(query) => { setDraft(query); setQuery(query); }}
          />
        </section>
      </Panel>
    </Group>
  );
}

/** 右侧那一页：这份本地文件的实情。渲染的是档案详情页的同一批分区——标题、封面、
 * 事实网格、按命名空间分组的标签墙，类名也一样，所以两边的长相和标签顺序不会各自
 * 漂移。差别只有内容：这一页说的是磁盘上的事（大小、下载时间、路径），动作也只有
 * 复制路径和本地删除。 */
function LocalArchiveDetail({ archive, onClose, onDelete, onSelectTag }: {
  archive: LocalArchiveRecord;
  onClose: () => void;
  onDelete: () => void;
  onSelectTag: (query: string) => void;
}) {
  const { showToast } = useToast();
  const { groups, colorFor } = useDetailTagGroups(archive.tags);
  const { cover, loading: coverLoading } = useArchiveCover({
    scopeId: archive.scopeId ?? undefined,
    serverId: archive.serverId ?? undefined,
    archiveId: archive.archiveId ?? undefined,
  });
  const titleRef = useTwoLineTitle(archive.title);
  const facts = [
    { kind: 'size' as const, label: '体积', value: formatByteSize(archive.fileSize) },
    { kind: 'added' as const, label: '下载时间', value: formatArchiveDate(Math.floor(archive.addedAt / 1000)) || '未知' },
    { kind: 'pages' as const, label: '页数', value: archive.pageCount ? `${archive.pageCount} 页` : '未知' },
    { kind: 'path' as const, label: '路径', value: archive.path },
  ];

  return (
    <main className="archive-detail-route" aria-labelledby="local-archive-title">
      <header className="archive-detail-route-header">
        <h1 id="local-archive-title" className="archive-detail-route-title" ref={titleRef}>{archive.title}</h1>
        <button type="button" className="reader-icon-button" aria-label="关闭详情" title="关闭" onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="archive-detail-overview">
        <ArchiveDetailCover title={archive.title} cover={cover} loading={coverLoading} />
        <div className="archive-detail-overview-copy">
          <ArchiveDetailFacts facts={facts} />
        </div>
      </div>
      <div className="archive-detail-route-actions" role="toolbar" aria-label="本地档案操作">
        <button
          type="button"
          className="secondary-action"
          onClick={() => void writeClipboardText(archive.path).then(
            () => showToast('路径已复制', 'success'),
            () => showToast('复制失败', 'error'),
          )}
        >
          复制路径
        </button>
        <button type="button" className="secondary-action is-danger" onClick={onDelete}>
          <Trash2 aria-hidden="true" />本地删除
        </button>
      </div>
      {/* 标签芯片照存档详情那一套排（My Tags 优先、按命名空间分组），点下去筛的是这一页
          的列表：本地档案的标签来自下载时抓下的元数据，不去档案库搜。 */}
      <ArchiveDetailTagSection groups={groups} colorFor={colorFor} onSelect={(tag) => onSelectTag(tag.query.replace(/\$$/, ''))} />
    </main>
  );
}
