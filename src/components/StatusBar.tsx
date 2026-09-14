import { CircleDot, Database, ListTodo, LibraryBig, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';

const repository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();
const cacheRepository = new NativeCacheRepository();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function StatusBar() {
  const [archiveTotal, setArchiveTotal] = useState<number>();
  const [serverName, setServerName] = useState<string>();
  const [serverConnection, setServerConnection] = useState<'none' | 'online' | 'offline'>('none');
  const [taskCount, setTaskCount] = useState(0);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number>();

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void Promise.allSettled([repository.listServers(), repository.checkServerStatus(), repository.listTasks(), syncRepository.listAccounts()]).then(([serversState, statusState, tasksState, syncState]) => {
        if (!active) return;
        const servers = serversState.status === 'fulfilled' ? serversState.value : undefined;
        const statuses = statusState.status === 'fulfilled' ? statusState.value : undefined;
        const tasks = tasksState.status === 'fulfilled' ? tasksState.value : undefined;
        const syncAccounts = syncState.status === 'fulfilled' ? syncState.value : undefined;
        const configuredServer = servers?.ok ? servers.value[0] : undefined;
        const serverStatus = statuses?.ok ? statuses.value[0] : undefined;
        if (serverStatus?.online) {
          setServerConnection('online');
          setServerName(serverStatus.name || configuredServer?.name);
        } else if (configuredServer) {
          setServerConnection('offline');
          setServerName(configuredServer.name);
        } else {
          setServerConnection('none');
          setServerName(undefined);
        }
        if (tasks?.ok) setTaskCount(tasks.value.length);
        if (syncAccounts?.ok) setSyncConfigured(syncAccounts.value.length > 0);
        // The archive total comes from the local mirror's own index — one SQL
        // count, no LANraragi page request. It used to be published by whichever
        // LibraryWorkspace rendered last: the watchlist shelf (five rows)
        // overwrote the library's ten-thousand with its own size.
        if (configuredServer) {
          void repository.listArchivesPage(configuredServer.id, 0, 1).then((page) => {
            if (active && page.ok) setArchiveTotal(page.value.total);
          }).catch(() => {});
        }
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void cacheRepository.stats().then((result) => {
        if (active && result.ok) setCacheBytes(result.value.bytes);
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('yomika:cache-changed', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('yomika:cache-changed', refresh);
    };
  }, []);

  const statuses = [
    { label: '连接状态', icon: CircleDot, name: '连接', value: serverConnection === 'online' ? (serverName ?? '在线') : serverConnection === 'offline' ? '离线' : '未连接', tone: serverConnection === 'online' ? 'success' : 'warning' },
    { label: '同步状态', icon: RefreshCw, name: '同步', value: syncConfigured ? '已配置' : '未配置', tone: syncConfigured ? 'success' : 'muted' },
    { label: '任务状态', icon: ListTodo, name: '任务', value: String(taskCount), tone: taskCount > 0 ? 'active' : 'muted' },
    { label: '缓存状态', icon: Database, name: '缓存', value: formatBytes(cacheBytes ?? 0), tone: cacheBytes ? 'active' : 'muted' },
  ] as const;

  // Not gated on the library route: the count belongs with the server it was
  // read from, the same as tasks and cache.
  const showArchiveTotal = archiveTotal !== undefined;
  const items = statuses.flatMap((status) => {
    const entries: Array<{ label: string; icon: typeof CircleDot; name: string; value: string; tone: string }> = [{ ...status }];
    // The archive count sits beside the server it was read from.
    if (status.label === '连接状态' && showArchiveTotal) {
      entries.push({ label: '档案数量', icon: LibraryBig, name: '档案', value: `${archiveTotal} 项`, tone: 'muted' });
    }
    return entries;
  });

  return (
    <footer className="status-bar" aria-label="系统状态">
      {items.map(({ label, icon: Icon, name, value, tone }) => (
        <div className={`status-item status-${tone}`} role="status" aria-label={label} key={label}>
          <Icon aria-hidden="true" />
          <span>{name}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </footer>
  );
}
