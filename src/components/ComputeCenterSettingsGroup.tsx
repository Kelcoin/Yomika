import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Plus, RefreshCw, Server, Unlink, Wand2 } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsMenu } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { useToast } from './Toast';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import {
  DEFAULT_REMOTE_OPS,
  NativeComputeCenterRepository,
  parseRemoteOps,
  serializeRemoteOps,
  type ComputeCenterStatus,
  type RemoteCapabilities,
  type DiscoveredDevice,
} from '../repositories/nativeComputeCenterRepository';

const OP_OPTIONS = [
  { value: 'upscale', label: '超分' },
  { value: 'decensor', label: '去码' },
  { value: 'dlssnr', label: 'DLSSNR' },
];

function cacheDisplayStatus(status: ComputeCenterStatus): void {
  try { localStorage.setItem('yomika.compute-center-status', JSON.stringify({ ...status, token: '' })); } catch { /* storage unavailable */ }
}

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
}

/** 算力中心：本机对外提供算力（桌面端），以及把一页交给远端算（任意端）。
 *
 * 两边的设置互不影响：远端那一份（`remoteComputeOps`）只描述「这次处理怎么做」，
 * 既不写进本机的超分/去码/DLSSNR 设置，也不会去改远端机器上的设置——远端收到的
 * 只是一次带参数的请求。 */
