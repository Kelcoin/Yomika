import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { App } from '../../src/app/App';
import { RetainedPage } from '../../src/app/RetainedPage';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { resetFilePickerForTests, setModelPickerForTests } from '../../src/bridge/filePicker';
import { DEFAULT_PREFERENCES, type PreferenceSnapshot } from '../../src/repositories/nativeSettingsRepository';
import { DlssnrSettingsGroup } from '../../src/components/DlssnrSettingsGroup';
import { ToastProvider } from '../../src/components/Toast';
import { MAX_DLSSNR_PASSES, parseDlssnrPasses, serializeDlssnrPasses } from '../../src/repositories/nativeDlssnrRepository';
import { parseRemoteOps, serializeRemoteOps, DEFAULT_REMOTE_OPS, COMPUTE_CENTER_PAIRING_CHANGED_EVENT } from '../../src/repositories/nativeComputeCenterRepository';
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
    variantLabel: 'Lecram 版',
    dllBytes: 165_840_496,
    gpu: { name: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community' },
    gpuName: 'NVIDIA GeForce RTX 4070',
    recommendedVariant: 'community',
    recommendedLabel: 'Lecram 版',
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
    { id: 'community', label: 'Lecram 版', note: 'RTX 40 / 50 系都能跑。', series: [40, 50], asset: 'nvngx_dlssnr--community-rtx40-50.dll', size: 165_840_496, sha256: '98'.repeat(32) },
    { id: 'sf-v2', label: 'SF 版', note: '走 FP16。', series: [20, 30, 40, 50], asset: 'nvngx_dlssnr--sf-v2.dll', size: 165_830_144, sha256: '6e'.repeat(32) },
  ],
};

/** 库里的三种已装片段（`dlssnr_status.installedVariants`）：一个变体一个文件，谁都没顶掉谁。
 *  最后一份是后端认不出的（`id` / `label` 都是 null）——文件名就是它唯一的名字。 */
const DLSSNR_LIBRARY = [
  { id: 'community', label: 'Lecram 版', bytes: 165_840_496, active: false, file: 'nvngx_dlssnr--community-rtx40-50.dll' },
  { id: 'sf-v2', label: 'SF 版', bytes: 165_830_144, active: true, file: 'nvngx_dlssnr--sf-v2.dll' },
  { id: null, label: null, bytes: 165_840_496, active: false, file: 'nvngx_dlssnr--custom.dll' },
];

function capability(id: string, ready: boolean, label = id) {
  return { id, label, ready, detail: ready ? '可用' : '不可用' };
}

function computeStatus(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    port: 47_653,
    addresses: ['192.168.1.5'],
    token: 'abcdef0123456789abcdef0123456789',
    capabilities: [capability('upscale', true, '超分'), capability('dlssnr', false, 'DLSS5')],
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

describe('local DLL import verification', () => {
  it('shows validation while a custom version is probed and reports the verified version', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    setInvokeAdapterForTests(adapterFor({ dlssnr_import_dll: () => pending }));
    setModelPickerForTests(async () => 'C:/custom/nvngx_dlssnr.dll');
    renderAdvanced();
    const button = await screen.findByRole('button', { name: '选择模型文件…' });
    fireEvent.click(button);
    expect(await screen.findByRole('button', { name: '正在验证 DLL…' })).toBeDisabled();
    await act(async () => finish({ ok: true, value: {
      bytes: 165840496, variant: null, variantLabel: null, version: '311.0.0.0',
      verification: { supported: true, width: 96, height: 96, elapsedMs: 21, difference: 4, error: null },
    } }));
    expect(await screen.findByText('DLSSNR 组件已导入：自定义 DLL · 311.0.0.0 · 本机验证通过（96×96）')).toBeInTheDocument();
  });

  it('shows the validation failure without announcing an installed DLL', async () => {
    setInvokeAdapterForTests(adapterFor({ dlssnr_import_dll: () => ({
      ok: false, error: { code: 'INVALID_RESPONSE', message: 'DLL 本机验证超时（60 秒）；保留原 DLL', retryable: false },
    }) }));
    setModelPickerForTests(async () => 'C:/custom/nvngx_dlssnr.dll');
    const imported = vi.fn();
    window.addEventListener('yomika:dlssnr-imported', imported);
    try {
      renderAdvanced();
      fireEvent.click(await screen.findByRole('button', { name: '选择模型文件…' }));
      expect(await screen.findByText('DLL 本机验证超时（60 秒）；保留原 DLL')).toBeInTheDocument();
      expect(imported).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '选择模型文件…' })).toBeEnabled();
    } finally { window.removeEventListener('yomika:dlssnr-imported', imported); }
  });
});

