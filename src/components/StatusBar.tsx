import { CircleDot, Database, ListTodo, RefreshCw } from 'lucide-react';

const statuses = [
  { label: '连接状态', icon: CircleDot, name: '连接', value: '未连接', tone: 'warning' },
  { label: '同步状态', icon: RefreshCw, name: '同步', value: '未配置', tone: 'muted' },
  { label: '任务状态', icon: ListTodo, name: '任务', value: '0', tone: 'muted' },
  { label: '缓存状态', icon: Database, name: '缓存', value: '0 B', tone: 'muted' },
] as const;

export function StatusBar() {
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
