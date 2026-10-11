import { ChevronDown, ClipboardCopy, Copy, Download, Info, MessageSquareWarning, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { writeClipboardText } from '../bridge/clipboard';
import { openExternalUrl } from '../bridge/externalUrl';
import { pickSavePath } from '../bridge/filePicker';
import { flushErrorLog } from '../lib/errorLog';
import { NativeErrorLogRepository, type ErrorLogEntry } from '../repositories/nativeErrorLogRepository';
import { NativeAppInfoRepository, type AppBuildInfo } from '../repositories/nativeAppInfoRepository';
import { useToast } from './Toast';
import { StatusLine } from './StatusLine';
import { ConfirmDialog } from './ConfirmDialog';

const repository = new NativeErrorLogRepository();
const appRepository = new NativeAppInfoRepository();

const APP_VERSION = __APP_VERSION__;
const APP_REPOSITORY = __APP_REPOSITORY__;

/** 后端 panic 写的是 `epoch:<毫秒>`，前端给的是 ISO；两种都认。 */
function formatEntryTime(value: string): string {
  const epoch = /^epoch:(\d+)$/.exec(value.trim());
  const at = epoch ? new Date(Number(epoch[1])) : new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 与原生侧 `read_buckets` 拼的是同一个前缀。 */
const LAST_RUN_PREFIX = '上次运行 · ';

/** 一条记录的文本形态：列表里的「复制这条」与导出用的是同一份写法。 */
function entryText(entry: ErrorLogEntry): string {
  const lines = [`${formatEntryTime(entry.at)}  ${entry.level}  ${entry.source}`, `  ${entry.message}`];
  // 明细可能是多行的（Java 栈、命令行），缩进四格让它读起来还是「这条的附注」。
  if (entry.detail) lines.push(...entry.detail.split('\n').map((line) => `    ${line}`));
  return lines.join('\n');
}

/** 导出的是**用户眼前这一份**：同一批条目、同一套时间格式。之前是原生侧再拼一个版本
 * （复制源文件、有崩溃记录就合并），两次拼装走散的结果就是「导出的日志是空的」。 */
function exportText(entries: ErrorLogEntry[], info: AppInfoLines | undefined): string {
  const lines = [
    '# Yomika 错误日志',
    `# 导出时间：${formatEntryTime(new Date().toISOString())}`,
    `# 共 ${entries.length} 条，本次运行在上、上次运行在下`,
    '',
  ];
  if (info) {
    lines.push('# 相关信息');
    lines.push(...info.sections.flatMap((section) => [`# ${section.title}`, ...section.rows.map((row) => `#   ${row.label}: ${row.value}`)]));
    lines.push('');
  }
  for (const entry of entries) {
    lines.push(entryText(entry));
  }
  return lines.join('\n') + '\n';
}

/** 窗口错误那份明细是 JSON（`{file,line,column,stack}`）：栈要单独成段、按行展开，
 * 这样才能照着它找到出错的那一帧。不是 JSON（panic 写的是 `文件:行`）就当普通明细。 */
function splitDetail(entry: ErrorLogEntry): { detail?: string; stack?: string } {
  const raw = entry.detail?.trim();
  if (!raw) return {};
  if (!raw.startsWith('{')) return { detail: raw };
  try {
    const parsed = JSON.parse(raw) as { stack?: unknown; file?: unknown; line?: unknown; column?: unknown };
    const stack = typeof parsed.stack === 'string' ? parsed.stack : undefined;
    const where = typeof parsed.file === 'string'
      ? `${parsed.file}${typeof parsed.line === 'number' ? `:${parsed.line}` : ''}${typeof parsed.column === 'number' ? `:${parsed.column}` : ''}`
      : undefined;
    // 明细里除了栈还有「在哪」：两者都留，别把现场丢掉一半。
    return { ...(where ? { detail: where } : {}), ...(stack ? { stack } : {}) };
  } catch {
    return { detail: raw };
  }
}

interface AppInfoLines {
  sections: Array<{ title: string; rows: Array<{ label: string; value: string }> }>;
}

/** 「相关信息」的内容：出问题时最先要问的几件事，一次抄全。
 *
 * 设备那一栏能从浏览器问到的（UA-CH 的平台版本、屏幕、语言、时区）就地取；应用与编译
 * 两栏来自 `app_build_info`（版本、运行环境、标识、编译时间、提交号）。取不到的项不写，
 * 不编占位值——一段看起来很确定却是猜的「相关信息」比没有更坏。 */
function appInfoLines(build: AppBuildInfo | undefined, platform: string | undefined): AppInfoLines {
  const device: Array<{ label: string; value: string }> = [];
  if (platform) device.push({ label: '平台', value: platform });
  // Chromium 的 UA-CH：Windows 11 在 UA 串里仍写着 NT 10.0，这里给的是真版本号。
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string; platformVersion?: string } }).userAgentData;
  const chPlatform = uaData?.platform;
  const chVersion = uaData?.platformVersion;
  if (chPlatform) device.push({ label: '系统', value: `${chPlatform}${chVersion ? ` ${chVersion}` : ''}` });
  else if (navigator.userAgent) device.push({ label: '系统', value: navigator.userAgent });
  if (build?.arch) device.push({ label: '架构', value: build.arch });
  device.push({ label: '屏幕', value: `${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x` });
  device.push({ label: '窗口', value: `${window.innerWidth}×${window.innerHeight}` });
  if (navigator.language) device.push({ label: '语言', value: navigator.language });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) device.push({ label: '时区', value: timezone });

  const app: Array<{ label: string; value: string }> = [{ label: '版本', value: `v${APP_VERSION}` }];
  if (build?.profile) app.push({ label: '运行环境', value: build.profile });
  if (build?.identifier) app.push({ label: '包标识', value: build.identifier });
  app.push({ label: '语言环境', value: navigator.languages?.join(', ') ?? navigator.language ?? '' });

  const buildRows: Array<{ label: string; value: string }> = [];
  if (build?.buildTime) buildRows.push({ label: '编译时间', value: formatEntryTime(`epoch:${Number(build.buildTime) * 1000}`) });
  if (build?.commit) buildRows.push({ label: '提交', value: build.commit });
  if (build?.version) buildRows.push({ label: '版本', value: build.version });

  return {
    sections: [
      { title: '设备信息', rows: device.filter((row) => row.value) },
      { title: '应用信息', rows: app.filter((row) => row.value) },
      ...(buildRows.length > 0 ? [{ title: '编译信息', rows: buildRows }] : []),
    ],
  };
}

