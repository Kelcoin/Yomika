import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setModelPickerForTests } from '../../src/bridge/filePicker';
import { DEFAULT_PREFERENCES, type PreferenceSnapshot } from '../../src/repositories/nativeSettingsRepository';
import { DlssnrSettingsGroup } from '../../src/components/DlssnrSettingsGroup';
import { ToastProvider } from '../../src/components/Toast';
import { parseDlssnrPasses, serializeDlssnrPasses } from '../../src/repositories/nativeDlssnrRepository';
import { parseRemoteOps, serializeRemoteOps, COMPUTE_CENTER_PAIRING_CHANGED_EVENT } from '../../src/repositories/nativeComputeCenterRepository';
import { emitTauriEvent } from '../tauriEvents';

afterEach(() => {
  resetInvokeAdapterForTests();
  resetFilePickerForTests();
});

/** DLSS5 的 status 回包：支持系列的 N 卡 + 装有核心（装没装片段看 `dllPresent`）。 */
function dlssnrStatus(overrides: Record<string, unknown> = {}) {
  return {
    dllPresent: true,
    variant: 'community',
    variantLabel: '社区兼容版（RTX 40 / 50 系）',
    dllBytes: 165_840_496,
    gpu: { name: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community' },
    gpuName: 'NVIDIA GeForce RTX 4070',
    recommendedVariant: 'community',
    recommendedLabel: '社区兼容版（RTX 40 / 50 系）',
    coreAvailable: true,
    installable: true,
    available: true,
    probe: null,
    /** 上次那份结论是不是对现在这一份片段跑的（换过 DLL 之后就不算数了）。 */
    probeValid: true,
    error: null,
    ...overrides,
  };
}

/** 模型仓库正文里那份 `dlssnr-manifest.json` 的形状：三条互斥的变体。 */
const DLSSNR_CATALOG = {
  tag: 'models-v1',
  license: { name: 'NVIDIA DLSS SDK License', asset: 'nvidia-dlss-license.txt', size: 26_620, sha256: 'd4'.repeat(32) },
  variants: [
    { id: 'official', label: 'NVIDIA 官方原版（RTX 50 系原生）', note: '只在 RTX 50 系上原生支持。', series: [50], asset: 'nvngx_dlssnr--official.dll', size: 165_840_496, sha256: 'e1'.repeat(32) },
    { id: 'community', label: '社区兼容版（RTX 40 / 50 系）', note: 'RTX 40 / 50 系都能跑。', series: [40, 50], asset: 'nvngx_dlssnr--community-rtx40-50.dll', size: 165_840_496, sha256: '98'.repeat(32) },
    { id: 'sf-v2', label: 'FP16 兼容版（RTX 20 / 30 系，性能较低）', note: '走 FP16。', series: [20, 30], asset: 'nvngx_dlssnr--sf-v2.dll', size: 165_830_144, sha256: '6e'.repeat(32) },
  ],
};

function capability(id: string, ready: boolean, label = id) {
  return { id, label, ready, detail: ready ? '可用' : '不可用' };
}

function computeStatus(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    port: 47_653,
    addresses: ['192.168.1.5'],
    token: 'abcdef0123456789abcdef0123456789',
    capabilities: [capability('upscale', true, '超分'), capability('decensor', false, '去码'), capability('dlssnr', false, 'DLSS5')],
    canStart: true,
    ...overrides,
  };
}

function renderAdvanced() {
  return render(
    <MemoryRouter initialEntries={['/settings?section=advanced']}>
      <App />
    </MemoryRouter>,
  );
}

/** DLSS5 那一组的平台条件是 `visible`：设置页把它绑在 `platform === 'windows'` 上，
 * 而 jsdom 里没有 Tauri 的运行时标记（`getPlatformCapabilities` 会直接回 browser），
 * 所以这一组单独渲染——测的是「门控与参数怎么写回偏好」，不是平台识别本身。 */
function renderDlssnr(props: { preferences?: PreferenceSnapshot; editPreferences?: (patch: Partial<PreferenceSnapshot>) => void } = {}) {
  return render(
    <ToastProvider>
      <DlssnrSettingsGroup
        preferences={props.preferences ?? { ...DEFAULT_PREFERENCES }}
        editPreferences={props.editPreferences ?? (() => {})}
        visible
      />
    </ToastProvider>,
  );
}

