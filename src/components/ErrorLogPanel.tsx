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

/** 面板顶上那一行：上次运行留下的记录单独说，别混进「本次运行」的计数里——它们恰恰是最
 * 要紧的（闪退现场就在里头），看到的第一眼就该知道那不是这次的。 */
function summaryOf(entries: ErrorLogEntry[]): string {
  const carried = entries.filter((entry) => entry.source.startsWith(LAST_RUN_PREFIX)).length;
  const current = entries.length - carried;
  if (entries.length === 0) return '本次与上次运行都没有记录到错误。';
  if (current === 0) return `上次运行记录到 ${carried} 条，本次还没有。`;
  if (carried === 0) return `本次运行记录到 ${current} 条。`;
  return `本次运行 ${current} 条，上次运行 ${carried} 条。`;
}

/** 与原生侧 `read_buckets` 拼的是同一个前缀。 */
const LAST_RUN_PREFIX = '上次运行 · ';

/** 导出的是**用户眼前这一份**：同一批条目、同一套时间格式。之前是原生侧再拼一个版本
 * （复制源文件、有崩溃记录就合并），两次拼装走散的结果就是「导出的日志是空的」。 */
function exportText(entries: ErrorLogEntry[]): string {
  const lines = [
    '# Yomika 错误日志',
    `# 导出时间：${formatEntryTime(new Date().toISOString())}`,
    `# 共 ${entries.length} 条，本次运行在上、上次运行在下`,
    '',
  ];
  for (const entry of entries) {
    lines.push(`${formatEntryTime(entry.at)}  ${entry.level}  ${entry.source}`, `  ${entry.message}`);
    // 明细可能是多行的（Java 栈、命令行），缩进四格让它读起来还是「这条的附注」。
    if (entry.detail) lines.push(...entry.detail.split('\n').map((line) => `    ${line}`));
  }
  return lines.join('\n') + '\n';
}

export interface ErrorLogState {
  entries: ErrorLogEntry[] | undefined;
  busy: boolean;
  exporting: boolean;
  reload: () => Promise<void>;
  exportLog: () => Promise<void>;
}

/** 错误日志的数据与动作：本次与上次两轮运行里，应用自己记下的失败。
 *
 * 原生侧留两轮（见 `src-tauri/src/error_log.rs`）：本轮在启动时把上一轮翻过去，所以
 * 刚闪退过的现场重启后还在，下下次才会消失。状态放在调用方而不是菜单里：和其它设置项
 * 一样，行上要显示当前状态（几条），而菜单只在打开时才挂载。 */
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
    if (!entries?.length) return;
    setExporting(true);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const path = await pickSavePath(`yomika-error-${stamp}.log`);
      if (!path) return;
      await flushErrorLog();
      const response = await repository.exportTo(path, exportText(entries));
      showToast(response.ok ? `错误日志已导出到 ${path}` : response.error.message, response.ok ? 'success' : 'error');
    } finally {
      setExporting(false);
    }
  }, [entries, showToast]);

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
        : <p className="error-log-summary">{summaryOf(entries)}</p>}
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
      {/* 原生侧给的就是从新到旧的顺序（本次在前、上次在后，各自新的在上），这里原样铺开。 */}
      {entries.map((entry, index) => <li key={`${entry.at}-${index}`} className={`error-log-entry is-${entry.level === 'warn' ? 'warn' : 'error'}`}>
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
