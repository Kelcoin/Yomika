import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Link2, Monitor, MonitorSmartphone, Plus, RefreshCw, Save, Server, Smartphone, Tablet, Unlink, Wand2 } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsMenu } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { useToast } from './Toast';
import { deviceDisplayName, deviceKind } from '../lib/deviceIdentity';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import {
  COMPUTE_CENTER_PAIRING_CHANGED_EVENT,
  DEFAULT_REMOTE_OPS,
  NativeComputeCenterRepository,
  parseRemoteOps,
  serializeRemoteOps,
  type ComputeCenterStatus,
  type RemoteCapabilities,
  type DiscoveredDevice,
} from '../repositories/nativeComputeCenterRepository';

function cacheDisplayStatus(status: ComputeCenterStatus): void {
  try { localStorage.setItem('yomika.compute-center-status', JSON.stringify({ ...status, token: '' })); } catch { /* storage unavailable */ }
}

/** 设备行左边那枚图标：类型是**对面配对时报上来的**（`kind`）。
 *
 * 认不出来就用通用图标——老记录没有这个字段，而画一台手机去猜一台平板，比画一个
 * 「某台设备」更不诚实。 */
function DeviceGlyph({ kind }: { kind?: string | null | undefined }) {
  if (kind === 'phone') return <Smartphone aria-hidden="true" />;
  if (kind === 'tablet') return <Tablet aria-hidden="true" />;
  if (kind === 'desktop') return <Monitor aria-hidden="true" />;
  return <MonitorSmartphone aria-hidden="true" />;
}

/** 设备行：左边一枚类型图标，右边名字一行、地址一行。`.settings-device-option` 现在
 * 是两列网格（图标 + 文字），所以三处设备列表都得是这个形状，不然名字和地址会被摆成
 * 并排的两列。 */
function DeviceRowBody({ name, address, kind }: { name: string; address: string; kind?: string | null | undefined }) {
  return <>
    <span className="settings-device-icon" aria-hidden="true"><DeviceGlyph kind={kind} /></span>
    <span className="settings-device-copy">
      <span className="settings-device-name">{name}</span>
      <span className="settings-device-address">{address}</span>
    </span>
  </>;
}

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
  /** 手机 / 平板：这一端只能连别人的算力，不能把自己当成算力中心（见下面的门控）。 */
  mobile?: boolean;
}

/** 算力中心：本机对外提供算力（桌面端），以及把一页交给远端算（任意端）。
 *
 * 远端这一档只有「用不用」和「配过哪些设备」两件事：处理方式由**对面**那份设置决定，
 * 本机不存 op / 模型 / 倍数 / 层参数（从前存过，见 `RemoteOpsSchema` 的注释）。这一组
 * 只把那台设备**能做什么**用最小面积显示出来（`settings-capability-row`），让用户知道
 * 开起来会得到什么——至于具体怎么算，去对面那台机器上设。 */