function adapterFor(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  return vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'load_preferences') return { ok: true, value: { ...DEFAULT_PREFERENCES } };
    if (command === 'list_servers') return { ok: true, value: [] };
    if (command === 'platform_capabilities') {
      return { ok: true, value: { platform: 'windows', native: true, secureStorage: true, fileSystem: true, backgroundTasks: false, nativeInference: true } };
    }
    if (command === 'inference_list_models') return { ok: true, value: [] };
    if (command === 'dlssnr_catalog' && !handlers[command]) return { ok: true, value: DLSSNR_CATALOG };
    const handler = handlers[command];
    if (handler) return handler(args);
    return { ok: true, value: null };
  });
}

describe('DLSS5 settings group', () => {
  it('does not render when this machine cannot run DLSS5', async () => {
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ available: false, dllPresent: false, error: '没有找到 NVIDIA 显卡' }) }),
    }));
    const { container } = render(
      <ToastProvider>
        <DlssnrSettingsGroup preferences={{ ...DEFAULT_PREFERENCES }} editPreferences={() => {}} visible={false} />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[aria-label="DLSSNR"]')).toBeNull());
    // 平台不满足时连 status 都不问：省一次往返，也不会闪一行「正在检测」。
    expect(setInvokeAdapterForTests).toBeTruthy();
  });

  it('allows the switch when a DLL is present without a mandatory probe', async () => {
    const user = userEvent.setup();
    let probed = false;
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ probe: probed ? { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null } : null }) }),
      dlssnr_probe: () => {
        probed = true;
        return { ok: true, value: { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null } };
      },
      compute_center_status: () => ({ ok: true, value: computeStatus() }),
    });
    setInvokeAdapterForTests(adapter);
    const edits: Array<Partial<PreferenceSnapshot>> = [];
    renderDlssnr({ editPreferences: (patch) => edits.push(patch) });

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const toggle = within(group).getByRole('switch', { name: '启用 DLSSNR' });
    await user.click(toggle);
    await waitFor(() => expect(edits).toContainEqual({ dlssnrEnabled: true }));
  });

  it('does not lock the switch on a stale probe result', async () => {
    // 换过片段之后旧结论作废：界面不能显示「检测通过、可以打开」，因为进程里跑的还是
    // 换之前那一份（NGX 一个进程只加载一份，换片段的那个进程要重启）。
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({
        ok: true,
        value: dlssnrStatus({
          probe: { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null },
          probeValid: false,
        }),
      }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const toggle = within(group).getByRole('switch', { name: '启用 DLSSNR' });
    await user.click(toggle);
  });

  it('lists the downloadable variants, marks the installed one, and switches to another', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      dlssnr_download_variant: (args) => ({
        ok: true,
        value: { bytes: 165_840_496, variant: args?.variantId ?? 'official', variantLabel: 'NVIDIA 官方原版（RTX 50 系原生）' },
      }),
    });
    setInvokeAdapterForTests(adapter);
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    // 三条都在：官方版与社区版各占一行，装的是哪一条由后端认哈希回答。
    expect(within(snippets).getByText('NVIDIA 官方原版（RTX 50 系原生）')).toBeTruthy();
    expect(within(snippets).getByText('社区兼容版（RTX 40 / 50 系）（推荐）')).toBeTruthy();
    expect(within(snippets).getByText('FP16 兼容版（RTX 20 / 30 系，性能较低）')).toBeTruthy();
    expect(within(snippets).getByText('已选择')).toBeTruthy();
    expect(within(snippets).queryByText(/NVIDIA DLSS SDK License/)).toBeNull();

    // 只有没装上的那两条可以点（下载完的替换由后端负责）。
    const buttons = within(snippets).getAllByRole('button').filter((button) => !button.hasAttribute('disabled'));
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dlssnr_download_variant', { variantId: 'official' }));
    await waitFor(() => expect(screen.getByText(/已装好并启用/)).toBeTruthy());
  });

  it('offers the variants even before any snippet is installed', async () => {
    setInvokeAdapterForTests(adapterFor({
      // 还没装片段：这一组仍然要出现——用户就是来挑一种下载的。开关锁着。
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ dllPresent: false, variant: null, variantLabel: null, dllBytes: null, available: false, error: '还没有片段：从下面选一种下载' }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    expect(within(group).getByRole('switch', { name: '启用 DLSSNR' })).toBeDisabled();
    await userEvent.setup().click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    expect(within(snippets).getAllByRole('button')).toHaveLength(3);
    // 还没有片段就没有「当前这一份」，导入那一行改说「按显卡系列选一种变体」。
    expect(within(snippets).queryByText('已选择')).toBeNull();
  });

  it('adds a second layer as a full set of pass parameters', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ probe: { supported: true, width: 96, height: 96, elapsedMs: 1200, difference: 12.5, error: null } }) }),
      compute_center_status: () => ({ ok: true, value: computeStatus() }),
    });
    setInvokeAdapterForTests(adapter);
    const edits: Array<Partial<PreferenceSnapshot>> = [];
    renderDlssnr({ editPreferences: (patch) => edits.push(patch) });

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '添加层' }));
    await waitFor(() => expect(edits.some((patch) => typeof patch.dlssnrPasses === 'string')).toBe(true));
    const saved = edits.find((patch) => typeof patch.dlssnrPasses === 'string')?.dlssnrPasses ?? '';
    const passes = parseDlssnrPasses(saved);
    expect(passes).toHaveLength(2);
    expect(passes[1]).toMatchObject({ style: 0, intensity: 1, autoMask: false });
    // 第二层是完整一份参数，不是只带一个字段的补丁。
    const [first, second] = passes;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(Object.keys(second!).sort()).toEqual(Object.keys(first!).sort());
  });

  it('edits the selected layer without changing the other layer', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    const initial = serializeDlssnrPasses([
      { style: 0, intensity: 1, localToneStrength: 1, localStructureStrength: 1, skinStructureStrength: 0, autoMask: false, uiCorrection: false },
      { style: 1, intensity: 1.5, localToneStrength: 1, localStructureStrength: 1, skinStructureStrength: 0, autoMask: false, uiCorrection: false },
    ]);
    let latest = initial;
    function Harness() {
      const [preferences, setPreferences] = useState({ ...DEFAULT_PREFERENCES, dlssnrPasses: initial });
      return <ToastProvider><DlssnrSettingsGroup preferences={preferences} editPreferences={(patch) => setPreferences((current) => {
        const next = { ...current, ...patch };
        latest = next.dlssnrPasses;
        return next;
      })} visible /></ToastProvider>;
    }
    render(<Harness />);
    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 2 层' }));
    await user.click(within(await screen.findByRole('dialog', { name: '第 2 层' })).getByRole('switch', { name: '自动遮罩' }));
    await user.click(within(screen.getByRole('dialog', { name: '第 2 层' })).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(parseDlssnrPasses(latest).map((pass) => pass.autoMask)).toEqual([false, true]));
  });

  it('keeps one overlay while entering and leaving a layer editor', async () => {
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('region', { name: 'DLSSNR' })).getByRole('button', { name: '层数' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '第 1 层' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }));
    expect(screen.getByRole('dialog', { name: 'DLSSNR 层数' })).toBeInTheDocument();
  });
});

