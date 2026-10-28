import { useTimedConfirmation } from '../lib/useTimedConfirmation';
import { RefreshIcon as RefreshCw } from './RefreshIcon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Link2, Monitor, MonitorSmartphone, Plus, Save, Server, Smartphone, Tablet, Unlink, Wand2 } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsMenu, SettingsOption } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { useToast } from './Toast';
import { deviceDisplayName, deviceKind } from '../lib/deviceIdentity';
import { readStorageSnapshot } from '../lib/storageSnapshot';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import {
  COMPUTE_CENTER_PAIRING_CHANGED_EVENT,
  DEFAULT_REMOTE_OPS,
  NativeComputeCenterRepository,
  ComputeCenterStatusSchema,
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

/** 设备行：左边一枚类型图标，中间名字一行、地址一行，右边（当前连上的那一台）挂一排
 *  「它现在能做什么」的胶囊。`.settings-device-option` 是三列网格，所以三处设备列表都
 *  得是这个形状，不然名字和地址会被摆成并排的两列。 */
function DeviceRowBody({ name, address, kind }: { name: string; address: string; kind?: string | null | undefined }) {
  return <>
    <span className="settings-device-icon" aria-hidden="true"><DeviceGlyph kind={kind} /></span>
    <span className="settings-device-copy">
      <span className="settings-device-name">{name}</span>
      <span className="settings-device-address">{address}</span>
    </span>
  </>;
}

/** 「对面现在能做什么」：三枚小标签，能用的亮着，不能用的压暗但仍显示（`title` 里是它
 *  自己报上来的细节，比如「还没有装好的超分模型」）。
 *
 *  它只出现在**当前连上的那一台**的设备行里。从前这里的两份摆法各有一半：设置组里铺一
 *  行、二级菜单底下再念一遍（`settings-menu-desc`），同一个清单在一页里出现两次，用户
 *  报「去掉图 1 和图 2 里的远端处理能力，以胶囊形式放到图 2 的设备名右侧」。 */
function CapabilityChips({ capabilities }: { capabilities: RemoteCapabilities['capabilities'] }) {
  return (
    <span className="settings-device-capabilities" role="group" aria-label="远端可用服务">
      {capabilities.map((item) => <span
        className={`settings-capability-chip${item.ready ? ' is-ready' : ''}`}
        key={item.id}
        title={item.detail}
      >{item.label}</span>)}
    </span>
  );
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
 * 只把那台设备**能做什么**用最小面积显示出来——就是设备行右边那三枚小标签，而且只在
 * 二级菜单里那一台上（见 `CapabilityChips`）——让用户知道开起来会得到什么；至于具体怎么
 * 算，去对面那台机器上设。 */
export function ComputeCenterSettingsGroup({ preferences, editPreferences, mobile = false }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeComputeCenterRepository(), []);
  const [status, setStatus] = useState<ComputeCenterStatus | undefined>(() => {
    const cached = readStorageSnapshot('yomika.compute-center-status', ComputeCenterStatusSchema);
    return cached ? { ...cached, token: '' } : undefined;
  });
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<RemoteCapabilities>();
  /** `remote` 说的是**哪一台**：换设备时旧清单要立刻让位，同一台重探时则留着（见 `connectRemote`）。 */
  const [remoteAddress, setRemoteAddress] = useState<string>();
  const remoteRequest = useRef(0);
  const [probingRemote, setProbingRemote] = useState(false);
  const [pairMenu, setPairMenu] = useState(false);
  const [pairFromDevices, setPairFromDevices] = useState(false);
  const [deviceMenu, setDeviceMenu] = useState(false);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [address, setAddress] = useState('');
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const pairPending = useRef(false);
  const [localPairMenu, setLocalPairMenu] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const revokePending = useRef(false);
  useTimedConfirmation(confirmRevoke, setConfirmRevoke, revoking);
  const [portMenu, setPortMenu] = useState(false);
  const [portDraft, setPortDraft] = useState(preferences.computeCenterPort);
  const [verified, setVerified] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const statusRequest = useRef(0);

  const remoteOps = useMemo(() => parseRemoteOps(preferences.remoteComputeOps), [preferences.remoteComputeOps]);
  /** 「本机对外提供算力」这一组什么时候在：手机上没有这一档（它只连别人），而且**远端算力
   *  开着的时候也不在**——两档是同一件事的两种做法（这台机器算，或者别人算），一起摆着
   *  就是让人以为能同时选。从前只有单向：本机开着时藏远端那一组，反过来没做，于是开着
   *  远端还留着「开启本机远程后处理服务」这条。 */
  const showLocalServing = !mobile && !remoteOps.enabled;
  /** 开关画的是「这一台在不在对外提供算力」。**初值取偏好，不取瞬时的 status**：status 要
   *  等一次 IPC 回来（挂载时先读上一次写下的缓存快照，那份很可能还是关着的时候写的），
   *  于是开关先画成关、再跳成开——用户报「每次进高级页面都默认关闭再变成开启；开着就一直
   *  开着，不要每次都从关闭再变成开的」。偏好是用户自己的意图，先按它画；`refresh()` 回来
   *  之后以 status 为准（真关了也就跟着画成关）。 */
  const serving = verified ? status?.running ?? preferences.computeCenterEnabled : preferences.computeCenterEnabled;
  // Initial visibility follows persisted intent, never the timing of the IPC.
  const showRemote = mobile || !serving;
  const servingPort = verified ? status?.port ?? preferences.computeCenterPort : preferences.computeCenterPort;
  /** 自动搜到的、**还没配对过**的设备：已经配好的在上面「已配对设备」那一条里，搜出来
   *  再列一遍只会让人分不清点哪个。 */
  const unpairedDevices = useMemo(
    () => devices.filter((device) => !remoteOps.pairedDevices.some((paired) => paired.address === device.address)),
    [devices, remoteOps.pairedDevices],
  );
  const updateRemoteOps = (patch: Partial<typeof remoteOps>) =>
    editPreferences({ remoteComputeOps: serializeRemoteOps({ ...remoteOps, ...patch }) });

  const publishStatus = useCallback((next: ComputeCenterStatus) => {
    // A mutation is authoritative over any status read already in flight.
    statusRequest.current += 1;
    setRefreshingStatus(false);
    setStatusError(undefined);
    setStatus(next);
    setVerified(true);
    cacheDisplayStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    setRefreshingStatus(true);
    const result = await repository.status();
    if (request !== statusRequest.current) return;
    setRefreshingStatus(false);
    if (result.ok) {
      publishStatus(result.value);
    } else setStatusError(result.error.message);
  }, [repository, publishStatus]);

  useEffect(() => {
    void refresh();
    return () => { statusRequest.current += 1; };
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
    // 端口与开关一起报上去。**不要在这里带 `rotateToken`**：它命中的那条路会
    // `pairing.clear()`，而这里从前判的是本机偏好里的令牌空不空（`computeCenterToken === ''`）
    // ——那只是个**没同步上**的状态，不是「请换令牌」。用户于是会遇到「设备连上之后
    // 又断开、还得重新配对」：一次开关就把所有已配对设备踢掉。Rust 侧那边本来就会在
    // 本机没有令牌时自己生成一个（`compute_center.rs` 的 `configure`），换令牌要换
    // 也应当是显式动作。 */
    const result = await repository.configure({
      enabled: next,
      port: preferences.computeCenterPort,
    });
    setBusy(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    publishStatus(result.value);
    editPreferences({
      computeCenterEnabled: next,
      computeCenterToken: result.value.token,
      ...(next ? { remoteComputeOps: serializeRemoteOps({ ...remoteOps, enabled: false }) } : {}),
    });
    showToast(next ? '本机远程后处理服务已开启' : '本机远程后处理服务已关闭', 'success');
  }

  async function revokeClient(id: string) {
    if (revokePending.current) return;
    revokePending.current = true;
    setRevoking(true);
    const result = await repository.revokePairing(id);
    revokePending.current = false;
    setRevoking(false);
    setConfirmRevoke(undefined);
    if (!result.ok) { showToast(result.error.message, 'error'); return; }
    publishStatus(result.value);
    showToast('配对已撤销', 'success');
  }

  async function savePort() {
    if (!Number.isInteger(portDraft) || portDraft < 1024 || portDraft > 65535) return;
    setBusy(true);
    const result = await repository.configure({ enabled: true, port: portDraft });
    setBusy(false);
    if (!result.ok) { showToast(result.error.message, 'error'); void refresh(); return; }
    publishStatus(result.value);
    editPreferences({ computeCenterPort: result.value.port });
    setPortMenu(false);
  }

  /** 连一次对面并取能力清单。
   *
   *  `quiet` 是给「打开这一组时顺带问一次」用的：对面没开着是常态，那一次失败不该弹错误。
   *
   *  **同一台设备重探时不清空旧清单**（keep-last-good）：每次进这一组、每次点「刷新服务」
   *  都先把三枚小标签抹掉再填回去，看起来就是「刚连上又断了一次」。换一台设备才让位——
   *  那时旧清单说的是别人。探失败同样不改写上一次的答案：对面只是这一会儿没答上（正在
   *  切网络、进程刚起），把「它有什么」抹成空就等于告诉用户它断了。 */
  async function connectRemote(url = preferences.remoteComputeUrl, token = preferences.remoteComputeToken, options?: { quiet?: boolean }) {
    const request = ++remoteRequest.current;
    const address = url.trim();
    if (address !== remoteAddress) { setRemote(undefined); setRemoteAddress(address); }
    setProbingRemote(true);
    const result = await repository.remoteCapabilities(url, token);
    if (request !== remoteRequest.current) return;
    setProbingRemote(false);
    if (!result.ok) {
      if (!options?.quiet) showToast(result.error.message, 'error');
      return;
    }
    setRemote(result.value);
    setRemoteAddress(address);
    if (!options?.quiet) showToast(`已连上 ${result.value.name}`, 'success');
  }

  async function scanDevices() {
    if (pairPending.current) return;
    pairPending.current = true;
    setPairBusy(true);
    const result = await repository.discover();
    pairPending.current = false;
    setPairBusy(false);
    if (result.ok) setDevices(result.value);
    else showToast(result.error.message, 'error');
  }

  async function startPairing() {
    if (!address.trim() || pairPending.current) return;
    pairPending.current = true;
    setPairBusy(true);
    // 报上**这一台**的名字与类型：对面的列表就是靠它显示「是哪台设备」。名字在
    // Android 上只有 UA 里有（后端 `host_name()` 认不出机型，只能回「Yomika」）。
    const result = await repository.requestPair(address.trim(), deviceDisplayName(), deviceKind());
    pairPending.current = false;
    setPairBusy(false);
    if (result.ok) setRequestId(result.value.requestId);
    else showToast(result.error.message, 'error');
  }

  async function finishPairing() {
    if (pairPending.current) return;
    pairPending.current = true;
    setPairBusy(true);
    const result = await repository.confirmPair(address.trim(), requestId, code.trim());
    pairPending.current = false;
    setPairBusy(false);
    if (!result.ok) { showToast(result.error.message, 'error'); return; }
    // 只留这一台：配对成功后上一台的令牌在服务器侧当场失效（Rust 那边整表替换），本地清单
    // 也跟着收成一格——留着一串已经连不上的旧设备，只会让人以为还能切回去。
    editPreferences({
      remoteComputeUrl: address.trim(),
      remoteComputeToken: result.value.token,
      remoteComputeOps: serializeRemoteOps({ ...remoteOps, pairedDevices: [{ address: address.trim(), name: result.value.name, token: result.value.token }] }),
    });
    setPairMenu(false);
    setRequestId('');
    setCode('');
    showToast(`已配对 ${result.value.name}`, 'success');
    void connectRemote(address.trim(), result.value.token);
  }

  return (
    <>
      {statusError && <div className="settings-group">
        <p className="form-error" role="alert">{statusError}</p>
        <button className="secondary-action" type="button" disabled={refreshingStatus} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />重新读取服务状态</button>
      </div>}
      {/* 本机节点与远端客户端互斥，避免一台设备同时显示两套连接入口；手机上一律不显示
          本机这一档（见 `showLocalServing`）。 */}
      {showLocalServing && <div className="settings-group" role="region" aria-label="本机远程后处理服务">
        <SettingsSwitch
          icon={<Server />}
          label="开启本机远程后处理服务"
          hint={
            serving ? '这台设备正在为局域网内的其他设备处理图片' : '允许其他设备连接这台设备处理图片'
          }
          disabled={busy || (!verified && !status)}
          checked={serving}
          onToggle={() => void toggleServing(!serving)}
        />
        {serving && <SettingsRow
          icon={<Server />}
          label="端口"
          hint={
            status && status.addresses.length > 0
              ? `移动端填：${status.addresses[0]}:${servingPort}`
              : '没有找到局域网地址，请连接 Wi-Fi 或网线'
          }
          value={String(servingPort)}
          onClick={() => { setPortDraft(servingPort); setPortMenu(true); }}
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
        {serving && <SettingsRow icon={<Link2 />} label="管理已有配对" value={`${status?.pairedClients?.length ?? 0} 台设备`} onClick={() => { setLocalPairMenu(true); void refresh(); }} />}
        {localPairMenu && <SettingsMenu
          title="管理已有配对"
          icon={<Link2 />}
          onClose={() => { setConfirmRevoke(undefined); setLocalPairMenu(false); }}
        >
          <div className="settings-choice-list">
            {status?.pairedClients?.map((client) => <div className="settings-choice-option settings-paired-client" key={client.id}>
              <div className="settings-choice-option-main settings-device-option">
                <DeviceRowBody name={client.name} address={client.address} kind={client.kind} />
              </div>
              <button className="secondary-action settings-revoke-action" type="button" disabled={revoking}
                onClick={() => { if (confirmRevoke === client.id) void revokeClient(client.id); else setConfirmRevoke(client.id); }}>
                <Unlink aria-hidden="true" />{revoking && confirmRevoke === client.id ? '撤销中…' : confirmRevoke === client.id ? '确认撤销' : '撤销配对'}
              </button>
            </div>)}
            {status?.pairedClients?.length === 0 && <p className="settings-choice-empty">暂无已配对设备</p>}
          </div>
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
        {/* 打开这一行只开菜单：探针由挂载时那次 `quiet: true` 的 `connectRemote` 负责，换设备
            时那次调用也会重跑。从前这里再连一次（不 quiet），于是「进页面」那一次与「点开这一
            行」那一次各弹一张一模一样的「已连上 X」——两张说的是同一件事。 */}
        <SettingsRow icon={<Server />} label="已配对设备" value={remoteOps.pairedDevices.find((device) => device.address === preferences.remoteComputeUrl)?.name ?? '未选择'} onClick={() => setDeviceMenu(true)} />        {/* 已经配过一台就不再摆「添加设备」这一行：配对是**替换**而不是追加，
            要换设备进「已配对设备」那张菜单（它的动作行里有「添加设备」）。 */}
        {remoteOps.pairedDevices.length === 0 && <SettingsRow icon={<Plus />} label="添加设备" onClick={() => { setPairMenu(true); void scanDevices(); }} />}
        {deviceMenu && <SettingsMenu title="已配对设备" icon={<Server />} onClose={() => setDeviceMenu(false)}>
          <div className="settings-choice-list">
            {remoteOps.pairedDevices.map((device) => <SettingsOption key={device.address} align="start" active={preferences.remoteComputeUrl === device.address} 
              onClick={() => { editPreferences({ remoteComputeUrl: device.address, remoteComputeToken: device.token }); setRemote(undefined); void connectRemote(device.address, device.token); }}
            >
                <DeviceRowBody name={device.name} address={device.address} />
                {/* 清单属于**这一台**：`remoteAddress` 记着最近一次问出来的是谁，`remote`
                    只在同一台重探时留着（keep-last-good，见 `connectRemote`），所以它此刻
                    描述的就是被选中的那一行。 */}
                {remote && preferences.remoteComputeUrl === device.address && <CapabilityChips capabilities={remote.capabilities} />}
              </SettingsOption>)}
            {remoteOps.pairedDevices.length === 0 && <p className="settings-choice-empty">还没有配对过的设备</p>}
          </div>
          <div className="settings-menu-actions">
            <button className="secondary-action" type="button" disabled={probingRemote || !preferences.remoteComputeUrl} onClick={() => void connectRemote()}>刷新服务</button>
            {/* 「添加设备」那一行在配过设备之后是收起来的，换设备只能从这里进；
                替换语义（配对成功顶掉现在这一台）在配对那张菜单里由按钮文字自己说清。 */}
            {remoteOps.pairedDevices.length > 0 && <button className="secondary-action" type="button" onClick={() => { setDeviceMenu(false); setPairFromDevices(true); setPairMenu(true); void scanDevices(); }}><Plus aria-hidden="true" />添加设备</button>}
          </div>
        </SettingsMenu>}
        {pairMenu && <SettingsMenu title="添加设备" icon={<Plus />}
          onBack={pairFromDevices ? () => { if (pairPending.current) return; setPairMenu(false); setPairFromDevices(false); setDeviceMenu(true); setRequestId(''); setCode(''); } : undefined}
          backLabel="返回已配对设备"
          onClose={() => { if (pairPending.current) return; setPairMenu(false); setPairFromDevices(false); setRequestId(''); setCode(''); }}>
          <div className="settings-choice-list">
            {unpairedDevices.map((device) => <SettingsOption key={device.address} align="start" active={address === device.address} disabled={pairBusy}
              onClick={() => { setAddress(device.address); setRequestId(''); setCode(''); }}
            >
                <DeviceRowBody name={device.name} address={device.address} />
              </SettingsOption>)}
            {unpairedDevices.length === 0 && <p className="settings-choice-empty">
              {devices.length > 0 ? '搜到的设备都已配对过' : '没搜到设备，直接填地址'}
            </p>}
          </div>
          {/* 字段名写在框上面：占位符放不下「这台设备是什么」，读起来也不再是一行孤零零的输入框。 */}
          <label className="settings-menu-field">
            <span className="settings-menu-field-label">设备地址</span>
            <input
              className="settings-address-input"
              aria-label="设备地址"
              disabled={pairBusy}
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
              disabled={pairBusy}
              inputMode="numeric"
              maxLength={6}
              placeholder="远端屏幕上显示的六位数字"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label> : null}
          <div className="settings-menu-actions">
            <button className="secondary-action" type="button" disabled={pairBusy} onClick={() => void scanDevices()}><RefreshCw aria-hidden="true" />重新搜索</button>
            {/* 配对是**替换**而不是追加：这件事原来靠一段小字说，现在收进按钮文字里
                ——已经有一台时按钮就叫「替换配对」，不用再读一行解释。 */}
            {requestId
              ? <button className="primary-action" type="button" disabled={pairBusy || code.length !== 6} onClick={() => void finishPairing()}><Link2 aria-hidden="true" />{remoteOps.pairedDevices.length > 0 ? '完成替换' : '完成配对'}</button>
              : <button className="primary-action" type="button" disabled={pairBusy || !address.trim()} onClick={() => void startPairing()}><Link2 aria-hidden="true" />{remoteOps.pairedDevices.length > 0 ? '替换配对' : '配对'}</button>}
          </div>
        </SettingsMenu>}
      </div>}
    </>
  );
}

/** 给测试与页面用：远端设置的默认值（与后端一致）。 */
export const DEFAULT_REMOTE_COMPUTE_OPS = serializeRemoteOps(DEFAULT_REMOTE_OPS);
