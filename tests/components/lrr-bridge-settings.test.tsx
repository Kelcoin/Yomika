import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setInvokeAdapterForTests, resetInvokeAdapterForTests } from '../../src/bridge/invoke';
import { invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';
import { LrrBridgeSettings } from '../../src/components/LrrBridgeSettings';
afterEach(() => { resetInvokeAdapterForTests(); invalidateLrrBridgeConfig(); });
it('requires successful detection and keeps mode disabled when enabling fails', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: false, pending: 0, conflicts: 0 } };
    if (command === 'lrr_bridge_request') return { ok: true, value: { protocol: 1, serverId: 's', epoch: 'e', version: 0 } };
    return { ok: false, error: { code: 'NETWORK', message: 'offline', retryable: true } };
  });
  setInvokeAdapterForTests(adapter);
  render(<LrrBridgeSettings scopeId="s" />);
  expect(screen.getByRole('switch', { name: '服务器托管用户数据' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: '检测已安装的插件' })).toBeEnabled());
  expect(adapter).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '检测已安装的插件' }));
  await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByText(/无法更改托管模式/);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText(/已有本机数据不会自动上传/)).toBeInTheDocument();
});

it('requires explicit confirmation before abandoning offline modifications', async () => {
  const actions: unknown[] = [];
  setInvokeAdapterForTests(async (command, args) => {
    if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 2, conflicts: 0 } };
    actions.push(args?.action);
    return { ok: true, value: { enabled: false, pending: 0, conflicts: 0 } };
  });
  render(<LrrBridgeSettings scopeId="s" />);
  fireEvent.click(await screen.findByRole('button', { name: '停用并恢复原本机数据' }));
  expect(actions).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '放弃待提交修改并停用' }));
  await screen.findByText('已停用托管并恢复原本机数据，服务器数据未改动。');
  expect(actions).toEqual(['abandon_pending']);
});