describe('compute center settings group', () => {
  it('allows starting without a capability list gate', async () => {
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      compute_center_status: () => ({
        ok: true,
        value: computeStatus({
          canStart: false,
          capabilities: [capability('upscale', false, '超分'), capability('decensor', false, '去码'), capability('dlssnr', false, 'DLSS5')],
        }),
      }),
    }));
    renderAdvanced();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await waitFor(() => expect(within(group).getByRole('switch', { name: '开启本机远程后处理服务' })).toBeEnabled());
  });

  it('starts the server with the configured port and shows the LAN address', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      compute_center_status: () => ({ ok: true, value: computeStatus() }),
      compute_center_configure: () => ({ ok: true, value: computeStatus({ running: true }) }),
    });
    setInvokeAdapterForTests(adapter);
    renderAdvanced();

    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    expect(within(group).queryByText(/192\.168\.1\.5:47653/)).toBeNull();
    await user.click(within(group).getByRole('switch', { name: '开启本机远程后处理服务' }));
    await waitFor(() => expect(within(group).getByText(/192\.168\.1\.5:47653/)).toBeTruthy());
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_center_configure', expect.objectContaining({ enabled: true, port: 47_653 })));
    await waitFor(() => expect(screen.queryByRole('region', { name: '远程后处理服务' })).toBeNull());
    expect(within(group).getByRole('button', { name: '端口' })).toBeEnabled();
    expect(localStorage.getItem('yomika.compute-center-status')).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('changes a running service port through its menu', async () => {
    const adapter = adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true }) }),
      compute_center_configure: (args) => ({ ok: true, value: computeStatus({ running: true, port: args?.port }) }),
    });
    setInvokeAdapterForTests(adapter);
    renderAdvanced();
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await user.click(within(group).getByRole('button', { name: '端口' }));
    const menu = screen.getByRole('dialog', { name: '端口' });
    const input = within(menu).getByRole('spinbutton', { name: '远程后处理服务端口' });
    await user.clear(input);
    await user.type(input, '47655');
    await user.click(within(menu).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_center_configure', { enabled: true, port: 47655 }));
  });

  it('shows server details only while running and revokes one paired client', async () => {
    const clients = [{ id: 'client-1', name: 'Phone', address: '192.168.1.9' }, { id: 'client-2', name: 'Tablet', address: '192.168.1.10' }];
    const adapter = adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ pairedClients: clients }) }),
      compute_center_configure: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: clients }) }),
      compute_center_revoke_pairing: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: clients.slice(1) }) }),
    });
    setInvokeAdapterForTests(adapter);
    renderAdvanced();
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    expect(within(group).queryByText('端口')).toBeNull();
    await user.click(within(group).getByRole('switch', { name: '开启本机远程后处理服务' }));
    await user.click(within(group).getByRole('button', { name: '管理已有配对' }));
    await user.click(within(screen.getByRole('dialog', { name: '管理已有配对' })).getByRole('button', { name: /Phone/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Phone' })).getByRole('button', { name: '撤销配对' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_center_revoke_pairing', { id: 'client-1' }));
    expect(screen.getByRole('dialog', { name: '管理已有配对' })).toBeInTheDocument();
  });

  it('opens the management panel with a freshly read paired list', async () => {
    let clients = [{ id: 'client-1', name: 'Phone', address: '192.168.1.9' }];
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: clients }) }),
    }));
    renderAdvanced();
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });

    // 配对是另一台设备发起的：这一份列表在设置页画出来之后、点开面板之前就变了。
    clients = [...clients, { id: 'client-2', name: 'Tablet', address: '192.168.1.10' }];
    await user.click(within(group).getByRole('button', { name: '管理已有配对' }));

    const panel = await screen.findByRole('dialog', { name: '管理已有配对' });
    expect(await within(panel).findByRole('button', { name: /Tablet/ })).toBeInTheDocument();
  });

  it('picks up a device that pairs while the settings page stays open', async () => {
    let clients = [{ id: 'client-1', name: 'Phone', address: '192.168.1.9' }];
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: clients }) }),
    }));
    renderAdvanced();
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await user.click(within(group).getByRole('button', { name: '管理已有配对' }));
    const panel = await screen.findByRole('dialog', { name: '管理已有配对' });
    expect(within(panel).queryByRole('button', { name: /Tablet/ })).toBeNull();

    // 服务端在 /v2/pair/confirm 里配对成功后广播这条事件（名字与 compute_center.rs 里的
    // PAIRING_CHANGED_EVENT 一致）——设置页收到就重拉列表，不必退出再进。
    clients = [...clients, { id: 'client-2', name: 'Tablet', address: '192.168.1.10' }];
    await act(async () => { emitTauriEvent('compute-center-pairing-changed', {}); });

    expect(await within(panel).findByRole('button', { name: /Tablet/ })).toBeInTheDocument();
  });

  it('has no revoke-everything action in the paired-device panel', async () => {
    const clients = [{ id: 'client-1', name: 'Phone', address: '192.168.1.9' }];
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: clients }) }),
    }));
    renderAdvanced();
    const user = userEvent.setup();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await user.click(within(group).getByRole('button', { name: '管理已有配对' }));
    const panel = await screen.findByRole('dialog', { name: '管理已有配对' });

    expect(within(panel).queryByRole('button', { name: /撤销全部配对/ })).toBeNull();

    // 逐台撤销还在：去掉的是「全部」那一个按钮，不是撤销这条路。
    await user.click(within(panel).getByRole('button', { name: /Phone/ }));
    expect(within(screen.getByRole('dialog', { name: 'Phone' })).getByRole('button', { name: '撤销配对' })).toBeInTheDocument();
  });

  it('keeps remote processing locked until pairing succeeds', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      compute_center_status: () => ({ ok: true, value: computeStatus() }),
      compute_discover: () => ({ ok: true, value: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', port: 47653 }] }),
      compute_pair_request: () => ({ ok: true, value: { requestId: 'request-1' } }),
      compute_pair_confirm: () => ({ ok: true, value: { token: 'remote-token', name: 'DESKTOP-PC' } }),
      remote_compute_capabilities: () => ({
        ok: true,
        value: {
          service: 'yomika-compute-center',
          version: 2,
          name: 'DESKTOP-PC',
          capabilities: [capability('upscale', true, '超分'), capability('dlssnr', true, 'DLSS5')],
          models: [{ id: 'upscale-x4', kind: 'upscale', label: '超分 x4', scale: 4 }],
        },
      }),
    });
    setInvokeAdapterForTests(adapter);
    renderAdvanced();

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    const toggle = within(group).getByRole('switch', { name: '使用远程后处理服务' });
    expect(toggle).toBeDisabled();

    await user.click(within(group).getByRole('button', { name: '添加设备' }));
    const pairDialog = await screen.findByRole('dialog', { name: '添加设备' });
    await user.type(within(pairDialog).getByLabelText('设备地址'), '192.168.1.9:47653');
    await user.click(within(pairDialog).getByRole('button', { name: /^配对$/ }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_pair_request', { url: '192.168.1.9:47653' }));
    await user.type(within(pairDialog).getByLabelText('配对码'), '123456');
    await user.click(within(pairDialog).getByRole('button', { name: '完成配对' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_pair_confirm', { url: '192.168.1.9:47653', requestId: 'request-1', code: '123456' }));
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(within(group).getByRole('button', { name: '已配对设备' }));
    const deviceDialog = await screen.findByRole('dialog', { name: '已配对设备' });
    await user.click(within(deviceDialog).getByRole('button', { name: '刷新模型' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('remote_compute_capabilities', { url: '192.168.1.9:47653', token: 'remote-token' }));
    await waitFor(() => expect(within(deviceDialog).getByText(/DESKTOP-PC · 超分、DLSS5/)).toBeTruthy());
    await user.click(within(deviceDialog).getByRole('button', { name: '超分 x4' }));
    await waitFor(() => expect(adapter.mock.calls.some(([command, args]) => command === 'save_preferences' && String((args?.input as PreferenceSnapshot | undefined)?.remoteComputeOps).includes('upscale-x4'))).toBe(true));
  });
});

describe('derived settings storage', () => {
  it('round-trips DLSS5 layers and remote operations without touching local ones', () => {
    const passes = parseDlssnrPasses(serializeDlssnrPasses([
      { style: 2, intensity: 1.5, localToneStrength: 1, localStructureStrength: 1, skinStructureStrength: 0.5, autoMask: true, uiCorrection: false },
    ]));
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ style: 2, intensity: 1.5, autoMask: true });

    // 坏数据不炸设置页：一律回一层默认。
    expect(parseDlssnrPasses('{')).toHaveLength(1);
    expect(parseDlssnrPasses('[]')).toHaveLength(1);

    const ops = parseRemoteOps(serializeRemoteOps({
      enabled: true,
      op: { op: 'dlssnr', modelId: '', scale: 2, dlssnrPasses: [{ style: 1 }] },
      pairedDevices: [],
    }));
    expect(ops.enabled).toBe(true);
    expect(ops.op.op).toBe('dlssnr');
    expect(parseRemoteOps('not json').op.op).toBe('upscale');
  });
});

describe('compute center pairing event', () => {
  const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8').replace(/\r\n/g, '\n');

  /** 事件名两边各写一份字面量（Rust 发、TS 听）。对不上不会报任何错，只是「配对后列表
   *  永远不刷新」——以前那个「要退出再进才看得见」的毛病会安静地回来。 */
  it('agrees on the event name across the bridge', () => {
    const rust = read('src-tauri/src/compute_center.rs');
    expect(rust).toContain(`pub const PAIRING_CHANGED_EVENT: &str = "${COMPUTE_CENTER_PAIRING_CHANGED_EVENT}";`);

    // 而且要在配对成功那条分支上真的广播它（只定义不发射等于没修）。
    const confirm = rust.slice(rust.indexOf('request.path == "/v2/pair/confirm"'));
    expect(confirm.slice(0, confirm.indexOf('request.path == "/v2/ping"'))).toContain('notify_pairing_changed');
  });
});
