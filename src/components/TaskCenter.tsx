import { useEffect, useState } from 'react';
import { Pause, Play, RotateCcw, X } from 'lucide-react';

import type { TaskRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { pickArchiveFile } from '../bridge/filePicker';

const repository = new NativeLibraryRepository();

export function TaskCenter() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let active = true;
    void repository.listTasks().then((result) => {
      if (!active) return;
      if (result.ok) setTasks(result.value);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function upload() {
    setError(undefined);
    setMessage(undefined);
    const filePath = await pickArchiveFile();
    if (!filePath) return;
    const servers = await repository.listServers();
    if (!servers.ok || !servers.value[0]) {
      setError(servers.ok ? '尚未配置服务器' : servers.error.message);
      return;
    }
    const filename = filePath.split(/[\\/]/).pop() ?? filePath;
    const created = await repository.createTask({ kind: 'download', label: `上传 ${filename}` });
    if (!created.ok) {
      setError(created.error.message);
      return;
    }
    const uploaded = await repository.uploadArchive({ serverId: servers.value[0].id, taskId: created.value.id, filePath });
    if (!uploaded.ok) {
      setError(uploaded.error.message);
      return;
    }
    setMessage('上传完成');
    const refreshed = await repository.listTasks();
    if (refreshed.ok) setTasks(refreshed.value);
  }

  async function act(task: TaskRecord, action: 'retry' | 'pause' | 'resume' | 'cancel') {
    setError(undefined);
    const result = action === 'retry'
      ? await repository.retryTask(task.id)
      : await repository.updateTask(task.id, {
        status: action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled',
      });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setTasks((current) => current.map((item) => item.id === result.value.id ? result.value : item));
  }

  return (
    <div>
      <header className="workspace-heading"><h1>下载</h1></header>
      <button className="primary-action" type="button" onClick={() => void upload()}>上传档案</button>
      {message && <p role="status">{message}</p>}
      {loading && <p className="server-list-message" role="status">正在读取任务…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && tasks.length === 0 && <p>暂无下载任务</p>}
      {!loading && !error && tasks.length > 0 && (
        <section aria-label="任务列表">
          {tasks.map((task) => (
            <article key={task.id}>
              <strong>{task.label}</strong>
              <span>{Math.round(task.progress * 100)}%</span>
              <small>{task.status}</small>
              <div className="task-actions">
                {task.status === 'failed' && task.retryable && (
                  <button type="button" className="icon-button" aria-label={`重试${task.label}`} title="重试" onClick={() => void act(task, 'retry')}><RotateCcw aria-hidden="true" /></button>
                )}
                {task.status === 'running' && (
                  <button type="button" className="icon-button" aria-label={`暂停${task.label}`} title="暂停" onClick={() => void act(task, 'pause')}><Pause aria-hidden="true" /></button>
                )}
                {task.status === 'paused' && (
                  <button type="button" className="icon-button" aria-label={`恢复${task.label}`} title="恢复" onClick={() => void act(task, 'resume')}><Play aria-hidden="true" /></button>
                )}
                {task.cancelable && ['queued', 'running', 'paused'].includes(task.status) && (
                  <button type="button" className="icon-button" aria-label={`取消${task.label}`} title="取消" onClick={() => void act(task, 'cancel')}><X aria-hidden="true" /></button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
