import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppSecurityGate } from '../src/components/AppSecurityGate';
import { SecuritySettings } from '../src/components/SecuritySettings';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../src/bridge/invoke';
import { closeTopOverlay } from '../src/lib/overlayBackGuard';
import { emitTauriEvent } from './tauriEvents';

const status = { locked: true, passwordEnabled: true, biometricEnabled: false, lockOnBackground: true, hidePreview: true, biometricAvailable: false, previewProtectionAvailable: true, platformNote: '' };
afterEach(() => { cleanup(); resetInvokeAdapterForTests(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });

it('names Windows Hello explicitly for the system PIN or biometric unlock entry', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  setInvokeAdapterForTests(async (name) => ({ ok: true, value: name === 'app_security_ready' ? null : { ...status, biometricEnabled: true, biometricAvailable: true, biometricLabel: 'Windows Hello' } }));
  render(<AppSecurityGate><p>private content</p></AppSecurityGate>);
  expect(await screen.findByRole('button', { name: '使用Windows Hello' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '使用生物认证' })).not.toBeInTheDocument();
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

it('requires matching new passwords and current-password authentication for changes', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const configure = vi.fn();
  setInvokeAdapterForTests(async (name, args) => {
    if (name === 'app_security_configure') configure(args);
    return { ok: true, value: name === 'app_security_ready' ? null : { ...status, locked: false } };
  });
  render(<AppSecurityGate><SecuritySettings /></AppSecurityGate>);
  await screen.findByRole('button', { name: '密码保护' });
  fireEvent.click(screen.getByRole('button', { name: '密码保护' }));
  fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'old-secret' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-secret' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'different' } });
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致');
  expect(configure).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(configure).toHaveBeenCalledWith({ config: { password: 'new-secret', currentPassword: 'old-secret' } }));
});
