import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreferencesProvider, usePreferences } from '../../src/app/preferences';
import { ComputeCenterSettingsGroup } from '../../src/components/ComputeCenterSettingsGroup';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { DEFAULT_PREFERENCES, type PreferenceSnapshot } from '../../src/repositories/nativeSettingsRepository';
import { parseRemoteOps, serializeRemoteOps } from '../../src/repositories/nativeComputeCenterRepository';
import { deviceDisplayName, deviceKind } from '../../src/lib/deviceIdentity';

/** 「管理已有配对」那一层要显示三件事：名字、地址、还有一枚**按设备类型挑出来**的
 *  图标。图标靠 lucide 的类名认（`lucide-smartphone` …）：验的是形状，不是配色——
 *  换一套颜色不该让这条红，把手机画成台式机才该红。 */

const ANDROID_PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const CLIENTS = [
  { id: 'client-1', name: 'Pixel 7 Pro', address: '192.168.1.9', kind: 'phone' },
  { id: 'client-2', name: 'Galaxy Tab', address: '192.168.1.10', kind: 'tablet' },
  { id: 'client-3', name: 'DESKTOP-PC', address: '192.168.1.11', kind: 'desktop' },
  // 老记录里没有 kind（这一版之前配的对）：既不能崩，也不该假装知道它是什么。
  { id: 'client-4', name: '老设备', address: '192.168.1.12' },
];

function computeStatus(overrides: Record<string, unknown> = {}) {
  return {
    running: false,
    port: 47_653,
    addresses: ['192.168.1.5'],
    token: 'abcdef0123456789abcdef0123456789abcdef01',
    capabilities: [],
    canStart: true,
    pairedClients: [],
    ...overrides,
  };
}

function capability(id: string, ready: boolean, label = id) {
  return { id, label, ready, detail: ready ? '可用' : '不可用' };
}

function adapterFor(handlers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  return vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'compute_center_status' && !handlers[command]) return { ok: true, value: computeStatus() };
    if (command === 'compute_discover' && !handlers[command]) return { ok: true, value: [] };
    const handler = handlers[command];
    if (handler) return handler(args);
    return { ok: true, value: null };
  });
}

function renderComputeCenter() {
  return render(
    <ToastProvider>
      <ComputeCenterSettingsGroup preferences={{ ...DEFAULT_PREFERENCES }} editPreferences={() => {}} />
    </ToastProvider>,
  );
}

function stubUserAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

/** jsdom 的屏幕是 1024×768：手机那一支只能自己造。 */
function stubDisplay(width: number, height: number) {
  Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
  Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
}

const user = () => userEvent.setup();

/** 打开「管理已有配对」：本机服务得在跑，那一行才在。 */
async function openManagedPairings() {
  const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
  await user().click(within(group).getByRole('button', { name: '管理已有配对' }));
  return screen.findByRole('dialog', { name: '管理已有配对' });
}

let originalUserAgent = '';
let originalScreen: { width: number; height: number };

beforeEach(() => {
  // 组件把 status 缓存在 localStorage 里：上一个用例的配对列表不能漏到下一个。
  localStorage.clear();
  originalUserAgent = navigator.userAgent;
  originalScreen = { width: window.screen.width, height: window.screen.height };
});

afterEach(() => {
  resetInvokeAdapterForTests();
  stubUserAgent(originalUserAgent);
  stubDisplay(originalScreen.width, originalScreen.height);
});

describe('device identity', () => {
  it('reads the model out of the Android UA and gives up when there is nothing usable', () => {
    expect(deviceDisplayName(ANDROID_PHONE_UA)).toBe('SM-S918B');
    expect(deviceDisplayName('Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36')).toBe('Pixel 7 Pro');
    // 老 UA 在机型前夹一个语言区域。
    expect(deviceDisplayName('Mozilla/5.0 (Linux; U; Android 4.0.3; de-ch; HTC Sensation Build/IML74K) AppleWebKit')).toBe('HTC Sensation');
    // Android 10 起简版 UA 把机型抹成一个字母：那个不是名字，宁可让后端退回 host_name()。
    expect(deviceDisplayName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36')).toBe('');
    // 桌面 UA 没有机型段：同样回空串（后端用 COMPUTERNAME）。
    expect(deviceDisplayName(WINDOWS_UA)).toBe('');
    expect(deviceDisplayName('')).toBe('');
  });

  it('calls an Android device a tablet only when its shortest screen side is wide enough', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36';
    stubDisplay(412, 915);
    expect(deviceKind(android)).toBe('phone');
    stubDisplay(800, 1_280);
    expect(deviceKind(android)).toBe('tablet');
    // 非 Android 不看屏幕：桌面上的窄窗口不会把它变成手机。
    stubDisplay(412, 915);
    expect(deviceKind(WINDOWS_UA)).toBe('desktop');
  });
});

