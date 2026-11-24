import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LrrBridgeSettings } from '../../src/components/LrrBridgeSettings';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setSavePickerForTests, setTextFilePickerForTests } from '../../src/bridge/filePicker';
import { invalidateLrrBridgeConfig } from '../../src/repositories/nativeLrrBridgeRepository';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
  invalidateLrrBridgeConfig();
});

const pluginStatus = { available: true, version: '1.3.0' };
const metadata = { protocol: 1, serverId: 's', epoch: 'e', version: 7 };
const hostedState = (archiveId: string, over: Record<string, unknown> = {}) => ({
  archiveId, version: 7, generation: 0,
  progress: null, historyAt: null, watchlistAt: null,
  ...over,
});

it('detects the installed plugin automatically and restores local data with the switch', async () => {
  const adapter = vi.fn(async (command: string) => {
    if (command === 'lrr_bridge_request') return { ok: true, value: pluginStatus };
    return { ok: true, value: { enabled: command === 'lrr_bridge_config', pending: 2, conflicts: 1 } };
  });
  setInvokeAdapterForTests(adapter);
  render(<LrrBridgeSettings scopeId="s" />);
  const toggle = screen.getByRole('switch', { name: '服务器托管用户数据' });
  expect(toggle).toBeDisabled();
  await screen.findByText('插件可用 · v1.3.0');
  expect(toggle).toBeEnabled();
  expect(screen.getAllByRole('switch')).toHaveLength(1);
  // 数据搬家的两个入口就在这一页：待看、历史与非重复标记由插件托管，导出与旧数据
  // 导入都得对着插件做，而不是设置里那份本机导入导出。
  expect(screen.getByRole('button', { name: '导出托管数据' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '导入旧数据' })).toBeEnabled();
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

it('exports what the plugin hosts, not the local mirror', async () => {
  const saved: { path: string; contents: string }[] = [];
  setInvokeAdapterForTests(async (command, args) => {
    if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
    if (command === 'lrr_bridge_request') {
      const action = args?.action;
      if (action === 'plugin_status') return { ok: true, value: pluginStatus };
      if (action === 'export') {
        return { ok: true, value: { ...metadata, states: [
          hostedState('a1', { historyAt: '2026-09-13T09:35:33.362Z', historyPageIndex: 148 }),
          hostedState('a2', { watchlistAt: '2026-09-01T08:00:00.000Z' }),
        ], total: 2 } };
      }
      if (action === 'collection_list') {
        return { ok: true, value: { records: [{
          collection: 'non_duplicates', key: 'aaa:bbb', version: 1,
          value: { archiveIdA: 'aaa', archiveIdB: 'bbb' }, createdAt: null, updatedAt: null,
        }] } };
      }
    }
    if (command === 'save_text_file') {
      saved.push(args as { path: string; contents: string });
      return { ok: true, value: 'C:/tmp/yomika-bridge.json' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  setSavePickerForTests(async () => 'C:/tmp/yomika-bridge.json');
  render(<LrrBridgeSettings scopeId="s" />);
  await screen.findByText('插件可用 · v1.3.0');
  fireEvent.click(screen.getByRole('button', { name: '导出托管数据' }));

  await waitFor(() => expect(saved).toHaveLength(1));
  const document = JSON.parse(saved[0]!.contents);
  expect(document.kind).toBe('yomika-bridge-transfer');
  expect(document.serverScope).toBe('s');
  expect(document.history).toEqual([
    { archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13T09:35:33.362Z' },
  ]);
  expect(document.watchlist).toEqual([
    { archiveId: 'a2', addedAt: '2026-09-01T08:00:00.000Z' },
  ]);
  expect(document.nonDuplicates).toEqual([{ archiveIdA: 'aaa', archiveIdB: 'bbb' }]);
});

it('writes an old export into the plugin instead of the local database', async () => {
  const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
  setInvokeAdapterForTests(async (command, args) => {
    calls.push({ command, args });
    if (command === 'lrr_bridge_config') return { ok: true, value: { enabled: true, pending: 0, conflicts: 0 } };
    if (command === 'read_text_file') {
      return { ok: true, value: JSON.stringify({
        kind: 'yomika-bridge-transfer',
        version: 1,
        exportedAt: '2026-09-13T12:21:55.353Z',
        serverScope: 's',
        watchlist: [{ archiveId: 'w1', addedAt: '2026-09-04T16:36:57.490Z' }],
        history: [{ archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13T09:35:33.362Z' }],
        nonDuplicates: [{ archiveIdA: 'aaa', archiveIdB: 'bbb' }],
      }) };
    }
    if (command === 'lrr_bridge_request') {
      const action = args?.action;
      if (action === 'plugin_status') return { ok: true, value: pluginStatus };
      if (action === 'apply') return { ok: true, value: { state: hostedState('w1'), queued: true } };
      if (action === 'import_history') return { ok: true, value: { imported: 1 } };
      if (action === 'collection_apply') {
        return { ok: true, value: { queued: true, record: {
          collection: 'non_duplicates', key: 'aaa:bbb', version: 1,
          value: { archiveIdA: 'aaa', archiveIdB: 'bbb' }, createdAt: null, updatedAt: null,
        } } };
      }
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  setTextFilePickerForTests(async () => 'C:/tmp/old-export.json');
  render(<LrrBridgeSettings scopeId="s" />);
  await screen.findByText('插件可用 · v1.3.0');
  fireEvent.click(screen.getByRole('button', { name: '导入旧数据' }));

  await waitFor(() => expect(calls.some(call => call.args?.action === 'collection_apply')).toBe(true));
  // 历史走插件的 import_history（服务端只收更新的），待看与非重复标记逐条写。
  const history = calls.find(call => call.args?.action === 'import_history');
  expect(history?.args).toMatchObject({ scopeId: 's', input: { entries: [
    { archiveId: 'a1', pageIndex: 148, visitedAt: '2026-09-13T09:35:33.362Z' },
  ] } });
  const watchlist = calls.find(call => call.args?.action === 'apply');
  expect(watchlist?.args).toMatchObject({ scopeId: 's', input: { operation: { archiveId: 'w1', kind: 'watchlist_add' } } });
  const pair = calls.find(call => call.args?.action === 'collection_apply');
  expect(pair?.args).toMatchObject({ scopeId: 's', input: { operation: {
    collection: 'non_duplicates', key: 'aaa:bbb', value: { archiveIdA: 'aaa', archiveIdB: 'bbb' },
  } } });
  // 应用自己的本机导入命令一次都没被调用。
  expect(calls.some(call => call.command === 'import_worker_export')).toBe(false);
  expect(calls.some(call => call.command === 'import_scoped_data')).toBe(false);
});

it('locks both transfer rows until the plugin is hosting the data', async () => {
  setInvokeAdapterForTests(async (command: string) => {
    if (command === 'lrr_bridge_request') return { ok: true, value: pluginStatus };
    return { ok: true, value: { enabled: false, pending: 0, conflicts: 0 } };
  });
  render(<LrrBridgeSettings scopeId="s" />);
  await screen.findByText('插件可用 · v1.3.0');
  expect(screen.getByRole('button', { name: '导出托管数据' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '导入旧数据' })).toBeDisabled();
});
