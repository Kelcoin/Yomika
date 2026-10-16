import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PairingCodeNotice } from '../../src/components/PairingCodeNotice';
import { ToastProvider } from '../../src/components/Toast';
import { COMPUTE_CENTER_PAIRING_CODE_EVENT } from '../../src/repositories/nativeComputeCenterRepository';
import { emitTauriEvent } from '../tauriEvents';

/** 配对码弹窗：以前这里是 Windows 原生消息框（主题之外的一张白窗体），现在由本机 HTTP
 *  服务的广播驱动（`/v2/pair/request` → `PAIRING_CODE_EVENT`）。这些用例盯的就是
 *  「另一台设备发起配对」到「屏上出现那串数字」这条链路。 */

function renderNotice() {
  return render(
    <ToastProvider>
      <PairingCodeNotice />
    </ToastProvider>,
  );
}

/** 发一条事件，并让监听注册（`listen` 回的是 Promise）先跑完。 */
async function deliver(payload: unknown) {
  await act(async () => { emitTauriEvent(COMPUTE_CENTER_PAIRING_CODE_EVENT, payload); });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pairing code notice', () => {
  it('stays out of the way until the other device asks to pair', async () => {
    renderNotice();
    await act(async () => {});
    expect(screen.queryByText('远端配对')).toBeNull();
  });

  it('shows the six-digit code, who is asking, and how long it lasts', async () => {
    renderNotice();
    await deliver({ code: '001422', name: 'Pixel 7 Pro', address: '192.168.1.9', expiresInSeconds: 90 });
    expect(screen.getByText('远端配对')).toBeInTheDocument();
    // 分两组显示：人念这串数字时不必自己数到第四位。
    expect(screen.getByText('001')).toBeInTheDocument();
    expect(screen.getByText('422')).toBeInTheDocument();
    expect(screen.getByText(/Pixel 7 Pro/)).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.9/)).toBeInTheDocument();
    expect(screen.getByText('还剩 90 秒有效')).toBeInTheDocument();
  });

  it('drops the code once it expires instead of leaving a dead number on screen', async () => {
    vi.useFakeTimers();
    renderNotice();
    await deliver({ code: '001422', name: 'Pixel 7 Pro', address: '192.168.1.9', expiresInSeconds: 2 });
    expect(screen.getByText('还剩 2 秒有效')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('还剩 1 秒有效')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText('远端配对')).toBeNull();
  });

  it('ignores a payload that is not a pairing code', async () => {
    // 载荷来自网络那一侧，形状对不上就不该弹。以前是 `if let Some(app)` 直接弹系统框，
    // 没有校验这一步——坏载荷会画出一张空窗。
    renderNotice();
    await deliver({ nothing: 'useful' });
    await deliver(null);
    expect(screen.queryByText('远端配对')).toBeNull();
  });

  it('expires against wall time after returning from a throttled background', async () => {
    vi.useFakeTimers();
    renderNotice();
    await deliver({ code: '001422', name: 'Device', address: '192.168.1.9', expiresInSeconds: 90 });
    vi.setSystemTime(Date.now() + 100_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByText('远端配对')).not.toBeInTheDocument();
  });

  it('closes on the confirm button so the dialog does not sit over the reader', async () => {
    const user = userEvent.setup();
    renderNotice();
    await deliver({ code: '001422', name: 'Pixel 7 Pro', address: '192.168.1.9', expiresInSeconds: 90 });
    await user.click(screen.getByRole('button', { name: /确定/ }));
    expect(screen.queryByText('远端配对')).toBeNull();
  });
});
