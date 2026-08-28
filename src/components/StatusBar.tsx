import { CircleDot, Database, ListTodo, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';

const repository = new NativeLibraryRepository();

export function StatusBar() {
  const [serverName, setServerName] = useState<string>();
  const [taskCount, setTaskCount] = useState(0);

  useEffect(() => {
    let active = true;
    void Promise.all([repository.listServers(), repository.listTasks()]).then(([servers, tasks]) => {
      if (!active) return;
      if (servers.ok) setServerName(servers.value[0]?.name);
      if (tasks.ok) setTaskCount(tasks.value.length);
    });
    return () => { active = false; };
  }, []);

  const statuses = [
    { label: '连接状态', icon: CircleDot, name: '连接', value: serverName ?? '未连接', tone: serverName ? 'success' : 'warning' },
    { label: '同步状态', icon: RefreshCw, name: '同步', value: '未配置', tone: 'muted' },
    { label: '任务状态', icon: ListTodo, name: '任务', value: String(taskCount), tone: taskCount > 0 ? 'active' : 'muted' },
    { label: '缓存状态', icon: Database, name: '缓存', value: '0 B', tone: 'muted' },
  ] as const;

  return (
    <footer className="status-bar" aria-label="系统状态">
      {statuses.map(({ label, icon: Icon, name, value, tone }) => (
        <div className={`status-item status-${tone}`} role="status" aria-label={label} key={label}>
          <Icon aria-hidden="true" />
          <span>{name}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </footer>
  );
}
