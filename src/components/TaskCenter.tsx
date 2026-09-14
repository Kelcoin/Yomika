import { useEffect, useState } from 'react';
import { Download, Pause, Play, RotateCcw, X } from 'lucide-react';

import { EmptyState } from './EmptyState';

import type { TaskRecord } from '../domain/library';
import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { useToast } from './Toast';

const repository = new NativeLibraryRepository();

export function TaskCenter() {
  const { showToast } = useToast();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pendingTaskId, setPendingTaskId] = useState<string>();

  // Failures reach the toast as well as the page: this panel can be scrolled out
  // of view, embedded in another page, or replaced by what the user did next, and
  // an error nobody saw is an error nobody can act on.
  useEffect(() => {
    if (error) showToast(error, 'error');
  }, [error, showToast]);

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

  async function act(task: TaskRecord, action: 'retry' | 'pause' | 'resume' | 'cancel') {
    setError(undefined);
    setPendingTaskId(task.id);
    try {
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
    } finally {
      setPendingTaskId(undefined);
    }
  }

  return (
    <div className="task-center">
      <h1 className="visually-hidden">下载</h1>
      {loading && <p className="server-list-message" role="status">正在读取任务…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && tasks.length === 0 && (
        <EmptyState icon={Download} title="暂无下载任务" description="开始下载后，任务和进度会显示在这里。" />
      )}
      {!loading && !error && tasks.length > 0 && (
        <section className="task-list" aria-label="任务列表">
          {tasks.map((task) => (
            <article className="task-row" key={task.id}>
              <div className="task-summary">
                <strong>{task.label}</strong>
                <small className={`status-chip ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</small>
              </div>
              <progress aria-label={`${task.label}进度`} max="100" value={Math.round(task.progress * 100)} />
              <span className="task-progress">{Math.round(task.progress * 100)}%</span>
              <div className="task-actions">
                {task.status === 'failed' && task.retryable && (
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-busy={pendingTaskId === task.id} aria-label={`重试${task.label}`} title="重试" onClick={() => void act(task, 'retry')}><RotateCcw aria-hidden="true" /></button>
                )}
                {task.status === 'running' && (
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-busy={pendingTaskId === task.id} aria-label={`暂停${task.label}`} title="暂停" onClick={() => void act(task, 'pause')}><Pause aria-hidden="true" /></button>
                )}
                {task.status === 'paused' && (
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-busy={pendingTaskId === task.id} aria-label={`恢复${task.label}`} title="恢复" onClick={() => void act(task, 'resume')}><Play aria-hidden="true" /></button>
                )}
                {task.cancelable && ['queued', 'running', 'paused'].includes(task.status) && (
                  <button type="button" className="icon-button" disabled={pendingTaskId === task.id} aria-busy={pendingTaskId === task.id} aria-label={`取消${task.label}`} title="取消" onClick={() => void act(task, 'cancel')}><X aria-hidden="true" /></button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function taskStatusLabel(status: TaskRecord['status']): string {
  if (status === 'queued') return '等待中';
  if (status === 'running') return '进行中';
  if (status === 'paused') return '已暂停';
  if (status === 'completed') return '已完成';
  if (status === 'failed') return '失败';
  return '已取消';
}

function taskStatusClass(status: TaskRecord['status']): string {
  if (status === 'failed' || status === 'cancelled') return 'status-chip-danger';
  if (status === 'completed') return 'status-chip-success';
  if (status === 'running') return 'status-chip-active';
  if (status === 'paused') return 'status-chip-warning';
  return 'status-chip-neutral';
}
