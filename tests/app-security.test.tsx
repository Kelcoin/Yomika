import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppSecurityGate } from '../src/components/AppSecurityGate';
import { SecuritySettings } from '../src/components/SecuritySettings';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../src/bridge/invoke';
import { closeTopOverlay } from '../src/lib/overlayBackGuard';
import { emitTauriEvent } from './tauriEvents';

const status = { locked: true, passwordEnabled: true, biometricEnabled: false, lockOnBackground: true, hidePreview: true, biometricAvailable: false, previewProtectionAvailable: true, platformNote: '' };
afterEach(() => { cleanup(); resetInvokeAdapterForTests(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); Reflect.deleteProperty(window, '__YOMIKA_SECURITY_BOOTSTRAP__'); });

it('allows system authentication without an app password and exposes system-only unlock', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let locked = false;
  let enabled = false;
  const configure = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (name === 'app_security_configure') { configure(args); enabled = true; }
    return { ok: true, value: { ...status, passwordEnabled: false, locked, biometricEnabled: enabled, biometricAvailable: true, biometricLabel: '系统认证' } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  const entry = await screen.findByRole('switch', { name: '系统认证' });
  expect(entry).toBeEnabled();
  fireEvent.click(entry);
  expect(screen.queryByLabelText('当前密码')).not.toBeInTheDocument();
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { biometricEnabled: true } }));
  locked = true;
  await act(async () => emitTauriEvent('app-security-lock', null));
  expect(await screen.findByRole('button', { name: '使用系统认证' })).toBeInTheDocument();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '解锁' })).not.toBeInTheDocument();
});

it('keeps the new pattern label accessible but visually hidden with one shared action row', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  setInvokeAdapterForTests(async (name) => ({ ok: true, value: name === 'app_security_ready' ? null : { ...status, locked: false, passwordEnabled: false } }));
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  fireEvent.click(await screen.findByRole('button', { name: '手势密码' }));
  expect(screen.getByText('新手势密码')).toHaveClass('sr-only');
  expect(screen.queryByRole('button', { name: '完成手势' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '清除' }).parentElement).toBe(screen.getByRole('button', { name: '下一步' }).parentElement);
  draw('新手势密码', [0, 2, 5]);
  expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
});

it('names Windows Hello explicitly for the system PIN or biometric unlock entry', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  setInvokeAdapterForTests(async (name) => ({ ok: true, value: name === 'app_security_ready' ? null : { ...status, biometricEnabled: true, biometricAvailable: true, biometricLabel: 'Windows Hello' } }));
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  expect(await screen.findByRole('button', { name: '使用Windows Hello' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '使用生物认证' })).not.toBeInTheDocument();
});

it('releases a preview-only shield when its late background reply arrives after foregrounding', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let finishBackground!: (result: unknown) => void;
  const plain = { ...status, locked: false, passwordEnabled: false, biometricEnabled: false };
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (name === 'app_security_background') return new Promise(resolve => { finishBackground = resolve; });
    return { ok: true, value: plain };
  });
  render(<AppSecurityGate><p>retained page</p></AppSecurityGate>);
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  // Some Android resume callbacks precede WebView visibility restoration;
  // the background IPC can then be the first authoritative foreground update.
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => finishBackground({ ok: true, value: plain }));
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  expect(screen.queryByText('应用已锁定')).not.toBeInTheDocument();
});

it('invalidates a pending password result when the app moves into the background', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let finish!: (value: unknown) => void;
  const background = vi.fn();
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (name === 'app_security_unlock_password') return new Promise((resolve) => { finish = resolve; });
    if (name === 'app_security_background') background();
    return { ok: true, value: status };
  });
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  fireEvent.change(await screen.findByLabelText('密码'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '解锁' }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(background).toHaveBeenCalledOnce());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => finish({ ok: true, value: { ...status, locked: false } }));
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
});

