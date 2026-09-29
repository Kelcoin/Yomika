import { afterEach, describe, expect, it } from 'vitest';

import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { checkDlssnrAvailability } from '../../src/lib/dlssnrGate';

afterEach(() => resetInvokeAdapterForTests());

function statusWith(overrides: Record<string, unknown>) {
  return {
    dllPresent: true,
    variant: 'community',
    variantLabel: '社区兼容版',
    dllBytes: 165_840_496,
    gpu: { name: 'NVIDIA GeForce RTX 4070', recommendedVariant: 'community' },
    gpuName: 'NVIDIA GeForce RTX 4070',
    recommendedVariant: 'community',
    recommendedLabel: '社区兼容版',
    coreAvailable: true,
    installable: true,
    available: true,
    probe: null,
    probeValid: true,
    error: null,
    ...overrides,
  };
}

function adapterReturning(value: unknown, ok = true) {
  setInvokeAdapterForTests(async (command: string) => {
    if (command !== 'dlssnr_status') throw new Error(`unexpected command ${command}`);
    return ok ? { ok: true, value } : { ok: false, error: value };
  });
}

const PASSED_PROBE = { supported: true, width: 96, height: 96, elapsedMs: 900, difference: 12.5, error: null };

describe('DLSS5 availability gate', () => {
  it('does not ask when the switch is off', async () => {
    setInvokeAdapterForTests(async () => { throw new Error('不该问'); });
    expect(await checkDlssnrAvailability(false)).toEqual({ ready: false, disable: false });
  });

  it('allows only a machine with a valid successful probe', async () => {
    adapterReturning(statusWith({ probe: PASSED_PROBE, probeValid: true }));
    expect(await checkDlssnrAvailability(true)).toEqual({ ready: true, disable: false });

    adapterReturning(statusWith({ probe: null, probeValid: false }));
    expect(await checkDlssnrAvailability(true)).toMatchObject({
      ready: false,
      disable: true,
      reason: '这台机器还没有检测过，请在设置页先检测一次',
    });
  });

  it('refuses and writes the switch back when the machine cannot run it at all', async () => {
    adapterReturning(statusWith({ available: false, dllPresent: false, error: '没有找到 NVIDIA 显卡' }));
    expect(await checkDlssnrAvailability(true)).toEqual({
      ready: false,
      reason: '没有找到 NVIDIA 显卡',
      disable: true,
    });
  });

  it('refuses a failed or stale probe, and says which one it is', async () => {
    adapterReturning(statusWith({ probe: { ...PASSED_PROBE, supported: false, error: '驱动不支持' } }));
    expect(await checkDlssnrAvailability(true)).toMatchObject({ ready: false, disable: true, reason: '驱动不支持' });

    adapterReturning(statusWith({ probe: PASSED_PROBE, probeValid: false }));
    const stale = await checkDlssnrAvailability(true);
    expect(stale.ready).toBe(false);
    expect(stale.disable).toBe(true);
    expect(stale.reason).toContain('重新检测');
  });

  it('stays out of the preference when the machine cannot be asked at all', async () => {
    // 问不到现状（平台不支持、命令失败）说明不了这台机器不行：偏好是同步的，手机
    // 不该把桌面端刚打开的开关关掉。
    adapterReturning({ code: 'PLATFORM_UNAVAILABLE', message: 'DLSS5 只在 Windows 桌面端可用', retryable: false }, false);
    expect(await checkDlssnrAvailability(true)).toEqual({
      ready: false,
      reason: 'DLSS5 只在 Windows 桌面端可用',
      disable: false,
    });
  });
});