describe('compute center paired clients', () => {
  it('does not restore a revoked client when an older status refresh finishes', async () => {
    let reads = 0;
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ++reads === 1
        ? { ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }
        : pending,
      compute_center_revoke_pairing: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: [] }) }),
    }));
    renderComputeCenter();
    const panel = await openManagedPairings();
    const row = within(panel).getByText('Pixel 7 Pro').closest('.settings-choice-option') as HTMLElement;
    await user().click(within(row).getByRole('button', { name: '撤销配对' }));
    await user().click(within(row).getByRole('button', { name: '确认撤销' }));
    expect(await screen.findByText('暂无已配对设备')).toBeInTheDocument();
    await act(async () => finish({ ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }));
    expect(screen.getByText('暂无已配对设备')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pixel 7 Pro/ })).not.toBeInTheDocument();
  });

  it('offers a retry when the initial local service status cannot be read', async () => {
    let reads = 0;
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ++reads === 1
        ? { ok: false, error: { code: 'LOCAL_DATABASE', message: '服务状态暂不可用', retryable: true } }
        : { ok: true, value: computeStatus() },
    }));
    renderComputeCenter();
    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    expect(await screen.findByRole('alert')).toHaveTextContent('服务状态暂不可用');
    expect(within(group).getByRole('switch')).toBeDisabled();
    await user().click(screen.getByRole('button', { name: '重新读取服务状态' }));
    await waitFor(() => expect(within(group).getByRole('switch')).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('lists every paired client by name and address with an icon that follows its kind', async () => {
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }),
    }));
    renderComputeCenter();

    const panel = await openManagedPairings();
    const row = (name: string) => within(panel).getByText(name).closest('.settings-choice-option') as HTMLElement;

    // 名字与地址都在（这正是截图里显示成「Yomika」的那两行）。
    expect(row('Pixel 7 Pro').textContent).toContain('192.168.1.9');
    expect(row('Galaxy Tab').textContent).toContain('192.168.1.10');
    expect(row('DESKTOP-PC').textContent).toContain('192.168.1.11');
    expect(row('老设备').textContent).toContain('192.168.1.12');

    // 图标跟着 kind 走：手机 / 平板 / 桌面，缺 kind 的那条给通用图标。
    expect(row('Pixel 7 Pro').querySelector('svg.lucide-smartphone')).not.toBeNull();
    expect(row('Galaxy Tab').querySelector('svg.lucide-tablet')).not.toBeNull();
    expect(row('DESKTOP-PC').querySelector('svg.lucide-monitor')).not.toBeNull();
    expect(row('老设备').querySelector('svg.lucide-monitor-smartphone')).not.toBeNull();
  });

  it('confirms inline and resets when focus leaves or the menu closes', async () => {
    const adapter = adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }),
    });
    setInvokeAdapterForTests(adapter);
    renderComputeCenter();
    let panel = await openManagedPairings();
    const row = () => within(panel).getByText('Pixel 7 Pro').closest('.settings-choice-option') as HTMLElement;
    await user().click(within(row()).getByRole('button', { name: '撤销配对' }));
    expect(within(row()).getByRole('button', { name: '确认撤销' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Pixel 7 Pro' })).toBeNull();
    expect(adapter.mock.calls.some(([command]) => command === 'compute_center_revoke_pairing')).toBe(false);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(within(row()).getByRole('button', { name: '撤销配对' })).toBeInTheDocument();
    await user().click(within(row()).getByRole('button', { name: '撤销配对' }));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    panel = await openManagedPairings();
    expect(within(row()).getByRole('button', { name: '撤销配对' })).toBeInTheDocument();
    await user().click(within(row()).getByRole('button', { name: '撤销配对' }));
    vi.useFakeTimers();
    try {
      // Confirmation was armed before timers were replaced; re-arm through focus reset.
      act(() => window.dispatchEvent(new Event('blur')));
      act(() => within(row()).getByRole('button', { name: '撤销配对' }).click());
      act(() => vi.advanceTimersByTime(8_001));
      expect(within(row()).getByRole('button', { name: '撤销配对' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it('uses the persisted switch mirror before native preferences arrive', () => {
    localStorage.setItem('yomika.last-nav', JSON.stringify({ computeCenterEnabled: true }));
    setInvokeAdapterForTests(adapterFor({
      load_preferences: () => new Promise(() => {}),
      compute_center_status: () => new Promise(() => {}),
    }));
    function Group() {
      const { preferences } = usePreferences();
      return <ComputeCenterSettingsGroup preferences={preferences} editPreferences={() => {}} />;
    }
    render(<PreferencesProvider><ToastProvider><Group /></ToastProvider></PreferencesProvider>);
    expect(screen.getByRole('switch', { name: '开启本机远程后处理服务' })).toBeChecked();
  });

  it('keeps enabled preference visible while an older cached status is unverified', () => {
    localStorage.setItem('yomika.compute-center-status', JSON.stringify(computeStatus({ running: false })));
    setInvokeAdapterForTests(adapterFor({ compute_center_status: () => new Promise(() => {}) }));
    render(<ToastProvider><ComputeCenterSettingsGroup preferences={{ ...DEFAULT_PREFERENCES, computeCenterEnabled: true }} editPreferences={() => {}} /></ToastProvider>);
    expect(screen.getByRole('switch', { name: '开启本机远程后处理服务' })).toBeChecked();
  });

});

describe('compute center settings menus', () => {
  it('gives the port menu no top text and an icon on its save button', async () => {
    setInvokeAdapterForTests(adapterFor({
      compute_center_status: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }),
      // 保存要让这一步成功，面板才会自己关上（失败会留一条 toast，后面就找不着设备面板了）。
      compute_center_configure: () => ({ ok: true, value: computeStatus({ running: true, pairedClients: CLIENTS }) }),
    }));
    renderComputeCenter();

    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await user().click(within(group).getByRole('button', { name: '端口' }));
    const portMenu = await screen.findByRole('dialog', { name: '端口' });
    expect(within(portMenu).queryByText(/其他设备填/)).toBeNull();
    expect(within(portMenu).getByRole('button', { name: '保存' }).querySelector('svg')).not.toBeNull();

    // 设备面板顶上那行小字同样没了。
    await user().click(within(screen.getByRole('dialog', { name: '端口' })).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '端口' })).toBeNull());
    const panel = await openManagedPairings();
    expect(within(panel).queryByText(/点一台设备可以单独撤销它的配对/)).toBeNull();
    expect(within(panel).queryByText(/点一台设备可以单独撤销/)).toBeNull();
  });

  it('gives the add-device menu no top text either', async () => {
    setInvokeAdapterForTests(adapterFor());
    renderComputeCenter();

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    await user().click(within(group).getByRole('button', { name: '添加设备' }));
    const dialog = await screen.findByRole('dialog', { name: '添加设备' });
    expect(within(dialog).queryByText(/选一台局域网里的设备/)).toBeNull();
  });

  it('reports this device name and kind when it asks to pair', async () => {
    stubUserAgent(ANDROID_PHONE_UA);
    stubDisplay(412, 915);
    const adapter = adapterFor();
    setInvokeAdapterForTests(adapter);
    renderComputeCenter();

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    await user().click(within(group).getByRole('button', { name: '添加设备' }));
    const dialog = await screen.findByRole('dialog', { name: '添加设备' });
    await user().type(within(dialog).getByLabelText('设备地址'), '192.168.1.9:47653');
    await user().click(within(dialog).getByRole('button', { name: /^配对$/ }));

    // 名字与类型都是**这一台**的：对面以前只能拿 `host_name()`，Android 上那是「Yomika」。
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('compute_pair_request', {
      url: '192.168.1.9:47653',
      name: 'SM-S918B',
      kind: 'phone',
    }));
  });
});

