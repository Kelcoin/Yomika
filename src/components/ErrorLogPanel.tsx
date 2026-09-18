import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { pickSavePath } from '../bridge/filePicker';
import { flushErrorLog } from '../lib/errorLog';
import { NativeErrorLogRepository, type ErrorLogEntry } from '../repositories/nativeErrorLogRepository';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';

const repository = new NativeErrorLogRepository();

/** 后端 panic 写的是 `epoch:<毫秒>`，前端给的是 ISO；两种都认。 */
function formatEntryTime(value: string): string {
  const epoch = /^epoch:(\d+)$/.exec(value.trim());
  const at = epoch ? new Date(Number(epoch[1])) : new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface ErrorLogState {
  entries: ErrorLogEntry[] | undefined;
  busy: boolean;
  exporting: boolean;
  reload: () => Promise<void>;
  exportLog: () => Promise<void>;
}

/** 错误日志的数据与动作：这一次运行里，应用自己记下的失败。
 *
 * 每次启动清空（见 `src-tauri/src/error_log.rs`），所以这里看到的永远是「本次
 * 运行」。状态放在调用方而不是菜单里：和其它设置项一样，行上要显示当前状态
 * （几条），而菜单只在打开时才挂载。 */
export function useErrorLog(): ErrorLogState {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<ErrorLogEntry[]>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    // 刚刚发生的失败可能还在缓冲区里：读之前先落盘，列表才是完整的。
    await flushErrorLog();
    const response = await repository.list();
    setBusy(false);
    if (response.ok) setEntries(response.value);
    else showToast(response.error.message, 'error');
  }, [showToast]);

  useEffect(() => { void reload(); }, [reload]);

  const exportLog = useCallback(async () => {
    setExporting(true);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const path = await pickSavePath(`yomika-error-${stamp}.log`);
      if (!path) return;
      await flushErrorLog();
      const response = await repository.exportTo(path);
      showToast(response.ok ? `错误日志已导出到 ${path}` : response.error.message, response.ok ? 'success' : 'error');
    } finally {
      setExporting(false);
    }
  }, [showToast]);

  return { entries, busy, exporting, reload, exportLog };
}

/** 菜单里的内容：一行状态加两个动作，下面是按时间倒序的记录。
 *
 * 外层是设置菜单自己的面板（`.settings-choice-panel`）——它就是这块的框，所以
 * 这里不再套第二层。 */
export function ErrorLogPanel({ state }: { state: ErrorLogState }) {
  const { entries, busy, exporting, reload, exportLog } = state;
  return <div className="error-log-panel">
    <div className="error-log-toolbar">
      {entries === undefined
        ? <StatusLine busy>正在读取…</StatusLine>
        : <p className="error-log-summary">{entries.length === 0 ? '本次运行还没有记录到错误。' : `本次运行记录到 ${entries.length} 条。`}</p>}
      <div className="error-log-actions">
        <button className="secondary-action" type="button" disabled={busy} aria-busy={busy} onClick={() => void reload()}>
          <RefreshCw aria-hidden="true" />刷新
        </button>
        <button className="primary-action" type="button" disabled={exporting || !entries?.length} onClick={() => void exportLog()}>
          <Download aria-hidden="true" />导出
        </button>
      </div>
    </div>
    {entries && entries.length > 0 && <ul className="error-log-list" aria-label="错误记录">
      {entries.slice().reverse().map((entry, index) => <li key={`${entry.at}-${index}`} className={`error-log-entry is-${entry.level === 'warn' ? 'warn' : 'error'}`}>
        <div className="error-log-meta">
          <span className="error-log-time">{formatEntryTime(entry.at)}</span>
          <span className="error-log-source" title={entry.source}>{entry.source}</span>
        </div>
        {/* 消息与明细是 div 不是 p：这里要的是「消息最亮、明细次之」的层次，
            而外面给 p 的正文字号会把它盖掉。 */}
        <div className="error-log-message">{entry.message}</div>
        {entry.detail && <div className="error-log-detail">{entry.detail}</div>}
      </li>)}
    </ul>}
  </div>;
}
