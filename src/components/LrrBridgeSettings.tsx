import { useEffect, useState } from 'react';
import { Database, FileDown, FileUp } from 'lucide-react';
import { NativeLrrBridgeRepository, type BridgeCollectionRecord, type LrrBridgeConfig } from '../repositories/nativeLrrBridgeRepository';
import { invalidateRouteCache } from '../lib/routeCache';
import { buildBridgeTransfer, parseBridgeTransfer, type BridgeTransferPair } from '../lib/bridgeDataTransfer';
import { getPlatformCapabilities } from '../bridge/platform';
import { pickSavePath, pickTextFile } from '../bridge/filePicker';
import { readTextFromFile, saveTextToFile } from '../bridge/textFile';
import { SettingsRow } from './SettingsRow';
import { SettingsSwitch } from './SettingsControls';
import { useToast } from './Toast';

const repository = new NativeLrrBridgeRepository();

/** 非重复标记在插件里存的是 `{archiveIdA, archiveIdB}`；读不懂的记录直接跳过，
 *  免得把半份值写回服务器。 */
function pairOf(record: BridgeCollectionRecord): BridgeTransferPair | undefined {
  const value = record.value as { archiveIdA?: unknown; archiveIdB?: unknown } | null;
  if (!value || typeof value.archiveIdA !== 'string' || typeof value.archiveIdB !== 'string') return undefined;
  return { archiveIdA: value.archiveIdA, archiveIdB: value.archiveIdB };
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Detect using the saved server credentials, never unsaved form edits. */
export function LrrBridgeSettings({ scopeId, disabled = false }: { scopeId: string; disabled?: boolean }) {
  const [config, setConfig] = useState<LrrBridgeConfig>();
  const [plugin, setPlugin] = useState<{ available: boolean; version?: string | undefined }>();
  const [pending, setPending] = useState(false);
  const [transfer, setTransfer] = useState<'export' | 'import'>();
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    void repository.config(scopeId, true).then(result => {
      if (active && result.ok) setConfig(result.value);
    });
    void repository.pluginStatus(scopeId).then(result => {
      if (active) setPlugin(result.ok ? result.value : { available: false });
    });
    return () => { active = false; };
  }, [scopeId]);

  async function toggle() {
    if (!config || !plugin?.available || pending || disabled) return;
    setPending(true);
    const result = await repository.configure(scopeId, !config.enabled);
    if (result.ok) {
      setConfig(result.value);
      for (const prefix of ['home:', 'state:', 'presets:', 'non-duplicates:']) invalidateRouteCache(prefix);
    } else {
      showToast('无法更改托管模式，请重试。', 'error');
    }
    setPending(false);
  }

  /** 导出读的是插件里的那份数据，不是本机镜像：这三类现在只有服务器是权威。 */
  async function exportHosted() {
    if (transfer || !config?.enabled || disabled) return;
    setTransfer('export');
    try {
      const states = await repository.exportAll(scopeId);
      if (!states.ok) { showToast(states.error.message, 'error'); return; }
      const records = await repository.collectionList(scopeId, 'non_duplicates');
      if (!records.ok) { showToast(records.error.message, 'error'); return; }
      const pairs = records.value.map(pairOf).filter((pair): pair is BridgeTransferPair => pair !== undefined);
      const document = buildBridgeTransfer({ scopeId, states: states.value, pairs });
      const text = JSON.stringify(document, null, 2);
      const filename = `yomika-bridge-${stamp()}.json`;
      const platform = await getPlatformCapabilities();
      const name = platform.ok && platform.value.platform === 'ios' ? filename : await pickSavePath(filename);
      if (!name) return;
      const saved = await saveTextToFile(name, text);
      if (!saved.ok) { showToast(saved.error.message, 'error'); return; }
      if (saved.value === null) return;
      showToast(`已导出到 ${saved.value}（待看 ${document.watchlist.length} · 历史 ${document.history.length} · 非重复 ${document.nonDuplicates.length}）`, 'success');
    } finally {
      setTransfer(undefined);
    }
  }

  /** 旧版应用导出与 Readoshi worker 导出都从这里写进插件：历史走插件的
   *  `import_history`（只收更新的记录），待看与非重复标记逐条 apply。 */
  async function importLegacy() {
    if (transfer || !config?.enabled || disabled) return;
    const path = await pickTextFile();
    if (!path) return;
    const file = await readTextFromFile(path);
    if (!file.ok) { showToast(file.error.message, 'error'); return; }
    const parsed = parseBridgeTransfer(file.value);
    if (parsed.kind === 'invalid') { showToast(parsed.reason, 'error'); return; }
    setTransfer('import');
    try {
      const payload = parsed.payload;
      let watchlist = 0;
      let pairs = 0;
      let history = 0;
      let failed = 0;
      let message = '';
      for (const entry of payload.watchlist) {
        const result = await repository.apply(scopeId, entry.archiveId, 'watchlist_add');
        if (result.ok) watchlist += 1; else { failed += 1; message ||= result.error.message; }
      }
      if (payload.history.length) {
        const result = await repository.importHistory(scopeId, payload.history);
        if (result.ok) history = result.value; else { failed += 1; message ||= result.error.message; }
      }
      for (const pair of payload.nonDuplicates) {
        const result = await repository.collectionApply(scopeId, 'non_duplicates', `${pair.archiveIdA}:${pair.archiveIdB}`, pair);
        if (result.ok) pairs += 1; else { failed += 1; message ||= result.error.message; }
      }
      if (failed && !watchlist && !history && !pairs) { showToast(message, 'error'); return; }
      const summary = `已写入插件：待看 ${watchlist} 条 · 历史 ${history} 条 · 非重复 ${pairs} 条`;
      showToast(failed ? `${summary}；${failed} 项未能写入（${message}）` : summary, failed ? 'info' : 'success');
    } finally {
      setTransfer(undefined);
    }
  }

  const status = !plugin ? '正在检测插件…' : plugin.available ? '插件可用' : '插件不可用';
  const locked = disabled || !config?.enabled || transfer !== undefined;
  return <section className="server-bridge-settings" aria-label="服务器阅读数据" aria-busy={pending || !plugin}>
    <SettingsSwitch icon={<Database aria-hidden="true" />} label="服务器托管用户数据"
      hint={`${status}${plugin?.version ? ` · v${plugin.version}` : ''}`}
      checked={config?.enabled ?? false}
      disabled={disabled || pending || !config || !plugin?.available}
      onToggle={() => { void toggle(); }} />
    <SettingsRow icon={<FileDown aria-hidden="true" />} label="导出托管数据"
      hint="待看、历史与非重复标记由插件托管，这里把它们存成一份 JSON 文件"
      trailing="none" disabled={locked} busy={transfer === 'export'}
      onClick={() => { void exportHosted(); }} />
    <SettingsRow icon={<FileUp aria-hidden="true" />} label="导入旧数据"
      hint="把旧版应用导出或 Readoshi worker 导出的待看、历史与非重复标记写进插件"
      trailing="none" disabled={locked} busy={transfer === 'import'}
      onClick={() => { void importLegacy(); }} />
  </section>;
}
