import { CloudDownload, FolderOpen, Play, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { onFileDrop } from '../bridge/fileDrop';
import { pickArchiveFiles } from '../bridge/filePicker';
import { pickServer } from '../domain/server';
import {
  appendUploadItems,
  parseUploadUrls,
  partitionUploadPaths,
  type UploadQueueItem,
} from '../domain/upload';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

function statusLabel(status: UploadQueueItem['status']): string {
  if (status === 'running') return '处理中';
  if (status === 'done') return '完成';
  if (status === 'failed') return '失败';
  return '等待';
}

/** Archive intake: local files or URLs the server downloads itself.
 *
 * Dropping is wired to the webview's own drag-and-drop events, not to HTML5
 * `ondrop`: Tauri handles drops natively, so the DOM events never fire and a
 * dropzone built on them does nothing at all. The native events are also the
 * only source of a real filesystem path, which is what the uploader needs.
 */
export function UploadPanel() {
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const serverParam = searchParams.get('server');
  const [mode, setMode] = useState<'local' | 'url'>('local');
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [urlText, setUrlText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState(false);

  const parsedUrls = useMemo(() => parseUploadUrls(urlText), [urlText]);
  const queued = items.filter((item) => item.status === 'queued');

  function addPaths(paths: readonly string[]) {
    const { accepted, rejected } = partitionUploadPaths(paths);
    if (accepted.length) setItems((current) => appendUploadItems(current, 'file', accepted));
    if (rejected.length) showToast(`已忽略 ${rejected.length} 个不支持的文件`, 'info');
  }

  useEffect(() => onFileDrop({
    onEnter: () => setDragging(true),
    onLeave: () => setDragging(false),
    onDrop: (paths) => { setDragging(false); setMode('local'); addPaths(paths); },
  }), []);

  async function pick() {
    setPicking(true);
    try {
      addPaths(await pickArchiveFiles());
    } finally {
      setPicking(false);
    }
  }

  function queueUrls() {
    if (parsedUrls.valid.length === 0) return;
    setItems((current) => appendUploadItems(current, 'url', parsedUrls.valid));
    // Only the lines that were queued leave the box, so a typo stays visible and
    // editable instead of vanishing with the rest.
    setUrlText((current) => current.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try { return !parsedUrls.valid.includes(new URL(trimmed).href); } catch { return true; }
    }).join('\n'));
  }

  function markItem(id: string, status: UploadQueueItem['status'], message?: string) {
    setItems((current) => current.map((item) => (item.id === id
      ? { ...item, status, ...(message === undefined ? {} : { message }) }
      : item)));
  }

  /** A failed item keeps its reason on its own row *and* says so once, out loud.
   * The row is easy to miss in a long queue, and a queue that quietly ends with
   * nothing uploaded is the one case someone needs told. */
  function fail(item: { id: string; label: string }, reason: string) {
    markItem(item.id, 'failed', reason);
    showToast(`${item.label}：${reason}`, 'error');
  }

  async function run() {
    if (running || queued.length === 0) return;
    setRunning(true);
    try {
      const servers = await repository.listServers();
      const server = servers.ok ? pickServer(servers.value, serverParam) : undefined;
      if (!server) {
        showToast(servers.ok ? '尚未配置服务器' : servers.error.message, 'error');
        return;
      }
      // One at a time: LANraragi extracts on receipt, and a parallel burst of
      // whole archives is the one way a client can knock it over.
      for (const item of queued) {
        markItem(item.id, 'running');
        if (item.kind === 'url') {
          const queuedJob = await repository.downloadUrl(server.id, item.source);
          if (queuedJob.ok) markItem(item.id, 'done', `服务器作业 #${queuedJob.value.job}`);
          else markItem(item.id, 'failed', queuedJob.error.message);
          continue;
        }
        const task = await repository.createTask({ kind: 'download', label: `上传 ${item.label}` });
        if (!task.ok) { markItem(item.id, 'failed', task.error.message); continue; }
        const uploaded = await repository.uploadArchive({ serverId: server.id, taskId: task.value.id, filePath: item.source });
        if (uploaded.ok) markItem(item.id, 'done', '已上传');
        else markItem(item.id, 'failed', uploaded.error.message);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-panel-title">
      <h2 className="sr-only" id="upload-panel-title">添加档案</h2>
      <div className="segmented-control upload-mode-tabs" role="tablist" aria-label="添加方式">
        <button type="button" role="tab" aria-selected={mode === 'local'} className={mode === 'local' ? 'is-active' : ''} onClick={() => setMode('local')}>
          <FolderOpen aria-hidden="true" />从本地添加
        </button>
        <button type="button" role="tab" aria-selected={mode === 'url'} className={mode === 'url' ? 'is-active' : ''} onClick={() => setMode('url')}>
          <CloudDownload aria-hidden="true" />从互联网添加
        </button>
      </div>

      {mode === 'local' ? (
        <div className={`upload-dropzone${dragging ? ' is-dragging' : ''}`}>
          <Upload aria-hidden="true" />
          <strong>{dragging ? '松手即加入队列' : '把压缩包拖到窗口，或点击选择'}</strong>
          <span>ZIP、CBZ、RAR、CBR、7Z、PDF</span>
          <button className="secondary-action" type="button" disabled={picking} aria-busy={picking} onClick={() => void pick()}>
            {picking ? '选择中…' : '选择文件'}
          </button>
        </div>
      ) : (
        <div className="upload-url-form">
          <label className="upload-url-label" htmlFor="upload-urls">要下载的链接（一行一个）</label>
          <textarea
            id="upload-urls"
            className="is-selectable"
            rows={6}
            spellCheck={false}
            value={urlText}
            placeholder={'https://example.com/g/123/abcdef\nhttps://example.com/g/456/fedcba'}
            onChange={(event) => setUrlText(event.target.value)}
          />
          <div className="upload-url-summary">
            <span>{parsedUrls.valid.length} 个有效链接</span>
            {parsedUrls.invalid.length > 0 && <span className="is-error">{parsedUrls.invalid.length} 个无法识别</span>}
            <button className="secondary-action" type="button" disabled={parsedUrls.valid.length === 0} onClick={queueUrls}>加入队列</button>
          </div>
          {/* The server picks the downloader, so there is no plugin to choose. */}
          <p className="upload-hint">链接交给 LANraragi 自己下载，由服务器决定使用哪个下载插件。</p>
        </div>
      )}

      <div className="upload-queue" aria-live="polite">
        <div className="upload-queue-heading">
          <h3>队列（{items.length}）</h3>
          <div className="upload-queue-actions">
            <button className="primary-action" type="button" disabled={running || queued.length === 0} aria-busy={running} onClick={() => void run()}>
              <Play aria-hidden="true" />{running ? '处理中…' : '开始处理'}
            </button>
            <button className="secondary-action" type="button" disabled={running || items.length === 0} onClick={() => setItems([])}>
              <Trash2 aria-hidden="true" />清空队列
            </button>
          </div>
        </div>
        {items.length === 0
          ? <p className="server-list-message">队列是空的。</p>
          : <ul className="upload-queue-list">
              {items.map((item) => (
                <li key={item.id} className={`upload-queue-row is-${item.status}`}>
                  <span className="upload-queue-label" title={item.source}>{item.label}</span>
                  <span className="upload-queue-status">{item.message ?? statusLabel(item.status)}</span>
                </li>
              ))}
            </ul>}
      </div>
    </section>
  );
}
