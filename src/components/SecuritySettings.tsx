import { useEffect, useState, type FormEvent } from 'react';
import { EyeOff, Fingerprint, LockKeyhole, ShieldCheck, Timer } from 'lucide-react';
import { useAppSecurity } from './AppSecurityGate';
import { SettingsRow } from './SettingsRow';
import { SettingsMenu, SettingsOption } from './SettingsValueControls';
import { appSecurityRepository, type AppSecurityConfig } from '../repositories/nativeAppSecurityRepository';

type Action = 'password' | 'disable' | 'biometricEnabled' | 'lockOnBackground' | 'hidePreview';
const titles: Record<Action, string> = { password: '设置密码', disable: '关闭密码保护', biometricEnabled: '生物认证', lockOnBackground: '后台自动锁定', hidePreview: '隐藏任务预览' };

/** Device security never enters preferences, synchronisation, or data exports. */
export function SecuritySettings() {
  const { status, supported, update } = useAppSecurity();
  const [action, setAction] = useState<Action>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (status?.locked) { setAction(undefined); setCurrentPassword(''); setPassword(''); setConfirm(''); setError(''); }
  }, [status?.locked]);
  const close = () => { if (!busy) { setAction(undefined); setPassword(''); setConfirm(''); setCurrentPassword(''); setError(''); } };
  if (!supported) return <p className="security-note">安全保护需要原生应用，浏览器预览不支持。</p>;
  if (!status) return <p className="security-note">正在读取安全状态…</p>;
  const open = (value: Action) => { setAction(value); setError(''); };
  const authenticationLabel = status.biometricLabel ?? '生物认证';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || busy) return;
    if (action === 'password' && (password.length < 6 || password !== confirm)) {
      setError(password.length < 6 ? '密码至少需要 6 个字符' : '两次输入的密码不一致'); return;
    }
    const config: AppSecurityConfig = {};
    if (status.passwordEnabled) config.currentPassword = currentPassword;
    if (action === 'password') config.password = password;
    else if (action === 'disable') config.password = '';
    else config[action] = !status[action];
    setBusy(true); setError('');
    const result = await appSecurityRepository.configure(config);
    setCurrentPassword(''); setPassword(''); setConfirm(''); setBusy(false);
    if (result.ok) { update(result.value); setAction(undefined); }
    else setError('保存失败，请检查当前密码后重试');
  };
  const enabled = (value: boolean) => value ? '已开启' : '已关闭';
  return <>
    <div className="settings-group">
      <SettingsRow icon={<LockKeyhole />} label="密码保护" hint="仅保存在此设备；启动时需认证" value={status.passwordEnabled ? '已设置' : '未设置'} onClick={() => open('password')} />
      {status.passwordEnabled && <SettingsRow icon={<ShieldCheck />} label="关闭密码保护" hint="需要验证当前密码" onClick={() => open('disable')} />}
      <SettingsRow icon={<Fingerprint />} label={authenticationLabel} hint={status.biometricAvailable ? `使用${authenticationLabel}解锁` : '当前平台或设备没有可用的系统认证'} value={enabled(status.biometricEnabled)} disabled={!status.passwordEnabled || !status.biometricAvailable} onClick={() => open('biometricEnabled')} />
      <SettingsRow icon={<Timer />} label="后台自动锁定" hint="离开应用后锁定，解锁后回到原位置" value={enabled(status.lockOnBackground)} disabled={!status.passwordEnabled} onClick={() => open('lockOnBackground')} />
      <SettingsRow icon={<EyeOff />} label="隐藏任务预览" hint={status.previewProtectionAvailable ? '隐藏系统任务切换器中的内容预览' : '当前平台不支持系统预览保护'} value={enabled(status.hidePreview)} disabled={!status.previewProtectionAvailable} onClick={() => open('hidePreview')} />
      {status.passwordEnabled && <SettingsRow icon={<LockKeyhole />} label="立即锁定" trailing="none" onClick={() => { void appSecurityRepository.lock().then((result) => { if (result.ok) update(result.value); }); }} />}
    </div>
    {!status.passwordEnabled && <p className="security-note">先设置密码，即可开启生物认证和后台自动锁定。请妥善保存密码，本机安全设置不参与同步或导出。</p>}
    {status.platformNote && <p className="security-note">{status.platformNote}</p>}
    {action && <SettingsMenu title={action === 'biometricEnabled' ? authenticationLabel : titles[action]} icon={action === 'biometricEnabled' ? <Fingerprint /> : action === 'hidePreview' ? <EyeOff /> : <LockKeyhole />} onClose={close}>
      <form className="security-form" onSubmit={(event) => void submit(event)}>
        {action === 'disable' && <p>关闭后，启动和返回应用时无需认证。</p>}
        {action !== 'password' && action !== 'disable' && <p>{status[action] ? '关闭' : '开启'}{action === 'biometricEnabled' ? authenticationLabel : titles[action]}</p>}
        {status.passwordEnabled && <label className="security-password-field">当前密码<input type="password" autoComplete="current-password" autoFocus value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} required /></label>}
        {action === 'password' && <>
          <label className="security-password-field">新密码<input type="password" autoComplete="new-password" autoFocus={!status.passwordEnabled} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} minLength={6} maxLength={1024} required /></label>
          <label className="security-password-field">确认新密码<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} disabled={busy} minLength={6} maxLength={1024} required /></label>
        </>}
        {error && <p role="alert">{error}</p>}
        <button className="primary-action" type="submit" disabled={busy}>{busy ? '正在验证…' : '确认'}</button>
      </form>
      {action === 'password' && status.passwordEnabled && <SettingsOption onClick={() => { setAction('disable'); setPassword(''); setConfirm(''); }}>关闭密码保护</SettingsOption>}
    </SettingsMenu>}
  </>;
}