describe('DLSS5 settings group', () => {
  it.each(['page', 'group'] as const)('retires nested layer editing when the %s hides', async (kind) => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    function Owner({ shown }: { shown: boolean }) {
      return <RetainedPage active={kind === 'page' ? shown : true}><ToastProvider>
        <DlssnrSettingsGroup visible={kind === 'group' ? shown : true} preferences={DEFAULT_PREFERENCES} editPreferences={vi.fn()} />
      </ToastProvider></RetainedPage>;
    }
    const view = render(<Owner shown />);
    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));
    await user.click(within(await screen.findByRole('dialog', { name: '第 1 层' })).getByRole('button', { name: '参数说明' }));
    expect(await screen.findByRole('note', { name: '层参数说明' })).toBeInTheDocument();
    view.rerender(<Owner shown={false} />);
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('note', { hidden: true })).not.toBeInTheDocument();
    view.rerender(<Owner shown />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('region', { name: 'DLSSNR' })).getByRole('button', { name: '层数' }));
    expect(screen.getByRole('dialog', { name: 'DLSSNR 层数' })).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('ignores a malformed cached variant list while refreshing the actual catalog', async () => {
    localStorage.setItem('yomika.dlssnr-status', JSON.stringify(dlssnrStatus()));
    localStorage.setItem('yomika.dlssnr-catalog', JSON.stringify({ tag: 'old', variants: [null] }));
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      dlssnr_catalog: () => ({ ok: true, value: DLSSNR_CATALOG }),
    }));
    renderDlssnr();
    expect(await screen.findByRole('button', { name: 'DLSSNR 组件' })).toBeInTheDocument();
  });

  it('does not render, and does not ask for a status, while the group is hidden', async () => {
    // 平台门控在调用点（设置页把它绑在 `platform === 'windows'` 上），所以这一条盯的是
    // 隐藏时的行为：连 status 都不问——省一次往返，也不会闪一行「正在检测」。
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
    });
    setInvokeAdapterForTests(adapter);
    const { container } = render(
      <ToastProvider>
        <DlssnrSettingsGroup preferences={{ ...DEFAULT_PREFERENCES }} editPreferences={() => {}} visible={false} />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[aria-label="DLSSNR"]')).toBeNull());
    expect(adapter.mock.calls.some(([command]) => command === 'dlssnr_status')).toBe(false);
  });

  it('reports which version of the snippet is installed, not just which variant', async () => {
    // 「装的是哪一条」与「装的是哪一版」是两件事：变体按我们认得的三种哈希回答，版本号
    // 只有文件自己的版本资源说得出来（导入一份社区新发的 DLL 时变体认不出，版本照样有）。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ dllVersion: '310.8.0.0' }) }),
    }));
    renderDlssnr();
    // 组件那一行的值：变体名后面跟版本号。
    expect(await screen.findByText('Lecram 版 · 310.8.0.0')).toBeInTheDocument();
    // 开关那一行的说明也跟着带上，用户不用打开菜单就知道装的是哪一版。
    expect(screen.getByText('Lecram 版 · 310.8.0.0 · NVIDIA GeForce RTX 4070')).toBeInTheDocument();
  });

  it('says nothing about a version it cannot read', async () => {
    // 读不出来就是不说：留个「未知」会与「没有片段」混在一起，比不写更糟。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ dllVersion: null }) }),
    }));
    renderDlssnr();
    expect(await screen.findByText('Lecram 版')).toBeInTheDocument();
    expect(screen.queryByText(/未知/)).toBeNull();
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
    // 换之前那一份（NGX 一个进程只加载一份，换片段的那个进程要重启）。`probeValid`
    // 只是目录里的一条记录：开关只认「现在能不能跑」，不认「上一次检测过没过」。
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
    const edits: Array<Partial<PreferenceSnapshot>> = [];
    renderDlssnr({ editPreferences: (patch) => edits.push(patch) });

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const toggle = within(group).getByRole('switch', { name: '启用 DLSSNR' });
    // 旧结论作废不等于「跑不起来」：开关照常能打开，写回的还是同一条偏好。
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await waitFor(() => expect(edits).toContainEqual({ dlssnrEnabled: true }));
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
    expect(within(snippets).getByText('Lecram 版（推荐）')).toBeTruthy();
    expect(within(snippets).getByText('SF 版')).toBeTruthy();
    expect(within(snippets).queryByText(/NVIDIA DLSS SDK License/)).toBeNull();

    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    // 行里不再有「使用中」「DLL 体积」「下载中 N%」那行文字：这一排和模型菜单同一个样子。
    expect(within(snippets).queryByText(/使用中/)).toBeNull();
    expect(within(snippets).queryByText(/MB/)).toBeNull();
    expect(within(snippets).queryByText(/下载中/)).toBeNull();

    // 装上的那一条：高亮 + aria-pressed，右侧没有下载按钮（没东西可下）。
    const installedRow = rows.find((row) => row.classList.contains('is-active'))!;
    expect(installedRow.querySelector('.settings-choice-option-main')?.getAttribute('aria-pressed')).toBe('true');
    expect(installedRow.querySelector('button.select-option-download')).toBeNull();

    // 没装上的两条右侧各有一个可点的下载按钮，无障碍名以「下载」开头。
    const downloadButtons = [...snippets.querySelectorAll<HTMLButtonElement>('button.select-option-download')];
    expect(downloadButtons).toHaveLength(2);
    expect(downloadButtons[0]!.getAttribute('aria-label')).toMatch(/^下载/);
    downloadButtons.forEach((button) => expect(button.disabled).toBe(false));

    // 三条行体都是活的：选中的那一条也是可聚焦的按钮，只是点它不会重复下载（它是
    // 「当前这一份」，不是不可用）。这一行原来断言「只有没装上的两条可以点」，正好把
    // 「选中行被 disabled、文字跟着灰掉」那个毛病钉死在测试里。
    const mainButtons = [...snippets.querySelectorAll<HTMLButtonElement>('.settings-choice-option-main')];
    expect(mainButtons).toHaveLength(DLSSNR_CATALOG.variants.length);
    mainButtons.forEach((button) => expect(button).not.toBeDisabled());
    await user.click(within(rows[0]!).getByRole('button', { name: /^下载/ }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dlssnr_download_variant', { variantId: 'official' }));
    await waitFor(() => expect(screen.getByText(/已装好并启用/)).toBeTruthy());
  });

  it('marks the component row when the catalog carries other bytes than the one on disk', async () => {
    const user = userEvent.setup();
    // 官方原版与Lecram 版**字节数完全相同**（165,840,496）：换过资产只能看哈希。盘上那份
    // 是老哈希（内置表还认得出这是 community），清单里那条已经是别的字节 —— 该说「有更新」。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ variant: 'community', dllSha256: 'ff'.repeat(32) }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const row = within(group).getByRole('button', { name: 'DLSSNR 组件' });
    expect(within(row).getByText('有更新')).toBeTruthy();

    await user.click(row);
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    // 换过资产那一条不再算「当前这一份」：选中态让出来，用户才看得出该点更新。
    expect(rows.every((item) => !item.classList.contains('is-active'))).toBe(true);
    // 行尾动作改叫更新（和超分模型那一行同一个控件），另外两条照旧是下载。
    expect(within(snippets).getByRole('button', { name: /^更新/ })).toBeTruthy();
    expect(within(snippets).getAllByRole('button', { name: /^下载/ })).toHaveLength(2);
  });

  it('leaves a variant alone when the disk copy is the catalog’s own bytes', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ variant: 'community', dllSha256: '98'.repeat(32) }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const row = within(group).getByRole('button', { name: 'DLSSNR 组件' });
    expect(within(row).queryByText('有更新')).toBeNull();

    await user.click(row);
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    const active = rows.find((item) => item.classList.contains('is-active'))!;
    expect(active.textContent).toContain('Lecram 版');
    expect(active.querySelector('button.select-option-download')).toBeNull();
    expect(within(snippets).queryByRole('button', { name: /^更新/ })).toBeNull();
  });

  it('recognises a community build the built-in table no longer knows', async () => {
    const user = userEvent.setup();
    // 社区把同一条变体重发之后，后端那张硬编码的内置表认不出它（`variant` 为 null），
    // 而清单按哈希认得出「这还是 community」——名字也就该照清单说。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ variant: null, variantLabel: null, dllSha256: '98'.repeat(32) }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const row = within(group).getByRole('button', { name: 'DLSSNR 组件' });
    expect(row.textContent).toContain('Lecram 版');
    expect(row.textContent).not.toContain('认不出的片段');

    await user.click(row);
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    expect(rows.find((item) => item.classList.contains('is-active'))!.textContent).toContain('Lecram 版');
  });

  it('says the snippet is unrecognised instead of claiming nothing is installed', async () => {
    // 文件在、哈希谁都不认识：说「未安装」是句谎话（165 MB 就在那儿），说它是哪一条也是猜。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ variant: null, variantLabel: null, dllSha256: 'aa'.repeat(32) }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    const row = within(group).getByRole('button', { name: 'DLSSNR 组件' });
    expect(row.textContent).toContain('认不出的片段');
  });

  it('keeps the installed variant as a selectable row instead of a disabled one', async () => {
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      dlssnr_download_variant: (args) => ({ ok: true, value: { bytes: 165_840_496, variant: args?.variantId ?? 'official', variantLabel: null } }),
    });
    setInvokeAdapterForTests(adapter);
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    const installedRow = rows.find((row) => row.classList.contains('is-active'))!;
    const installedMain = installedRow.querySelector<HTMLButtonElement>('.settings-choice-option-main')!;

    // 「当前这一份」由 is-active / aria-pressed 说话，它不是不可用。压成 disabled 会让
    // 全局那条 `button:disabled { opacity: .55 }`（base.css:378-384）把这一行的字一起
    // 调暗——用户截图里「已选中的那行发灰」就是这个。档案库那套选择菜单
    // （SettingsValueControls 的 SettingsChoice）里选中行也从不禁用，两边要一个样子。
    expect(installedMain.getAttribute('aria-pressed')).toBe('true');
    expect(installedMain.hasAttribute('disabled')).toBe(false);
    expect(installedMain).toBeEnabled();
    // 可聚焦：选中行不该是键盘上的死胡同。
    installedMain.focus();
    expect(document.activeElement).toBe(installedMain);

    // 点它不会又下一次：装的就是这一份，没有要下的东西。
    await user.click(installedMain);
    expect(adapter.mock.calls.filter(([command]) => command === 'dlssnr_download_variant')).toHaveLength(0);

    // 没装上的那两条照旧可点：点行体就是下这一条（和下载按钮同一个动作）。
    const otherMain = rows.find((row) => !row.classList.contains('is-active'))!.querySelector<HTMLButtonElement>('.settings-choice-option-main')!;
    expect(otherMain).toBeEnabled();
    await user.click(otherMain);
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dlssnr_download_variant', { variantId: 'official' }));
  });

  it('lists the snippets already in the library and marks the one in use', async () => {
    // 用户 2026-10-18 报「dlssnr多个版本没法共存，导致下了一个版本就会顶掉其他版本」。
    // 后端现在一个变体一个文件，设置页要把库里这些都列出来：认得出的用清单里的名字，
    // 认不出的念文件名——165 MB 就在盘上，不能因为认不出是什么变体就不给换回去。
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ installedVariants: DLSSNR_LIBRARY }) }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const library = await screen.findByRole('group', { name: '已安装的片段' });
    const rows = [...library.querySelectorAll<HTMLElement>('.settings-choice-option')];
    expect(rows).toHaveLength(DLSSNR_LIBRARY.length);

    // 正在用的那一条由高亮 + aria-pressed 说；它行尾没有「切换」（没有要换的东西）。
    const inUse = rows.filter((row) => row.classList.contains('is-active'));
    expect(inUse).toHaveLength(1);
    expect(inUse[0]!.textContent).toContain('SF 版');
    expect(inUse[0]!.querySelector('.settings-choice-option-main')!.getAttribute('aria-pressed')).toBe('true');
    expect(inUse[0]!.querySelector('button.select-option-download')).toBeNull();

    // 其余每一条都能换回去：行尾那个按钮的文案就是「切换」，无障碍名带上是哪一条。
    expect(within(library).getByRole('button', { name: '切换到Lecram 版' })).toBeTruthy();
    const switches = [...library.querySelectorAll<HTMLButtonElement>('button.select-option-download')];
    expect(switches).toHaveLength(DLSSNR_LIBRARY.length - 1);
    switches.forEach((button) => expect(button.textContent).toBe('切换'));

    // 认不出的那一份也在列表里：没有名字就拿文件名当名字，另起一行小字说明它不是坏掉了。
    expect(within(library).getByText('nvngx_dlssnr--custom.dll')).toBeTruthy();
    expect(within(library).getByText('认不出的片段')).toBeTruthy();
  });

  it('switches to a snippet already in the library without downloading it again', async () => {
    // 切换＝把库里那一份放回固定名，不下载；后端会先退掉计算进程，所以换完要重新读一遍
    // 状态（「现在用的是哪一条」是它回答的），并且明确告诉用户引擎重启了。
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ installedVariants: DLSSNR_LIBRARY }) }),
      dlssnr_activate_variant: (args) => ({ ok: true, value: { bytes: 165_840_496, variant: args?.variantId ?? null, variantLabel: 'Lecram 版' } }),
    });
    setInvokeAdapterForTests(adapter);
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const library = await screen.findByRole('group', { name: '已安装的片段' });
    const before = adapter.mock.calls.filter(([command]) => command === 'dlssnr_status').length;

    await user.click(within(library).getByRole('button', { name: '切换到Lecram 版' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dlssnr_activate_variant', { variantId: 'community' }));
    // 没重新下载：库里那份原样留着，只是放回了固定名。
    expect(adapter.mock.calls.filter(([command]) => command === 'dlssnr_download_variant')).toHaveLength(0);
    // 盘上那一份换了，状态得重新读一遍。
    await waitFor(() => expect(adapter.mock.calls.filter(([command]) => command === 'dlssnr_status').length).toBeGreaterThan(before));
    expect(await screen.findByText(/已切换到：Lecram 版/)).toBeTruthy();
    expect(screen.getByText(/计算进程已重启/)).toBeTruthy();
  });

  it('switches a file the backend cannot name by its file name', async () => {
    // 认不出的片段只有文件名可用（`id` 是 null）：设置页要把文件名发过去。不然这份
    // 165 MB 既看不见也换不了，用户还是只能靠删文件解决。
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ installedVariants: DLSSNR_LIBRARY }) }),
      dlssnr_activate_variant: (args) => ({ ok: true, value: { bytes: 165_840_496, variant: null, variantLabel: args?.variantId ?? null } }),
    });
    setInvokeAdapterForTests(adapter);
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const library = await screen.findByRole('group', { name: '已安装的片段' });
    await user.click(within(library).getByRole('button', { name: '切换到nvngx_dlssnr--custom.dll' }));

    await waitFor(() => expect(adapter).toHaveBeenCalledWith('dlssnr_activate_variant', { variantId: 'nvngx_dlssnr--custom.dll' }));
  });

  it('reports a failed switch instead of claiming the snippet was changed', async () => {
    // 失败时盘上那份一个字节没动，就不能报「已切换」——用户会以为换过去了。
    const user = userEvent.setup();
    const adapter = adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus({ installedVariants: DLSSNR_LIBRARY }) }),
      dlssnr_activate_variant: () => ({
        ok: false,
        error: { code: 'MODEL_ACTIVATION_FAILED', message: '算力进程没能退休：切换没做成，用的还是原来那一份', retryable: true },
      }),
    });
    setInvokeAdapterForTests(adapter);
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const library = await screen.findByRole('group', { name: '已安装的片段' });
    await user.click(within(library).getByRole('button', { name: '切换到Lecram 版' }));

    expect(await screen.findByText(/算力进程没能退休/)).toBeTruthy();
    expect(screen.queryByText(/已切换到：/)).toBeNull();
  });

  it('draws no snippet library when the backend does not report one', async () => {
    // `installedVariants` 是后加的可选字段：老后端不回这一段，设置页照样得能用
    // （状态本身能解析、菜单照开、只是没有这一段）。
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    await screen.findByRole('group', { name: 'DLSSNR 组件' });
    expect(screen.queryByRole('group', { name: '已安装的片段' })).toBeNull();
  });

  it('disables the variant rows while one of them is coming down', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      dlssnr_download_variant: () => new Promise(() => { /* 停在下载中 */ }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    await user.click(within(rows[0]!).getByRole('button', { name: /^下载/ }));

    // 「下载中」才是真正的不可用：后端那条下载路径一次只跑一件，这时候再点没有意义。
    await waitFor(() => expect(snippets.querySelector('.model-download-slot.is-open')).not.toBeNull());
    const mains = [...snippets.querySelectorAll<HTMLButtonElement>('.settings-choice-option-main')];
    expect(mains).toHaveLength(DLSSNR_CATALOG.variants.length);
    mains.forEach((main) => expect(main).toBeDisabled());
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
    // 三条变体的主按钮 + 每条右侧那个下载按钮（一条都还没装上，三个都能下）。
    expect(within(snippets).getAllByRole('button')).toHaveLength(6);
    expect(within(snippets).getAllByRole('button', { name: /^下载/ })).toHaveLength(3);
    // 还没有片段就没有「当前这一份」，没有一条报「使用中」，也没有体积那行字。
    expect(within(snippets).queryByText(/使用中/)).toBeNull();
    expect(within(snippets).queryByText(/MB/)).toBeNull();
  });

  it('lays every variant out as a name plus its supported series on one line', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });

    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    expect(rows).toHaveLength(DLSSNR_CATALOG.variants.length);
    rows.forEach((row, index) => {
      const variant = DLSSNR_CATALOG.variants[index]!;
      const main = row.querySelector('.settings-choice-option-main');
      // 2026-10-18 用户要求「把各 DLSSNR 的适配显卡系列补回来」：名字一行、系列一行。
      const spans = [...(main?.querySelectorAll('span') ?? [])];
      expect(spans).toHaveLength(2);
      expect(spans[0]?.textContent ?? '').toBe(variant.id === 'community' ? `${variant.label}（推荐）` : variant.label);
      expect(spans[1]?.className).toBe('settings-choice-option-series');
      for (const generation of variant.series) {
        expect(spans[1]?.textContent ?? '').toContain(String(generation));
      }
      // 那一长句兼容性说明仍然悬停可见（title），不占行。
      expect(main?.getAttribute('title')).toBe(variant.note);
    });
    // 行尾换成模型菜单那一套：没装上的挂下载按钮，装上的不挂；
    // 「已选择」徽标那行文字（使用中 / 体积）整行去掉。
    expect(rows[0]!.querySelector('button.select-option-download')).not.toBeNull();
    expect(rows[1]!.querySelector('button.select-option-download')).toBeNull();
    expect(rows[2]!.querySelector('button.select-option-download')).not.toBeNull();
    // 没有一条在下载：进度槽**常驻**（关着时 opacity 0 + 绝对定位，不占位），但一条都不该是打开的。
    // 2026-10-18 之前它按需挂载，于是「页面出现任何更新」就把正在长出来的那条重挂一次，
    // 用户看到的是进度条一闪就没。
    expect(snippets.querySelectorAll('.model-download-slot')).toHaveLength(DLSSNR_CATALOG.variants.length);
    expect(snippets.querySelectorAll('.model-download-slot.is-open')).toHaveLength(0);
  });

  it('grows the download progress slot on the variant that is coming down', async () => {
    const user = userEvent.setup();
    // 下载这条命令要等整个文件下完才回：用一条挂着的 promise 把「正在下载」那一刻钉住。
    setInvokeAdapterForTests(adapterFor({
      dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }),
      dlssnr_download_variant: () => new Promise(() => { /* 停在下载中 */ }),
    }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: 'DLSSNR 组件' }));
    const snippets = await screen.findByRole('group', { name: 'DLSSNR 组件' });
    const rows = [...snippets.querySelectorAll<HTMLElement>('.settings-choice-option')];
    await user.click(within(rows[0]!).getByRole('button', { name: /^下载/ }));

    // 进度槽常驻在每一条下面（关着时不占位），只有正在下载的那一条是打开的。
    await waitFor(() => expect(snippets.querySelector('.model-download-slot.is-open')).not.toBeNull());
    expect(snippets.querySelectorAll('.model-download-slot')).toHaveLength(DLSSNR_CATALOG.variants.length);
    expect(snippets.querySelectorAll('.model-download-slot.is-open')).toHaveLength(1);
    const bar = within(snippets).getByRole('progressbar', { name: /下载进度/ });
    expect(bar).toBeTruthy();
    // 下载中不再往那一行写字。
    expect(within(snippets).queryByText(/下载中/)).toBeNull();
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

  it('keeps adding layers up to the cap, then frees the button again after a layer is removed', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    // 层数是写回偏好的：用一个带状态的壳子，菜单画的是偏好里那一份而不是组件内的草稿。
    function Harness() {
      const [preferences, setPreferences] = useState({ ...DEFAULT_PREFERENCES });
      return <ToastProvider><DlssnrSettingsGroup preferences={preferences} editPreferences={(patch) => setPreferences((current) => ({ ...current, ...patch }))} visible /></ToastProvider>;
    }
    render(<Harness />);

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    const layerList = () => screen.getByRole('dialog', { name: 'DLSSNR 层数' });
    const addButton = () => within(layerList()).getByRole('button', { name: '添加层' });
    const layerButtons = () => within(layerList()).getAllByRole('button', { name: /^第 \d+ 层$/ });

    // 用户要的是「能一路加到五层」，所以这里把 5 写死成本可见行为，不从常量推：
    // 用 MAX_DLSSNR_PASSES 当循环上界的话，上限还是三层时这条测试照样绿。
    for (const count of [2, 3, 4, 5]) {
      expect(addButton()).toBeEnabled();
      await user.click(addButton());
      await waitFor(() => expect(within(layerList()).getByRole('button', { name: `第 ${count} 层` })).toBeInTheDocument());
    }
    expect(layerButtons()).toHaveLength(5);
    // 到顶才禁用：这一条是用户举报的那个毛病（到不了第 4、5 层）。
    expect(addButton()).toBeDisabled();

    // 从 5 层减到 4 层之后必须重新可加：禁用按当前层数算，不是一次性的锁。
    await user.click(within(layerList()).getByRole('button', { name: '第 5 层' }));
    await user.click(within(await screen.findByRole('dialog', { name: '第 5 层' })).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(addButton()).toBeEnabled());
    expect(layerButtons()).toHaveLength(4);
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

  it('steps every layer parameter by a tenth', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));
    const editor = await screen.findByRole('dialog', { name: '第 1 层' });

    // 0.05 的步进会让 1.1 走到 1.15：用户要的是一格 0.1（浮点残渣由 SettingsNumber
    // 自己吸收，见 settings-number-stepper.test.tsx）。
    for (const label of ['强度', '局部色调', '局部结构', '皮肤结构']) {
      await user.click(within(editor).getByRole('button', { name: label }));
      const stepper = await screen.findByRole('dialog', { name: label });
      expect(within(stepper).getByRole('spinbutton', { name: label })).toHaveAttribute('step', '0.1');
    }
  });

  it('caps the strength where the network stops caring', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));
    const editor = await screen.findByRole('dialog', { name: '第 1 层' });

    // 真机上量过：强度 1.5 / 2.0 与 1.0 逐字节相同（风格 0/1/2 下、别的旋钮拉满时也一样），
    // 而 0 就是「原图原封不动」——这个旋钮的有效区间只有 0–1，再往上给滑块就是骗人。
    await user.click(within(editor).getByRole('button', { name: '强度' }));
    const strength = await screen.findByRole('dialog', { name: '强度' });
    expect(within(strength).getByRole('spinbutton', { name: '强度' })).toHaveAttribute('max', '1');

    // 另外三个还是 0–2：它们两头都真的在动，没有被压过。
    for (const label of ['局部色调', '局部结构', '皮肤结构']) {
      await user.click(within(editor).getByRole('button', { name: label }));
      const stepper = await screen.findByRole('dialog', { name: label });
      expect(within(stepper).getByRole('spinbutton', { name: label })).toHaveAttribute('max', '2');
    }
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

  it('names a layer once: the menu title, not a repeated sub-heading inside the editor', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    const layerList = await screen.findByRole('dialog', { name: 'DLSSNR 层数' });
    await user.click(within(layerList).getByRole('button', { name: '第 1 层' }));

    const editor = await screen.findByRole('dialog', { name: '第 1 层' });
    // 标题已经写着「第 1 层」，内容区顶上再来一行同名小标题就是同一句话说两遍。
    expect(within(editor).getAllByText(/第 1 层/)).toHaveLength(1);
    // 分组本体留着：标题没了，这一组仍然要按名字念得出来。
    expect(within(editor).getByRole('group', { name: '第 1 层' })).toBeInTheDocument();
  });

  it('draws an icon in each layer editor action button', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));

    const editor = await screen.findByRole('dialog', { name: '第 1 层' });
    // 图标对无障碍名没有影响（aria-hidden），念出来的还是「保存」「删除」。
    expect(within(editor).getByRole('button', { name: '保存' }).querySelector('svg')).not.toBeNull();
    expect(within(editor).getByRole('button', { name: '删除' }).querySelector('svg')).not.toBeNull();
  });

  it('explains every layer parameter, on hover for a glance and pinned for a read', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));
    const editor = await screen.findByRole('dialog', { name: '第 1 层' });
    // 说明是挂在 body 上的气泡：它绝不能进这个面板——面板是固定高度 + overflow:hidden 的
    // 弹层，说明块一进内容流就把面板撑高、把问号挤走，指针还停在原地而按钮已经挪开。
    const note = () => screen.queryByRole('note', { name: '层参数说明' });

    // 默认不占地方：说明是问出来的，不是每次都糊在参数上面并把保存按钮顶下去。
    expect(note()).toBeNull();

    const toggle = within(editor).getByRole('button', { name: '参数说明' });
    await user.hover(toggle);
    await waitFor(() => expect(note()).not.toBeNull());
    const help = note()!;
    expect(within(editor).queryByRole('note', { name: '层参数说明' })).toBeNull();
    // 七个旋钮一个一个交代：少一条，用户就只能从行上那行 hint 里猜。
    for (const name of ['风格', '强度', '局部色调', '局部结构', '皮肤结构', '自动遮罩', '界面修正']) {
      expect(within(help).getByText(name)).toBeInTheDocument();
    }
    // 「风格」的三个取值单独列出来，不比别的旋钮更含糊。
    expect(within(help).getByText(/模型自带的档位/)).toBeInTheDocument();
    // 行上不再重复一遍：参数界面下面不该再挂说明文字。
    expect(within(editor).queryByText(/网络参与的力度/)).toBeNull();

    // 鼠标移开就收回去——悬停是「瞄一眼」。
    await user.unhover(toggle);
    await waitFor(() => expect(note()).toBeNull());
    // 点一下才钉住：移开鼠标也还在，才能边看边调。
    await user.click(toggle);
    await user.unhover(toggle);
    expect(note()).not.toBeNull();
    // 再点一下解钉，移开后收回去。
    await user.click(toggle);
    await user.unhover(toggle);
    await waitFor(() => expect(note()).toBeNull());
  });

  it('sizes the help bubble to the menu panel it explains', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    renderDlssnr();

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'DLSSNR 层数' })).getByRole('button', { name: '第 1 层' }));
    const editor = await screen.findByRole('dialog', { name: '第 1 层' });
    const toggle = within(editor).getByRole('button', { name: '参数说明' });
    await user.hover(toggle);
    const bubble = await screen.findByRole('note', { name: '层参数说明' });

    // jsdom 没有布局，矩形全是 0：把「面板」与问号的位置捏出来，再踢一次 resize 让气泡
    // 重新量（真实浏览器里这一步由窗口变化触发）。
    const panel = editor.closest('.settings-choice-panel') ?? editor;
    const rect = ({ width, top, right, bottom }: { width: number; top: number; right: number; bottom: number }) => ({
      width,
      top,
      right,
      bottom,
      height: bottom - top,
      left: right - width,
      x: right - width,
      y: top,
      toJSON: () => ({ width, top, right, bottom }),
    } as DOMRect);
    panel.getBoundingClientRect = () => rect({ width: 320, top: 100, right: 900, bottom: 700 });
    toggle.getBoundingClientRect = () => rect({ width: 28, top: 120, right: 880, bottom: 148 });
    fireEvent(window, new Event('resize'));

    // 气泡跟下面那张菜单一样宽、右边缘对齐（用户要的「匹配下方的菜单」），上沿仍落在
    // 问号下面——不然它会盖住标题行。
    await waitFor(() => expect(bubble).toHaveStyle({ width: '320px' }));
    expect(bubble).toHaveStyle({ right: `${window.innerWidth - 900}px`, top: '156px' });
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);
    const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(220);
    try {
      fireEvent(window, new Event('resize'));
      expect(bubble).toHaveStyle({ width: '296px', right: '12px', top: '12px', maxHeight: '100px' });
    } finally { width.mockRestore(); height.mockRestore(); }
  });

  it('applies a 3DCG preset over the current layer settings', async () => {
    const user = userEvent.setup();
    setInvokeAdapterForTests(adapterFor({ dlssnr_status: () => ({ ok: true, value: dlssnrStatus() }) }));
    // 层数与参数都是写回偏好的：用带状态的壳子，菜单画的才是选完之后的这一份。
    let latest = DEFAULT_PREFERENCES.dlssnrPasses;
    function Harness() {
      const [preferences, setPreferences] = useState({ ...DEFAULT_PREFERENCES });
      return <ToastProvider><DlssnrSettingsGroup preferences={preferences} editPreferences={(patch) => setPreferences((current) => {
        const next = { ...current, ...patch };
        latest = next.dlssnrPasses;
        return next;
      })} visible /></ToastProvider>;
    }
    render(<Harness />);

    const group = await screen.findByRole('region', { name: 'DLSSNR' });
    await user.click(within(group).getByRole('button', { name: '层数' }));
    const layerList = await screen.findByRole('dialog', { name: 'DLSSNR 层数' });
    // 预设排在「添加层」左边：先「挑一套」再「加一层」，两个动作同一行。
    const actions = within(layerList).getAllByRole('button');
    expect(actions[actions.length - 2]).toHaveTextContent('预设');
    expect(actions[actions.length - 1]).toHaveTextContent('添加层');

    await user.click(within(layerList).getByRole('button', { name: '预设' }));
    const presets = await screen.findByRole('dialog', { name: 'DLSSNR 预设' });
    // 三套预设各按层数标出来——「1/3/5 层」本身就是它们之间最大的差别。
    expect(within(presets).getByRole('button', { name: '轻度' })).toHaveTextContent('1 层');
    expect(within(presets).getByRole('button', { name: '标准' })).toHaveTextContent('3 层');
    expect(within(presets).getByRole('button', { name: '强化' })).toHaveTextContent('5 层');

    await user.click(within(presets).getByRole('button', { name: '强化' }));
    // 选择就是覆盖：回到层列表已经是五层。
    const applied = await screen.findByRole('dialog', { name: 'DLSSNR 层数' });
    await waitFor(() => expect(within(applied).getAllByRole('button', { name: /^第 \d+ 层$/ })).toHaveLength(5));
    // 写回去的是整套参数，不是只改了层数：第一层还是最强的那个出效果的人。
    const passes = parseDlssnrPasses(latest);
    expect(passes).toHaveLength(5);
    expect(passes[0]).toMatchObject({ style: 0, intensity: 1, localToneStrength: 0.4, localStructureStrength: 0.8 });
    // 再打开预设，命中当前设置的那一套标「当前」。
    await user.click(within(applied).getByRole('button', { name: '预设' }));
    const reopened = await screen.findByRole('dialog', { name: 'DLSSNR 预设' });
    expect(within(reopened).getByRole('button', { name: '强化' })).toHaveTextContent('当前');
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
          capabilities: [capability('upscale', false, '超分'), capability('dlssnr', false, 'DLSS5')],
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
    // 配对请求还会带上这台设备自报的名字与类型（Tauri 对缺失的参数键也会报错，
    // 所以仓库层永远显式送这两个键，未识别时是 null）。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_pair_request', expect.objectContaining({ url: '192.168.1.9:47653' })));
    await user.type(within(pairDialog).getByLabelText('配对码'), '123456');
    await user.click(within(pairDialog).getByRole('button', { name: '完成配对' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_pair_confirm', { url: '192.168.1.9:47653', requestId: 'request-1', code: '123456' }));
    await waitFor(() => expect(toggle).toBeEnabled());

    await user.click(within(group).getByRole('button', { name: '已配对设备' }));
    const deviceDialog = await screen.findByRole('dialog', { name: '已配对设备' });
    await user.click(within(deviceDialog).getByRole('button', { name: '刷新服务' }));
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('remote_compute_capabilities', { url: '192.168.1.9:47653', token: 'remote-token' }));

    // 远端能做什么就亮什么：能力标签照它对上来的 `ready` 亮/暗。（模型、倍数、层数这些
    // 「这次怎么做」的控件全都删了。）
    //
    // 第 3 项的判据：这一排只在二级菜单里**当前那一台**设备的名字右边——设置组里不再铺
    // 一行（图 1 里那一排要删掉），菜单底下那行「DESKTOP-PC · 超分、DLSS5」也一并删掉。
    await waitFor(() => expect(within(deviceDialog).getByRole('group', { name: '远端可用服务' })).toBeTruthy());
    expect(within(group).queryByRole('group', { name: '远端可用服务' })).toBeNull();
    expect(within(deviceDialog).queryByText(/DESKTOP-PC · 超分/)).toBeNull();
    const services = within(deviceDialog).getByRole('group', { name: '远端可用服务' });
    expect(within(services).getByText('超分')).toHaveClass('is-ready');
    expect(within(services).getByText('DLSS5')).toHaveClass('is-ready');
    // 它长在设备行里（和名字同一个按钮），不是对话框里另外一行。
    const deviceRow = within(deviceDialog).getByRole('button', { name: /DESKTOP-PC/ });
    expect(deviceRow.contains(services)).toBe(true);
    expect(deviceRow.getAttribute('aria-pressed')).toBe('true');
    expect(within(deviceDialog).getByText('192.168.1.9:47653')).toBeTruthy();

    // 第 8 项的判据：存下去的 remoteComputeOps 只剩「开不开」和「配过哪几台」——
    // 这一次用哪个模型、放大几倍都不再由客户端记，写进去就等于把老毛病存回来。
    // 取配完对之后那几次写盘（认刚配上的这台设备），逐次核对键集合。
    // 第 8 项的判据：存下去的 remoteComputeOps 只剩「开不开」和「配过哪几台」——
    // 这一次用哪个模型、放大几倍都不再由客户端记，写进去就等于把老毛病存回来。
    // 取配完对之后那几次写盘（认刚配上的这台设备），逐次核对键集合。
    const currentWrites = () => adapter.mock.calls
      .filter(([command]) => command === 'save_preferences')
      .map(([, args]) => (args?.input as PreferenceSnapshot | undefined)?.remoteComputeOps ?? '')
      .filter((value) => value.includes('DESKTOP-PC'));
    await waitFor(() => expect(currentWrites().length).toBeGreaterThan(0));
    for (const value of currentWrites()) {
      expect(Object.keys(JSON.parse(value) as Record<string, unknown>).sort()).toEqual(['enabled', 'pairedDevices']);
    }
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

    const ops = parseRemoteOps(serializeRemoteOps({ enabled: true, pairedDevices: [] }));
    expect(ops.enabled).toBe(true);
    expect(parseRemoteOps('not json')).toEqual(DEFAULT_REMOTE_OPS);

    // 旧数据里那些「这次怎么做」的字段（op / modelId / scale / dlssnrPasses）读进来直接
    // 丢掉，但 enabled 和配过的设备要留住：从前它们跟 op 挤在同一段 schema 里，字段一对
    // 不上就整段回默认，用户会发现自己「配对没了」。
    const legacy = parseRemoteOps(JSON.stringify({
      enabled: true,
      op: { op: 'dlssnr', modelId: 'upscale-x4', scale: 2, dlssnrPasses: [{ style: 1, intensity: 1 }] },
      pairedDevices: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'remote-token' }],
    }));
    expect(legacy.enabled).toBe(true);
    expect(legacy.pairedDevices).toHaveLength(1);
    expect(Object.keys(legacy).sort()).toEqual(['enabled', 'pairedDevices']);
  });

  it('round-trips four and five saved layers and leaves the old three-layer data intact', () => {
    // 上限从三层提到五层之后：老用户存下的两三层要原样读回来，新存下的四五层也不能被截掉。
    // 每层用不同的 intensity 认人（style 只有 0–2，超出范围的那一份会被整段判成坏数据）。
    const intensities = [1, 1.1, 1.2, 1.3, 1.4];
    const layers = intensities.map((intensity) => ({
      style: 0, intensity, localToneStrength: 1, localStructureStrength: 1, skinStructureStrength: 0, autoMask: false, uiCorrection: false,
    }));

    expect(parseDlssnrPasses(serializeDlssnrPasses(layers.slice(0, 3)))).toHaveLength(3);

    const four = parseDlssnrPasses(serializeDlssnrPasses(layers.slice(0, 4)));
    expect(four).toHaveLength(4);
    expect(four.map((pass) => pass.intensity)).toEqual(intensities.slice(0, 4));

    const five = parseDlssnrPasses(serializeDlssnrPasses(layers));
    expect(five).toHaveLength(MAX_DLSSNR_PASSES);
    expect(MAX_DLSSNR_PASSES).toBe(5);
    expect(five.map((pass) => pass.intensity)).toEqual(intensities);

    // 只有超过上限的部分才截掉。
    expect(parseDlssnrPasses(serializeDlssnrPasses([...layers, layers[0]!]))).toHaveLength(MAX_DLSSNR_PASSES);
  });

  it('reads back remote operations that still carry the retired op fields', () => {
    /* 远端那份设置从前还记着「这一次用什么模型、放大几倍、DLSSNR 走几层」（`RemoteOpSchema`），
       现在整段删了：客户端只留「开不开」和「配过哪几台」，模型与参数由对面自己的设置决定
       （第 8 项）。老用户存下的那份 JSON 里那些字段还在，读的时候必须只是被忽略——
       若为它们整段回 `DEFAULT_REMOTE_OPS`，用户会发现自己「远端处理被关了、设备也没了」。 */
    const stored = JSON.stringify({
      enabled: true,
      op: { op: 'dlssnr', modelId: 'upscale-x4', scale: 4, dlssnrPasses: [1, 2, 3, 4, 5] },
      pairedDevices: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'remote-token' }],
    });
    const ops = parseRemoteOps(stored);
    expect(ops.enabled).toBe(true);
    expect(ops.pairedDevices).toEqual([{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'remote-token' }]);
    expect(Object.keys(ops).sort()).toEqual(['enabled', 'pairedDevices']);

    // 而且写回去的时候不该再带上它们（否则删掉的字段会被这棵老数据复活）。
    const written = serializeRemoteOps(ops);
    expect(written).not.toMatch(/"(op|modelId|scale|dlssnrPasses)"/);

    // 已配对设备本身还是坏的（缺 token / 不是数组）时，才轮到回默认。
    expect(parseRemoteOps(JSON.stringify({ enabled: true, pairedDevices: [{ address: 'a' }] }))).toEqual(DEFAULT_REMOTE_OPS);
    expect(parseRemoteOps(JSON.stringify({ enabled: true, pairedDevices: 'nope' }))).toEqual(DEFAULT_REMOTE_OPS);
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