it('conceals native content until status resolves and preserves the mounted page through unlock and background lock', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let resolveStatus!: (value: unknown) => void;
  setInvokeAdapterForTests(async (name) => name === 'app_security_status'
    ? new Promise((resolve) => { resolveStatus = resolve; })
    : { ok: true, value: name === 'app_security_ready' ? null : { ...status, locked: name !== 'app_security_unlock_password' } });
  const unmount = vi.fn();
  function Page() { return <input aria-label="page state" defaultValue="retained" ref={(node) => { if (!node) unmount(); }} />; }
  render(<AppSecurityGate><Page /></AppSecurityGate>);
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  await act(async () => resolveStatus({ ok: true, value: status }));
  expect(closeTopOverlay()).toBe(true);
  expect(screen.getByRole('dialog', { name: '应用已锁定' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
  expect(screen.getByLabelText('page state')).toHaveValue('retained');
  expect(unmount).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange'));
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

it('covers immediately on a native lock event and acknowledges only after a lock screen commit', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let locked = false;
  const ready = vi.fn();
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') { ready(document.body.dataset.appSecurityCovered); return { ok: true, value: null }; }
    return { ok: true, value: { ...status, locked } };
  });
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
  ready.mockClear();
  locked = true;
  await act(async () => emitTauriEvent('app-security-lock', null));
  await screen.findByLabelText('密码');
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(ready).toHaveBeenCalledWith('true');
});

it.each(['lock', 'changed'])('ignores an older unlocked status response after a newer native %s event', async (event) => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const pending: Array<(value: unknown) => void> = [];
  let initial = true;
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (initial) { initial = false; return { ok: true, value: { ...status, locked: false } }; }
    return new Promise((resolve) => pending.push(resolve));
  });
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
  act(() => window.dispatchEvent(new Event('yomika-security-resume')));
  expect(pending).toHaveLength(1);
  if (event === 'lock') {
    act(() => emitTauriEvent('app-security-lock', null));
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!({ ok: true, value: status }));
  } else {
    act(() => emitTauriEvent('app-security-changed', status));
  }
  await screen.findByLabelText('密码');
  await act(async () => pending[0]!({ ok: true, value: { ...status, locked: false } }));
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
});

it('stays covered when native security status cannot be loaded', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let failing = true;
  const ready = vi.fn();
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') { ready(document.body.dataset.appSecurityCovered); return { ok: true, value: null }; }
    return failing ? { ok: false, error: { code: 'UNKNOWN', message: 'failure', retryable: true } } : { ok: true, value: { ...status, locked: false } };
  });
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  await screen.findByRole('button', { name: '重试' });
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(ready).toHaveBeenCalledWith('true');
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
});

function draw(label: string, points: number[]) {
  for (const point of points) fireEvent.click(screen.getByRole('button', { name: `${label}：点 ${point + 1}` }));
}

it('requires legacy authentication and matching gesture confirmation before replacing credentials', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const configure = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_configure') configure(args);
    return { ok: true, value: name === 'app_security_ready' ? null : { ...status, locked: false } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  fireEvent.click(await screen.findByRole('button', { name: '手势密码' }));
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  draw('新手势密码', [0, 2, 5]);
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  draw('确认手势密码', [0, 6, 7]);
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('两次手势不一致');
  expect(configure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  draw('确认手势密码', [0, 2, 5]);
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { password: '0125', currentPassword: 'old-secret', credentialKind: 'pattern' } }));
});

it('paints an unconfigured native launch immediately with only the trusted bootstrap', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {}, __YOMIKA_SECURITY_BOOTSTRAP__: Object.freeze({ locked: false, passwordEnabled: false, credentialKind: 'password' }) });
  const ready = vi.fn();
  setInvokeAdapterForTests(async (name) => { if (name === 'app_security_ready') { ready(); return { ok: true, value: null }; } return new Promise(() => {}); });
  render(<AppSecurityGate><p>startup page</p></AppSecurityGate>);
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ready).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event('yomika-security-resume')));
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ready).not.toHaveBeenCalled();
});