describe('one paired device at a time', () => {
  it('keeps the pairing address stable while requesting its code', async () => {
    let finish!: (value: unknown) => void;
    setInvokeAdapterForTests(adapterFor({
      compute_pair_request: () => new Promise((resolve) => { finish = resolve; }),
    }));
    renderComputeCenter();
    await user().click(await screen.findByRole('button', { name: '添加设备' }));
    const dialog = await screen.findByRole('dialog', { name: '添加设备' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '重新搜索' })).toBeEnabled());
    await user().type(within(dialog).getByLabelText('设备地址'), '192.168.1.5:47653');
    await user().click(within(dialog).getByRole('button', { name: '配对' }));
    expect(within(dialog).getByLabelText('设备地址')).toBeDisabled();
    await user().keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '添加设备' })).toBeInTheDocument();
    await act(async () => { finish({ ok: true, value: { requestId: 'req-stable' } }); });
    expect(await screen.findByLabelText('配对码')).toBeEnabled();
  });

  /** 配第二台时把这一台换掉：这台机器是它自己的算力来源，没有「轮流用几台」这回事。 */
  it('replaces the paired device instead of appending a second one', async () => {
    const written: Partial<PreferenceSnapshot>[] = [];
    setInvokeAdapterForTests(adapterFor({
      compute_pair_request: () => ({ ok: true, value: { requestId: 'req-2' } }),
      compute_pair_confirm: () => ({ ok: true, value: { name: 'Galaxy Tab', token: 'token-b' } }),
    }));
    render(
      <ToastProvider>
        <ComputeCenterSettingsGroup
          preferences={{
            ...DEFAULT_PREFERENCES,
            remoteComputeUrl: '192.168.1.9:47653',
            remoteComputeToken: 'token-a',
            remoteComputeOps: serializeRemoteOps({
              enabled: true,
              pairedDevices: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'token-a' }],
            }),
          }}
          editPreferences={(patch) => { written.push(patch); }}
        />
      </ToastProvider>,
    );

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    // 已经配了一台：列表里不再摆「添加设备」那一行（配对是替换不是追加），入口收进
    // 「已配对设备」这张菜单的动作行里。
    expect(within(group).queryByRole('button', { name: '添加设备' })).toBeNull();
    await user().click(within(group).getByRole('button', { name: '已配对设备' }));
    const pairedDialog = await screen.findByRole('dialog', { name: '已配对设备' });
    await user().click(within(pairedDialog).getByRole('button', { name: '添加设备' }));
    const dialog = await screen.findByRole('dialog', { name: '添加设备' });
    // 替换语义写在按钮文字里，不再是一段解释的小字。
    expect(within(dialog).getByRole('button', { name: /^替换配对$/ })).toBeTruthy();
    await user().type(within(dialog).getByLabelText('设备地址'), '192.168.1.10:47653');
    await user().click(within(dialog).getByRole('button', { name: /^替换配对$/ }));
    await user().type(await screen.findByLabelText('配对码'), '001422');
    await user().click(within(await screen.findByRole('dialog', { name: '添加设备' })).getByRole('button', { name: '完成替换' }));

    await waitFor(() => expect(written.some((patch) => patch.remoteComputeOps)).toBe(true));
    const last = written[written.length - 1];
    const ops = parseRemoteOps(last?.remoteComputeOps ?? '');
    expect(ops.pairedDevices).toEqual([{ address: '192.168.1.10:47653', name: 'Galaxy Tab', token: 'token-b' }]);
    expect(last?.remoteComputeToken).toBe('token-b');
  });

  /** 旧版本可能存着好几台：读进来只留**最后配对**的那一台，而不是整份回默认。 */
  it('keeps only the newest device out of an older list without dropping the settings', () => {
    const ops = parseRemoteOps(serializeRemoteOps({
      enabled: true,
      pairedDevices: [
        { address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'token-a' },
        { address: '192.168.1.10:47653', name: 'Galaxy Tab', token: 'token-b' },
      ],
    }));

    expect(ops.enabled).toBe(true);
    expect(ops.pairedDevices).toEqual([{ address: '192.168.1.10:47653', name: 'Galaxy Tab', token: 'token-b' }]);
    // 旧文件里的这块 JSON 是原样存下来的：直接读它也要收敛成一台。
    expect(parseRemoteOps(JSON.stringify({
      enabled: true,
      pairedDevices: [
        { address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'token-a' },
        { address: '192.168.1.10:47653', name: 'Galaxy Tab', token: 'token-b' },
      ],
    })).pairedDevices).toHaveLength(1);
  });
});

