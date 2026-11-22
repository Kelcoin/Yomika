import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { NativeLrrBridgeRepository, type LrrBridgeConfig } from '../repositories/nativeLrrBridgeRepository';
import { invalidateRouteCache } from '../lib/routeCache';
import { SettingsSwitch } from './SettingsControls';
import { useToast } from './Toast';

const repository = new NativeLrrBridgeRepository();

/** Detect using the saved server credentials, never unsaved form edits. */
export function LrrBridgeSettings({ scopeId, disabled = false }: { scopeId: string; disabled?: boolean }) {
  const [config, setConfig] = useState<LrrBridgeConfig>();
  const [plugin, setPlugin] = useState<{ available: boolean; version?: string | undefined }>();
  const [pending, setPending] = useState(false);
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

  const status = !plugin ? '正在检测插件…' : plugin.available ? '插件可用' : '插件不可用';
  return <section className="server-bridge-settings" aria-label="服务器阅读数据" aria-busy={pending || !plugin}>
    <SettingsSwitch icon={<Database aria-hidden="true" />} label="服务器托管用户数据"
      hint={`${status}${plugin?.version ? ` · v${plugin.version}` : ''}`}
      checked={config?.enabled ?? false}
      disabled={disabled || pending || !config || !plugin?.available}
      onToggle={() => { void toggle(); }} />
  </section>;
}
