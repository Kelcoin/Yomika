import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../src/app/App';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setModelPickerForTests } from '../../src/bridge/filePicker';
import { DEFAULT_PREFERENCES, type PreferenceSnapshot } from '../../src/repositories/nativeSettingsRepository';
import { DlssnrSettingsGroup } from '../../src/components/DlssnrSettingsGroup';
import { ToastProvider } from '../../src/components/Toast';
import { parseDlssnrPasses, serializeDlssnrPasses } from '../../src/repositories/nativeDlssnrRepository';
import { parseRemoteOps, serializeRemoteOps } from '../../src/repositories/nativeComputeCenterRepository';

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
    await waitFor(() => expect(container.querySelector('[aria-label="DLSS5"]')).toBeNull());
    // 平台不满足时连 status 都不问：省一次往返，也不会闪一行「正在检测」。
    expect(setInvokeAdapterForTests).toBeTruthy();
  });

  it('locks the switch until a probe has actually run', async () => {
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

    const group = await screen.findByRole('region', { name: 'DLSS5' });
    const toggle = within(group).getByRole('switch', { name: '启用 DLSS5' });
    expect(toggle).toBeDisabled();

    await user.click(within(group).getByRole('button', { name: '检测' }));
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(toggle);
    await waitFor(() => expect(edits).toContainEqual({ dlssnrEnabled: true }));
  });

  it('keeps the switch locked when the last probe belongs to a different snippet', async () => {
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

    const group = await screen.findByRole('region', { name: 'DLSS5' });
    const toggle = within(group).getByRole('switch', { name: '启用 DLSS5' });
    expect(toggle).toBeDisabled();
    expect(within(group).getByText(/换过片段：先重启应用，再点一次「检测」/)).toBeTruthy();
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

    const group = await screen.findByRole('region', { name: 'DLSS5' });
    const snippets = await within(group).findByRole('group', { name: 'DLSS5 片段' });
    // 三条都在：官方版与社区版各占一行，装的是哪一条由后端认哈希回答。
    expect(within(snippets).getByText('NVIDIA 官方原版（RTX 50 系原生）')).toBeTruthy();
    expect(within(snippets).getByText('社区兼容版（RTX 40 / 50 系）（推荐）')).toBeTruthy();
    expect(within(snippets).getByText('FP16 兼容版（RTX 20 / 30 系，性能较低）')).toBeTruthy();
    expect(within(snippets).getByText('当前这一份')).toBeTruthy();
    // 许可要念出来：片段内嵌 NVIDIA 的 DLSS SDK。
    expect(within(snippets).getByText(/NVIDIA DLSS SDK License/)).toBeTruthy();

    // 只有没装上的那两条可以点（下载完的替换由后端负责）。
    const buttons = within(snippets).getAllByRole('button', { name: '下载并使用' });
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

    const group = await screen.findByRole('region', { name: 'DLSS5' });
    expect(within(group).getByRole('switch', { name: '启用 DLSS5' })).toBeDisabled();
    const snippets = await within(group).findByRole('group', { name: 'DLSS5 片段' });
    expect(within(snippets).getAllByRole('button', { name: '下载并使用' })).toHaveLength(3);
    // 还没有片段就没有「当前这一份」，导入那一行改说「按显卡系列选一种变体」。
    expect(within(snippets).queryByText('当前这一份')).toBeNull();
    expect(within(snippets).getByText(/也可以自己找一份来导入/)).toBeTruthy();
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

    const group = await screen.findByRole('region', { name: 'DLSS5' });
    await user.click(within(group).getByRole('button', { name: '增加一层' }));
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
});

describe('compute center settings group', () => {
  it('refuses to start when no capability is complete', async () => {
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
    const group = await screen.findByRole('region', { name: '算力中心' });
    expect(within(group).getByRole('switch', { name: '作为算力中心' })).toBeDisabled();
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

    const group = await screen.findByRole('region', { name: '算力中心' });
    // 地址与端口一起念给用户：移动端就填这两个。
    await waitFor(() => expect(within(group).getByText(/192\.168\.1\.5:47653/)).toBeTruthy());
    await user.click(within(group).getByRole('switch', { name: '作为算力中心' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_center_configure', expect.objectContaining({ enabled: true, port: 47_653 })));
  });

  it('keeps remote processing locked until an address and token are filled in', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      compute_center_status: () => ({ ok: true, value: computeStatus() }),
      remote_compute_capabilities: () => ({
        ok: true,
        value: {
          service: 'yomika-compute-center',
          version: 1,
          name: 'DESKTOP-PC',
          capabilities: [capability('upscale', true, '超分'), capability('dlssnr', true, 'DLSS5')],
        },
      }),
    });
    setInvokeAdapterForTests(adapter);
    renderAdvanced();

    const group = await screen.findByRole('region', { name: '远端算力' });
    const toggle = within(group).getByRole('switch', { name: '使用远端算力' });
    expect(toggle).toBeDisabled();

    const address = within(group).getByLabelText('远端地址');
    await user.type(address, '192.168.1.9:47653');
    await user.type(within(group).getByLabelText('远端令牌'), 'remote-token');
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(within(group).getByRole('button', { name: '连接' }));
    // 对面的能力是动态显示出来的：连上之前这一组根本不知道它有什么。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('remote_compute_capabilities', { url: '192.168.1.9:47653', token: 'remote-token' }));
    await waitFor(() => expect(within(group).getByText('DESKTOP-PC · 协议 v1')).toBeTruthy());
    expect(within(group).getByText('2 项可用')).toBeTruthy();
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
      source: 'decensored',
      op: { op: 'dlssnr', modelId: '', scale: 2, dlssnrPasses: [{ style: 1 }] },
    }));
    expect(ops.enabled).toBe(true);
    expect(ops.source).toBe('decensored');
    expect(ops.op.op).toBe('dlssnr');
    expect(parseRemoteOps('not json').op.op).toBe('upscale');
  });
});