/** 「设备连上之后又断开、还得重新配对」的两条机制：一次探测失败被当成断开，以及点一次
 *  本机开关就顺手换掉令牌（Rust 侧换令牌会 `pairing.clear()`）。 */
describe('staying connected', () => {
  const paired = {
    ...DEFAULT_PREFERENCES,
    remoteComputeUrl: '192.168.1.9:47653',
    remoteComputeToken: 'token-a',
    remoteComputeOps: serializeRemoteOps({
      enabled: true,
      pairedDevices: [{ address: '192.168.1.9:47653', name: 'DESKTOP-PC', token: 'token-a' }],
    }),
  };

  it('keeps the capability chips when a later probe fails', async () => {
    let probes = 0;
    setInvokeAdapterForTests(adapterFor({
      remote_compute_capabilities: () => {
        probes += 1;
        if (probes === 1) {
          return {
            ok: true,
            value: {
              service: 'yomika-compute-center',
              version: 2,
              name: 'DESKTOP-PC',
              capabilities: [capability('upscale', true, '超分')],
              models: [],
            },
          };
        }
        return { ok: false, error: { code: 'REMOTE_UNAVAILABLE', message: '对面没答上', retryable: true } };
      },
    }));
    render(
      <ToastProvider>
        <ComputeCenterSettingsGroup preferences={paired} editPreferences={() => {}} />
      </ToastProvider>,
    );

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    await user().click(within(group).getByRole('button', { name: '已配对设备' }));
    const dialog = await screen.findByRole('dialog', { name: '已配对设备' });
    await waitFor(() => expect(within(dialog).getByText('超分')).toHaveClass('is-ready'));

    // 再问一次，对面没答上：小标签说的是它**有什么**，抹掉就等于替它宣布断开。
    await user().click(within(dialog).getByRole('button', { name: '刷新服务' }));
    await waitFor(() => expect(probes).toBeGreaterThan(1));
    expect(within(screen.getByRole('group', { name: '远端可用服务' })).getByText('超分')).toHaveClass('is-ready');
    // 失败本身还是要说一声：留着旧清单不等于假装没事。
    expect(await screen.findByText('对面没答上')).toBeTruthy();
  });

  /** 打开「已配对设备」这一行只是展开菜单：从前它顺手又连一次（不 quiet），于是「进这一组」
   *  与「点开这一行」各弹一张一模一样的「已连上 X」。探针交给挂载时那次 quiet 探测。 */
  it('opens the paired device panel without probing a second time', async () => {
    const adapter = adapterFor({
      remote_compute_capabilities: () => ({
        ok: true,
        value: {
          service: 'yomika-compute-center',
          version: 2,
          name: 'DESKTOP-PC',
          capabilities: [capability('upscale', true, '超分')],
          models: [],
        },
      }),
    });
    setInvokeAdapterForTests(adapter);
    render(
      <ToastProvider>
        <ComputeCenterSettingsGroup preferences={paired} editPreferences={() => {}} />
      </ToastProvider>,
    );

    const group = await screen.findByRole('region', { name: '远程后处理服务' });
    await waitFor(() => expect(adapter).toHaveBeenCalledWith('remote_compute_capabilities', expect.anything()));
    await user().click(within(group).getByRole('button', { name: '已配对设备' }));
    await screen.findByRole('dialog', { name: '已配对设备' });

    const probes = adapter.mock.calls.filter(([command]) => command === 'remote_compute_capabilities');
    expect(probes).toHaveLength(1);
  });

  it('toggles the local service without rotating the token', async () => {    const configure: Record<string, unknown>[] = [];
    setInvokeAdapterForTests(adapterFor({
      compute_center_configure: (args) => {
        configure.push(args ?? {});
        return { ok: true, value: computeStatus({ running: true }) };
      },
    }));
    renderComputeCenter();

    const group = await screen.findByRole('region', { name: '本机远程后处理服务' });
    await user().click(within(group).getByRole('switch', { name: '开启本机远程后处理服务' }));

    await waitFor(() => expect(configure).toHaveLength(1));
    // 换令牌会清空配对表：已配对设备会被全部踢掉，用户看到的就是「连上又断开」。
    expect(configure[0]).not.toHaveProperty('rotateToken');
    expect(configure[0]).toMatchObject({ enabled: true });
  });
});