export interface ErrorLogState {
  entries: ErrorLogEntry[] | undefined;
  build: AppBuildInfo | undefined;
  platform: string | undefined;
  busy: boolean;
  exporting: boolean;
  /** `quiet` 是给轮询用的：后台自己刷新时不要把「正在读取…」那半拍闪出来，也不必
   * 每次读失败都弹一次 toast（面板还开着，用户什么都没做）。 */
  reload: (options?: { quiet?: boolean }) => Promise<void>;
  exportLog: () => Promise<void>;
  copyLog: () => Promise<void>;
  clearLog: () => Promise<boolean>;
}

/** 面板开着的时候多久自己去问一次原生侧。
 *
 * 为什么是轮询而不是订阅事件：这份日志有好几个写入口——前端的 bridge（`error_log_append`）、
 * 原生命令自己、panic 钩子、以及只有数据目录没有 `AppHandle` 的 `record_at_data_dir`。
 * 事件只能覆盖其中带 `AppHandle` 的那几个，剩下一半照样要刷新才知道。轮询问的是「现在
 * 磁盘上是什么」，四条路都算数。 */
export const ERROR_LOG_REFRESH_MS = 2_000;

/** 一条记录的稳定身份。展开的那一条按它记，不按序号：轮询会把整个列表换一份新的，
 * 按序号记就会串到隔壁那条上。`at`/`level`/`source`/`message` 是这条日志自带的全部身份。 */
function entryKey(entry: ErrorLogEntry): string {
  return [entry.at, entry.level, entry.source, entry.message].join('\u0000');
}

/** 错误日志的数据与动作：本次与上次两轮运行里，应用自己记下的失败。
 *
 * 原生侧留两轮（见 `src-tauri/src/error_log.rs`）：本轮在启动时把上一轮翻过去，所以
 * 刚闪退过的现场重启后还在，下下次才会消失。状态放在调用方而不是菜单里：和其它设置项
 * 一样，行上要显示当前状态（几条），而菜单只在打开时才挂载。 */
