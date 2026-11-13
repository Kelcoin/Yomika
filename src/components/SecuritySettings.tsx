import { useEffect, useRef, useState } from 'react';
import { EyeOff, Fingerprint, LockKeyhole, ShieldCheck, Timer } from 'lucide-react';
import { useAppSecurity } from './AppSecurityGate';
import { PatternLock } from './PatternLock';
import { SettingsRow } from './SettingsRow';
import { SettingsSwitch } from './SettingsControls';
import { SettingsMenu, SettingsOption } from './SettingsValueControls';
import { ContentSkeleton } from './ContentSkeleton';
import { type AppSecurityConfig } from '../repositories/nativeAppSecurityRepository';

type Action = 'password' | 'disable' | 'biometricEnabled' | 'backgroundLockSeconds' | 'hidePreview';
const titles: Record<Action, string> = { password: '设置手势密码', disable: '关闭密码保护', biometricEnabled: '系统认证', backgroundLockSeconds: '后台自动锁定', hidePreview: '隐藏任务预览' };
const LOCK_DELAYS = [{ seconds: -1, label: '不锁定' }, { seconds: 0, label: '立即' }, { seconds: 300, label: '5 分钟' }, { seconds: 900, label: '15 分钟' }, { seconds: 1800, label: '30 分钟' }, { seconds: 3600, label: '60 分钟' }];

