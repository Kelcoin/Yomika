import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, Layers, Loader2, RefreshCw, Server, Sparkles, Wand2 } from 'lucide-react';

import { SettingsSwitch } from './SettingsControls';
import { SettingsChoice, SettingsNumber } from './SettingsValueControls';
import { SettingsRow } from './SettingsRow';
import { useToast } from './Toast';
import { writeClipboardText } from '../bridge/clipboard';
import type { PreferenceSnapshot } from '../repositories/nativeSettingsRepository';
import {
  DEFAULT_REMOTE_OPS,
  NativeComputeCenterRepository,
  parseRemoteOps,
  serializeRemoteOps,
  type ComputeCenterStatus,
  type RemoteCapabilities,
} from '../repositories/nativeComputeCenterRepository';

const OP_OPTIONS = [
  { value: 'upscale', label: '超分' },
  { value: 'decensor', label: '去码' },
  { value: 'dlssnr', label: 'DLSS5' },
];

const SOURCE_OPTIONS = [
  { value: 'reader-page', label: '原图' },
  { value: 'decensored', label: '已去码' },
  { value: 'enhanced', label: '已超分' },
];

interface Props {
  preferences: PreferenceSnapshot;
  editPreferences: (patch: Partial<PreferenceSnapshot>) => void;
}

/** 算力中心：本机对外提供算力（桌面端），以及把一页交给远端算（任意端）。
 *
 * 两边的设置互不影响：远端那一份（`remoteComputeOps`）只描述「这次处理怎么做」，
 * 既不写进本机的超分/去码/DLSS5 设置，也不会去改远端机器上的设置——远端收到的
 * 只是一次带参数的请求。 */