export function useErrorLog(): ErrorLogState {
  const { showToast } = useToast();
  const [entries, setEntries] = useState<ErrorLogEntry[]>();
  const [build, setBuild] = useState<AppBuildInfo>();
  const [platform, setPlatform] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const reload = useCallback(async (options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true;
    if (!quiet) setBusy(true);
    // 刚刚发生的失败可能还在缓冲区里：读之前先落盘，列表才是完整的。
    await flushErrorLog();
    const response = await repository.list();
    if (!quiet) setBusy(false);
    if (response.ok) setEntries(response.value);
    else if (!quiet) showToast(response.error.message, 'error');
  }, [showToast]);

  useEffect(() => { void reload(); }, [reload]);

  // 「相关信息」一次读回：版本、编译时间、包标识这些在进程里不会变。
  useEffect(() => {
    let active = true;
    void appRepository.buildInfo().then((result) => { if (active && result.ok) setBuild(result.value); });
    void appRepository.platformName().then((result) => { if (active && result.ok) setPlatform(result.value); });
    return () => { active = false; };
  }, []);

  const exportLog = useCallback(async () => {
    if (!entries?.length) return;
    setExporting(true);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const path = await pickSavePath(`yomika-error-${stamp}.log`);
      if (!path) return;
      await flushErrorLog();
      const response = await repository.exportTo(path, exportText(entries, appInfoLines(build, platform)));
      showToast(response.ok ? `错误日志已导出到 ${path}` : response.error.message, response.ok ? 'success' : 'error');
    } finally {
      setExporting(false);
    }
  }, [build, entries, platform, showToast]);

  const copyLog = useCallback(async () => {
    if (!entries?.length) return;
    try {
      await writeClipboardText(exportText(entries, appInfoLines(build, platform)));
      showToast('日志已复制到剪贴板', 'success');
    } catch {
      showToast('复制失败，请在列表里逐条复制', 'error');
    }
  }, [build, entries, platform, showToast]);

  const clearLog = useCallback(async () => {
    const response = await repository.clear();
    if (!response.ok) {
      showToast(response.error.message, 'error');
      return false;
    }
    setEntries([]);
    showToast(response.value > 0 ? `已清空 ${response.value} 条记录` : '没有可清空的记录', 'success');
    return true;
  }, [showToast]);

  return { entries, build, platform, busy, exporting, reload, exportLog, copyLog, clearLog };
}

/** 二级菜单里的错误日志：「相关信息」与按时间倒序的记录，四个动作铺在底部。
 *
 * 外层是设置菜单自己的面板（`.settings-choice-panel`）——它就是这块的框，所以
 * 这里不再套第二层。记录按「标题 + 时间」折起来：一屏看得见很多条，展开才是一个现场
 * （错误详情、堆栈跟踪）。面板开着的时候每 `ERROR_LOG_REFRESH_MS` 自己去问一次原生侧
 * （顶上没有刷新按钮），关掉菜单就停。 */