export function ComputeCenterSettingsGroup({ preferences, editPreferences }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeComputeCenterRepository(), []);
  const [status, setStatus] = useState<ComputeCenterStatus>();
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
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
  const updateRemoteOps = (patch: Partial<typeof remoteOps>) =>
    editPreferences({ remoteComputeOps: serializeRemoteOps({ ...remoteOps, ...patch }) });
  const updateRemoteOp = (patch: Partial<typeof remoteOps.op>) =>
    updateRemoteOps({ op: { ...remoteOps.op, ...patch } as typeof remoteOps.op });

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
    showToast(next ? '算力中心已开启' : '算力中心已关闭', 'success');
  }

  async function rotateToken() {
    setRotating(true);
    const result = await repository.configure({
      enabled: status?.running ?? false,
      port: preferences.computeCenterPort,
      rotateToken: true,
    });
    setRotating(false);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    setStatus(result.value);
    cacheDisplayStatus(result.value);
    editPreferences({ computeCenterToken: result.value.token });
    showToast('已撤销所有配对，设备需要重新配对', 'success');
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

  async function connectRemote(url = preferences.remoteComputeUrl, token = preferences.remoteComputeToken) {
    const request = ++remoteRequest.current;
    setRemote(undefined);
    setProbingRemote(true);
    const result = await repository.remoteCapabilities(url, token);
    if (request !== remoteRequest.current) return;
    setProbingRemote(false);
    if (!result.ok) {
      setRemote(undefined);
      showToast(result.error.message, 'error');
      return;
    }
    setRemote(result.value);
    showToast(`已连上 ${result.value.name}`, 'success');
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
    const result = await repository.requestPair(address.trim());
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

  return (
    <>
      {/* 本机节点与远端客户端互斥，避免一台设备同时显示两套连接入口。 */}
      <div className="settings-group" role="region" aria-label="算力中心">
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
          <input className="settings-number settings-port-input" type="number" min={1024} max={65535} value={portDraft} aria-label="远程后处理服务端口" onChange={(event) => setPortDraft(Number(event.target.value))} />
          <button className="primary-action" type="button" disabled={busy || !Number.isInteger(portDraft) || portDraft < 1024 || portDraft > 65535} onClick={() => void savePort()}>保存</button>
        </SettingsMenu>}
        {status?.running && <SettingsRow icon={<Link2 />} label="管理已有配对" value={`${status.pairedClients?.length ?? 0} 台设备`} onClick={verified ? () => setLocalPairMenu(true) : undefined} />}
        {localPairMenu && <SettingsMenu title={selectedClient ? status?.pairedClients?.find((client) => client.id === selectedClient)?.name ?? '设备' : '管理已有配对'} icon={<Link2 />} onClose={() => { if (selectedClient) setSelectedClient(undefined); else setLocalPairMenu(false); }}>
          {selectedClient ? <>
            <p className="settings-menu-desc">{status?.pairedClients?.find((client) => client.id === selectedClient)?.address}</p>
            <button className="secondary-action" type="button" onClick={() => void revokeClient(selectedClient)}><Unlink aria-hidden="true" />撤销配对</button>
          </> : <>
            <div className="settings-choice-list">
              {status?.pairedClients?.map((client) => <button className="settings-choice-option-main" key={client.id} type="button" onClick={() => setSelectedClient(client.id)}>{client.name} · {client.address}</button>)}
              {status?.pairedClients?.length === 0 && <p className="settings-choice-empty">暂无已配对设备</p>}
            </div>
            <button className="secondary-action" type="button" disabled={rotating || !status?.pairedClients?.length} onClick={() => void rotateToken()}><Unlink aria-hidden="true" />撤销全部配对</button>
          </>}
        </SettingsMenu>}
      </div>

      {/* 远端算力：把这一页交给另一台设备处理。 */}
      {status && !status.running && <div className="settings-group" role="region" aria-label="远端算力">
        <SettingsSwitch
          icon={<Wand2 />}
          label="使用远程后处理服务"
          hint="由已配对设备处理图片，结果在这台设备显示"
          disabled={!remoteOps.pairedDevices.some((device) => device.address === preferences.remoteComputeUrl && device.token === preferences.remoteComputeToken)}
          checked={remoteOps.enabled}
          onToggle={() => updateRemoteOps({ enabled: !remoteOps.enabled })}
        />
        <SettingsRow icon={<Server />} label="已配对设备" value={remoteOps.pairedDevices.find((device) => device.address === preferences.remoteComputeUrl)?.name ?? '未选择'} onClick={() => { setDeviceMenu(true); if (preferences.remoteComputeUrl && preferences.remoteComputeToken) void connectRemote(); }} />
        <SettingsRow icon={<Plus />} label="添加设备" onClick={() => { setPairMenu(true); void scanDevices(); }} />
        {deviceMenu && <SettingsMenu title="已配对设备" icon={<Server />} onClose={() => setDeviceMenu(false)}>
          <div className="settings-choice-list">
            {remoteOps.pairedDevices.map((device) => <button className="settings-choice-option-main" key={device.address} type="button" onClick={() => { editPreferences({ remoteComputeUrl: device.address, remoteComputeToken: device.token }); setRemote(undefined); void connectRemote(device.address, device.token); }}>{device.name} · {device.address}</button>)}
          </div>
          <button className="secondary-action" type="button" disabled={probingRemote || !preferences.remoteComputeUrl} onClick={() => void connectRemote()}>刷新模型</button>
          {remote && <p className="settings-menu-desc">{remote.name} · {remote.capabilities.filter((item) => item.ready).map((item) => item.label).join('、')}</p>}
          {remote && <div className="settings-choice-list" role="group" aria-label="远端处理方式">
            {OP_OPTIONS.filter((option) => remote.capabilities.some((item) => item.id === option.value && item.ready)).map((option) => <button key={option.value} className="settings-choice-option-main" type="button" aria-pressed={remoteOps.op.op === option.value} onClick={() => updateRemoteOp({ op: option.value as typeof remoteOps.op.op, modelId: '' })}>{option.label}</button>)}
          </div>}
          {remote && remoteOps.op.op !== 'dlssnr' && <div className="settings-choice-list" role="group" aria-label="远端模型">
            {remoteOps.op.op === 'upscale' && <button className="settings-choice-option-main" type="button" aria-pressed={remoteOps.op.modelId === ''} onClick={() => updateRemoteOp({ modelId: '' })}>默认放大</button>}
            {remote.models.filter((model) => model.kind === remoteOps.op.op).map((model) => <button key={model.id} className="settings-choice-option-main" type="button" aria-pressed={remoteOps.op.modelId === model.id} onClick={() => updateRemoteOp({ modelId: model.id })}>{model.label}</button>)}
          </div>}
          {remote && remoteOps.op.op === 'upscale' && remoteOps.op.modelId === '' && <label className="settings-menu-field">放大倍数<input className="settings-number settings-port-input" type="number" min={1} max={4} aria-label="远端放大倍数" value={remoteOps.op.scale} onChange={(event) => updateRemoteOp({ scale: Math.min(4, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
        </SettingsMenu>}
        {pairMenu && <SettingsMenu title="添加设备" icon={<Plus />} onClose={() => { setPairMenu(false); setRequestId(''); }}>
          <div className="settings-choice-list">
            {devices.map((device) => <button className="settings-choice-option-main" key={device.address} type="button" onClick={() => { setAddress(device.address); setRequestId(''); setCode(''); }}>{device.name} · {device.address}</button>)}
          </div>
          <input className="settings-text-input settings-pair-address" aria-label="设备 IP" placeholder="192.168.1.5:47653" value={address} onChange={(event) => { setAddress(event.target.value); setRequestId(''); setCode(''); }} />
          {requestId ? <>
            <input className="settings-text-input" aria-label="配对码" inputMode="numeric" maxLength={6} placeholder="输入远端显示的六位配对码" value={code} onChange={(event) => setCode(event.target.value)} />
          </> : null}
          <div className="settings-pair-actions">
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
