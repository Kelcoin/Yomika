import { useEffect, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import { NativeLrrBridgeRepository, type LrrBridgeConfig } from '../repositories/nativeLrrBridgeRepository';
import { invalidateRouteCache } from '../lib/routeCache';
import { SettingsSwitch } from './SettingsControls';
import { ConfirmDialog } from './ConfirmDialog';

const repository = new NativeLrrBridgeRepository();

/** Saved scope only: detection always uses the saved native credentials. */
export function LrrBridgeSettings({ scopeId, disabled = false }: { scopeId: string; disabled?: boolean }) {
  const [config, setConfig] = useState<LrrBridgeConfig>();
  const [pending, setPending] = useState(false);
  const [detected, setDetected] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const activeScope = useRef<string | null>(scopeId);
  useEffect(() => {
    activeScope.current = scopeId;
    let active = true;
    void repository.config(scopeId, true).then(result => {
      if (!active) return;
      if (result.ok) { setConfig(result.value); setDetected(result.value.enabled); }
      else setMessage('无法读取托管设置，请重新打开服务器设置。');
    });
    return () => { active = false; activeScope.current = null; };
  }, [scopeId]);

  async function detect() {
    setPending(true);
    const result = await repository.detect(scopeId);
    if (activeScope.current !== scopeId) return;
    setDetected(result.ok);
    setMessage(result.ok ? '已检测到兼容插件，可以启用托管。' : '未能检测到兼容插件，请检查安装与连接。');
    setPending(false);
  }
  async function toggle() {
    if (!config) return;
    setPending(true);
    const result = await repository.configure(scopeId, !config.enabled);
    if (activeScope.current !== scopeId) return;
    if (result.ok) {
      setConfig(result.value);
      setMessage(result.value.enabled ? '已启用服务器托管。' : '已切回本机数据；服务器托管数据仍保留。');
      invalidateRouteCache('home:'); invalidateRouteCache('state:');
    } else setMessage('无法更改托管模式，原设置保持不变。请检查连接后重试。');
    setPending(false);
  }
  async function retry() {
    setPending(true);
    const result = await repository.flush(scopeId);
    if (activeScope.current !== scopeId) return;
    if (result.ok) { setConfig(result.value); setMessage('已检查待提交操作。'); }
    else setMessage('暂时无法连接，待提交操作仍保留在本机。');
    setPending(false);
  }
  async function discardConflicts() {
    setPending(true);
    const result = await repository.discardConflicts(scopeId);
    if (activeScope.current !== scopeId) return;
    if (result.ok) {
      setConfig(result.value); setConfirmDiscard(false);
      setMessage('已采用服务器数据，并丢弃有冲突档案的本机待提交修改。');
      invalidateRouteCache('home:'); invalidateRouteCache('state:');
    } else setMessage('无法获取服务器数据，本机冲突修改仍保留。');
    setPending(false);
  }
  async function abandonPending() {
    setPending(true);
    const result = await repository.abandonPending(scopeId);
    if (activeScope.current !== scopeId) return;
    if (result.ok) {
      setConfig(result.value); setDetected(false); setConfirmAbandon(false);
      setMessage('已停用托管并恢复原本机数据，服务器数据未改动。');
      invalidateRouteCache('home:'); invalidateRouteCache('state:');
    } else setMessage('未能恢复本机数据，原状态保持不变。');
    setPending(false);
  }
  return <section aria-label="服务器阅读数据" aria-busy={pending}>
    <SettingsSwitch icon={<Database aria-hidden="true" />} label="服务器托管用户数据"
      hint="同一服务器共享待看、历史、阅读进度、搜索预设与非重复标记。已有本机数据不会自动上传；切换模式会显示所选数据源。"
      checked={config?.enabled ?? false} disabled={disabled || pending || !config || (!config.enabled && !detected)}
      onToggle={() => { void toggle(); }} />
    {!config?.enabled && <button type="button" className="secondary-action" disabled={disabled || pending || !config} onClick={() => { void detect(); }}>检测已安装的插件</button>}
    {config?.enabled && <>
      <p role="status">待提交 {config.pending} 项 · 冲突 {config.conflicts} 项。离线时保留本机缓存与待提交操作；冲突不会自动覆盖服务器数据。</p>
      <button type="button" className="secondary-action" disabled={disabled || pending} onClick={() => { void retry(); }}>重试待提交操作</button>
      {config.conflicts > 0 && <button type="button" className="secondary-action" disabled={disabled || pending} onClick={() => setConfirmDiscard(true)}>采用服务器数据解决冲突</button>}
      <button type="button" className="secondary-action" disabled={disabled || pending} onClick={() => setConfirmAbandon(true)}>停用并恢复原本机数据</button>
    </>}
    {message && <p role="status">{message}</p>}
    {confirmDiscard && <ConfirmDialog title="采用服务器数据？" description="这会丢弃发生冲突档案的所有本机待提交修改，并重新获取服务器数据。服务器数据不会被改写。" confirmLabel="采用服务器数据" onClose={() => { if (!pending) setConfirmDiscard(false); }} onConfirm={discardConflicts} />}
    {confirmAbandon && <ConfirmDialog title="停用服务器托管？" description="这会放弃此服务器所有尚未提交的本机修改，恢复启用托管前的本机记录，并解除原服务器身份绑定。已提交的服务器数据保持不变；此操作无需联网。" confirmLabel="放弃待提交修改并停用" onClose={() => { if (!pending) setConfirmAbandon(false); }} onConfirm={abandonPending} />}
  </section>;
}