export function ErrorLogPanel({ state }: { state: ErrorLogState }) {
  const { entries, build, platform, exporting, reload, exportLog, copyLog, clearLog } = state;
  const { showToast } = useToast();
  const [factsOpen, setFactsOpen] = useState(false);
  const [openEntry, setOpenEntry] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const facts = useMemo(() => appInfoLines(build, platform), [build, platform]);
  const factsText = useMemo(
    () => facts.sections.flatMap((section) => [`${section.title}`, ...section.rows.map((row) => `  ${row.label}: ${row.value}`)]).join('\n'),
    [facts],
  );

  /** 面板自己去看新日志（用户要的「实时更新」）。面板只在菜单开着的时候挂载，所以关掉
   * 菜单就停了；`quiet` 让这半拍不闪状态行、也不因为读失败弹 toast。 */
  useEffect(() => {
    const timer = window.setInterval(() => { void reload({ quiet: true }); }, ERROR_LOG_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  /** 一条记录的复制：连着时间、来源与明细一起，粘到哪儿都是完整的一条。 */
  const copyEntry = async (entry: ErrorLogEntry) => {
    try {
      await writeClipboardText(entryText(entry));
      showToast('这条记录已复制', 'success');
    } catch {
      showToast('复制失败，请手动选择文本复制', 'error');
    }
  };

  const openFeedback = () => {
    const url = APP_REPOSITORY ? `${APP_REPOSITORY.replace(/\.git$/, '')}/issues/new` : '';
    if (!url) {
      showToast('这个构建没有仓库地址', 'error');
      return;
    }
    void openExternalUrl(url).then((result) => { if (!result.ok) showToast(result.error.message, 'error'); });
  };

  return <div className="error-log-panel">
    {/* 顶上不再有刷新与 ⋮（用户要的）：刷新由面板自己轮询（见上面的 effect），
        四个动作像其它设置面板那样铺在底部。这里只剩头一次读取的那半拍。 */}
    {entries === undefined && <StatusLine busy>正在读取…</StatusLine>}

    {/* 相关信息：能抄给别人的那一份现场。折起来是它默认的样子——它是给「要报问题」的
        时候用的，不是每次看日志都要读一遍。 */}
    <section className="error-log-facts">
      <div className="error-log-facts-head">
        <button className="error-log-facts-toggle" type="button" aria-expanded={factsOpen} onClick={() => setFactsOpen((value) => !value)}>
          <Info aria-hidden="true" />
          <span>相关信息</span>
          <ChevronDown className={`error-log-caret${factsOpen ? ' is-open' : ''}`} aria-hidden="true" />
        </button>
        <button className="error-log-icon" type="button" aria-label="复制相关信息" title="复制相关信息" onClick={() => {
          void writeClipboardText(factsText).then(() => showToast('相关信息已复制', 'success'), () => showToast('复制失败', 'error'));
        }}><Copy aria-hidden="true" /></button>
      </div>
      {factsOpen && (
        <div className="error-log-reveal">
          <div className="error-log-facts-body">
            {facts.sections.map((section) => (
              <div key={section.title} className="error-log-facts-section">
                <h3>{section.title}</h3>
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>

    {/* 第一次读回来时列表整块长出来（`.error-log-reveal` 的 0fr → 1fr）：
        面板从「正在读取…」跳到几十条记录，那一截高度变化不该是硬跳。 */}
    {entries && entries.length > 0 && <div className="error-log-reveal">
      <ul className="error-log-list" aria-label="错误记录">
        {/* 原生侧给的就是从新到旧的顺序（本次在前、上次在后，各自新的在上），这里原样铺开。
            展开按 `entryKey` 记而不是序号：轮询每两秒把列表换一份，序号会串到隔壁那条上。 */}
        {entries.map((entry) => {
          const key = entryKey(entry);
          const open = openEntry === key;
          const { detail, stack } = splitDetail(entry);
          return <li key={key} className={`error-log-entry is-${entry.level === 'warn' ? 'warn' : 'error'}${open ? ' is-open' : ''}`}>
            <div className="error-log-entry-head">
              <button className="error-log-entry-toggle" type="button" aria-expanded={open} onClick={() => setOpenEntry(open ? undefined : key)}>
                <span className="error-log-entry-title" title={entry.message}>{entry.message}</span>
                <span className="error-log-entry-meta">
                  <span className="error-log-time">{formatEntryTime(entry.at)}</span>
                  <span className="error-log-source" title={entry.source}>{entry.source}</span>
                </span>
                <ChevronDown className={`error-log-caret${open ? ' is-open' : ''}`} aria-hidden="true" />
              </button>
              <button className="error-log-icon" type="button" aria-label="复制这条记录" title="复制这条记录" onClick={() => void copyEntry(entry)}>
                <Copy aria-hidden="true" />
              </button>
            </div>
            {open && (
              <div className="error-log-reveal">
                <div className="error-log-entry-body">
                  <h4>错误详情</h4>
                  <pre className="error-log-code">{detail ?? entry.message}</pre>
                  {stack && <>
                    <h4>堆栈跟踪</h4>
                    <pre className="error-log-code">{stack}</pre>
                  </>}
                </div>
              </div>
            )}
          </li>;
        })}
      </ul>
    </div>}

    {/* 四个动作铺在底部、各占一份宽（`.settings-menu-actions` 的既有规则就是「一行动作平分
        宽度」）：清空是破坏性的那一个，用 `is-danger` 说清楚。 */}
    <div className="settings-menu-actions" role="group" aria-label="日志操作">
      <button className="secondary-action" type="button" disabled={!entries?.length} onClick={() => void copyLog()}>
        <ClipboardCopy aria-hidden="true" />复制日志
      </button>
      <button className="secondary-action" type="button" disabled={exporting || !entries?.length} onClick={() => void exportLog()}>
        <Download aria-hidden="true" />导出日志
      </button>
      <button className="secondary-action" type="button" onClick={openFeedback}>
        <MessageSquareWarning aria-hidden="true" />错误反馈
      </button>
      <button className="secondary-action is-danger" type="button" disabled={!entries?.length} onClick={() => setConfirmClear(true)}>
        <Trash2 aria-hidden="true" />清空日志
      </button>
    </div>

    {confirmClear && <ConfirmDialog
      title="清空日志"
      description={`将删掉本次与上次运行的全部记录（含崩溃现场）。这个操作不可撤销，之后再出的错照样会记。`}
      confirmLabel="清空"
      danger
      onClose={() => setConfirmClear(false)}
      onConfirm={async () => {
        const done = await clearLog();
        if (!done) throw new Error('清空失败');
      }}
    />}
  </div>;
}