export function ComputeCenterSettingsGroup({ preferences, editPreferences }: Props) {
  const { showToast } = useToast();
  const repository = useMemo(() => new NativeComputeCenterRepository(), []);
  const [status, setStatus] = useState<ComputeCenterStatus>();
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [remote, setRemote] = useState<RemoteCapabilities>();
  const [probingRemote, setProbingRemote] = useState(false);

  const remoteOps = useMemo(() => parseRemoteOps(preferences.remoteComputeOps), [preferences.remoteComputeOps]);
  const updateRemoteOps = (patch: Partial<typeof remoteOps>) =>
    editPreferences({ remoteComputeOps: serializeRemoteOps({ ...remoteOps, ...patch }) });
  const updateRemoteOp = (patch: Partial<typeof remoteOps.op>) =>
    updateRemoteOps({ op: { ...remoteOps.op, ...patch } as typeof remoteOps.op });

  const refresh = useCallback(async () => {
    const result = await repository.status();
    if (result.ok) setStatus(result.value);
  }, [repository]);

  useEffect(() => {
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
    showToast('已换一份新令牌：移动端要重新填', 'success');
  }

  async function connectRemote() {
    setProbingRemote(true);
    const result = await repository.remoteCapabilities(
      preferences.remoteComputeUrl,
      preferences.remoteComputeToken,
    );
    setProbingRemote(false);
    if (!result.ok) {
      setRemote(undefined);
      showToast(result.error.message, 'error');
      return;
    }
    setRemote(result.value);
    showToast(`已连上 ${result.value.name}`, 'success');
  }

  const readyCount = status?.capabilities.filter((capability) => capability.ready).length ?? 0;

  return (
    <>
      {/* 本机作为算力中心：模型包至少齐全一项才允许开。 */}
      <div className="settings-group" role="region" aria-label="算力中心">
        <SettingsSwitch
          icon={<Server />}
          label="作为算力中心"
          hint={
            !status
              ? '正在读取能力清单…'
              : readyCount === 0
                ? '超分模型、去码模型包、DLSS5 至少要齐全一项才能开'
                : `局域网内给移动端提供：${status.capabilities.filter((item) => item.ready).map((item) => item.label).join('、')}`
          }
          disabled={busy || !status?.canStart}
          checked={status?.running ?? false}
          onToggle={() => void toggleServing(!(status?.running ?? false))}
        />
        <SettingsRow
          icon={<Server />}
          label="端口"
          hint={
            status && status.addresses.length > 0
              ? `移动端填：${status.addresses[0]}:${preferences.computeCenterPort}`
              : '没有找到局域网地址（先连上 Wi-Fi / 网线）'
          }
          control={
            <input
              className="settings-number"
              type="number"
              min={1024}
              max={65535}
              value={preferences.computeCenterPort}
              aria-label="算力中心端口"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 1024 && value <= 65535) {
                  editPreferences({ computeCenterPort: Math.round(value) });
                }
              }}
            />
          }
        />
        <SettingsRow
          icon={<Copy />}
          label="令牌"
          hint={preferences.computeCenterToken === '' ? '开启时会自动生成一份' : '移动端要用这一份；换一份就要在移动端上重填'}
          control={
            <div className="settings-inline-actions">
              <code className="settings-token" title={preferences.computeCenterToken}>
                {preferences.computeCenterToken === '' ? '—' : `${preferences.computeCenterToken.slice(0, 8)}…`}
              </code>
              <button
                className="secondary-action"
                type="button"
                disabled={preferences.computeCenterToken === ''}
                onClick={() => void writeClipboardText(preferences.computeCenterToken).then(() => showToast('令牌已复制', 'success'))}
              >
                复制
              </button>
              <button className="secondary-action" type="button" disabled={rotating} aria-busy={rotating} onClick={() => void rotateToken()}>
                <RefreshCw aria-hidden="true" />
                换一份
              </button>
            </div>
          }
        />
        {status?.capabilities.map((capability) => (
          <SettingsRow
            key={capability.id}
            icon={capability.ready ? <Sparkles /> : <AlertTriangle />}
            label={capability.label}
            hint={capability.detail}
            control={<span className="settings-row-note">{capability.ready ? '可用' : '不可用'}</span>}
          />
        ))}
      </div>

      {/* 远端算力：把这一页交给另一台设备处理。 */}
      <div className="settings-group" role="region" aria-label="远端算力">
        <SettingsSwitch
          icon={<Wand2 />}
          label="使用远端算力"
          hint={
            preferences.remoteComputeUrl.trim() === ''
              ? '先填上桌面端的地址（那边设置里会显示）'
              : '把这一页交给那台设备处理，结果回到本机显示'
          }
          disabled={preferences.remoteComputeUrl.trim() === '' || preferences.remoteComputeToken.trim() === ''}
          checked={remoteOps.enabled}
          onToggle={() => updateRemoteOps({ enabled: !remoteOps.enabled })}
        />
        <SettingsRow
          icon={<Server />}
          label="远端地址"
          hint="IP 或 IP:端口（端口不填按 47653）"
          control={
            <input
              className="settings-text-input"
              type="url"
              inputMode="url"
              placeholder="192.168.1.5:47653"
              value={preferences.remoteComputeUrl}
              aria-label="远端地址"
              onChange={(event) => editPreferences({ remoteComputeUrl: event.target.value })}
            />
          }
        />
        <SettingsRow
          icon={<Copy />}
          label="远端令牌"
          hint="在桌面端的算力中心设置里复制"
          control={
            <div className="settings-inline-actions">
              <input
                className="settings-text-input"
                type="password"
                value={preferences.remoteComputeToken}
                aria-label="远端令牌"
                onChange={(event) => editPreferences({ remoteComputeToken: event.target.value })}
              />
              <button
                className="secondary-action"
                type="button"
                disabled={probingRemote || preferences.remoteComputeUrl.trim() === ''}
                aria-busy={probingRemote}
                onClick={() => void connectRemote()}
              >
                {probingRemote ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                连接
              </button>
            </div>
          }
        />
        {remote && (
          <>
            <SettingsRow
              icon={<Server />}
              label="对面的能力"
              hint={`${remote.name} · 协议 v${remote.version}`}
              control={<span className="settings-row-note">{remote.capabilities.filter((item) => item.ready).length} 项可用</span>}
            />
            {remote.capabilities.map((capability) => (
              <SettingsRow
                key={capability.id}
                icon={capability.ready ? <Sparkles /> : <AlertTriangle />}
                label={capability.label}
                hint={capability.detail}
                control={<span className="settings-row-note">{capability.ready ? '可用' : '不可用'}</span>}
              />
            ))}
          </>
        )}
        <SettingsChoice
          icon={<Wand2 />}
          label="远端处理方式"
          hint="只作用于远端这一次处理"
          value={remoteOps.op.op}
          options={OP_OPTIONS}
          onChange={(value) => updateRemoteOp({ op: value as typeof remoteOps.op.op })}
        />
        <SettingsChoice
          icon={<Layers />}
          label="起点"
          hint="从哪一版页面开始送过去"
          value={remoteOps.source}
          options={SOURCE_OPTIONS}
          onChange={(value) => updateRemoteOps({ source: value as typeof remoteOps.source })}
        />
        <SettingsRow
          icon={<Sparkles />}
          label="远端模型 / 倍数"
          hint={
            remoteOps.op.op === 'dlssnr'
              ? 'DLSS5 用远端设置页里那份层参数'
              : remoteOps.op.modelId === ''
                ? '留空 = 用对面的默认（超分按倍数）'
                : `模型 ${remoteOps.op.modelId}`
          }
          control={
            <input
              className="settings-text-input"
              type="text"
              placeholder="模型 id（可留空）"
              value={remoteOps.op.modelId}
              aria-label="远端模型 id"
              onChange={(event) => updateRemoteOp({ modelId: event.target.value })}
            />
          }
        />
        {remoteOps.op.op === 'upscale' && (
          <SettingsNumber
            icon={<Wand2 />}
            label="倍数"
            hint="只在对面没有点名模型时起作用"
            value={remoteOps.op.scale}
            min={1}
            max={4}
            step={1}
            format={(value) => `${value}×`}
            onChange={(value) => updateRemoteOp({ scale: Math.round(value) })}
          />
        )}
        <SettingsRow
          icon={<AlertTriangle />}
          label="明文 HTTP"
          hint="局域网内的临时通道：令牌就是全部凭据，别把它暴露到公网"
          control={<span className="settings-row-note">{remoteOps.enabled ? '使用中' : '未使用'}</span>}
        />
      </div>
    </>
  );
}

/** 给测试与页面用：远端设置的默认值（与后端一致）。 */
export const DEFAULT_REMOTE_COMPUTE_OPS = serializeRemoteOps(DEFAULT_REMOTE_OPS);
