import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LrrBridgeSettings } from '../../src/components/LrrBridgeSettings';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';

afterEach(() => { resetInvokeAdapterForTests(); invalidateLrrBridgeConfig(); });

const pluginStatus = { available: true, version: '1.2.2' };

it('detects the installed plugin automatically and restores local data with the switch', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'lrr_bridge_request') return { ok: true, value: pluginStatus };
    return { ok: true, value: { enabled: command === 'lrr_bridge_config', pending: 2, conflicts: 1 } };
  });
  setInvokeAdapterForTests(adapter);
  render(<LrrBridgeSettings scopeId="s" />);
  const toggle = screen.getByRole('switch', { name: '服务器托管用户数据' });
  expect(toggle).toBeDisabled();
  await screen.findByText('插件可用 · v1.2.2');
  expect(toggle).toBeEnabled();
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  expect(adapter).toHaveBeenCalledWith('lrr_bridge_configure', { scopeId: 's', enabled: false });
});

it('keeps the existing setting locked when the plugin cannot be reached', async () => {
  setInvokeAdapterForTests(async command => command === 'lrr_bridge_config'
    ? { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } }
    : { ok: false, error: { code: 'INFERENCE_UNAVAILABLE', message: 'offline', retryable: true } });
  render(<LrrBridgeSettings scopeId="s" />);
  await screen.findByText('插件不可用');
  const toggle = screen.getByRole('switch');
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('aria-checked', 'true');
});