it('refreshes an unprotected resume without a checking flash or a blocking error gate', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {}, __YOMIKA_SECURITY_BOOTSTRAP__: { locked: false, passwordEnabled: false, credentialKind: 'pattern' } });
  let failing = false;
  setInvokeAdapterForTests(async (name) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (failing) return { ok: false, error: { code: 'UNKNOWN', message: 'offline', retryable: true } };
    return { ok: true, value: { ...status, locked: false, passwordEnabled: false, hidePreview: false } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  await screen.findByRole('button', { name: '手势密码' });
  failing = true;
  act(() => window.dispatchEvent(new Event('yomika-security-resume')));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  await screen.findByRole('alert');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  await act(async () => emitTauriEvent('app-security-lock', null));
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('does not use browser storage or a protected bootstrap to bypass native status loading', () => {
  Object.assign(window, { __TAURI_INTERNALS__: {}, __YOMIKA_SECURITY_BOOTSTRAP__: { locked: true, passwordEnabled: true, credentialKind: 'pattern' } });
  localStorage.setItem('__YOMIKA_SECURITY_BOOTSTRAP__', JSON.stringify({ locked: false, passwordEnabled: false, credentialKind: 'pattern' }));
  setInvokeAdapterForTests(async () => new Promise(() => {}));
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  expect(document.body.dataset.appSecurityCovered).toBe('true');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('unlocks a configured gesture and keeps failed authentication safely covered', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const unlock = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_unlock_password') { unlock(args); return { ok: false, error: { code: 'APP_SECURITY_AUTH', message: 'wrong', retryable: true } }; }
    return { ok: true, value: name === 'app_security_ready' ? null : { ...status, credentialKind: 'pattern' } };
  });
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  await screen.findByRole('group', { name: '手势密码' });
  draw('手势密码', [0, 2, 5]);
  fireEvent.click(screen.getByRole('button', { name: '解锁' }));
  await waitFor(() => expect(unlock).toHaveBeenCalledWith({ password: '0125' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('手势错误');
  expect(document.body.dataset.appSecurityCovered).toBe('true');
});

it('toggles preview directly without credentials and requires current gesture when protected', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let protectedState = false;
  const configure = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_configure') configure(args);
    return { ok: true, value: name === 'app_security_ready' ? null : { ...status, locked: false, hidePreview: false, passwordEnabled: protectedState, credentialKind: 'pattern' } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  fireEvent.click(await screen.findByRole('switch', { name: '隐藏任务预览' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { hidePreview: true } }));
  expect(screen.queryByRole('dialog')).toBeNull();
  protectedState = true;
  await act(async () => emitTauriEvent('app-security-changed', { ...status, locked: false, hidePreview: false, credentialKind: 'pattern' }));
  configure.mockClear();
  fireEvent.click(screen.getByRole('switch', { name: '隐藏任务预览' }));
  draw('当前手势密码', [0, 2, 5]);
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { hidePreview: true, currentPassword: '0125' } }));
});


it('offers shared timeout choices, persists the chosen delay and removes manual locking', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  let delay = 300;
  const configure = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (name === 'app_security_configure') { configure(args); delay = (args as { config: { backgroundLockSeconds: number } }).config.backgroundLockSeconds; }
    return { ok: true, value: { ...status, locked: false, passwordEnabled: false, biometricEnabled: true, backgroundLockSeconds: delay, lockOnBackground: delay >= 0 } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  fireEvent.click(await screen.findByRole('button', { name: '后台自动锁定' }));
  expect(screen.queryByRole('button', { name: '立即锁定' })).toBeNull();
  for (const name of ['不锁定', '立即', '5 分钟', '15 分钟', '30 分钟', '60 分钟']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '5 分钟' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '15 分钟' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { backgroundLockSeconds: 900 } }));
  fireEvent.click(screen.getByRole('button', { name: '后台自动锁定' }));
  expect(screen.getByRole('button', { name: '15 分钟' })).toHaveAttribute('aria-pressed', 'true');
});

it('does not flash a checking screen or lock a delayed short background return', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const plain = { ...status, locked: false, backgroundLockSeconds: 300 };
  let complete!: (result: unknown) => void;
  let resumed = false;
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_ready') return { ok: true, value: null };
    if (name === 'app_security_status' && (args as { foreground?: boolean })?.foreground) { resumed = true; return new Promise(resolve => { complete = resolve; }); }
    return { ok: true, value: plain };
  });
  render(<AppSecurityGate><p>retained settings</p></AppSecurityGate>);
  await waitFor(() => expect(document.body.dataset.appSecurityCovered).toBeUndefined());
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.queryByText('正在检查安全状态')).toBeNull();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(resumed).toBe(true);
  expect(screen.queryByText('正在检查安全状态')).toBeNull();
  await act(async () => complete({ ok: true, value: plain }));
  expect(document.body.dataset.appSecurityCovered).toBeUndefined();
  expect(screen.queryByText('应用已锁定')).toBeNull();
});
