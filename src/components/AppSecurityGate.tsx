import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { Fingerprint, LockKeyhole } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { appSecurityRepository, AppSecurityStatusSchema, hasNativeSecurity, type AppSecurityStatus } from '../repositories/nativeAppSecurityRepository';
import '../styles/security.css';
import { useOverlayBackGuard } from '../lib/overlayBackGuard';

type SecurityContext = { status: AppSecurityStatus | undefined; supported: boolean; update: (status: AppSecurityStatus) => void; refresh: () => Promise<void> };
const Context = createContext<SecurityContext | undefined>(undefined);
export function useAppSecurity() {
  const value = useContext(Context);
  if (!value) throw new Error('AppSecurityGate is required');
  return value;
}

export function AppSecurityGate({ children }: { children: ReactNode }) {
  const native = hasNativeSecurity();
  const [status, setStatus] = useState<AppSecurityStatus>();
  const [checking, setChecking] = useState(native);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [obscured, setObscured] = useState(false);
  const authenticating = useRef(false);
  const systemAuthenticating = useRef(false);
  // Native lock events and newer reads supersede every earlier asynchronous
  // snapshot, even if that earlier IPC response arrives last.
  const generation = useRef(0);
  const current = useRef(status);
  current.current = status;
  const covered = native && (checking || !status || status.locked || obscured || !!error);
  // System back must not navigate the retained route behind the authentication gate.
  useOverlayBackGuard(covered, useCallback(() => {}, []));
  const update = useCallback((value: AppSecurityStatus) => { generation.current++; setStatus(value); setChecking(false); setError(''); }, []);
  const refresh = useCallback(async () => {
    if (!native) return;
    const requestGeneration = ++generation.current;
    const result = await appSecurityRepository.status();
    if (requestGeneration !== generation.current) return;
    if (result.ok) { update(result.value); if (document.visibilityState !== 'hidden') setObscured(false); }
    else { setChecking(false); setError('无法读取安全状态，请重试'); }
  }, [native, update]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  useLayoutEffect(() => {
    if (covered) document.body.dataset.appSecurityCovered = 'true';
    else delete document.body.dataset.appSecurityCovered;
    // The native resume cover is removed only after this commit has covered the page.
    // A failed status read also has a solid, actionable error gate. Keeping the
    // native WebView hidden there would make its Retry button unreachable.
    if (native && !checking && document.visibilityState !== 'hidden') void appSecurityRepository.ready();
    return () => { delete document.body.dataset.appSecurityCovered; };
  }, [covered, checking, native, status, obscured, error]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const subscription = listen<unknown>('app-security-changed', (event) => {
      const parsed = AppSecurityStatusSchema.safeParse(event.payload);
      if (parsed.success) update(parsed.data);
    }).catch(() => undefined);
    const lockSubscription = listen('app-security-lock', () => {
      document.body.dataset.appSecurityCovered = 'true';
      setObscured(true);
      setChecking(true);
      void refresh();
    }).catch(() => undefined);
    const background = () => {
      if (document.visibilityState !== 'hidden' || systemAuthenticating.current) return;
      const value = current.current;
      if (value?.hidePreview || (value?.passwordEnabled && value.lockOnBackground)) {
        const requestGeneration = ++generation.current;
        // Set synchronously: React's next commit may be after the OS takes its snapshot.
        document.body.dataset.appSecurityCovered = 'true';
        setObscured(true);
        if (value.passwordEnabled && value.lockOnBackground) setStatus({ ...value, locked: true });
        else setChecking(true);
        void appSecurityRepository.background().then((result) => { if (!disposed && requestGeneration === generation.current && result.ok && document.visibilityState !== 'hidden') update(result.value); });
      }
    };
    const resume = () => {
      if (systemAuthenticating.current) return;
      if (document.visibilityState === 'hidden') return;
      // Re-read native authoritative state before revealing any retained content.
      document.body.dataset.appSecurityCovered = 'true';
      setChecking(true);
      void refresh();
    };
    const visibility = () => document.visibilityState === 'hidden' ? background() : resume();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('yomika-security-resume', resume);
    return () => {
      disposed = true;
      void subscription.then((stop) => stop?.());
      void lockSubscription.then((stop) => stop?.());
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('yomika-security-resume', resume);
    };
  }, [native, refresh, update]);
  const unlock = async (biometric: boolean) => {
    if (authenticating.current) return;
    authenticating.current = true;
    systemAuthenticating.current = biometric;
    const requestGeneration = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await (biometric ? appSecurityRepository.unlockBiometric() : appSecurityRepository.unlockPassword(password));
      setPassword('');
      if (requestGeneration !== generation.current) return;
      if (result.ok) update(result.value);
      else setError('认证未完成或密码错误，请重试');
    } finally { authenticating.current = false; systemAuthenticating.current = false; setBusy(false); }
  };
  return <Context.Provider value={{ status, supported: native && (status?.supported ?? true), update, refresh }}>
    <div className="app-security-content" aria-hidden={covered || undefined} {...(covered ? { inert: '' } : {})}>{children}</div>
    {covered && createPortal(<div className="app-security-overlay">
      <FocusScope trapped loop asChild><section className="app-security-card" role="dialog" aria-modal="true" aria-label="应用已锁定">
        <LockKeyhole size={36} aria-hidden="true" />
        <h1>{checking ? '正在检查安全状态' : '应用已锁定'}</h1>
        {!checking && status?.locked && <form onSubmit={(event) => { event.preventDefault(); void unlock(false); }}>
          <label className="security-password-field">密码<input type="password" autoComplete="current-password" autoFocus value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary-action" type="submit" disabled={busy || !password}>解锁</button>
          {status.biometricEnabled && status.biometricAvailable && <button className="secondary-action" type="button" disabled={busy} onClick={() => void unlock(true)}><Fingerprint aria-hidden="true" />使用{status.biometricLabel ?? '生物认证'}</button>}
        </form>}
        {error && <p role="alert">{error}</p>}
        {!checking && (!status || (!status.locked && error)) && <button className="secondary-action" type="button" onClick={() => { setChecking(true); void refresh(); }}>重试</button>}
      </section></FocusScope>
    </div>, document.body)}
  </Context.Provider>;
}
