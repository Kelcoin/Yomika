import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputeCenterSettingsGroup } from '../../src/components/ComputeCenterSettingsGroup';
import { ToastProvider } from '../../src/components/Toast';
import { resetInvokeAdapterForTests, setInvokeAdapterForTests } from '../../src/bridge/invoke';
import { DEFAULT_PREFERENCES } from '../../src/repositories/nativeSettingsRepository';
import { COLOR_SCHEMES } from '../../src/lib/cssThemePresets';

/** 2026-10-17 那一批界面缺陷里能落在**行为**上的两条判据。其余几条量的是 CSS 与 JSX 的
 *  形状，挂在 `tests/design-system-contract.test.ts`（那个文件的读法就是读源码文本）。 */

afterEach(() => {
  resetInvokeAdapterForTests();
});

describe('the 2026-10-17 UI batch', () => {
  it('offers a whole number of palette rows, so the theme grid has no hole', () => {
    // 用户报「再增加一个配色，补全右下角的缺口」：配色网格是三等分，张数不是 3 的倍数时
    // 最后一格就空着。判据钉在「行数整」这件事上，而不是钉在「第九张叫天青」。
    expect(COLOR_SCHEMES.length % 3, `配色张数 ${COLOR_SCHEMES.length} 不是 3 的倍数`).toBe(0);
    expect(COLOR_SCHEMES.map((scheme) => scheme.id)).toContain('sky-cyan');
  });

  it('keeps the local serving switch on while the status is still on its way', async () => {
    // 用户报「每次进高级页，开关先关再开」：开关原先只看 `status?.running`，而状态要等 IPC
    // 回来 ⇒ 服务本来就开着的机器，进门第一帧被画成关。判据：偏好里开着时，第一帧就是开的。
    let release: (() => void) | undefined;
    const adapter = vi.fn(async (command: string) => {
      if (command === 'compute_center_status') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ok: true,
          value: {
            running: true,
            port: 47_653,
            addresses: ['192.168.1.5'],
            token: 'abcdef0123456789abcdef0123456789abcdef01',
            capabilities: [],
            canStart: true,
            pairedClients: [],
          },
        };
      }
      if (command === 'compute_discover') return { ok: true, value: [] };
      return { ok: true, value: null };
    });
    setInvokeAdapterForTests(adapter);
    render(
      <ToastProvider>
        <ComputeCenterSettingsGroup
          preferences={{ ...DEFAULT_PREFERENCES, computeCenterEnabled: true }}
          editPreferences={() => {}}
        />
      </ToastProvider>,
    );

    const toggle = await screen.findByRole('switch', { name: '开启本机远程后处理服务' });
    expect(toggle, '状态还没回来时也要按偏好画成开着').toBeChecked();
    release?.();
    await waitFor(() => expect(toggle).toBeChecked());
  });
});