export function ComputeCenterSettingsGroup({ preferences, editPreferences, mobile = false }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeComputeCenterRepository(), []);
  const [status, setStatus] = useState<ComputeCenterStatus>();
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<RemoteCapabilities>();
  const remoteRequest = useRef(0);
  const [probingRemote, setProbingRemote] = useState(false);
  const [pairMenu, setPairMenu] = useState(false);
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [address, setAddress] = useState('');
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [localPairMenu, setLocalPairMenu] = useState(false);
  const [selectedClient, setSelectedClient] = useState<string>();
  const [portMenu, setPortMenu] = useState(false);
  const [portDraft, setPortDraft] = useState(preferences.computeCenterPort);
  const [verified, setVerified] = useState(false);

  const remoteOps = useMemo(() => parseRemoteOps(preferences.remoteComputeOps), [preferences.remoteComputeOps]);
  /** 「本机对外提供算力」这一组什么时候在：手机上没有这一档（它只连别人），而且**远端算力
   *  开着的时候也不在**——两档是同一件事的两种做法（这台机器算，或者别人算），一起摆着
   *  就是让人以为能同时选。从前只有单向：本机开着时藏远端那一组，反过来没做，于是开着
   *  远端还留着「开启本机远程后处理服务」这条。 */
  const showLocalServing = !mobile && !remoteOps.enabled;
  /** 远端那一组什么时候在：桌面端要等到 status 回来（本机开着算力中心时这一档没意义），
   *  手机上没有本机那一档可争，status 取不到（网页调试、命令失败）也得留着——不然手机
   *  用户就一个入口都没有了。 */
  const showRemote = mobile || (Boolean(status) && !status?.running);
  /** 自动搜到的、**还没配对过**的设备：已经配好的在上面「已配对设备」那一条里，搜出来
   *  再列一遍只会让人分不清点哪个。 */
  const unpairedDevices = useMemo(
    () => devices.filter((device) => !remoteOps.pairedDevices.some((paired) => paired.address === device.address)),
    [devices, remoteOps.pairedDevices],
  );
  const updateRemoteOps = (patch: Partial<typeof remoteOps>) =>
    editPreferences({ remoteComputeOps: serializeRemoteOps({ ...remoteOps, ...patch }) });

  const refresh = useCallback(async () => {
    const result = await repository.status();
    if (result.ok) {
      setStatus(result.value);
      setVerified(true);
      cacheDisplayStatus(result.value);
    }
  }, [repository]);

  useEffect(() => {
    try {
      const cached = localStorage.getItem('yomika.compute-center-status');
      if (cached) {
        const display = { ...(JSON.parse(cached) as ComputeCenterStatus), token: '' };
        setStatus(display);
        localStorage.setItem('yomika.compute-center-status', JSON.stringify(display));
      }
    } catch { /* stale or unavailable cache */ }
    void refresh();
  }, [refresh]);

  // 设备是在**对面**配对的：它直接打本机 HTTP 服务的 /v2/pair/confirm，那条路不经过
  // 这份设置页，所以光靠挂载时那次 `status` 看不到新设备（以前要退出再进）。Rust 侧
  // 配对成功后广播这条事件，这里收到就重拉一次——不做轮询，因为要的只是「有新配对时
  // 更新」，而事件恰好就是这件事的失效通知。
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen(COMPUTE_CENTER_PAIRING_CHANGED_EVENT, () => { void refresh(); })
      .then((detach) => { if (active) unlisten = detach; else detach(); })
      .catch(() => { /* 不在壳里就没有事件 */ });
    return () => { active = false; unlisten?.(); };
  }, [refresh]);

  // 那三枚「对面能做什么」的小标签要一直是准的，所以打开这一组时就顺带问一次；不能等
  // 用户点开「已配对设备」才去取（从前就是这样，于是设置页上根本看不见对面有什么）。
  // 失败不吭声：对面没开着、手机不在同一个网里都是常态。
  useEffect(() => {
    if (!showRemote) return;
    const url = preferences.remoteComputeUrl;
    const token = preferences.remoteComputeToken;
    if (!url.trim() || !token.trim()) return;
    void connectRemote(url, token, { quiet: true });
    // `connectRemote` 每次渲染都是新的函数，放进依赖会导致每渲染一次就连一次对面；这里
    // 真正要跟的是「用哪台设备」这三个值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRemote, preferences.remoteComputeUrl, preferences.remoteComputeToken]);

  async function toggleServing(next: boolean) {
    setBusy(true);
    // 端口与令牌一起报上去：开关一次就把这一组该有的状态定下来（首次开启会生成令牌）。
    const result = await repository.configure({
      enabled: next,
      port: preferences.computeCenterPort,
      rotateToken: preferences.computeCenterToken === '',
    });
    setBusy(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    setStatus(result.value);
    setVerified(true);
    cacheDisplayStatus(result.value);
    editPreferences({
      computeCenterEnabled: next,
      computeCenterToken: result.value.token,
      ...(next ? { remoteComputeOps: serializeRemoteOps({ ...remoteOps, enabled: false }) } : {}),
    });
    showToast(next ? '本机远程后处理服务已开启' : '本机远程后处理服务已关闭', 'success');
  }

  async function revokeClient(id: string) {
    const result = await repository.revokePairing(id);
    if (!result.ok) { showToast(result.error.message, 'error'); return; }
    setStatus(result.value);
    cacheDisplayStatus(result.value);
    setSelectedClient(undefined);
    showToast('配对已撤销', 'success');
  }

  async function savePort() {
    if (!Number.isInteger(portDraft) || portDraft < 1024 || portDraft > 65535) return;
    setBusy(true);
    const result = await repository.configure({ enabled: true, port: portDraft });
    setBusy(false);
    if (!result.ok) { showToast(result.error.message, 'error'); void refresh(); return; }
    setStatus(result.value);
    cacheDisplayStatus(result.value);
    editPreferences({ computeCenterPort: result.value.port });
    setPortMenu(false);
  }

  /** 连一次对面并取能力清单。
   *
   *  `quiet` 是给「打开这一组时顺带问一次」用的：对面没开着是常态，那一次失败不该弹错误。 */
  async function connectRemote(url = preferences.remoteComputeUrl, token = preferences.remoteComputeToken, options?: { quiet?: boolean }) {
    const request = ++remoteRequest.current;
    setRemote(undefined);
    setProbingRemote(true);
    const result = await repository.remoteCapabilities(url, token);
    if (request !== remoteRequest.current) return;
    setProbingRemote(false);
    if (!result.ok) {
      setRemote(undefined);
      if (!options?.quiet) showToast(result.error.message, 'error');
      return;
    }
    setRemote(result.value);
    if (!options?.quiet) showToast(`已连上 ${result.value.name}`, 'success');
  }

  async function scanDevices() {
    setPairBusy(true);
    const result = await repository.discover();
    setPairBusy(false);
    if (result.ok) setDevices(result.value);
    else showToast(result.error.message, 'error');
  }

  async function startPairing() {
    if (!address.trim()) return;
    setPairBusy(true);
    // 报上**这一台**的名字与类型：对面的列表就是靠它显示「是哪台设备」。名字在
    // Android 上只有 UA 里有（后端 `host_name()` 认不出机型，只能回「Yomika」）。
    const result = await repository.requestPair(address.trim(), deviceDisplayName(), deviceKind());
    setPairBusy(false);
    if (result.ok) setRequestId(result.value.requestId);
    else showToast(result.error.message, 'error');
  }

  async function finishPairing() {
    setPairBusy(true);
    const result = await repository.confirmPair(address.trim(), requestId, code.trim());
    setPairBusy(false);
    if (!result.ok) { showToast(result.error.message, 'error'); return; }
    const existing = remoteOps.pairedDevices.filter((device) => device.address !== address.trim());
    editPreferences({
      remoteComputeUrl: address.trim(),
      remoteComputeToken: result.value.token,
      remoteComputeOps: serializeRemoteOps({ ...remoteOps, pairedDevices: [...existing.slice(-7), { address: address.trim(), name: result.value.name, token: result.value.token }] }),
    });
    setPairMenu(false);
    setRequestId('');
    setCode('');
    showToast(`已配对 ${result.value.name}`, 'success');
    void connectRemote(address.trim(), result.value.token);
  }

  // 单台设备那一层的内容区只写这一台的事：名字进标题，地址进说明，剩下的话留给
  // 「撤销之后会怎样」——列表态和它共用同一块遮罩，返回手势先退回列表（见 onClose）。
  const selectedPairClient = status?.pairedClients?.find((client) => client.id === selectedClient);

  return (
    <>
      {/* 本机节点与远端客户端互斥，避免一台设备同时显示两套连接入口；手机上一律不显示
          本机这一档（见 `showLocalServing`）。 */}
      {showLocalServing && <div className="settings-group" role="region" aria-label="本机远程后处理服务">
        <SettingsSwitch
          icon={<Server />}
          label="开启本机远程后处理服务"
          hint={
            status?.running ? '这台设备正在为局域网内的其他设备处理图片' : '允许其他设备连接这台设备处理图片'
          }
          disabled={busy || !verified}
          checked={status?.running ?? false}
          onToggle={() => void toggleServing(!(status?.running ?? false))}
        />
        {status?.running && <SettingsRow
          icon={<Server />}
          label="端口"
          hint={
            status && status.addresses.length > 0
              ? `移动端填：${status.addresses[0]}:${status.port}`
              : '没有找到局域网地址，请连接 Wi-Fi 或网线'
          }
          value={String(status.port)}
          onClick={verified ? () => { setPortDraft(status.port); setPortMenu(true); } : undefined}
        />}
        {portMenu && <SettingsMenu title="端口" icon={<Server />} onClose={() => setPortMenu(false)}>
          <label className="settings-menu-field">
            <span className="settings-menu-field-label">远程后处理服务端口</span>
            <input className="settings-port-input" type="number" min={1024} max={65535} value={portDraft} aria-label="远程后处理服务端口" onChange={(event) => setPortDraft(Number(event.target.value))} />
          </label>
          <div className="settings-menu-actions">
            <button className="primary-action" type="button" disabled={busy || !Number.isInteger(portDraft) || portDraft < 1024 || portDraft > 65535} onClick={() => void savePort()}><Save aria-hidden="true" />保存</button>
          </div>
        </SettingsMenu>}
        {status?.running && <SettingsRow icon={<Link2 />} label="管理已有配对" value={`${status.pairedClients?.length ?? 0} 台设备`} onClick={verified ? () => { setLocalPairMenu(true); void refresh(); } : undefined} />}
        {localPairMenu && <SettingsMenu
          title={selectedPairClient?.name ?? '管理已有配对'}
          icon={<Link2 />}
          onClose={() => { if (selectedClient) setSelectedClient(undefined); else setLocalPairMenu(false); }}
        >
          {selectedPairClient ? <>
            {/* 标题只剩名字：这一台是谁就落到正文里的地址上（菜单顶上那行小字删了）。 */}
            <p className="settings-menu-note">{selectedPairClient.address}</p>
            <p className="settings-menu-note">撤销后这台设备要重新配对，才能继续把图片交给本机处理。</p>
            <div className="settings-menu-actions">
              <button className="secondary-action" type="button" onClick={() => void revokeClient(selectedPairClient.id)}><Unlink aria-hidden="true" />撤销配对</button>
            </div>
          </> : <>
            <div className="settings-choice-list">
              {status?.pairedClients?.map((client) => <div className="settings-choice-option" key={client.id}>
                <button className="settings-choice-option-main settings-device-option" type="button" onClick={() => setSelectedClient(client.id)}>
                  <DeviceRowBody name={client.name} address={client.address} kind={client.kind} />
                </button>
              </div>)}
              {status?.pairedClients?.length === 0 && <p className="settings-choice-empty">暂无已配对设备</p>}
            </div>
          </>}
        </SettingsMenu>}
      </div>}

      {/* 远端算力：把这一页交给另一台设备处理。 */}
      {showRemote && <div className="settings-group" role="region" aria-label="远程后处理服务">
        <SettingsSwitch
          icon={<Wand2 />}
          label="使用远程后处理服务"
          hint="由已配对设备处理图片，结果在这台设备显示"
          disabled={!remoteOps.pairedDevices.some((device) => device.address === preferences.remoteComputeUrl && device.token === preferences.remoteComputeToken)}
          checked={remoteOps.enabled}
          onToggle={() => updateRemoteOps({ enabled: !remoteOps.enabled })}
        />
        <SettingsRow icon={<Server />} label="已配对设备" value={remoteOps.pairedDevices.find((device) => device.address === preferences.remoteComputeUrl)?.name ?? '未选择'} onClick={() => { setDeviceMenu(true); if (preferences.remoteComputeUrl && preferences.remoteComputeToken) void connectRemote(); }} />
        {/* 对面能做什么，最小面积地说一遍：三枚小标签，能用的一组亮着，不能用的一组压暗
            （`title` 里是它自己报上来的细节，比如「还没有装好的超分模型」）。具体用哪个
            模型、放大几倍、DLSSNR 走哪几层，都跟随对面那份设置，这里不摆那些控件。 */}
        {remote && <div className="settings-capability-row" role="group" aria-label="远端可用服务">
          {remote.capabilities.map((item) => <span
            className={`settings-capability-chip${item.ready ? ' is-ready' : ''}`}
            key={item.id}
            title={item.detail}
          >{item.label}</span>)}
        </div>}
        <SettingsRow icon={<Plus />} label="添加设备" onClick={() => { setPairMenu(true); void scanDevices(); }} />
        {deviceMenu && <SettingsMenu title="已配对设备" icon={<Server />} onClose={() => setDeviceMenu(false)}>
          <div className="settings-choice-list">
            {remoteOps.pairedDevices.map((device) => <div className="settings-choice-option" key={device.address}>
              <button
                className="settings-choice-option-main settings-device-option"
                type="button"
                aria-pressed={preferences.remoteComputeUrl === device.address}
                onClick={() => { editPreferences({ remoteComputeUrl: device.address, remoteComputeToken: device.token }); setRemote(undefined); void connectRemote(device.address, device.token); }}
              >
                <DeviceRowBody name={device.name} address={device.address} />
              </button>
            </div>)}
            {remoteOps.pairedDevices.length === 0 && <p className="settings-choice-empty">还没有配对过的设备</p>}
          </div>
          <div className="settings-menu-actions">
            <button className="secondary-action" type="button" disabled={probingRemote || !preferences.remoteComputeUrl} onClick={() => void connectRemote()}>刷新服务</button>
          </div>
          {/* 选哪一档不在这里选：处理方式跟随对面那份设置，这里只把它的清单念一遍。 */}
          {remote && <p className="settings-menu-desc">{remote.name} · {remote.capabilities.filter((item) => item.ready).map((item) => item.label).join('、') || '这台设备还没有可用的处理服务'}</p>}
        </SettingsMenu>}
        {pairMenu && <SettingsMenu title="添加设备" icon={<Plus />} onClose={() => { setPairMenu(false); setRequestId(''); }}>
          <div className="settings-choice-list">
            {unpairedDevices.map((device) => <div className="settings-choice-option" key={device.address}>
              <button
                className="settings-choice-option-main settings-device-option"
                type="button"
                aria-pressed={address === device.address}
                onClick={() => { setAddress(device.address); setRequestId(''); setCode(''); }}
              >
                <DeviceRowBody name={device.name} address={device.address} />
              </button>
            </div>)}
            {unpairedDevices.length === 0 && <p className="settings-choice-empty">
              {devices.length > 0 ? '搜到的设备都已经配对过了，在上面「已配对设备」里选' : '没搜到其他设备，可以填地址直接配对'}
            </p>}
          </div>
          {/* 字段名写在框上面：占位符放不下「这台设备是什么」，读起来也不再是一行孤零零的输入框。 */}
          <label className="settings-menu-field">
            <span className="settings-menu-field-label">设备地址</span>
            <input
              className="settings-address-input"
              aria-label="设备地址"
              placeholder="192.168.1.5:47653"
              value={address}
              onChange={(event) => { setAddress(event.target.value); setRequestId(''); setCode(''); }}
            />
          </label>
          {requestId ? <label className="settings-menu-field">
            <span className="settings-menu-field-label">配对码</span>
            <input
              className="settings-code-input"
              aria-label="配对码"
              inputMode="numeric"
              maxLength={6}
              placeholder="远端屏幕上显示的六位数字"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label> : null}
          <div className="settings-menu-actions">
            <button className="secondary-action" type="button" disabled={pairBusy} onClick={() => void scanDevices()}><RefreshCw aria-hidden="true" />重新搜索</button>
            {requestId
              ? <button className="primary-action" type="button" disabled={pairBusy || code.length !== 6} onClick={() => void finishPairing()}><Link2 aria-hidden="true" />完成配对</button>
              : <button className="primary-action" type="button" disabled={pairBusy || !address.trim()} onClick={() => void startPairing()}><Link2 aria-hidden="true" />配对</button>}
          </div>
        </SettingsMenu>}
      </div>}
    </>
  );
}

/** 给测试与页面用：远端设置的默认值（与后端一致）。 */
export const DEFAULT_REMOTE_COMPUTE_OPS = serializeRemoteOps(DEFAULT_REMOTE_OPS);