/** Device security never enters preferences, synchronisation, or data exports. */
export function SecuritySettings() {
  const { status, supported, loadError, update, refresh, configure } = useAppSecurity();
  const [action, setAction] = useState<Action>();
  const [timeoutMenu, setTimeoutMenu] = useState(false);
  const [pendingTimeout, setPendingTimeout] = useState(-1);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [stage, setStage] = useState<'current' | 'new' | 'confirm' | 'ready'>('new');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    if (status?.locked) { setAction(undefined); setCurrentPassword(''); setPassword(''); setConfirm(''); setError(''); }
  }, [status?.locked]);
  const clear = () => { setPassword(''); setConfirm(''); setCurrentPassword(''); setError(''); };
  const close = () => { if (!busyRef.current) { setAction(undefined); clear(); } };
  if (!supported) return <p className="security-note">安全保护需要原生应用，浏览器预览不支持。</p>;
  if (!status) return loadError ? <div className="security-form"><p role="alert">{loadError}</p><button className="secondary-action" type="button" onClick={() => void refresh()}>重试</button></div> : <ContentSkeleton label="正在读取安全状态" rows={4} />;
  const open = (value: Action) => { clear(); setStage(status.passwordEnabled ? 'current' : value === 'password' ? 'new' : 'ready'); setAction(value); };
  const authenticationLabel = status.biometricLabel ?? '生物认证';
  const apply = async (config: AppSecurityConfig) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    const result = await configure(config);
    busyRef.current = false; setBusy(false);
    if (result.ok) { update(result.value); setAction(undefined); clear(); }
    else {
      setError('保存失败，请检查当前凭据后重试');
      setCurrentPassword('');
      if (status.passwordEnabled) setStage('current');
    }
  };
  const submit = () => {
    if (!action || busyRef.current) return;
    if (stage === 'current') {
      if (!currentPassword) return;
      setStage(action === 'password' ? 'new' : 'ready'); return;
    }
    if (action === 'password' && stage === 'new') {
      if (password.length < 4) { setError('请至少连接 4 个点'); return; }
      setStage('confirm'); setError(''); return;
    }
    if (action === 'password' && password !== confirm) { setError('两次手势不一致，请重新确认'); setConfirm(''); return; }
    const config: AppSecurityConfig = {};
    if (status.passwordEnabled) config.currentPassword = currentPassword;
    if (action === 'password') { config.password = password; config.credentialKind = 'pattern'; }
    else if (action === 'disable') config.password = '';
    else if (action === 'backgroundLockSeconds') config.backgroundLockSeconds = pendingTimeout;
    else config[action] = !status[action];
    void apply(config);
  };
  const lockDelay = status.backgroundLockSeconds ?? (status.lockOnBackground ? 0 : -1);
  const submitButton = <button className="primary-action" type="submit" disabled={busy || (stage === 'current' && !currentPassword) || (stage === 'new' && password.length < 4) || (stage === 'confirm' && confirm.length < 4)}>{busy ? '正在验证…' : stage === 'current' || stage === 'new' ? '下一步' : '确认'}</button>;
  const patternStage = stage === 'current' && status.credentialKind === 'pattern' || action === 'password' && (stage === 'new' || stage === 'confirm');
  return <>
    <div className="settings-group">
      <SettingsRow icon={<LockKeyhole />} label="手势密码" hint={status.passwordEnabled && status.credentialKind === 'password' ? '已设置旧密码，可验证后更换为手势' : '连接至少 4 个点，启动时认证'} value={status.passwordEnabled ? '已设置' : '未设置'} onClick={() => open('password')} />
      {status.passwordEnabled && <SettingsRow icon={<ShieldCheck />} label="关闭密码保护" hint="需要验证当前凭据" onClick={() => open('disable')} />}
      <SettingsSwitch icon={<Fingerprint />} label={authenticationLabel} hint={status.biometricAvailable ? '由系统选择符合要求的人脸、指纹或锁屏密码' : '当前平台或设备没有可用的系统认证'} checked={status.biometricEnabled} disabled={busy || !status.biometricAvailable} onToggle={() => { if (status.passwordEnabled) open('biometricEnabled'); else void apply({ biometricEnabled: !status.biometricEnabled }); }} />
      <SettingsRow icon={<Timer />} label="后台自动锁定" hint="离开应用达到指定时间后锁定" value={LOCK_DELAYS.find(value => value.seconds === lockDelay)?.label ?? '不锁定'} disabled={!status.passwordEnabled && !status.biometricEnabled} onClick={() => setTimeoutMenu(true)} />
      <SettingsSwitch icon={<EyeOff />} label="隐藏任务预览" hint={status.previewProtectionAvailable ? '隐藏系统任务切换器中的内容预览' : '当前平台不支持系统预览保护'} checked={status.hidePreview} disabled={busy || !status.previewProtectionAvailable} onToggle={() => { if (status.passwordEnabled) open('hidePreview'); else void apply({ hidePreview: !status.hidePreview }); }} />
    </div>
    {!action && (error || loadError) && <p className="form-error" role="alert">{error || loadError}</p>}
    {timeoutMenu && <SettingsMenu title="后台自动锁定" icon={<Timer />} onClose={() => setTimeoutMenu(false)}>
      <div className="settings-choice-list">{LOCK_DELAYS.map(value => <SettingsOption key={value.seconds} active={lockDelay === value.seconds} disabled={busy} onClick={() => {
        setTimeoutMenu(false);
        if (value.seconds === lockDelay) return;
        setPendingTimeout(value.seconds);
        if (status.passwordEnabled) open('backgroundLockSeconds');
        else void apply({ backgroundLockSeconds: value.seconds });
      }}><span>{value.label}</span></SettingsOption>)}</div>
    </SettingsMenu>}
    {action && <SettingsMenu title={action === 'biometricEnabled' ? authenticationLabel : titles[action]} icon={action === 'biometricEnabled' ? <Fingerprint /> : action === 'hidePreview' ? <EyeOff /> : <LockKeyhole />} onClose={close}>
      <form className="security-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {stage === 'current' && (status.credentialKind === 'pattern'
          ? <PatternLock key={`current-${busy}`} label="当前手势密码" disabled={busy} onComplete={setCurrentPassword} primaryAction={submitButton} />
          : <label className="security-password-field">当前密码<input type="password" autoComplete="current-password" autoFocus value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={busy} required /></label>)}
        {action === 'password' && stage === 'new' && <PatternLock key="new" label="新手势密码" hideLabel disabled={busy} onComplete={setPassword} primaryAction={submitButton} />}
        {action === 'password' && stage === 'confirm' && <PatternLock key="confirm" label="确认手势密码" disabled={busy} onComplete={setConfirm} primaryAction={submitButton} />}
        {stage === 'ready' && <p>{action === 'disable' ? '关闭后，启动和返回应用时无需认证。' : action === 'backgroundLockSeconds' ? LOCK_DELAYS.find(value => value.seconds === pendingTimeout)?.label : `${(action === 'biometricEnabled' ? status.biometricEnabled : status.hidePreview) ? '关闭' : '开启'}${action === 'biometricEnabled' ? authenticationLabel : titles[action]}`}</p>}
        {error && <p role="alert">{error}</p>}
        {!patternStage && submitButton}
      </form>
    </SettingsMenu>}
  </>;
}
