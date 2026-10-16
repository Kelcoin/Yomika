import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { usePageActive } from '../app/RetainedPage';
import { CircleDot, Database, ListTodo, LibraryBig } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { NativeLibraryRepository } from '../repositories/nativeLibraryRepository';
import { NativeSyncRepository } from '../repositories/nativeSyncRepository';
import { NativeCacheRepository } from '../repositories/nativeCacheRepository';
import { pickServer } from '../domain/server';

const repository = new NativeLibraryRepository();
const syncRepository = new NativeSyncRepository();
const cacheRepository = new NativeCacheRepository();

/** 缓存字节数跟着 `yomika:cache-changed` 重量的最小间隔。
 *
 * 那个事件每落一张封面、每读一页都会发一次，所以它是「一边刷图一边量缓存」的节奏；
 * 而缓存统计要扫整张 cache_entries（实测 19k 条 273ms），且要跟读者的翻页读取抢
 * 同一把全局库锁。字节数不是秒级指标，半分钟一次足够。
 */
const STATS_THROTTLE_MS = 30_000;

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
  const pageActive = usePageActive();
  const [archiveTotal, setArchiveTotal] = useState<number>();
  const [serverName, setServerName] = useState<string>();
  const [serverConnection, setServerConnection] = useState<'none' | 'online' | 'offline'>('none');
  const [taskCount, setTaskCount] = useState(0);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number>();
  const countedServer = useRef<string>();

  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    let pending = false;
    const refresh = () => {
      if (!active || pending || document.visibilityState === 'hidden') return;
      pending = true;
      void Promise.allSettled([repository.listServers(), repository.checkServerStatus(), repository.listTasks(), syncRepository.listAccounts()]).then(async ([serversState, statusState, tasksState, syncState]) => {
        if (!active) return;
        const servers = serversState.status === 'fulfilled' ? serversState.value : undefined;
        const statuses = statusState.status === 'fulfilled' ? statusState.value : undefined;
        const tasks = tasksState.status === 'fulfilled' ? tasksState.value : undefined;
        const syncAccounts = syncState.status === 'fulfilled' ? syncState.value : undefined;
        const configuredServer = servers?.ok ? pickServer(servers.value, undefined) : undefined;
        const serverStatus = statuses?.ok ? statuses.value.find((status) => status.serverId === configuredServer?.id) : undefined;
        if (serverStatus?.online) {
          setServerConnection('online');
          setServerName(serverStatus.name || configuredServer?.name);
        } else if (configuredServer) {
          setServerConnection('offline');
          setServerName(configuredServer.name);
        } else if (servers?.ok) {
          setServerConnection('none');
          setServerName(undefined);
        }
        // 只数没跑完的：任务行从不删除（完成的上传、下载都会留在表里），数到
        // 底就成了「这个应用一共做过多少件事」，而不是现在有几件在跑。
        if (tasks?.ok) setTaskCount(tasks.value.filter((task) => task.status === 'running' || task.status === 'queued' || task.status === 'paused').length);
        if (syncAccounts?.ok) setSyncConfigured(syncAccounts.value.length > 0);
        // The archive total comes from the local mirror's own index — one SQL
        // count, no LANraragi page request. It used to be published by whichever
        // LibraryWorkspace rendered last: the watchlist shelf (five rows)
        // overwrote the library's ten-thousand with its own size.
        if (configuredServer) {
          if (countedServer.current !== configuredServer.id) setArchiveTotal(undefined);
          countedServer.current = configuredServer.id;
          const page = await repository.listArchivesPage(configuredServer.id, 0, 1);
          if (active && page.ok) setArchiveTotal(page.value.total);
        } else if (servers?.ok) {
          countedServer.current = undefined;
          setArchiveTotal(undefined);
        }
      }).catch(() => {}).finally(() => { pending = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [pageActive]);

  useEffect(() => {
    if (!pageActive) return;
    let active = true;
    let reading = false;
    const refresh = () => {
      if (!active || reading || document.visibilityState === 'hidden') return;
      reading = true;
      void cacheRepository.stats().then((result) => {
        if (active && result.ok) setCacheBytes(result.value.bytes);
      }).catch(() => {}).finally(() => { reading = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh);
    // 封面一落缓存就触发一次这个事件：首屏几十张封面就是几十次 stats IPC。
    // 以前节流到一秒一次——那正好是「一边刷封面一边量缓存」的节奏，一次缓存统计
    // 在实测的库上要 273ms，而且它要跟读者的翻页读取抢同一把全局库锁。字节数不是
    // 秒级指标：半分钟一次、或者切回这个窗口时量一次就够。
    let lastStats = 0;
    let throttleTimer: number | undefined;
    let pending = false;
    const onCacheChanged = () => {
      pending = true;
      const now = Date.now();
      if (now - lastStats < STATS_THROTTLE_MS) {
        throttleTimer ??= window.setTimeout(() => {
          throttleTimer = undefined;
          if (pending) { pending = false; lastStats = Date.now(); refresh(); }
        }, STATS_THROTTLE_MS - (now - lastStats));
        return;
      }
      pending = false;
      lastStats = now;
      refresh();
    };
    window.addEventListener('yomika:cache-changed', onCacheChanged);
    return () => {
      active = false;
      window.clearInterval(timer);
      if (throttleTimer !== undefined) window.clearTimeout(throttleTimer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('yomika:cache-changed', onCacheChanged);
    };
  }, [pageActive]);

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
